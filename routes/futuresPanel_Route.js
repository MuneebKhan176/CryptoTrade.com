// futuresPanel_Route.js
const express = require("express");
const path = require("path");
const router = express.Router();

// Same db module used across the app (authRoutes.js, walletRoutes.js, spotTradeRoutes.js …)
const { conn } = require("../db_connection");

// Same auth middleware used by /dashboard, /funding-wallet, /spot-trade, etc.
const verifyToken = require("../middle/middleware");

// NEW — live margin merge + engine client, for the wallet fix and the
// three previously-stubbed trading endpoints below.
const { getMergedFuturesWallet } = require("../Futures_Engine/futuresWalletMerge");
const { sendOrderToEngine, cancelOrderOnEngine } = require("../Futures_Engine/futuresEngineClient");

function sendResponse(res, statusCode, success, message, data = null) {
    return res.status(statusCode).json({ success, message, data });
}

function queryAsync(sql, params = []) {
    return new Promise((resolve, reject) => {
        conn.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
    });
}

// ── Symbol normalization ────────────────────────────────────────────
// Every row in futures_orders / futures_trades / positions is stored
// with the FULL trading-pair symbol ("BTCUSDT", "ETHUSDT", ...) — see
// POST /api/futures/order below, which builds `fullSymbol =
// symbol.toUpperCase() + "USDT"` before inserting.
//
// The frontend, however, calls the read-only market endpoints
// (orderbook, trades) with just the bare coin ticker from
// TRADE_COINS — e.g. `?symbol=BTC`, not `?symbol=BTCUSDT`. Comparing
// that raw value directly against the `symbol` column (`WHERE symbol
// = 'BTC'`) can never match a row stored as `'BTCUSDT'`, so those two
// endpoints always returned zero rows regardless of how much data
// existed — that's what made the Order Book and Recent Trades panes
// look permanently empty. This helper normalizes either form
// ("BTC" or "BTCUSDT") to the full pair symbol before it hits SQL.
function toFullSymbol(raw) {
    const s = (raw || "").toUpperCase().trim();
    if (!s) return "";
    return s.endsWith("USDT") ? s : s + "USDT";
}

/* ═══════════════════════════════════════════════════════════════════════
   PAGE
   ═══════════════════════════════════════════════════════════════════════ */
router.get("/futures-trade", verifyToken, (req, res) => {
    res.sendFile(path.join(__dirname, "../Frontend/TradePanels_UI/futures_trade.html"));
});

/* ═══════════════════════════════════════════════════════════════════════
   FUTURES WALLET  (GET /api/futures/wallet)
   ═══════════════════════════════════════════════════════════════════════ */
router.get("/api/futures/wallet", verifyToken, async (req, res) => {
    try {
        const wallet = await getMergedFuturesWallet(req.user.id);
        if (!wallet) return sendResponse(res, 404, false, "Futures wallet not found");

        return sendResponse(res, 200, true, "Futures wallet loaded", {
            wallet_id: wallet.walletId,
            wallet_balance: wallet.walletBalance,
            available_margin: wallet.availableMargin,
            used_margin: wallet.usedMargin,
            margin_ratio: wallet.marginRatio,
            status: wallet.status,
            live: wallet.live,
        });
    } catch (err) {
        console.error("GET /api/futures/wallet error:", err);
        return sendResponse(res, 500, false, "Database error");
    }
});

/* ═══════════════════════════════════════════════════════════════════════
   OPEN POSITIONS  (GET /api/futures/positions)

   FIX (earlier revision): `positions` has no `order_id` column (it's
   `last_order_id`) and `margin_mode` lives directly on `positions` — no
   join onto `futures_orders` needed.

   FIX (this revision): now also SELECTs `initial_margin`. It was never
   read here even though the column now exists and is written by
   futures_Persistence.js — the frontend's ROI/margin math
   (unrealized_pnl / initial_margin) was silently dividing by
   `undefined` because this endpoint just never sent the field.

   `liquidation_price` is intentionally NOT selected here — it's not a
   column on `positions` in this schema (it's tick-driven, recomputed by
   the engine and cached in LiveStateStore, not persisted — see that
   file's header). The frontend should read it from the WebSocket
   snapshot/liveTick, not this REST response.
   ═══════════════════════════════════════════════════════════════════════ */
router.get("/api/futures/positions", verifyToken, (req, res) => {
    const userId = req.user.id;

    conn.query(
        `SELECT position_id, last_order_id AS order_id, symbol, position_side, margin_mode,
                quantity, entry_price, leverage, initial_margin, take_profit, stop_loss,
                realized_pnl, status, opened_at
         FROM positions
         WHERE user_id = ? AND status = 'OPEN'
         ORDER BY opened_at DESC`,
        [userId],
        (err, result) => {
            if (err) {
                console.error("GET /api/futures/positions error:", err);
                return sendResponse(res, 500, false, "Database error");
            }

            const positions = result.map(p => ({
                position_id: p.position_id,
                order_id: p.order_id,
                symbol: p.symbol,
                position_side: p.position_side,
                quantity: parseFloat(p.quantity),
                entry_price: parseFloat(p.entry_price),
                leverage: p.leverage,
                margin_mode: p.margin_mode,
                initial_margin: p.initial_margin != null ? parseFloat(p.initial_margin) : null,
                take_profit: p.take_profit !== null ? parseFloat(p.take_profit) : null,
                stop_loss: p.stop_loss !== null ? parseFloat(p.stop_loss) : null,
                realized_pnl: parseFloat(p.realized_pnl),
                status: p.status,
                opened_at: p.opened_at,
            }));

            return sendResponse(res, 200, true, "Open positions loaded", positions);
        }
    );
});

/* ═══════════════════════════════════════════════════════════════════════
   OPEN ORDERS  (GET /api/futures/orders)

   FIX: this is a demo exchange — there's no real order-matching against
   other users, so a MARKET order is always filled in full the instant
   the engine accepts it (see AccountManager::applyFill /
   SymbolBook::placeOrder's MARKET branch, which fills synchronously at
   the current reference price with no book interaction at all). A
   MARKET order is therefore never, even momentarily, a real "open"
   order — it should only ever surface later as a fill in Recent Trades.
   `AND order_type = 'LIMIT'` makes that explicit and guarantees it here
   regardless of whatever transient status a MARKET row might carry in
   futures_orders (see the POST /api/futures/order fix below, which also
   stops writing MARKET rows as 'OPEN' in the first place).
   ═══════════════════════════════════════════════════════════════════════ */
router.get("/api/futures/orders", verifyToken, (req, res) => {
    const userId = req.user.id;

    conn.query(
        `SELECT order_id, symbol, side, order_type, quantity, remaining_quantity,
                limit_price, leverage, margin_mode, position_side, reduce_only,
                take_profit, stop_loss, status, created_at
         FROM futures_orders
         WHERE user_id = ? AND order_type = 'LIMIT' AND status IN ('OPEN', 'PARTIALLY_FILLED')
         ORDER BY created_at DESC`,
        [userId],
        (err, result) => {
            if (err) return sendResponse(res, 500, false, "Database error");

            const orders = result.map(o => ({
                order_id: o.order_id,
                symbol: o.symbol,
                side: o.side,
                order_type: o.order_type,
                quantity: parseFloat(o.quantity),
                remaining_quantity: parseFloat(o.remaining_quantity),
                limit_price: o.limit_price !== null ? parseFloat(o.limit_price) : null,
                leverage: o.leverage,
                margin_mode: o.margin_mode,
                position_side: o.position_side,
                reduce_only: !!o.reduce_only,
                take_profit: o.take_profit !== null ? parseFloat(o.take_profit) : null,
                stop_loss: o.stop_loss !== null ? parseFloat(o.stop_loss) : null,
                status: o.status,
                created_at: o.created_at,
            }));

            return sendResponse(res, 200, true, "Open futures orders loaded", orders);
        }
    );
});

/* ═══════════════════════════════════════════════════════════════════════
   HISTORY  (GET /api/futures/history)

   FIX: same broken join as /api/futures/positions above
   (`positions.order_id` doesn't exist) — dropped for the same reason.
   `margin_mode` now comes straight off `positions`. `liquidation_price`
   dropped for the same reason as above (not a persisted column here) —
   for a CLOSED/LIQUIDATED row you likely want the *historical* price at
   the moment of liquidation instead, which now lives in the
   `liquidations` table (see futures_Persistence.js) — join that in
   separately if/when you build a dedicated liquidation-history view.
   ═══════════════════════════════════════════════════════════════════════ */
router.get("/api/futures/history", verifyToken, (req, res) => {
    const userId = req.user.id;

    conn.query(
        `SELECT position_id, last_order_id AS order_id, symbol, position_side, margin_mode,
                quantity, entry_price, leverage, realized_pnl, status, opened_at, closed_at
         FROM positions
         WHERE user_id = ? AND status IN ('CLOSED', 'LIQUIDATED')
         ORDER BY closed_at DESC
         LIMIT 50`,
        [userId],
        (err, result) => {
            if (err) {
                console.error("GET /api/futures/history error:", err);
                return sendResponse(res, 500, false, "Database error");
            }

            const closed = result.map(p => ({
                position_id: p.position_id,
                order_id: p.order_id,
                symbol: p.symbol,
                position_side: p.position_side,
                quantity: parseFloat(p.quantity),
                entry_price: parseFloat(p.entry_price),
                leverage: p.leverage,
                margin_mode: p.margin_mode,
                realized_pnl: parseFloat(p.realized_pnl),
                status: p.status,
                opened_at: p.opened_at,
                closed_at: p.closed_at,
            }));

            return sendResponse(res, 200, true, "Position history loaded", closed);
        }
    );
});

/* ═══════════════════════════════════════════════════════════════════════
   ORDER BOOK  (GET /api/futures/orderbook?symbol=BTC)

   FIX: normalize the incoming bare ticker ("BTC") to the full pair
   symbol ("BTCUSDT") before querying — futures_orders.symbol is always
   stored in the full-pair form (see POST /api/futures/order). Without
   this, `WHERE symbol = 'BTC'` could never match any row and the book
   was always empty.
   ═══════════════════════════════════════════════════════════════════════ */
router.get("/api/futures/orderbook", verifyToken, (req, res) => {
    const symbol = toFullSymbol(req.query.symbol);
    if (!symbol) return sendResponse(res, 400, false, "Missing symbol query param");

    const bookQuery = `
        SELECT side, limit_price, SUM(remaining_quantity) AS total_qty
        FROM futures_orders
        WHERE symbol = ?
          AND order_type = 'LIMIT'
          AND status IN ('OPEN', 'PARTIALLY_FILLED')
          AND limit_price IS NOT NULL
        GROUP BY side, limit_price
        ORDER BY limit_price DESC
    `;

    conn.query(bookQuery, [symbol], (err, rows) => {
        if (err) return sendResponse(res, 500, false, "Database error");

        const bids = rows
            .filter(r => r.side === "BUY")
            .map(r => [parseFloat(r.limit_price), parseFloat(r.total_qty)]);

        const asks = rows
            .filter(r => r.side === "SELL")
            .map(r => [parseFloat(r.limit_price), parseFloat(r.total_qty)]);

        return sendResponse(res, 200, true, "Futures order book loaded", { symbol, bids, asks });
    });
});

/* ═══════════════════════════════════════════════════════════════════════
   RECENT TRADES  (GET /api/futures/trades?symbol=BTC)

   FIX: same symbol normalization as the order book above, PLUS the
   query itself was broken independently of that — it selected
   `ft.entry_price` and ordered by `ft.opened_at`, neither of which
   exists on `futures_trades` (that table has `price` and
   `executed_at` — see the CREATE TABLE). That's what produced the 500
   on this endpoint even before symbol normalization was fixed. `side`
   is still read from `futures_orders` (futures_trades doesn't carry a
   raw BUY/SELL side, only position_side + position_action), joined on
   the real `order_id` FK.
   ═══════════════════════════════════════════════════════════════════════ */
router.get("/api/futures/trades", verifyToken, (req, res) => {
    const symbol = toFullSymbol(req.query.symbol);
    if (!symbol) return sendResponse(res, 400, false, "Missing symbol query param");

    conn.query(
        `SELECT ft.price AS price, ft.quantity AS quantity, ft.position_side, ft.position_action,
                fo.side AS side
         FROM futures_trades ft
         JOIN futures_orders fo ON fo.order_id = ft.order_id
         WHERE ft.symbol = ?
         ORDER BY ft.executed_at DESC
         LIMIT 20`,
        [symbol],
        (err, rows) => {
            if (err) {
                console.error("GET /api/futures/trades error:", err);
                return sendResponse(res, 500, false, "Database error");
            }

            const trades = rows.map(t => ({
                side: t.side,
                position_side: t.position_side,
                position_action: t.position_action,
                price: parseFloat(t.price),
                quantity: parseFloat(t.quantity),
            }));

            return sendResponse(res, 200, true, "Recent trades loaded", trades);
        }
    );
});

/* ═══════════════════════════════════════════════════════════════════════
   TRADING ENGINE
   ═══════════════════════════════════════════════════════════════════════ */
router.post("/api/futures/order", verifyToken, async (req, res) => {
    try {
        const {
            symbol, side, order_type, quantity, limit_price, leverage,
            margin_mode, position_side, take_profit, stop_loss, reduce_only,
        } = req.body;

        if (!symbol || !side || !order_type || !quantity || !leverage || !margin_mode || !position_side) {
            return sendResponse(res, 400, false, "Missing required order fields.");
        }

        const fullSymbol = toFullSymbol(symbol);
        const wallet = await getMergedFuturesWallet(req.user.id);
        if (!wallet) return sendResponse(res, 404, false, "No futures wallet found for this account.");

        // FIX: wallet_id is a NOT NULL column on futures_orders with no
        // default — it was missing from this INSERT entirely, which is
        // what threw "Field 'wallet_id' doesn't have a default value".
        //
        // FIX: MARKET orders no longer get written as 'OPEN'. This is a
        // demo exchange — there's no counterparty matching, so a MARKET
        // order always fills in full the moment the engine accepts it
        // (see the comment on GET /api/futures/orders above). Writing it
        // as 'OPEN' first and only fixing the status later (once the
        // async EXECUTION event from the engine gets persisted) created a
        // real window — and on any hiccup in that async path, a
        // permanent one — where a market order sat in futures_orders
        // looking exactly like a resting order, which is what was
        // leaking into the Open Orders tab. LIMIT orders are unaffected
        // and still start life as 'OPEN', since they genuinely do rest
        // on the book until matched or cancelled.
        const isMarket = order_type === "MARKET";
        const initialStatus = isMarket ? "FILLED" : "OPEN";
        const initialRemaining = isMarket ? 0 : quantity;

        const insertResult = await queryAsync(
            `INSERT INTO futures_orders
                (user_id, wallet_id, symbol, side, order_type, position_side, margin_mode,
                 leverage, quantity, remaining_quantity, limit_price, reduce_only,
                 take_profit, stop_loss, status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
            [req.user.id, wallet.walletId, fullSymbol, side, order_type, position_side, margin_mode,
             leverage, quantity, initialRemaining, limit_price || null, !!reduce_only,
             take_profit || null, stop_loss || null, initialStatus]
        );
        const orderId = insertResult.insertId;

        let ackResult;
        try {
            ackResult = await sendOrderToEngine({
                order_id: orderId,
                user_id: req.user.id,
                wallet_id: wallet.walletId,
                symbol: fullSymbol,
                side,
                order_type,
                quantity,
                limit_price: limit_price || undefined,
                leverage,
                margin_mode,
                position_side,
                position_mode: "ONE_WAY",
                reduce_only: !!reduce_only,
                take_profit: take_profit || undefined,
                stop_loss: stop_loss || undefined,
                wallet_balance: wallet.walletBalance,
            });
        } catch (engineErr) {
            await queryAsync(`UPDATE futures_orders SET status = 'REJECTED' WHERE order_id = ?`, [orderId]);
            return sendResponse(res, 502, false, engineErr.message || "Futures engine unavailable.");
        }

        if (!ackResult.ack.accepted) {
            await queryAsync(`UPDATE futures_orders SET status = 'REJECTED' WHERE order_id = ?`, [orderId]);
            return sendResponse(res, 400, false, ackResult.ack.message || "Order rejected by the engine.", {
                errors: ackResult.ack.errors || [],
            });
        }

        return sendResponse(res, 200, true, "Order accepted.", {
            order_id: orderId,
            engine_order_id: ackResult.ack.engine_order_id,
        });
    } catch (err) {
        console.error("POST /api/futures/order error:", err);
        return sendResponse(res, 500, false, err.message || "Could not place order.");
    }
});

router.post("/api/futures/order/:order_id/cancel", verifyToken, async (req, res) => {
    try {
        const orderId = parseInt(req.params.order_id, 10);
        const rows = await queryAsync(
            `SELECT symbol FROM futures_orders
             WHERE order_id = ? AND user_id = ? AND status IN ('OPEN', 'PARTIALLY_FILLED')`,
            [orderId, req.user.id]
        );
        const row = rows[0];
        if (!row) return sendResponse(res, 404, false, "Order not found or already closed.");

        const ack = await cancelOrderOnEngine(orderId, row.symbol);
        if (ack.cancelled) {
            await queryAsync(`UPDATE futures_orders SET status = 'CANCELLED' WHERE order_id = ?`, [orderId]);
        }
        return sendResponse(res, 200, !!ack.cancelled, ack.message);
    } catch (err) {
        console.error("POST /api/futures/order/:order_id/cancel error:", err);
        return sendResponse(res, 500, false, err.message || "Could not cancel order.");
    }
});

router.post("/api/futures/position/:position_id/close", verifyToken, async (req, res) => {
    try {
        const positionId = parseInt(req.params.position_id, 10);
        const rows = await queryAsync(
            `SELECT * FROM positions WHERE position_id = ? AND user_id = ? AND status = 'OPEN'`,
            [positionId, req.user.id]
        );
        const pos = rows[0];
        if (!pos) return sendResponse(res, 404, false, "Position not found or already closed.");

        // FIX: margin_mode now lives directly on `positions` — the old
        // code fetched it via a lookup into futures_orders keyed off
        // `pos.order_id`, a column that doesn't exist on this table.
        const marginMode = pos.margin_mode || "ISOLATED";

        // FIX: wallet is now required, not optional — closing a position
        // always needs a real wallet_id for the INSERT below (same NOT
        // NULL column). Fail cleanly instead of reaching wallet.walletId
        // on a null further down.
        const wallet = await getMergedFuturesWallet(req.user.id);
        if (!wallet) return sendResponse(res, 404, false, "Futures wallet not found for this account.");

        const closeSide = pos.position_side === "LONG" ? "SELL" : "BUY";

        // FIX: same reasoning as POST /api/futures/order — this is
        // always a MARKET order (position closes execute immediately,
        // no matching), so it's written as already-filled rather than
        // 'OPEN'. It was never legitimate for a "Close Position" click
        // to show up in the Open Orders tab even for an instant.
        const insertResult = await queryAsync(
            `INSERT INTO futures_orders
                (user_id, wallet_id, symbol, side, order_type, position_side, margin_mode,
                 leverage, quantity, remaining_quantity, reduce_only, status, created_at)
             VALUES (?, ?, ?, ?, 'MARKET', ?, ?, ?, ?, 0, 1, 'FILLED', NOW())`,
            [req.user.id, wallet.walletId, pos.symbol, closeSide, pos.position_side, marginMode,
             pos.leverage, pos.quantity]
        );
        const orderId = insertResult.insertId;

        let ackResult;
        try {
            ackResult = await sendOrderToEngine({
                order_id: orderId,
                user_id: req.user.id,
                wallet_id: wallet.walletId,
                symbol: pos.symbol,
                side: closeSide,
                order_type: "MARKET",
                quantity: pos.quantity,
                leverage: pos.leverage,
                margin_mode: marginMode,
                position_side: pos.position_side,
                position_mode: "ONE_WAY",
                reduce_only: true,
                wallet_balance: wallet.walletBalance,
            });
        } catch (engineErr) {
            await queryAsync(`UPDATE futures_orders SET status = 'REJECTED' WHERE order_id = ?`, [orderId]);
            return sendResponse(res, 502, false, engineErr.message || "Futures engine unavailable.");
        }

        if (!ackResult.ack.accepted) {
            await queryAsync(`UPDATE futures_orders SET status = 'REJECTED' WHERE order_id = ?`, [orderId]);
            return sendResponse(res, 400, false, ackResult.ack.message || "Could not close position.");
        }

        return sendResponse(res, 200, true, "Close order submitted.");
    } catch (err) {
        console.error("POST /api/futures/position/:position_id/close error:", err);
        return sendResponse(res, 500, false, err.message || "Could not close position.");
    }
});

module.exports = router;