// Wallets_Config/walletTransfer.js
//
// db_connection.js now exports a mysql2 POOL (`conn`) plus a
// getConnection() helper that checks out ONE dedicated connection for a
// real multi-statement transaction. This file was still calling
// conn.beginTransaction(...) / conn.commit(...) / conn.rollback(...)
// directly on the pool object — pool objects don't have those methods at
// all (only a connection you've checked out does), so every transfer was
// throwing immediately at beginTransaction. Fixed below by using
// getConnection() and running the whole transaction on that one
// connection, releasing it in a finally block.

const { getConnection } = require("../db_connection");

const WALLET_TYPES = ["funding", "spot", "futures"];

function sendResponse(res, statusCode, success, message, data = null) {
    return res.status(statusCode).json({ success, message, data });
}

// Promise wrapper around connection.query — `connection` here is always
// the ONE dedicated connection for this transaction, never the pool.
function query(connection, sql, params) {
    return new Promise((resolve, reject) => {
        connection.query(sql, params, (err, result) => {
            if (err) return reject(err);
            resolve(result);
        });
    });
}

function beginTransaction(connection) {
    return new Promise((resolve, reject) => {
        connection.beginTransaction((err) => (err ? reject(err) : resolve()));
    });
}

function commit(connection) {
    return new Promise((resolve, reject) => {
        connection.commit((err) => (err ? reject(err) : resolve()));
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

async function getFundingBalance(connection, userId) {
    const rows = await query(
        connection,
        "SELECT balance FROM accounts WHERE user_id = ? FOR UPDATE",
        [userId]
    );
    if (!rows.length) return null;
    return { type: "funding", balance: parseFloat(rows[0].balance) };
}

async function getSpotBalance(connection, userId) {
    const walletRows = await query(
        connection,
        "SELECT wallet_id FROM spot_wallet WHERE user_id = ?",
        [userId]
    );
    if (!walletRows.length) return null;

    const walletId = walletRows[0].wallet_id;

    // Reads available_quantity only (not available_quantity +
    // locked_quantity) — funds an order has reserved via
    // spotHoldingsLock.js are correctly excluded from what a transfer can
    // move out, now that orders actually populate locked_quantity.
    const hRows = await query(
        connection,
        `SELECT available_quantity FROM spot_holdings
         WHERE wallet_id = ? AND symbol = 'USDT' FOR UPDATE`,
        [walletId]
    );

    return {
        type: "spot",
        walletId,
        balance: hRows.length ? parseFloat(hRows[0].available_quantity) : 0,
        hasHoldingRow: hRows.length > 0,
    };
}

async function getFuturesBalance(connection, userId) {
    const rows = await query(
        connection,
        "SELECT wallet_id, available_margin FROM futures_wallet WHERE user_id = ? FOR UPDATE",
        [userId]
    );
    if (!rows.length) return null;
    return {
        type: "futures",
        walletId: rows[0].wallet_id,
        balance: parseFloat(rows[0].available_margin),
    };
}

function resolveWallet(connection, type, userId) {
    if (type === "funding") return getFundingBalance(connection, userId);
    if (type === "spot") return getSpotBalance(connection, userId);
    if (type === "futures") return getFuturesBalance(connection, userId);
    return Promise.reject(new Error("Unknown wallet type"));
}

// ═══════════════════════════════════════════════════════
// WRITE (debit/credit) HELPERS
// ═══════════════════════════════════════════════════════
async function debitWallet(connection, type, userId, wallet, amount) {
    if (type === "funding") {
        return query(connection, "UPDATE accounts SET balance = balance - ? WHERE user_id = ?", [amount, userId]);
    }
    if (type === "spot") {
        if (!wallet.hasHoldingRow) throw new Error("Spot USDT holding not found");
        return query(
            connection,
            `UPDATE spot_holdings SET available_quantity = available_quantity - ?
             WHERE wallet_id = ? AND symbol = 'USDT'`,
            [amount, wallet.walletId]
        );
    }
    if (type === "futures") {
        return query(
            connection,
            `UPDATE futures_wallet
             SET wallet_balance = wallet_balance - ?, available_margin = available_margin - ?
             WHERE wallet_id = ?`,
            [amount, amount, wallet.walletId]
        );
    }
    throw new Error("Unknown wallet type");
}

async function creditWallet(connection, type, userId, wallet, amount) {
    if (type === "funding") {
        return query(connection, "UPDATE accounts SET balance = balance + ? WHERE user_id = ?", [amount, userId]);
    }
    if (type === "spot") {
        if (wallet.hasHoldingRow) {
            return query(
                connection,
                `UPDATE spot_holdings SET available_quantity = available_quantity + ?
                 WHERE wallet_id = ? AND symbol = 'USDT'`,
                [amount, wallet.walletId]
            );
        }
        // Defensive fallback — the signup flow always creates this row, but
        // if it's ever missing, create it instead of failing the transfer.
        return query(
            connection,
            `INSERT INTO spot_holdings
                (wallet_id, symbol, available_quantity, locked_quantity, average_buy_price, total_cost)
             VALUES (?, 'USDT', ?, 0, 1.00, 0)`,
            [wallet.walletId, amount]
        );
    }
    if (type === "futures") {
        return query(
            connection,
            `UPDATE futures_wallet
             SET wallet_balance = wallet_balance + ?, available_margin = available_margin + ?
             WHERE wallet_id = ?`,
            [amount, amount, wallet.walletId]
        );
    }
    throw new Error("Unknown wallet type");
}

// ═══════════════════════════════════════════════════════
// MAIN HANDLER — POST /api/wallets/transfer
// body: { fromWallet: 'funding'|'spot'|'futures', toWallet: same, amount: number }
// ═══════════════════════════════════════════════════════
async function transferBetweenWallets(req, res) {
    const userId = req.user.id;

    const fromType = String(req.body.fromWallet || "").toLowerCase();
    const toType = String(req.body.toWallet || "").toLowerCase();
    const amount = Math.round((parseFloat(req.body.amount) || 0) * 100) / 100;

    if (!WALLET_TYPES.includes(fromType) || !WALLET_TYPES.includes(toType)) {
        return sendResponse(res, 400, false, "Invalid wallet type. Use funding, spot, or futures.");
    }
    if (fromType === toType) {
        return sendResponse(res, 400, false, "Cannot transfer to the same wallet.");
    }
    if (!amount || amount <= 0) {
        return sendResponse(res, 400, false, "Amount must be greater than zero.");
    }

    let connection;
    try {
        connection = await getConnection();
    } catch (e) {
        return sendResponse(res, 500, false, "Could not acquire a database connection.");
    }

    try {
        await beginTransaction(connection);

        const source = await resolveWallet(connection, fromType, userId);
        if (!source) {
            await rollback(connection);
            return sendResponse(res, 404, false, `Your ${fromType} wallet was not found.`);
        }
        if (amount > source.balance) {
            await rollback(connection);
            return sendResponse(res, 400, false, `Insufficient balance. Available: $${source.balance.toFixed(2)}`);
        }

        const destination = await resolveWallet(connection, toType, userId);
        if (!destination) {
            await rollback(connection);
            return sendResponse(res, 404, false, `Your ${toType} wallet was not found.`);
        }

        await debitWallet(connection, fromType, userId, source, amount);
        await creditWallet(connection, toType, userId, destination, amount);

        await commit(connection);

        return sendResponse(
            res, 200, true,
            `Transferred $${amount.toFixed(2)} USDT from ${fromType} to ${toType}.`,
            {
                fromWallet: fromType,
                toWallet: toType,
                amount,
                fromBalanceAfter: +(source.balance - amount).toFixed(2),
                toBalanceAfter: +(destination.balance + amount).toFixed(2),
            }
        );
    } catch (err) {
        await rollback(connection);
        return sendResponse(res, 500, false, err.message || "Transfer failed due to a server error.");
    } finally {
        connection.release();
    }
}

module.exports = { transferBetweenWallets };