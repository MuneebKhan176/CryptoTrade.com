const express = require("express");
const path = require("path");
const router = express.Router();

// Same db module used across the app (authRoutes.js, walletRoutes.js, spotTradeRoutes.js …)
const { conn } = require("../db_connection");

// Same auth middleware used by /dashboard, /funding-wallet, /spot-trade, etc.
const verifyToken = require("../middle/middleware");

function sendResponse(res, statusCode, success, message, data = null) {
    return res.status(statusCode).json({ success, message, data });
}

/* ═══════════════════════════════════════════════════════════════════════
   SCHEMA NOTE
   ───────────────────────────────────────────────────────────────────────
   No database changes were required for this page. Every field the
   Futures Trading UI needs (leverage, margin_mode, position_side,
   take_profit, stop_loss, liquidation_price, realized_pnl, etc.) already
   exists on futures_orders / positions / futures_trades. futures_wallet
   is read-only here and is never altered, per spec.
   ═══════════════════════════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════════════════════════════
   PAGE
   ───────────────────────────────────────────────────────────────────────
   /futures-trade -> serves futures_trade.html (same folder as spot_trade.html)
   ═══════════════════════════════════════════════════════════════════════ */
router.get("/futures-trade", verifyToken, (req, res) => {
    res.sendFile(path.join(__dirname, "../Frontend/TradePanels_UI/futures_trade.html"));
});

/* ═══════════════════════════════════════════════════════════════════════
   FUTURES WALLET  (GET /api/futures/wallet)
   ───────────────────────────────────────────────────────────────────────
   Read-only. futures_wallet is never written to by this router — the
   task explicitly said not to modify that table.
   ═══════════════════════════════════════════════════════════════════════ */
router.get("/api/futures/wallet", verifyToken, (req, res) => {
    const userId = req.user.id;

    conn.query(
        `SELECT wallet_id, wallet_balance, available_margin, used_margin, status
         FROM futures_wallet
         WHERE user_id = ?`,
        [userId],
        (err, result) => {
            if (err) return sendResponse(res, 500, false, "Database error");
            if (!result.length) return sendResponse(res, 404, false, "Futures wallet not found");

            const w = result[0];
            return sendResponse(res, 200, true, "Futures wallet loaded", {
                wallet_id: w.wallet_id,
                wallet_balance: parseFloat(w.wallet_balance),
                available_margin: parseFloat(w.available_margin),
                used_margin: parseFloat(w.used_margin),
                status: w.status,
            });
        }
    );
});

/* ═══════════════════════════════════════════════════════════════════════
   OPEN POSITIONS  (GET /api/futures/positions)
   ───────────────────────────────────────────────────────────────────────
   The caller's OPEN positions, newest first. margin_mode isn't stored on
   `positions` directly, so it's pulled via the originating futures_orders
   row (positions.order_id -> futures_orders.order_id) — no schema change
   needed for that either.
   ═══════════════════════════════════════════════════════════════════════ */
router.get("/api/futures/positions", verifyToken, (req, res) => {
    const userId = req.user.id;

    conn.query(
        `SELECT p.position_id, p.order_id, p.symbol, p.position_side, p.quantity,
                p.entry_price, p.leverage, p.liquidation_price, p.take_profit,
                p.stop_loss, p.realized_pnl, p.status, p.opened_at,
                fo.margin_mode AS margin_mode
         FROM positions p
         JOIN futures_orders fo ON fo.order_id = p.order_id
         WHERE p.user_id = ? AND p.status = 'OPEN'
         ORDER BY p.opened_at DESC`,
        [userId],
        (err, result) => {
            if (err) return sendResponse(res, 500, false, "Database error");

            const positions = result.map(p => ({
                position_id: p.position_id,
                order_id: p.order_id,
                symbol: p.symbol,
                position_side: p.position_side,
                quantity: parseFloat(p.quantity),
                entry_price: parseFloat(p.entry_price),
                leverage: p.leverage,
                margin_mode: p.margin_mode,
                liquidation_price: p.liquidation_price !== null ? parseFloat(p.liquidation_price) : null,
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
   ───────────────────────────────────────────────────────────────────────
   The caller's own OPEN / PARTIALLY_FILLED futures_orders rows, including
   take_profit / stop_loss, as required by the Open Orders tab.
   ═══════════════════════════════════════════════════════════════════════ */
router.get("/api/futures/orders", verifyToken, (req, res) => {
    const userId = req.user.id;

    conn.query(
        `SELECT order_id, symbol, side, order_type, quantity, remaining_quantity,
                limit_price, leverage, margin_mode, position_side, reduce_only,
                take_profit, stop_loss, status, created_at
         FROM futures_orders
         WHERE user_id = ? AND status IN ('OPEN', 'PARTIALLY_FILLED')
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
   ───────────────────────────────────────────────────────────────────────
   The caller's CLOSED / LIQUIDATED positions, most recently closed first.
   Same row shape as /api/futures/positions so the frontend can reuse one
   render path.
   ═══════════════════════════════════════════════════════════════════════ */
router.get("/api/futures/history", verifyToken, (req, res) => {
    const userId = req.user.id;

    conn.query(
        `SELECT p.position_id, p.order_id, p.symbol, p.position_side, p.quantity,
                p.entry_price, p.leverage, p.liquidation_price, p.realized_pnl,
                p.status, p.opened_at, p.closed_at,
                fo.margin_mode AS margin_mode
         FROM positions p
         JOIN futures_orders fo ON fo.order_id = p.order_id
         WHERE p.user_id = ? AND p.status IN ('CLOSED', 'LIQUIDATED')
         ORDER BY p.closed_at DESC
         LIMIT 50`,
        [userId],
        (err, result) => {
            if (err) return sendResponse(res, 500, false, "Database error");

            const closed = result.map(p => ({
                position_id: p.position_id,
                order_id: p.order_id,
                symbol: p.symbol,
                position_side: p.position_side,
                quantity: parseFloat(p.quantity),
                entry_price: parseFloat(p.entry_price),
                leverage: p.leverage,
                margin_mode: p.margin_mode,
                liquidation_price: p.liquidation_price !== null ? parseFloat(p.liquidation_price) : null,
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
   ───────────────────────────────────────────────────────────────────────
   Same aggregation pattern as GET /api/spot/orderbook in
   spotTradeRoutes.js, run against futures_orders instead of spot_orders.
   MARKET orders have no limit_price so they're excluded — they never
   rest on the book.
   ═══════════════════════════════════════════════════════════════════════ */
router.get("/api/futures/orderbook", verifyToken, (req, res) => {
    const symbol = (req.query.symbol || "").toUpperCase();
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
   ───────────────────────────────────────────────────────────────────────
   Market-wide (not user-scoped) recent fills for the left-panel Recent
   Trades feed. futures_trades has no `side` column of its own, so it's
   joined back to futures_orders to get it. Per spec, no timestamp is
   returned to the client — price is the leading column instead.
   ═══════════════════════════════════════════════════════════════════════ */
router.get("/api/futures/trades", verifyToken, (req, res) => {
    const symbol = (req.query.symbol || "").toUpperCase();
    if (!symbol) return sendResponse(res, 400, false, "Missing symbol query param");

    conn.query(
        `SELECT ft.entry_price AS price, ft.quantity AS quantity, fo.side AS side
         FROM futures_trades ft
         JOIN futures_orders fo ON fo.order_id = ft.order_id
         WHERE ft.symbol = ?
         ORDER BY ft.opened_at DESC
         LIMIT 20`,
        [symbol],
        (err, rows) => {
            if (err) return sendResponse(res, 500, false, "Database error");

            const trades = rows.map(t => ({
                side: t.side,
                price: parseFloat(t.price),
                quantity: parseFloat(t.quantity),
            }));

            return sendResponse(res, 200, true, "Recent trades loaded", trades);
        }
    );
});

/* ═══════════════════════════════════════════════════════════════════════
   TRADING ENGINE — NOT IMPLEMENTED HERE
   ───────────────────────────────────────────────────────────────────────
   Same stance as spotTradeRoutes.js: futures_trade.html also calls
   POST /api/futures/order, POST /api/futures/order/:order_id/cancel, and
   POST /api/futures/position/:position_id/close. Matching, margin
   locking, liquidation monitoring, and fill logic are out of scope for
   this file — these stubs exist only so the frontend gets a clean,
   expected JSON shape instead of a raw 404/HTML error page while the
   engine is being built.
   ═══════════════════════════════════════════════════════════════════════ */
router.post("/api/futures/order", verifyToken, (req, res) => {
    return sendResponse(res, 501, false, "Trading engine not implemented yet");
});

router.post("/api/futures/order/:order_id/cancel", verifyToken, (req, res) => {
    return sendResponse(res, 501, false, "Trading engine not implemented yet");
});

router.post("/api/futures/position/:position_id/close", verifyToken, (req, res) => {
    return sendResponse(res, 501, false, "Trading engine not implemented yet");
});

module.exports = router;

/* ═══════════════════════════════════════════════════════════════════════
   WIRE-UP (in your main server file, next to spotTradeRoutes):

     const futuresTradeRoutes = require("./routes/futuresTradeRoutes");
     app.use("/", futuresTradeRoutes);

   Adjust the require path/folder name to match where you save this file.
   ═══════════════════════════════════════════════════════════════════════ */