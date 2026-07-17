const express = require('express');
const router = express.Router();
const path = require('path');

// db_connection.js now exports `conn` as a mysql2 POOL, plus a
// getConnection() helper that checks out ONE dedicated connection for a
// real multi-statement transaction. `conn.query(...)` (pool.query) still
// works unchanged for one-shot reads — see poolQuery() below — but the
// transfer transaction below (BEGIN ... FOR UPDATE ... COMMIT) MUST run
// on a single dedicated connection, or concurrent transfers will
// interleave their row locks and commit/rollback calls on the same
// shared socket. That's what was throwing "conn.beginTransaction is not
// a function", and — if it hadn't thrown — is exactly the kind of bug
// that could produce a corrupted balance under real concurrency.
const { conn, getConnection } = require('../db_connection');
const verifyToken = require('../middle/middleware');

// ---------------- HELPERS ----------------
function sendResponse(res, status, success, message, data = null) {
    return res.status(status).json({ success, message, data });
}

// One-shot, non-transactional query — safe to run straight on the pool.
// Used for reads that don't need to be inside the transfer's transaction
// (the idempotency pre-check, the account lookup route).
function poolQuery(sql, params = []) {
    return new Promise((resolve, reject) => {
        conn.query(sql, params, (err, result) => {
            if (err) return reject(err);
            resolve(result);
        });
    });
}

// Transactional query — always runs on the ONE dedicated connection
// passed in, never on the pool. Every query inside a transfer's
// BEGIN/COMMIT must go through this, not poolQuery, so locks and commit
// boundaries stay tied to the request that opened them.
function query(connection, sql, params = []) {
    return new Promise((resolve, reject) => {
        connection.query(sql, params, (err, result) => {
            if (err) return reject(err);
            resolve(result);
        });
    });
}

function beginTransaction(connection) {
    return new Promise((resolve, reject) => {
        connection.beginTransaction(err => { if (err) reject(err); else resolve(); });
    });
}

function commit(connection) {
    return new Promise((resolve, reject) => {
        connection.commit(err => { if (err) reject(err); else resolve(); });
    });
}

function rollback(connection) {
    return new Promise((resolve) => {
        // rollback() on a connection that never successfully started a
        // transaction is a harmless no-op in mysql2 — safe to call
        // unconditionally in the catch block below.
        connection.rollback(() => resolve());
    });
}

// ---------------- LEDGER BALANCE CHECK ----------------
// Must read through the SAME transactional connection as the rest of the
// transfer, so it sees the debit/credit rows this transaction just
// inserted (not yet committed / invisible to other connections) rather
// than racing a separate pool connection against its own writes.
async function checkLedgerBalance(connection, transactionId) {
    const [debitSum] = await query(
        connection,
        `SELECT COALESCE(SUM(amount), 0) AS total FROM debit_ledger WHERE transaction_id = ?`,
        [transactionId]
    );
    const [creditSum] = await query(
        connection,
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
        return sendResponse(res, 400, false, 'Amount should be greater than 0');
    }

    // ---------------- IDEMPOTENCY CHECK (before transaction) ----------------
    // Plain pool read — no lock needed yet, so no dedicated connection
    // needed here. (Note: this pre-check alone doesn't close the race
    // where two requests with the SAME idempotencyKey both pass it before
    // either INSERTs — that's guarded by ledger_transactions having a
    // UNIQUE constraint on idempotency_key at the DB level, which turns a
    // simultaneous duplicate into an INSERT error inside the transaction
    // below rather than a double transfer.)
    let existing;
    try {
        existing = await poolQuery(
            `SELECT * FROM ledger_transactions WHERE idempotency_key = ?`,
            [idempotencyKey]
        );
    } catch (err) {
        console.error('SYSTEM ERROR:', err.message);
        return sendResponse(res, 500, false, 'Internal server error');
    }
    if (existing.length > 0) {
        return sendResponse(res, 200, true, 'Duplicate request ignored', existing[0]);
    }

    // ---------------- CHECK OUT A DEDICATED CONNECTION ----------------
    // Everything from here on (BEGIN ... FOR UPDATE ... COMMIT) runs on
    // this ONE connection, so a concurrent transfer on a different
    // connection can't interleave its locks or commit boundary with this
    // one. Every other in-flight /api/transfer request gets its own
    // connection from the pool the same way, so concurrent transfers are
    // fully isolated from each other instead of bottlenecking on one
    // shared socket.
    let connection;
    try {
        connection = await getConnection();
    } catch (err) {
        console.error('SYSTEM ERROR:', err.message);
        return sendResponse(res, 500, false, 'Could not acquire a database connection.');
    }

    try {
        await beginTransaction(connection);

        // ---------------- LOCK ACCOUNTS ----------------
        // Select explicit columns only — no joins, no alias collisions.
        const accounts = await query(
            connection,
            `SELECT user_id, account_number, balance, status
             FROM accounts
             WHERE user_id IN (?, ?)
             FOR UPDATE`,
            [fromAccountId, toAccountId]
        );

        const fromAcc = accounts.find(a => a.user_id === Number(fromAccountId));
        const toAcc   = accounts.find(a => a.user_id === Number(toAccountId));

        if (!fromAcc || !toAcc)          throw new Error('Account not found');
        if (fromAcc.user_id !== userId)  throw new Error('Unauthorized access');
        if (toAcc.status   !== 'ACTIVE') throw new Error('Receiver account not active');
        if (fromAcc.status !== 'ACTIVE') throw new Error('Sender account not active');
        if (fromAcc.balance < amount)    throw new Error('Insufficient balance');

        // ---------------- CREATE PARENT TRANSACTION (PENDING) ----------------
        const txResult = await query(
            connection,
            `INSERT INTO ledger_transactions
                (from_account, to_account, amount, type, status, idempotency_key)
             VALUES (?, ?, ?, 'TRANSFER', 'PENDING', ?)`,
            [fromAccountId, toAccountId, amount, idempotencyKey]
        );
        const transactionId = txResult.insertId;

        // ---------------- DEBIT ENTRY (sender loses money) ----------------
        await query(
            connection,
            `INSERT INTO debit_ledger
                (transaction_id, account_id, to_account_id, amount, status, idempotency_key)
             VALUES (?, ?, ?, ?, 'PENDING', ?)`,
            [transactionId, fromAccountId, toAccountId, amount, `${idempotencyKey}-DEBIT`]
        );

        // ---------------- CREDIT ENTRY (receiver gains money) ----------------
        await query(
            connection,
            `INSERT INTO credit_ledger
                (transaction_id, account_id, from_account_id, amount, status, idempotency_key)
             VALUES (?, ?, ?, ?, 'PENDING', ?)`,
            [transactionId, toAccountId, fromAccountId, amount, `${idempotencyKey}-CREDIT`]
        );

        // ---------------- IMBALANCE CHECK (before touching balances) ----------------
        await checkLedgerBalance(connection, transactionId);

        // ---------------- UPDATE ACCOUNT BALANCES ----------------
        await query(
            connection,
            `UPDATE accounts SET balance = balance - ? WHERE user_id = ?`,
            [amount, fromAccountId]
        );
        await query(
            connection,
            `UPDATE accounts SET balance = balance + ? WHERE user_id = ?`,
            [amount, toAccountId]
        );

        // ---------------- MARK LEDGER ENTRIES AS POSTED ----------------
        await query(
            connection,
            `UPDATE debit_ledger  SET status = 'POSTED' WHERE transaction_id = ?`,
            [transactionId]
        );
        await query(
            connection,
            `UPDATE credit_ledger SET status = 'POSTED' WHERE transaction_id = ?`,
            [transactionId]
        );

        // ---------------- MARK TRANSACTION SUCCESS ----------------
        await query(
            connection,
            `UPDATE ledger_transactions SET status = 'SUCCESS' WHERE id = ?`,
            [transactionId]
        );

        await commit(connection);

        return sendResponse(res, 200, true, 'Transfer successful', { transactionId });

    } catch (error) {
        await rollback(connection);
        console.error('TRANSFER ERROR:', error.message);
        return sendResponse(res, 500, false, error.message);
    } finally {
        // Always hand the connection back to the pool, success or failure,
        // so it's free for the next request instead of leaking connections
        // under load.
        connection.release();
    }
});

// ---------------- ACCOUNT LOOKUP ----------------
// Returns { user_id, account_number, status } — user_id is the accounts PK,
// the frontend passes it directly as toAccountId in the transfer body.
// Plain read, no transaction needed — stays on the pool via poolQuery.
router.get('/api/account/lookup', verifyToken, async (req, res) => {
    const { account_number } = req.query;
    if (!account_number) return sendResponse(res, 400, false, 'Missing account_number');
    try {
        const rows = await poolQuery(
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