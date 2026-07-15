// Wallets_Config/spotHoldingsLock.js
//
// This is a standalone module — it is NOT yet wired into an order engine
// because that file (wherever you currently INSERT INTO spot_orders /
// handle cancels / handle fills) wasn't available to merge against. Once
// you share it, these calls should be spliced directly into that
// transaction flow rather than left as a separate module.
//
// Why this exists: walletTransfer.js already reads only
// available_quantity (not available_quantity + locked_quantity) via
// getSpotBalance, FOR UPDATE inside a transaction. So the moment orders
// correctly move funds into locked_quantity using the functions below,
// transfers will already respect the lock — zero changes needed to
// walletTransfer.js.

const { conn } = require("../db_connection");

/**
 * Call BEFORE inserting the spot_orders row, inside the SAME transaction
 * as that insert.
 *   BUY  → locks the quote asset (USDT) worth quantity * estimatedPrice
 *   SELL → locks the base asset quantity itself
 *
 * For MARKET buys, pull estimatedPrice from getLivePrice() in
 * market_data.js so the lock amount and the actual execution price come
 * from the same source — otherwise a lock computed against a stale price
 * could under- or over-reserve funds relative to what actually fills.
 */
function lockForOrder({ walletId, side, symbol, quantity, estimatedPrice }, cb) {
    const lockSymbol = side === 'BUY' ? 'USDT' : symbol;
    const lockAmount = side === 'BUY' ? quantity * estimatedPrice : quantity;

    conn.query(
        `SELECT available_quantity FROM spot_holdings
         WHERE wallet_id = ? AND symbol = ? FOR UPDATE`,
        [walletId, lockSymbol],
        (err, rows) => {
            if (err) return cb(err);
            const available = rows.length ? parseFloat(rows[0].available_quantity) : 0;
            if (available < lockAmount) {
                return cb(new Error(`Insufficient available ${lockSymbol} to place this order.`));
            }
            conn.query(
                `UPDATE spot_holdings
                 SET available_quantity = available_quantity - ?, locked_quantity = locked_quantity + ?
                 WHERE wallet_id = ? AND symbol = ?`,
                [lockAmount, lockAmount, walletId, lockSymbol],
                (uErr) => cb(uErr, { lockSymbol, lockAmount })
            );
        }
    );
}

/**
 * Call on cancel (full order, or the remaining unfilled portion of a
 * partially-filled order) — moves locked funds back to available.
 */
function unlockOnCancel({ walletId, lockSymbol, lockAmount }, cb) {
    conn.query(
        `UPDATE spot_holdings
         SET locked_quantity = locked_quantity - ?, available_quantity = available_quantity + ?
         WHERE wallet_id = ? AND symbol = ?`,
        [lockAmount, lockAmount, walletId, lockSymbol],
        cb
    );
}

/**
 * Call on (partial) fill — releases the locked amount corresponding to
 * the filled portion only. The credit side (the asset actually received
 * from the fill) is handled separately in your existing
 * fill/settlement code — this function only clears the lock, it does
 * not credit anything.
 */
function releaseOnFill({ walletId, lockSymbol, filledLockAmount }, cb) {
    conn.query(
        `UPDATE spot_holdings SET locked_quantity = locked_quantity - ?
         WHERE wallet_id = ? AND symbol = ?`,
        [filledLockAmount, walletId, lockSymbol],
        cb
    );
}

module.exports = { lockForOrder, unlockOnCancel, releaseOnFill };