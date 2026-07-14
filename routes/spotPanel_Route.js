const express = require("express");
const path = require("path");
const router = express.Router();

// Same db module used across the app (authRoutes.js, walletRoutes.js …)
const { conn } = require("../db_connection");

// Same auth middleware used by /dashboard, /funding-wallet, etc. — sets req.user.id from the JWT cookie.
const verifyToken = require("../middle/middleware");

// TCP client for the C++ CryptoTrade engine (see engine/trade_engine.cpp).
// engineClient.js owns ONE shared, persistent TCP connection for the whole
// process — every call to sendOrderToEngine() below reuses it, regardless
// of which user's request triggered it. No connection is opened per order.
const { sendOrderToEngine } = require("../Spot_Engine/engineClient");

function sendResponse(res, statusCode, success, message, data = null) {
    return res.status(statusCode).json({ success, message, data });
}

/* ═══════════════════════════════════════════════════════════════════════
   SUPPORTED SYMBOLS
   ───────────────────────────────────────────────────────────────────────
   Must stay in sync with the TRADE_COINS list in spot_trade.html. Anything
   not in this list is rejected before we even bother hitting Binance.
   ═══════════════════════════════════════════════════════════════════════ */
const SUPPORTED_SYMBOLS = ["BTC", "ETH", "BNB", "SOL", "XRP", "USDC"];

/* ═══════════════════════════════════════════════════════════════════════
   LIVE MARKET PRICE (server-side, never trusted from the client)
   ───────────────────────────────────────────────────────────────────────
   All price-direction checks (LIMIT vs market, TP/SL vs entry) are
   validated against a price WE fetch, not whatever the frontend happened
   to have cached in its WebSocket feed. This is what keeps a client from
   spoofing a favorable price to force a bad TP/SL through.
   ═══════════════════════════════════════════════════════════════════════ */
async function getMarketPrice(symbol) {
    const url = `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}USDT`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Binance responded with status ${r.status}`);
    const data = await r.json();
    const price = parseFloat(data.price);
    if (!price || isNaN(price)) throw new Error("Binance returned an invalid price");
    return price;
}

/* ═══════════════════════════════════════════════════════════════════════
   ORDER VALIDATION — the full checklist
   ───────────────────────────────────────────────────────────────────────
   ✓ Request format is valid
   ✓ Trading symbol exists
   ✓ Quantity > 0
   ✓ LIMIT order must have a limit price / MARKET must not
   ✓ TP > 0 (if provided), SL > 0 (if provided)
   ✓ BUY MARKET  : TP > entry, SL < entry            (entry = market price)
   ✓ BUY LIMIT   : limit < market, TP > limit, SL < limit
   ✓ SELL MARKET : TP < entry, SL > entry             (entry = market price)
   ✓ SELL LIMIT  : limit > market, TP < limit, SL > limit
   Returns { valid, errors[], normalized } — normalized is the clean,
   type-coerced packet that gets forwarded to the engine on success.
   ═══════════════════════════════════════════════════════════════════════ */
function validateOrderRequest(body, marketPrice) {
    const errors = [];

    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return { valid: false, errors: ["Malformed request body"] };
    }

    const { symbol, side, order_type, quantity, limit_price, take_profit_price, stop_loss_price } = body;

    if (!symbol || typeof symbol !== "string") errors.push("Symbol is required");
    if (side !== "BUY" && side !== "SELL") errors.push("Side must be BUY or SELL");
    if (order_type !== "MARKET" && order_type !== "LIMIT") errors.push("Order type must be MARKET or LIMIT");

    // Can't safely check anything symbol/side/type-dependent below without these
    if (errors.length) return { valid: false, errors };

    const upperSymbol = symbol.toUpperCase();
    if (!SUPPORTED_SYMBOLS.includes(upperSymbol)) {
        errors.push(`Symbol '${upperSymbol}' is not supported for trading`);
    }

    const qty = parseFloat(quantity);
    if (quantity === undefined || quantity === null || isNaN(qty) || qty <= 0) {
        errors.push("Quantity must be a number greater than 0");
    }

    let limitPrice = null;
    if (order_type === "LIMIT") {
        limitPrice = parseFloat(limit_price);
        if (limit_price === undefined || limit_price === null || isNaN(limitPrice) || limitPrice <= 0) {
            errors.push("LIMIT orders require a limit_price greater than 0");
        }
    } else {
        // MARKET orders must not carry a limit price at all
        if (limit_price !== undefined && limit_price !== null && limit_price !== "") {
            errors.push("MARKET orders must not include a limit_price");
        }
    }

    let tp = null;
    if (take_profit_price !== undefined && take_profit_price !== null && take_profit_price !== "") {
        tp = parseFloat(take_profit_price);
        if (isNaN(tp) || tp <= 0) errors.push("take_profit_price must be greater than 0");
    }

    let sl = null;
    if (stop_loss_price !== undefined && stop_loss_price !== null && stop_loss_price !== "") {
        sl = parseFloat(stop_loss_price);
        if (isNaN(sl) || sl <= 0) errors.push("stop_loss_price must be greater than 0");
    }

    // Stop here if the basic shape is already broken — directional checks
    // below assume limitPrice/tp/sl are valid numbers when not null.
    if (errors.length) return { valid: false, errors };

    const entryPrice = order_type === "MARKET" ? marketPrice : limitPrice;

    if (side === "BUY" && order_type === "MARKET") {
        if (tp !== null && tp <= entryPrice) errors.push(`Take profit must be above the market entry price (${entryPrice})`);
        if (sl !== null && sl >= entryPrice) errors.push(`Stop loss must be below the market entry price (${entryPrice})`);
    } else if (side === "BUY" && order_type === "LIMIT") {
        if (limitPrice >= marketPrice) errors.push(`Buy limit price must be below the current market price (${marketPrice})`);
        if (tp !== null && tp <= limitPrice) errors.push(`Take profit must be above the limit price (${limitPrice})`);
        if (sl !== null && sl >= limitPrice) errors.push(`Stop loss must be below the limit price (${limitPrice})`);
    } else if (side === "SELL" && order_type === "MARKET") {
        if (tp !== null && tp >= entryPrice) errors.push(`Take profit must be below the market entry price (${entryPrice})`);
        if (sl !== null && sl <= entryPrice) errors.push(`Stop loss must be above the market entry price (${entryPrice})`);
    } else if (side === "SELL" && order_type === "LIMIT") {
        if (limitPrice <= marketPrice) errors.push(`Sell limit price must be above the current market price (${marketPrice})`);
        if (tp !== null && tp >= limitPrice) errors.push(`Take profit must be below the limit price (${limitPrice})`);
        if (sl !== null && sl <= limitPrice) errors.push(`Stop loss must be above the limit price (${limitPrice})`);
    }

    if (errors.length) return { valid: false, errors };

    return {
        valid: true,
        errors: [],
        normalized: {
            symbol: upperSymbol,
            side,
            order_type,
            quantity: qty,
            limit_price: limitPrice,
            take_profit_price: tp,
            stop_loss_price: sl,
            entry_price_reference: entryPrice,
            market_price_reference: marketPrice,
        },
    };
}

/* ═══════════════════════════════════════════════════════════════════════
   PAGES
   ═══════════════════════════════════════════════════════════════════════ */
router.get("/spot-trade", verifyToken, (req, res) => {
    res.sendFile(path.join(__dirname, "../Frontend/TradePanels_UI/spot_trade.html"));
});

/* ═══════════════════════════════════════════════════════════════════════
   SPOT WALLET  (GET /api/spot/wallet)
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
   ═══════════════════════════════════════════════════════════════════════ */
router.get("/api/spot/orders", verifyToken, (req, res) => {
    const userId = req.user.id;

    conn.query(
        `SELECT order_id, symbol, side, order_type, quantity, remaining_quantity,
                limit_price, take_profit_price, stop_loss_price, status, created_at
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
                take_profit_price: o.take_profit_price !== null ? parseFloat(o.take_profit_price) : null,
                stop_loss_price: o.stop_loss_price !== null ? parseFloat(o.stop_loss_price) : null,
                status: o.status,
                created_at: o.created_at,
            }));

            return sendResponse(res, 200, true, "Open orders loaded", orders);
        }
    );
});

/* ═══════════════════════════════════════════════════════════════════════
   ORDER BOOK  (GET /api/spot/orderbook?symbol=BTC)
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
   PLACE ORDER  (POST /api/spot/order)
   ───────────────────────────────────────────────────────────────────────
   Flow:
     1. verifyToken already confirmed the JWT — req.user.id is trusted.
     2. Fetch a fresh, server-side market price for the requested symbol.
     3. Run the full validation checklist against that price.
     4. On failure -> 400 with a list of every violated rule.
     5. On success -> look up the caller's spot wallet, build the engine
        packet from the *normalized* data (never the raw client body),
        and hand it off to the C++ engine over TCP.
   Note: there is no DB insert here anymore — persistence now happens on
   the engine side (or a later step), once matching/fills are wired up.
   This layer's job is: validate, look up the wallet, forward to engine,
   relay the engine's decision back to the client.
   ═══════════════════════════════════════════════════════════════════════ */
router.post("/api/spot/order", verifyToken, async (req, res) => {
    const userId = req.user.id;
    const symbolInput = req.body && req.body.symbol;

    if (!symbolInput || typeof symbolInput !== "string") {
        return sendResponse(res, 400, false, "Order validation failed", { errors: ["Symbol is required"] });
    }

    const upperSymbol = symbolInput.toUpperCase();
    if (!SUPPORTED_SYMBOLS.includes(upperSymbol)) {
        return sendResponse(res, 400, false, "Order validation failed", {
            errors: [`Symbol '${upperSymbol}' is not supported for trading`],
        });
    }

    let marketPrice;
    try {
        marketPrice = await getMarketPrice(upperSymbol);
    } catch (e) {
        return sendResponse(res, 502, false, "Could not fetch a live market price right now. Please try again.");
    }

    const validation = validateOrderRequest(req.body, marketPrice);
    if (!validation.valid) {
        return sendResponse(res, 400, false, "Order validation failed", { errors: validation.errors });
    }

    const packet = validation.normalized;

    conn.query("SELECT wallet_id, status FROM spot_wallet WHERE user_id = ?", [userId], async (err, walletRows) => {
        if (err) return sendResponse(res, 500, false, "Database error");
        if (!walletRows.length) return sendResponse(res, 404, false, "Spot wallet not found");

        const wallet = walletRows[0];
        if (wallet.status !== "ACTIVE") return sendResponse(res, 403, false, "Spot wallet is blocked");

        // Enriched packet for the engine — only order-relevant fields, no
        // price-reference/audit fields it doesn't need to act on.
        // sendOrderToEngine() adds a request_id and writes this onto the
        // one shared connection; it does NOT open a new socket per order.
        const enginePacket = {
            action: "PLACE_ORDER",
            user_id: userId,
            wallet_id: wallet.wallet_id,
            symbol: packet.symbol,
            side: packet.side,
            order_type: packet.order_type,
            quantity: packet.quantity,
            limit_price: packet.limit_price,
            take_profit_price: packet.take_profit_price,
            stop_loss_price: packet.stop_loss_price,
        };

        try {
            const engineReply = await sendOrderToEngine(enginePacket);

            if (!engineReply.accepted) {
                return sendResponse(res, 400, false, "Order rejected by trade engine", {
                    errors: engineReply.errors || [],
                });
            }

            return sendResponse(res, 200, true, "Order validated and sent to trade engine", {
                engine_order_id: engineReply.engine_order_id,
                wallet_id: wallet.wallet_id,
                symbol: packet.symbol,
                side: packet.side,
                order_type: packet.order_type,
                quantity: packet.quantity,
                limit_price: packet.limit_price,
                take_profit_price: packet.take_profit_price,
                stop_loss_price: packet.stop_loss_price,
                entry_price_reference: packet.entry_price_reference,
                market_price_reference: packet.market_price_reference,
                status: "SENT_TO_ENGINE",
            });
        } catch (engineErr) {
            return sendResponse(res, 502, false, `Trade engine unavailable: ${engineErr.message}`);
        }
    });
});

/* ═══════════════════════════════════════════════════════════════════════
   CANCEL ORDER  (POST /api/spot/order/:order_id/cancel)
   ═══════════════════════════════════════════════════════════════════════ */
router.post("/api/spot/order/:order_id/cancel", verifyToken, (req, res) => {
    const userId = req.user.id;
    const orderId = req.params.order_id;

    conn.query(
        "SELECT order_id, status FROM spot_orders WHERE order_id = ? AND user_id = ?",
        [orderId, userId],
        (err, rows) => {
            if (err) return sendResponse(res, 500, false, "Database error");
            if (!rows.length) return sendResponse(res, 404, false, "Order not found");

            const order = rows[0];
            if (order.status !== "OPEN" && order.status !== "PARTIALLY_FILLED") {
                return sendResponse(res, 400, false, `Order cannot be cancelled — current status is ${order.status}`);
            }

            conn.query(
                "UPDATE spot_orders SET status = 'CANCELLED' WHERE order_id = ? AND user_id = ?",
                [orderId, userId],
                (updateErr) => {
                    if (updateErr) return sendResponse(res, 500, false, "Database error while cancelling order");
                    return sendResponse(res, 200, true, "Order cancelled", { order_id: orderId });
                }
            );
        }
    );
});

module.exports = router;

/* ═══════════════════════════════════════════════════════════════════════
   WIRE-UP (in your main server file, next to the other routers):

     const spotTradeRoutes = require("./routes/spotTradeRoutes");
     app.use("/", spotTradeRoutes);

   Adjust the require path/folder name to match where you save this file.
   engineClient.js must sit next to this file (or update the require path).

   Requires Node 18+ for the global `fetch` used in getMarketPrice(). If
   you're on an older Node version, swap it for node-fetch or axios.

   Requires the C++ engine (trade_engine.cpp) running and reachable at
   TRADE_ENGINE_HOST:TRADE_ENGINE_PORT (defaults to 127.0.0.1:9000).
   ═══════════════════════════════════════════════════════════════════════ */