// futures_Persistence.js
// -----------------------------------------------------------------------
// The only place MySQL gets written for futures data. Subscribes to
// 'execution' / 'liquidation' / 'fundingApplied' ONLY — never to
// 'positionUpdate' / 'marginUpdate' (those are tick-driven and are
// liveStateStore.js's job, cached in RAM, never persisted). See the
// STATIC vs LIVE section at the top of futuresEngineClient.js.
//
// ─────────────────────────────────────────────────────────────────────
// SCHEMA-COMPLIANCE FIX (earlier revision — kept for context)
// ─────────────────────────────────────────────────────────────────────
// This file was previously written against an older shape of the
// schema (missing wallet_id on positions INSERTs, wrong column names,
// liquidations/funding faked as futures_trades rows). All of that was
// already fixed — see the CREATE TABLE statements for the real shape:
//
//   positions:
//     - wallet_id BIGINT NOT NULL, no default
//     - last_order_id (not order_id)
//     - margin_mode column lives directly on positions
//     - initial_margin column lives directly on positions
//     - no order_id column at all
//
//   futures_trades:
//     - price (not entry_price / exit_price)
//     - position_side, position_action columns exist and are NOT NULL
//     - executed_at (not opened_at)
//
//   liquidations / funding_payments: dedicated tables, written to below.
//
// ─────────────────────────────────────────────────────────────────────
// PREVIOUS REVISION — two bugs fixed (kept for context)
// ─────────────────────────────────────────────────────────────────────
// 1. "CROSS selected but history shows ISOLATED": margin_mode was only
//    ever written once, at OPEN. The engine now sends margin_mode on
//    every EXECUTION message, so handleOpen() and handleIncrease() both
//    persist it from the wire.
// 2. "History quantity = 0": handleClose() and the liquidation handler's
//    full-liquidation branch no longer zero out positions.quantity on
//    close — `status` already distinguishes OPEN vs CLOSED/LIQUIDATED.
//
// ─────────────────────────────────────────────────────────────────────
// THIS REVISION — initial_margin is now threaded through everywhere
// ─────────────────────────────────────────────────────────────────────
// Root cause of "leverage shows 1x" + "ROI/margin panel frozen":
//   - Bug 1 (leverage): the C++ engine's ExecutionMsg.leverage field was
//     declared but never assigned before being sent, so every EXECUTION
//     message told Node "leverage = 1" regardless of what was actually
//     selected. Fixed engine-side (see futures_engine.cpp) — Node's
//     `msg.leverage || 1` fallback below was already correct, it just
//     never received anything but 1 to work with.
//   - Bug 2 (frozen ROI/margin): positions.initial_margin was never
//     written or read anywhere in this file (or selected in
//     futuresPanel_Route.js), so it was always NULL — and ROI is
//     normally unrealized_pnl / initial_margin, a null/garbage
//     denominator. The engine now sends initial_margin on every
//     EXECUTION/LIQUIDATION message (mirroring how margin_mode is
//     already threaded through); every handler below now reads and
//     persists it on the same code path it already touches `positions`.
// -----------------------------------------------------------------------
const { conn: pool, getConnection } = require('../db_connection');
const { engineEvents } = require("./futuresEngineClient");

/* ═══════════════════════════════════════════════════════════════════════
   PROMISE WRAPPERS around the callback-style mysql2 API
   ═══════════════════════════════════════════════════════════════════════ */
function queryAsync(connectionOrPool, sql, params = []) {
    return new Promise((resolve, reject) => {
        connectionOrPool.query(sql, params, (err, results) => {
            if (err) return reject(err);
            resolve(results);
        });
    });
}

function beginTransactionAsync(connection) {
    return new Promise((resolve, reject) => {
        connection.beginTransaction((err) => (err ? reject(err) : resolve()));
    });
}

function commitAsync(connection) {
    return new Promise((resolve, reject) => {
        connection.commit((err) => (err ? reject(err) : resolve()));
    });
}

function rollbackAsync(connection) {
    return new Promise((resolve) => {
        connection.rollback(() => resolve());
    });
}

async function withTransaction(work) {
    const connection = await getConnection();
    try {
        await beginTransactionAsync(connection);
        const result = await work(connection);
        await commitAsync(connection);
        return result;
    } catch (err) {
        await rollbackAsync(connection);
        throw err;
    } finally {
        connection.release();
    }
}

/* ═══════════════════════════════════════════════════════════════════════
   EVENT WIRING
   ═══════════════════════════════════════════════════════════════════════ */
function attachPersistenceHandlers() {
    // ── EXECUTION: OPEN / INCREASE (DCA) / DECREASE / CLOSE / REVERSE ──
    engineEvents.on("execution", async (msg) => {
        try {
            switch (msg.position_action) {
                case "OPEN":
                    await handleOpen(msg);
                    break;
                case "INCREASE":
                    await handleIncrease(msg); // DCA
                    break;
                case "DECREASE":
                    await handleDecrease(msg);
                    break;
                case "CLOSE":
                case "REVERSE":
                    // A one-way reversal arrives as two EXECUTION messages
                    // from the engine (closing leg on the old side, then
                    // an OPEN/INCREASE leg on the new side). REVERSE only
                    // labels the closing leg; handle it like CLOSE.
                    await handleClose(msg);
                    break;
            }

            // TP/SL-triggered closes arrive with db_order_id = 0 (see
            // futures_engine.cpp AccountManager::checkRisk — "not tied to
            // a specific Node order row"). There is no futures_orders row
            // to update in that case, so skip it rather than UPDATE ...
            // WHERE order_id = 0.
            if (msg.order_id) {
                await queryAsync(
                    pool,
                    `UPDATE futures_orders SET remaining_quantity = ?, status = ? WHERE order_id = ?`,
                    [msg.remaining_quantity, msg.status, msg.order_id]
                );
            }
        } catch (err) {
            console.error("futuresPersistence: failed to persist execution", msg, err);
        }
    });

    // ── LIQUIDATION ──
    // Writes into the real `liquidations` table (history) AND updates
    // the `positions` row (live status), same as before — but no longer
    // fakes a futures_trades row, since that table's columns don't fit a
    // liquidation event and the schema now has a dedicated table for it.
    engineEvents.on("liquidation", async (msg) => {
        try {
            await withTransaction(async (connection) => {
                const rows = await queryAsync(
                    connection,
                    `SELECT position_id, quantity FROM positions
                     WHERE user_id = ? AND symbol = ? AND position_side = ? AND status = 'OPEN'
                     FOR UPDATE`,
                    [msg.user_id, msg.symbol, msg.position_side]
                );
                const row = rows[0];
                if (!row) {
                    console.error("futuresPersistence: liquidation for unknown open position", msg);
                    return;
                }

                if (msg.is_partial && msg.remaining_quantity > 0) {
                    // Partial liquidation — position stays OPEN with the
                    // reduced quantity and a proportionally reduced
                    // initial_margin (engine already computed the correct
                    // post-liquidation value — msg.initial_margin — same
                    // way margin_mode is mirrored, not recomputed here).
                    await queryAsync(
                        connection,
                        `UPDATE positions
                         SET quantity = ?, initial_margin = ?, realized_pnl = realized_pnl + ?
                         WHERE position_id = ?`,
                        [msg.remaining_quantity, msg.initial_margin ?? 0, msg.realized_pnl, row.position_id]
                    );
                } else {
                    // Full liquidation — `status = 'LIQUIDATED'` already
                    // marks it closed everywhere the app checks; quantity
                    // is left untouched (history needs it), initial_margin
                    // is set to 0 to match the engine's cleared position.
                    await queryAsync(
                        connection,
                        `UPDATE positions
                         SET status = 'LIQUIDATED', initial_margin = 0,
                             realized_pnl = realized_pnl + ?, closed_at = NOW()
                         WHERE position_id = ?`,
                        [msg.realized_pnl, row.position_id]
                    );
                }

                await queryAsync(
                    connection,
                    `INSERT INTO liquidations
                        (position_id, user_id, symbol, position_side, margin_mode,
                         liquidated_quantity, remaining_quantity, liquidation_price,
                         mark_price, realized_pnl, is_partial)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [row.position_id, msg.user_id, msg.symbol, msg.position_side, msg.margin_mode,
                     msg.liquidated_quantity, msg.remaining_quantity, msg.liquidation_price,
                     msg.mark_price, msg.realized_pnl, !!msg.is_partial]
                );

                await queryAsync(
                    connection,
                    `UPDATE futures_wallet SET wallet_balance = wallet_balance + ? WHERE wallet_id = ?`,
                    [msg.realized_pnl, msg.wallet_id]
                );
            });
        } catch (err) {
            console.error("futuresPersistence: failed to persist liquidation", msg, err);
        }
    });

    // ── FUNDING ──
    // Writes into the real `funding_payments` table AND applies the
    // wallet delta, in one transaction so the two can't drift apart.
    engineEvents.on("fundingApplied", async (msg) => {
        try {
            await withTransaction(async (connection) => {
                const rows = await queryAsync(
                    connection,
                    `SELECT position_id FROM positions
                     WHERE user_id = ? AND symbol = ? AND position_side = ? AND status = 'OPEN'
                     FOR UPDATE`,
                    [msg.user_id, msg.symbol, msg.position_side]
                );
                const row = rows[0];
                if (!row) {
                    console.error("futuresPersistence: funding for unknown open position", msg);
                    return;
                }

                await queryAsync(
                    connection,
                    `INSERT INTO funding_payments
                        (position_id, user_id, symbol, position_side, funding_rate,
                         mark_price, funding_fee)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [row.position_id, msg.user_id, msg.symbol, msg.position_side,
                     msg.funding_rate, msg.mark_price, msg.funding_fee]
                );

                await queryAsync(
                    connection,
                    `UPDATE futures_wallet SET wallet_balance = wallet_balance - ? WHERE wallet_id = ?`,
                    [msg.funding_fee, msg.wallet_id]
                );
            });
        } catch (err) {
            console.error("futuresPersistence: failed to persist funding", msg, err);
        }
    });
}

/* ═══════════════════════════════════════════════════════════════════════
   PER-ACTION HANDLERS — columns match the real `positions` /
   `futures_trades` tables (wallet_id + last_order_id + margin_mode +
   initial_margin on positions, price/position_side/position_action on
   futures_trades).
   ═══════════════════════════════════════════════════════════════════════ */

// Fallback only — kept for compatibility with an older engine build that
// doesn't send margin_mode on EXECUTION yet. Once the engine (see
// futures_engine.cpp's ExecutionMsg/executionToJson) is confirmed to
// always include margin_mode on the wire, this lookup is no longer
// needed and handleOpen() could drop straight to msg.margin_mode.
async function getMarginModeForOrder(connection, orderId) {
    if (!orderId) return 'ISOLATED';
    const rows = await queryAsync(connection, `SELECT margin_mode FROM futures_orders WHERE order_id = ?`, [orderId]);
    return (rows[0] && rows[0].margin_mode) || 'ISOLATED';
}

// OPEN: insert the position row (wallet_id + last_order_id + margin_mode
// + initial_margin all included — see header). margin_mode comes from
// the wire first (msg.margin_mode) and only falls back to the
// futures_orders lookup for backward compatibility. initial_margin comes
// straight from the wire (msg.initial_margin, sent by the engine as of
// this revision) — falls back to 0 only for an old engine build that
// doesn't send it yet.
async function handleOpen(msg) {
    await withTransaction(async (connection) => {
        const marginMode = msg.margin_mode || await getMarginModeForOrder(connection, msg.order_id);

        const result = await queryAsync(
            connection,
            `INSERT INTO positions
                (user_id, wallet_id, last_order_id, symbol, position_side, margin_mode,
                 quantity, entry_price, leverage, initial_margin, take_profit, stop_loss, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN')`,
            [msg.user_id, msg.wallet_id, msg.order_id || null, msg.symbol, msg.position_side,
             marginMode, msg.fill_quantity, msg.fill_price, msg.leverage || 1,
             msg.initial_margin || 0, msg.take_profit ?? null, msg.stop_loss ?? null]
        );
        await insertTradeRow(connection, result.insertId, msg, 'OPEN');
    });
}

// INCREASE (DCA): re-average entry_price/quantity, bump last_order_id to
// the order that just touched this position, resync margin_mode from
// the wire (fix: "CROSS selected but history shows ISOLATED"), and now
// also resync initial_margin from the wire (fix: frozen ROI/margin —
// without this, a DCA fill never grew positions.initial_margin, so ROI
// kept dividing by the position's *original* margin instead of the
// current one). Both use COALESCE to guard against an older engine
// build that might omit the field on the wire — falls back to leaving
// the column untouched rather than writing NULL over a valid value.
async function handleIncrease(msg) {
    await withTransaction(async (connection) => {
        const rows = await queryAsync(
            connection,
            `SELECT position_id, quantity, entry_price
             FROM positions
             WHERE user_id = ? AND symbol = ? AND position_side = ? AND status = 'OPEN'
             FOR UPDATE`,
            [msg.user_id, msg.symbol, msg.position_side]
        );
        const row = rows[0];
        if (!row) {
            console.error("futuresPersistence: INCREASE/DCA for unknown open position", msg);
            return;
        }

        const newQty = Number(row.quantity) + msg.fill_quantity;
        const newEntry = (Number(row.quantity) * Number(row.entry_price) + msg.fill_quantity * msg.fill_price) / newQty;

        await queryAsync(
            connection,
            `UPDATE positions
             SET quantity = ?, entry_price = ?, last_order_id = ?,
                 margin_mode = COALESCE(?, margin_mode),
                 initial_margin = COALESCE(?, initial_margin)
             WHERE position_id = ?`,
            [newQty, newEntry, msg.order_id || null, msg.margin_mode || null,
             msg.initial_margin ?? null, row.position_id]
        );
        await insertTradeRow(connection, row.position_id, msg, 'INCREASE');
    });
}

// DECREASE: partial exit. initial_margin now shrinks along with
// quantity (msg.initial_margin is the engine's post-fill value — see
// closeAgainst() in futures_engine.cpp, which reduces initial_margin
// proportionally on every partial close) instead of staying frozen at
// whatever it was set to on OPEN.
async function handleDecrease(msg) {
    await withTransaction(async (connection) => {
        const rows = await queryAsync(
            connection,
            `SELECT position_id, quantity
             FROM positions
             WHERE user_id = ? AND symbol = ? AND position_side = ? AND status = 'OPEN'
             FOR UPDATE`,
            [msg.user_id, msg.symbol, msg.position_side]
        );
        const row = rows[0];
        if (!row) {
            console.error("futuresPersistence: DECREASE for unknown open position", msg);
            return;
        }

        const newQty = Math.max(0, Number(row.quantity) - msg.fill_quantity);

        await queryAsync(
            connection,
            `UPDATE positions
             SET quantity = ?, initial_margin = ?, realized_pnl = realized_pnl + ?, last_order_id = ?
             WHERE position_id = ?`,
            [newQty, msg.initial_margin ?? 0, msg.realized_pnl, msg.order_id || null, row.position_id]
        );
        await insertTradeRow(connection, row.position_id, msg, 'DECREASE');

        await queryAsync(
            connection,
            `UPDATE futures_wallet SET wallet_balance = wallet_balance + ? WHERE wallet_id = ?`,
            [msg.realized_pnl, msg.wallet_id]
        );
    });
}

// CLOSE: full exit. `status = 'CLOSED'` already marks it closed
// everywhere the app checks (GET /api/futures/history filters on status
// IN ('CLOSED', 'LIQUIDATED')), so quantity is left untouched — history
// needs it. initial_margin is explicitly zeroed to match the engine's
// cleared position, same treatment as the full-liquidation branch above.
async function handleClose(msg) {
    await withTransaction(async (connection) => {
        const rows = await queryAsync(
            connection,
            `SELECT position_id FROM positions
             WHERE user_id = ? AND symbol = ? AND position_side = ? AND status = 'OPEN'
             FOR UPDATE`,
            [msg.user_id, msg.symbol, msg.position_side]
        );
        const row = rows[0];
        if (!row) {
            console.error("futuresPersistence: CLOSE for unknown open position", msg);
            return;
        }

        await queryAsync(
            connection,
            `UPDATE positions
             SET status = 'CLOSED', initial_margin = 0,
                 realized_pnl = realized_pnl + ?, last_order_id = ?, closed_at = NOW()
             WHERE position_id = ?`,
            [msg.realized_pnl, msg.order_id || null, row.position_id]
        );
        await insertTradeRow(connection, row.position_id, msg, 'CLOSE');

        await queryAsync(
            connection,
            `UPDATE futures_wallet SET wallet_balance = wallet_balance + ? WHERE wallet_id = ?`,
            [msg.realized_pnl, msg.wallet_id]
        );
    });
}

// One row per fill. Matches the real futures_trades columns: price
// (not entry_price/exit_price) and position_side/position_action are
// both NOT NULL on that table.
//
// KNOWN SCHEMA GAP: futures_trades.order_id is NOT NULL with an
// ON DELETE RESTRICT FK to futures_orders(order_id). A TP/SL-triggered
// close is NOT tied to any Node order row — the C++ engine sends
// db_order_id = 0 for those (see AccountManager::checkRisk's comment in
// futures_engine.cpp: "not tied to a specific Node order row — TP/SL
// fires from the position"). Inserting order_id = 0 would violate the
// FK (no such row exists) and throw, which — same as the wallet_id bug
// fixed in an earlier revision — would silently roll back the whole
// transaction and drop the fill from history.
//
// Until the schema is migrated to make futures_trades.order_id nullable
// (recommended: `order_id BIGINT NULL` + swap the FK to ON DELETE SET
// NULL), this fill is still applied to `positions` (quantity/status/
// realized_pnl/initial_margin all get updated correctly by the caller)
// but the per-fill futures_trades row is skipped for TP/SL closes
// specifically, with a console.warn so it's visible rather than
// silently lost.
async function insertTradeRow(connection, positionId, msg, positionAction) {
    if (!msg.order_id) {
        console.warn(
            "futuresPersistence: skipping futures_trades row for TP/SL-triggered fill " +
            "(order_id=0, no matching futures_orders row — see KNOWN SCHEMA GAP note above)",
            { positionId, symbol: msg.symbol, position_side: msg.position_side, trigger: msg.trigger }
        );
        return;
    }

    await queryAsync(
        connection,
        `INSERT INTO futures_trades
            (position_id, order_id, user_id, symbol, position_side, position_action,
             quantity, price, realized_pnl, commission)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [positionId, msg.order_id, msg.user_id, msg.symbol, msg.position_side, positionAction,
         msg.fill_quantity, msg.fill_price, msg.realized_pnl || 0, msg.commission || 0]
    );
}

module.exports = { attachPersistenceHandlers };