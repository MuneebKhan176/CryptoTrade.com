const express = require("express");
const path = require("path");
const router = express.Router();

// Same db module used across the app (authRoutes.js, walletRoutes.js …)
const { conn } = require("../db_connection");

// Same auth middleware used by /dashboard, /funding-wallet, etc. — sets req.user.id from the JWT cookie.
const verifyToken = require("../middle/middleware");

function sendResponse(res, statusCode, success, message, data = null) {
    return res.status(statusCode).json({ success, message, data });
}

/* ═══════════════════════════════════════════════════════════════════════
   PAGES
   ───────────────────────────────────────────────────────────────────────
   /spot-trade    -> serves spot_trade.html
   /futures-trade -> intentionally NOT defined here. Futures isn't built
                      yet, so hitting that route falls through to Express's
                      default 404 handler. Add its route/page in this file
                      once the futures page is ready.
   ═══════════════════════════════════════════════════════════════════════ */
router.get("/spot-trade", verifyToken, (req, res) => {
    res.sendFile(path.join(__dirname, "../Frontend/TradePanels_UI/spot_trade.html"));
});

/* ═══════════════════════════════════════════════════════════════════════
   SPOT WALLET  (GET /api/spot/wallet)
   ───────────────────────────────────────────────────────────────────────
   Returns the caller's spot_wallet row plus every spot_holdings row tied
   to it (symbol, available/locked qty, avg buy price). This is what
   spot_trade.html's loadWallet() renders into the Holdings tab and uses
   for balance checks / the % slider.
   ═══════════════════════════════════════════════════════════════════════ */
router.get("/api/spot/wallet", verifyToken, (req, res) => {
    const userId = req.user.id;

    conn.query(
        "SELECT wallet_id, status FROM spot_wallet WHERE user_id = ?",
        [userId],
        (err, walletResult) => {
            if (err) return sendResponse(res, 500, false, "Database error");
            if (!walletResult.length) return sendResponse(res, 404, false, "Spot wallet not found");

            const wallet = walletResult[0];

            conn.query(
                `SELECT symbol, available_quantity, locked_quantity, average_buy_price, total_cost
                 FROM spot_holdings
                 WHERE wallet_id = ?`,
                [wallet.wallet_id],
                (holdingsErr, holdingsResult) => {
                    if (holdingsErr) return sendResponse(res, 500, false, "Database error");

                    const holdings = holdingsResult.map(h => ({
                        symbol: h.symbol,
                        available_quantity: parseFloat(h.available_quantity),
                        locked_quantity: parseFloat(h.locked_quantity),
                        average_buy_price: parseFloat(h.average_buy_price),
                        total_cost: parseFloat(h.total_cost),
                    }));

                    return sendResponse(res, 200, true, "Spot wallet loaded", {
                        wallet_id: wallet.wallet_id,
                        status: wallet.status,
                        holdings,
                    });
                }
            );
        }
    );
});

/* ═══════════════════════════════════════════════════════════════════════
   OPEN ORDERS  (GET /api/spot/orders)
   ───────────────────────────────────────────────────────────────────────
   Returns the caller's own OPEN / PARTIALLY_FILLED spot_orders rows,
   newest first. Rendered in the "Open Orders" tab of the right column.
   ═══════════════════════════════════════════════════════════════════════ */
router.get("/api/spot/orders", verifyToken, (req, res) => {
    const userId = req.user.id;

    conn.query(
        `SELECT order_id, symbol, side, order_type, quantity, remaining_quantity,
                limit_price, status, created_at
         FROM spot_orders
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
                status: o.status,
                created_at: o.created_at,
            }));

            return sendResponse(res, 200, true, "Open orders loaded", orders);
        }
    );
});

/* ═══════════════════════════════════════════════════════════════════════
   ORDER BOOK  (GET /api/spot/orderbook?symbol=BTC)
   ───────────────────────────────────────────────────────────────────────
   Aggregates every OPEN / PARTIALLY_FILLED LIMIT order across ALL users
   for the given symbol into price-level bids/asks. MARKET orders have no
   limit_price so they're excluded — they never rest on the book.
   ═══════════════════════════════════════════════════════════════════════ */
router.get("/api/spot/orderbook", verifyToken, (req, res) => {
    const symbol = (req.query.symbol || "").toUpperCase();
    if (!symbol) return sendResponse(res, 400, false, "Missing symbol query param");

    const bookQuery = `
        SELECT side, limit_price, SUM(remaining_quantity) AS total_qty
        FROM spot_orders
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

        return sendResponse(res, 200, true, "Order book loaded", { symbol, bids, asks });
    });
});

/* ═══════════════════════════════════════════════════════════════════════
   TRADING ENGINE — NOT IMPLEMENTED HERE
   ───────────────────────────────────────────────────────────────────────
   spot_trade.html also calls POST /api/spot/order and
   POST /api/spot/order/:order_id/cancel. Matching, balance locking, and
   fill logic are out of scope for this file — these two stubs exist only
   so the frontend gets a clean, expected JSON shape instead of a raw
   404/HTML error page while the engine is being built.
   ═══════════════════════════════════════════════════════════════════════ */
router.post("/api/spot/order", verifyToken, (req, res) => {
    return sendResponse(res, 501, false, "Trading engine not implemented yet");
});

router.post("/api/spot/order/:order_id/cancel", verifyToken, (req, res) => {
    return sendResponse(res, 501, false, "Trading engine not implemented yet");
});

module.exports = router;

/* ═══════════════════════════════════════════════════════════════════════
   WIRE-UP (in your main server file, next to the other routers):

     const spotTradeRoutes = require("./routes/spotTradeRoutes");
     app.use("/", spotTradeRoutes);

   Adjust the require path/folder name to match where you save this file.
   ═══════════════════════════════════════════════════════════════════════ */