const { conn } = require("../db_connection");

const WALLET_TYPES = ["funding", "spot", "futures"];

function sendResponse(res, statusCode, success, message, data = null) {
    return res.status(statusCode).json({ success, message, data });
}


function getFundingBalance(userId, cb) {
    conn.query(
        "SELECT balance FROM accounts WHERE user_id = ? FOR UPDATE",
        [userId],
        (err, rows) => {
            if (err) return cb(err);
            if (!rows.length) return cb(null, null);
            cb(null, { type: "funding", balance: parseFloat(rows[0].balance) });
        }
    );
}

function getSpotBalance(userId, cb) {
    conn.query(
        "SELECT wallet_id FROM spot_wallet WHERE user_id = ?",
        [userId],
        (err, walletRows) => {
            if (err) return cb(err);
            if (!walletRows.length) return cb(null, null);

            const walletId = walletRows[0].wallet_id;

            conn.query(
                `SELECT available_quantity FROM spot_holdings
                 WHERE wallet_id = ? AND symbol = 'USDT' FOR UPDATE`,
                [walletId],
                (hErr, hRows) => {
                    if (hErr) return cb(hErr);
                    cb(null, {
                        type: "spot",
                        walletId,
                        balance: hRows.length ? parseFloat(hRows[0].available_quantity) : 0,
                        hasHoldingRow: hRows.length > 0,
                    });
                }
            );
        }
    );
}

function getFuturesBalance(userId, cb) {
    conn.query(
        "SELECT wallet_id, available_margin FROM futures_wallet WHERE user_id = ? FOR UPDATE",
        [userId],
        (err, rows) => {
            if (err) return cb(err);
            if (!rows.length) return cb(null, null);
            cb(null, {
                type: "futures",
                walletId: rows[0].wallet_id,
                balance: parseFloat(rows[0].available_margin),
            });
        }
    );
}

function resolveWallet(type, userId, cb) {
    if (type === "funding") return getFundingBalance(userId, cb);
    if (type === "spot") return getSpotBalance(userId, cb);
    if (type === "futures") return getFuturesBalance(userId, cb);
    cb(new Error("Unknown wallet type"));
}

// ═══════════════════════════════════════════════════════
// WRITE (debit/credit) HELPERS
// ═══════════════════════════════════════════════════════
function debitWallet(type, userId, wallet, amount, cb) {
    if (type === "funding") {
        return conn.query(
            "UPDATE accounts SET balance = balance - ? WHERE user_id = ?",
            [amount, userId], cb
        );
    }
    if (type === "spot") {
        if (!wallet.hasHoldingRow) return cb(new Error("Spot USDT holding not found"));
        return conn.query(
            `UPDATE spot_holdings SET available_quantity = available_quantity - ?
             WHERE wallet_id = ? AND symbol = 'USDT'`,
            [amount, wallet.walletId], cb
        );
    }
    if (type === "futures") {
        return conn.query(
            `UPDATE futures_wallet
             SET wallet_balance = wallet_balance - ?, available_margin = available_margin - ?
             WHERE wallet_id = ?`,
            [amount, amount, wallet.walletId], cb
        );
    }
    cb(new Error("Unknown wallet type"));
}

function creditWallet(type, userId, wallet, amount, cb) {
    if (type === "funding") {
        return conn.query(
            "UPDATE accounts SET balance = balance + ? WHERE user_id = ?",
            [amount, userId], cb
        );
    }
    if (type === "spot") {
        if (wallet.hasHoldingRow) {
            return conn.query(
                `UPDATE spot_holdings SET available_quantity = available_quantity + ?
                 WHERE wallet_id = ? AND symbol = 'USDT'`,
                [amount, wallet.walletId], cb
            );
        }
        // Defensive fallback — the signup flow always creates this row, but
        // if it's ever missing, create it instead of failing the transfer.
        return conn.query(
            `INSERT INTO spot_holdings
                (wallet_id, symbol, available_quantity, locked_quantity, average_buy_price, total_cost)
             VALUES (?, 'USDT', ?, 0, 1.00, 0)`,
            [wallet.walletId, amount], cb
        );
    }
    if (type === "futures") {
        return conn.query(
            `UPDATE futures_wallet
             SET wallet_balance = wallet_balance + ?, available_margin = available_margin + ?
             WHERE wallet_id = ?`,
            [amount, amount, wallet.walletId], cb
        );
    }
    cb(new Error("Unknown wallet type"));
}

// ═══════════════════════════════════════════════════════
// MAIN HANDLER — POST /api/wallets/transfer
// body: { fromWallet: 'funding'|'spot'|'futures', toWallet: same, amount: number }
// ═══════════════════════════════════════════════════════
function transferBetweenWallets(req, res) {
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

    conn.beginTransaction((txErr) => {
        if (txErr) return sendResponse(res, 500, false, "Could not start transaction.");

        resolveWallet(fromType, userId, (srcErr, source) => {
            if (srcErr) {
                return conn.rollback(() =>
                    sendResponse(res, 500, false, "Database error reading source wallet.")
                );
            }
            if (!source) {
                return conn.rollback(() =>
                    sendResponse(res, 404, false, `Your ${fromType} wallet was not found.`)
                );
            }
            if (amount > source.balance) {
                return conn.rollback(() =>
                    sendResponse(res, 400, false,
                        `Insufficient balance. Available: $${source.balance.toFixed(2)}`)
                );
            }

            resolveWallet(toType, userId, (dstErr, destination) => {
                if (dstErr) {
                    return conn.rollback(() =>
                        sendResponse(res, 500, false, "Database error reading destination wallet.")
                    );
                }
                if (!destination) {
                    return conn.rollback(() =>
                        sendResponse(res, 404, false, `Your ${toType} wallet was not found.`)
                    );
                }

                debitWallet(fromType, userId, source, amount, (debitErr) => {
                    if (debitErr) {
                        return conn.rollback(() =>
                            sendResponse(res, 500, false, "Failed to debit source wallet.")
                        );
                    }

                    creditWallet(toType, userId, destination, amount, (creditErr) => {
                        if (creditErr) {
                            return conn.rollback(() =>
                                sendResponse(res, 500, false, "Failed to credit destination wallet.")
                            );
                        }

                        conn.commit((commitErr) => {
                            if (commitErr) {
                                return conn.rollback(() =>
                                    sendResponse(res, 500, false, "Commit failed.")
                                );
                            }

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
                        });
                    });
                });
            });
        });
    });
}

module.exports = { transferBetweenWallets };