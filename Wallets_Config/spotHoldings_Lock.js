// Wallets_Config/spotHoldingsLock.js
//
// IMPORTANT: every function here takes `connection` as its first argument
// — this MUST be the one dedicated connection checked out via
// getConnection() in db_connection.js for the surrounding transaction,
// never the shared pool (`conn`). If you pass the pool instead, the
// FOR UPDATE row lock and the eventual commit/rollback will not apply to
// the same session as the rest of your order-placement/cancel/fill
// transaction — which was exactly the second locking bug (pool vs.
// dedicated connection) alongside the "orders never locked funds" bug.

function query(connection, sql, params) {
    return new Promise((resolve, reject) => {
        connection.query(sql, params, (err, result) => {
            if (err) return reject(err);
            resolve(result);
        });
    });
}

/**
 * Call BEFORE inserting the spot_orders row, on the SAME connection/
 * transaction as that insert.
 *   BUY  → locks the quote asset (USDT) worth quantity * estimatedPrice
 *   SELL → locks the base asset quantity itself
 *
 * estimatedPrice should be the order's entry_price_reference (market
 * price for MARKET orders, limit_price for LIMIT orders) — the SAME
 * value you persist as spot_orders.locked_price, so a later cancel or
 * fill can recompute exactly how much was reserved without any
 * additional bookkeeping.
 *
 * Throws (rejects) on insufficient balance — the caller should catch
 * this, roll back, and return a 400 to the client.
 */
async function lockForOrder(connection, { walletId, side, symbol, quantity, estimatedPrice }) {
    const lockSymbol = side === 'BUY' ? 'USDT' : symbol;
    const lockAmount = side === 'BUY' ? quantity * estimatedPrice : quantity;

    const rows = await query(
        connection,
        `SELECT available_quantity FROM spot_holdings
         WHERE wallet_id = ? AND symbol = ? FOR UPDATE`,
        [walletId, lockSymbol]
    );

    const available = rows.length ? parseFloat(rows[0].available_quantity) : 0;
    if (available < lockAmount) {
        throw new Error(`Insufficient available ${lockSymbol} to place this order.`);
    }

    await query(
        connection,
        `UPDATE spot_holdings
         SET available_quantity = available_quantity - ?, locked_quantity = locked_quantity + ?
         WHERE wallet_id = ? AND symbol = ?`,
        [lockAmount, lockAmount, walletId, lockSymbol]
    );

    return { lockSymbol, lockAmount };
}

/**
 * Call on cancel (full order, or the remaining unfilled portion of a
 * partially-filled order) — moves locked funds/asset back to available.
 */
async function unlockOnCancel(connection, { walletId, lockSymbol, lockAmount }) {
    return query(
        connection,
        `UPDATE spot_holdings
         SET locked_quantity = locked_quantity - ?, available_quantity = available_quantity + ?
         WHERE wallet_id = ? AND symbol = ?`,
        [lockAmount, lockAmount, walletId, lockSymbol]
    );
}

/**
 * Call on (partial) fill — returns the locked amount corresponding to
 * the filled portion back to available_quantity. This is now IDENTICAL
 * to unlockOnCancel: it unconditionally credits the reservation back.
 *
 * PREVIOUSLY this only decremented locked_quantity and credited nothing
 * back — the reserved slice just vanished. That was the double-debit
 * bug: at placement, available -= lockAmount and locked += lockAmount.
 * At fill, this function did locked -= lockAmount (that money now gone
 * from both columns), and then the BUY caller separately did
 * available -= actualCost on top of that — so available got debited
 * twice for the same fill (once at lock time, once again at fill time),
 * while locked_quantity absorbed the loss silently. It only showed up
 * as "balance goes negative after a refresh" because the second debit
 * wasn't reflected until the wallet was re-fetched.
 *
 * Fixed contract — release ALWAYS credits back what was reserved, then
 * every caller in spotPanel_Route.js follows it with an explicit debit
 * of exactly what's being spent/consumed:
 *   - BUY fill:  release credits back the USDT lock, then the caller
 *     debits available_quantity for the actual fill cost
 *     (fillQty * fillPrice). If locked_price and fillPrice match
 *     exactly (the normal case), the two cancel out to a net-zero
 *     change beyond the original reservation; any difference (slippage)
 *     flows through correctly.
 *   - SELL fill (plain sell or TP/SL exit): release credits the base
 *     asset back to available_quantity, then the caller immediately
 *     debits that same fillQty back out, since it's being sold rather
 *     than returned to the user. Net effect is identical to before
 *     (available drops by fillQty overall) but nothing is ever left
 *     dangling in locked_quantity with no corresponding credit.
 */
async function releaseOnFill(connection, { walletId, lockSymbol, filledLockAmount }) {
    return query(
        connection,
        `UPDATE spot_holdings
         SET locked_quantity = locked_quantity - ?, available_quantity = available_quantity + ?
         WHERE wallet_id = ? AND symbol = ?`,
        [filledLockAmount, filledLockAmount, walletId, lockSymbol]
    );
}

module.exports = { lockForOrder, unlockOnCancel, releaseOnFill };