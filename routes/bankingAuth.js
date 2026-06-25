const express = require('express');
const router = express.Router();
const path = require('path');

const { conn } = require('../db_connection');
const verifyToken = require('../middle/middleware');

// ---------------- HELPERS ----------------
function sendResponse(res, status, success, message, data = null) {
    return res.status(status).json({ success, message, data });
}

function query(sql, params = []) {
    return new Promise((resolve, reject) => {
        conn.query(sql, params, (err, result) => {
            if (err) return reject(err);
            resolve(result);
        });
    });
}

function beginTransaction() {
    return new Promise((resolve, reject) => {
        conn.beginTransaction(err => { if (err) reject(err); else resolve(); });
    });
}

function commit() {
    return new Promise((resolve, reject) => {
        conn.commit(err => { if (err) reject(err); else resolve(); });
    });
}

function rollback() {
    return new Promise((resolve) => { conn.rollback(() => resolve()); });
}

// ---------------- LEDGER BALANCE CHECK ----------------
async function checkLedgerBalance(transactionId) {
    const [debitSum] = await query(
        `SELECT COALESCE(SUM(amount), 0) AS total FROM debit_ledger WHERE transaction_id = ?`,
        [transactionId]
    );
    const [creditSum] = await query(
        `SELECT COALESCE(SUM(amount), 0) AS total FROM credit_ledger WHERE transaction_id = ?`,
        [transactionId]
    );

    const debit  = parseFloat(debitSum.total);
    const credit = parseFloat(creditSum.total);

    if (debit !== credit) {
        throw new Error(`Ledger imbalance detected: DEBIT(${debit}) !== CREDIT(${credit})`);
    }

    return { debit, credit };
}

// ---------------- PAGE ROUTE ----------------
router.get('/transfer', verifyToken, (req, res) => {
    res.sendFile(path.join(__dirname, '../Frontend/transfer.html'));
});

// ---------------- DASHBOARD API ----------------
//
// ROOT CAUSE FIX:
//   The mysql Node.js driver collapses result columns by their *original* column
//   name when two aliased columns share the same underlying name, even if you gave
//   them different aliases.  Both u.id and a.user_id have the underlying name
//   "id" / "user_id" — the driver returns whichever it encounters last and drops
//   the other, so row.account_uid ends up undefined.
//
//   Solution: use TWO COMPLETELY SEPARATE QUERIES — one for the user row,
//   one for the account row.  No join, no alias collision, no driver bug.
//

// ---------------- TRANSFER API ----------------
// fromAccountId and toAccountId are both accounts.user_id values (the PK).
router.post('/api/transfer', verifyToken, async (req, res) => {
    try {
        let { fromAccountId, toAccountId, amount, idempotencyKey } = req.body;
        const userId = req.user.id;
        amount = Number(amount);

        // ---------------- BASIC VALIDATION ----------------
        if (!fromAccountId || !toAccountId || !amount || !idempotencyKey) {
            return sendResponse(res, 400, false, 'Missing fields');
        }
        if (Number(fromAccountId) === Number(toAccountId)) {
            return sendResponse(res, 400, false, 'Cannot transfer to same account');
        }
        if (amount <= 0) {
            return sendResponse(res, 400, false, 'Invalid amount');
        }

        // ---------------- IDEMPOTENCY CHECK (before transaction) ----------------
        const existing = await query(
            `SELECT * FROM ledger_transactions WHERE idempotency_key = ?`,
            [idempotencyKey]
        );
        if (existing.length > 0) {
            return sendResponse(res, 200, true, 'Duplicate request ignored', existing[0]);
        }

        // ---------------- START TRANSACTION ----------------
        await beginTransaction();

        try {
            // ---------------- LOCK ACCOUNTS ----------------
            // Select explicit columns only — no joins, no alias collisions.
            const accounts = await query(
                `SELECT user_id, account_number, balance, status
                 FROM accounts
                 WHERE user_id IN (?, ?)
                 FOR UPDATE`,
                [fromAccountId, toAccountId]
            );

            const fromAcc = accounts.find(a => a.user_id === Number(fromAccountId));
            const toAcc   = accounts.find(a => a.user_id === Number(toAccountId));

            if (!fromAcc || !toAcc)         throw new Error('Account not found');
            if (fromAcc.user_id !== userId) throw new Error('Unauthorized access');
            if (toAcc.status   !== 'ACTIVE') throw new Error('Receiver account not active');
            if (fromAcc.status !== 'ACTIVE') throw new Error('Sender account not active');
            if (fromAcc.balance < amount)    throw new Error('Insufficient balance');

            // ---------------- CREATE PARENT TRANSACTION (PENDING) ----------------
            const txResult = await query(
                `INSERT INTO ledger_transactions
                    (from_account, to_account, amount, type, status, idempotency_key)
                 VALUES (?, ?, ?, 'TRANSFER', 'PENDING', ?)`,
                [fromAccountId, toAccountId, amount, idempotencyKey]
            );
            const transactionId = txResult.insertId;

            // ---------------- DEBIT ENTRY (sender loses money) ----------------
            await query(
                `INSERT INTO debit_ledger
                    (transaction_id, account_id, to_account_id, amount, status, idempotency_key)
                 VALUES (?, ?, ?, ?, 'PENDING', ?)`,
                [transactionId, fromAccountId, toAccountId, amount, `${idempotencyKey}-DEBIT`]
            );

            // ---------------- CREDIT ENTRY (receiver gains money) ----------------
            await query(
                `INSERT INTO credit_ledger
                    (transaction_id, account_id, from_account_id, amount, status, idempotency_key)
                 VALUES (?, ?, ?, ?, 'PENDING', ?)`,
                [transactionId, toAccountId, fromAccountId, amount, `${idempotencyKey}-CREDIT`]
            );

            // ---------------- IMBALANCE CHECK (before touching balances) ----------------
            await checkLedgerBalance(transactionId);

            // ---------------- UPDATE ACCOUNT BALANCES ----------------
            await query(
                `UPDATE accounts SET balance = balance - ? WHERE user_id = ?`,
                [amount, fromAccountId]
            );
            await query(
                `UPDATE accounts SET balance = balance + ? WHERE user_id = ?`,
                [amount, toAccountId]
            );

            // ---------------- MARK LEDGER ENTRIES AS POSTED ----------------
            await query(
                `UPDATE debit_ledger  SET status = 'POSTED' WHERE transaction_id = ?`,
                [transactionId]
            );
            await query(
                `UPDATE credit_ledger SET status = 'POSTED' WHERE transaction_id = ?`,
                [transactionId]
            );

            // ---------------- MARK TRANSACTION SUCCESS ----------------
            await query(
                `UPDATE ledger_transactions SET status = 'SUCCESS' WHERE id = ?`,
                [transactionId]
            );

            await commit();

            return sendResponse(res, 200, true, 'Transfer successful', { transactionId });

        } catch (error) {
            await rollback();
            console.error('TRANSFER ERROR:', error.message);
            return sendResponse(res, 500, false, error.message);
        }

    } catch (outerError) {
        console.error('SYSTEM ERROR:', outerError.message);
        return sendResponse(res, 500, false, 'Internal server error');
    }
});

// ---------------- ACCOUNT LOOKUP ----------------
// Returns { user_id, account_number, status } — user_id is the accounts PK,
// the frontend passes it directly as toAccountId in the transfer body.
router.get('/api/account/lookup', verifyToken, async (req, res) => {
    const { account_number } = req.query;
    if (!account_number) return sendResponse(res, 400, false, 'Missing account_number');
    try {
        const rows = await query(
            `SELECT user_id, account_number, status FROM accounts WHERE account_number = ?`,
            [account_number]
        );
        if (rows.length === 0) return sendResponse(res, 404, false, 'Account not found');
        return sendResponse(res, 200, true, 'Account found', rows[0]);
    } catch (e) {
        console.error('LOOKUP ERROR:', e.message);
        return sendResponse(res, 500, false, 'Internal server error');
    }
});

module.exports = router;