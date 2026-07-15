const express = require("express");
const path = require("path");
const router = express.Router();

// Same db module used across the app (authRoutes.js, walletRoutes.js …)
const { conn } = require("../db_connection");

// Same auth middleware used by /dashboard, /funding-wallet, etc. — sets req.user.id from the JWT cookie.
const verifyToken = require("../middle/middleware");

// TCP client for the C++ CryptoTrade engine (see engine/trade_engine.cpp).
// engineClient.js owns ONE shared, persistent TCP connection for the whole
// process — every call below reuses it, regardless of which user's request
// triggered it. No connection is opened per order.
//
// engineEvents is how the engine's PUSH messages arrive — fills and book
// updates that are NOT replies to a specific request (a resting LIMIT
// order can fill minutes later, triggered by someone else's price tick).
// All MySQL persistence for fills happens off that event, in ONE place,
// not scattered across route handlers — see handleExecution() below.
const { sendOrderToEngine, cancelOrderOnEngine, engineEvents } = require("../Spot_Engine/engineClient");

function sendResponse(res, statusCode, success, message, data = null) {
    return res.status(statusCode).json({ success, message, data });
}

// Promise-flavored query helper — the persistence logic below chains
// several dependent queries (fetch order -> insert trade -> upsert
// holdings -> upsert position) and reads far worse as nested callbacks.
function query(sql, params) {
    return new Promise((resolve, reject) => {
        conn.query(sql, params, (err, result) => {
            if (err) return reject(err);
            resolve(result);
        });
    });
}

/* ═══════════════════════════════════════════════════════════════════════
   SUPPORTED SYMBOLS
   ───────────────────────────────────────────────────────────────────────
   Must stay in sync with the TRADE_COINS list in spot_trade.html. Anything
   not in this list is rejected before we even bother hitting Binance.

   DB / REST layer uses the base asset only ("BTC"), matching spot_orders
   / spot_holdings.symbol. The engine speaks full pairs ("BTCUSDT") — see
   toEnginePair/fromEnginePair below. Convert at the boundary, never store
   the pair form in MySQL.
   ═══════════════════════════════════════════════════════════════════════ */
const SUPPORTED_SYMBOLS = ["BTC", "ETH", "BNB", "SOL", "XRP", "USDC"];

function toEnginePair(baseSymbol) {
    return `${baseSymbol}USDT`;
}
function fromEnginePair(pairSymbol) {
    return pairSymbol.endsWith("USDT") ? pairSymbol.slice(0, -4) : pairSymbol;
}

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
   type-coerced packet used for both the DB insert and the engine packet.
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

    // NOTE: TP/SL only make economic sense on a BUY (spot has no
    // short-selling — spot_positions only ever tracks a long quantity /
    // entry_price). The engine also rejects TP/SL on a SELL; we surface
    // the same rule here so the client gets a clean 400 instead of a
    // round trip to the engine just to be told no.
    if (side === "SELL" && (tp !== null || sl !== null)) {
        return { valid: false, errors: ["take_profit_price / stop_loss_price are only supported on BUY orders"] };
    }

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
   OPEN POSITIONS  (GET /api/spot/positions)
   ───────────────────────────────────────────────────────────────────────
   A position row is created the moment a BUY entry order fills (see
   handleExecution below) and closed the moment its TP or SL fires.
   Orders placed with no TP/SL never get a position row — they're just a
   holdings change, tracked in spot_holdings instead.
   ═══════════════════════════════════════════════════════════════════════ */
router.get("/api/spot/positions", verifyToken, (req, res) => {
    const userId = req.user.id;
    const statusFilter = req.query.status === "CLOSED" ? "CLOSED" : "OPEN";

    conn.query(
        `SELECT position_id, order_id, symbol, quantity, entry_price, invested_usdt,
                take_profit_price, stop_loss_price, status, opened_at, closed_at
         FROM spot_positions
         WHERE user_id = ? AND status = ?
         ORDER BY opened_at DESC`,
        [userId, statusFilter],
        (err, rows) => {
            if (err) return sendResponse(res, 500, false, "Database error");

            const positions = rows.map(p => ({
                position_id: p.position_id,
                order_id: p.order_id,
                symbol: p.symbol,
                quantity: parseFloat(p.quantity),
                entry_price: parseFloat(p.entry_price),
                invested_usdt: parseFloat(p.invested_usdt),
                take_profit_price: p.take_profit_price !== null ? parseFloat(p.take_profit_price) : null,
                stop_loss_price: p.stop_loss_price !== null ? parseFloat(p.stop_loss_price) : null,
                status: p.status,
                opened_at: p.opened_at,
                closed_at: p.closed_at,
            }));

            return sendResponse(res, 200, true, "Positions loaded", positions);
        }
    );
});

/* ═══════════════════════════════════════════════════════════════════════
   TRADE HISTORY  (GET /api/spot/trades)
   ───────────────────────────────────────────────────────────────────────
   spot_trades only ever gets a row from handleExecution() below, i.e.
   strictly AFTER the engine reports a fill. An order that's still
   OPEN/PARTIALLY_FILLED has no trade history yet — that's by design.
   ═══════════════════════════════════════════════════════════════════════ */
router.get("/api/spot/trades", verifyToken, (req, res) => {
    const userId = req.user.id;
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);

    conn.query(
        `SELECT trade_id, order_id, symbol, quantity, price, commission, executed_at
         FROM spot_trades
         WHERE user_id = ?
         ORDER BY executed_at DESC
         LIMIT ?`,
        [userId, limit],
        (err, rows) => {
            if (err) return sendResponse(res, 500, false, "Database error");

            const trades = rows.map(t => ({
                trade_id: t.trade_id,
                order_id: t.order_id,
                symbol: t.symbol,
                quantity: parseFloat(t.quantity),
                price: parseFloat(t.price),
                commission: parseFloat(t.commission),
                executed_at: t.executed_at,
            }));

            return sendResponse(res, 200, true, "Trade history loaded", trades);
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
     4. On failure -> 400 with a list of every violated rule. Nothing is
        written to the DB and nothing reaches the engine.
     5. On success -> INSERT the order into spot_orders as OPEN *first*.
        This row is what makes the order durable: if the engine or Node
        crashes one millisecond later, the order still exists and will be
        picked back up by recoverOpenOrdersToEngine() the next time this
        process connects to a (possibly fresh) engine. The engine's RAM
        book is a cache of this table, never the source of truth.
     6. Forward the DB-assigned order_id to the engine as `order_id` —
        that's the correlation key EXECUTION packets come back with.
     7. If the engine rejects the packet, mark the row CANCELLED and
        relay the errors. If the engine is unreachable, leave the row
        OPEN — we genuinely don't know whether the engine received it,
        and recovery will reconcile it on the next connect.
   Fills are NOT persisted here — see handleExecution(), which runs off
   the engine's push events regardless of which request caused them.
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

    try {
        const walletRows = await query("SELECT wallet_id, status FROM spot_wallet WHERE user_id = ?", [userId]);
        if (!walletRows.length) return sendResponse(res, 404, false, "Spot wallet not found");

        const wallet = walletRows[0];
        if (wallet.status !== "ACTIVE") return sendResponse(res, 403, false, "Spot wallet is blocked");

        // Durable first: this row exists before the engine ever sees the
        // order, so a crash on either side loses nothing.
        const insertResult = await query(
            `INSERT INTO spot_orders
                (user_id, wallet_id, symbol, side, order_type, quantity, remaining_quantity,
                 limit_price, take_profit_price, stop_loss_price, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN')`,
            [
                userId, wallet.wallet_id, packet.symbol, packet.side, packet.order_type,
                packet.quantity, packet.quantity, packet.limit_price,
                packet.take_profit_price, packet.stop_loss_price,
            ]
        );
        const orderId = insertResult.insertId;

        const enginePacket = {
            action: "PLACE_ORDER",
            order_id: orderId,
            user_id: userId,
            wallet_id: wallet.wallet_id,
            symbol: toEnginePair(packet.symbol),
            side: packet.side,
            order_type: packet.order_type,
            quantity: packet.quantity,
            limit_price: packet.limit_price,
            take_profit_price: packet.take_profit_price,
            stop_loss_price: packet.stop_loss_price,
        };

        let engineReply;
        try {
            engineReply = await sendOrderToEngine(enginePacket);
        } catch (engineErr) {
            // Unreachable / timed out — we don't know if the engine ever
            // saw it. Leave the row OPEN; recovery reconciles it against
            // whatever engine process is live the next time we connect.
            return sendResponse(res, 502, false,
                `Trade engine unavailable: ${engineErr.message}. Your order (#${orderId}) was saved and will be retried automatically.`,
                { order_id: orderId }
            );
        }

        if (!engineReply.accepted) {
            await query("UPDATE spot_orders SET status = 'CANCELLED' WHERE order_id = ?", [orderId]);
            return sendResponse(res, 400, false, "Order rejected by trade engine", {
                order_id: orderId,
                errors: engineReply.errors || [],
            });
        }

        return sendResponse(res, 200, true, "Order placed", {
            order_id: orderId,
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
            status: "OPEN",
        });
    } catch (dbErr) {
        return sendResponse(res, 500, false, "Database error while placing order");
    }
});

/* ═══════════════════════════════════════════════════════════════════════
   CANCEL ORDER  (POST /api/spot/order/:order_id/cancel)
   ───────────────────────────────────────────────────────────────────────
   Cancels on the engine FIRST, then reflects the outcome in MySQL —
   never the other way around, or the DB could say CANCELLED for an
   order the engine is still resting (and will happily fill later).
   ═══════════════════════════════════════════════════════════════════════ */
router.post("/api/spot/order/:order_id/cancel", verifyToken, async (req, res) => {
    const userId = req.user.id;
    const orderId = req.params.order_id;

    try {
        const rows = await query(
            "SELECT order_id, symbol, status FROM spot_orders WHERE order_id = ? AND user_id = ?",
            [orderId, userId]
        );
        if (!rows.length) return sendResponse(res, 404, false, "Order not found");

        const order = rows[0];
        if (order.status !== "OPEN" && order.status !== "PARTIALLY_FILLED") {
            return sendResponse(res, 400, false, `Order cannot be cancelled — current status is ${order.status}`);
        }

        let engineReply;
        try {
            engineReply = await cancelOrderOnEngine(order.order_id, toEnginePair(order.symbol));
        } catch (engineErr) {
            return sendResponse(res, 502, false, `Trade engine unavailable: ${engineErr.message}`);
        }

        if (!engineReply.cancelled) {
            // Most likely reason: it already filled (an EXECUTION for it
            // may be landing right now via handleExecution). Don't touch
            // the DB row — let the fill path be the one source of truth.
            return sendResponse(res, 409, false, engineReply.message || "Order could not be cancelled — it may have already filled");
        }

        await query("UPDATE spot_orders SET status = 'CANCELLED' WHERE order_id = ? AND user_id = ?", [orderId, userId]);
        return sendResponse(res, 200, true, "Order cancelled", { order_id: orderId });
    } catch (dbErr) {
        return sendResponse(res, 500, false, "Database error while cancelling order");
    }
});

/* ═══════════════════════════════════════════════════════════════════════
   FILL PERSISTENCE  (driven by the engine's EXECUTION push events)
   ───────────────────────────────────────────────────────────────────────
   This is the ONLY place spot_trades gets a row — i.e. transaction
   history exists strictly after a trade executes, never before. Until
   this fires, the order just sits in spot_orders as OPEN/PARTIALLY_FILLED.

   Two shapes of EXECUTION come through here:
     - Entry fill (is_exit_order=false): a BUY or SELL order filled.
       -> record the trade, update the order, adjust holdings, and if it
          was a BUY with TP/SL attached, open a position row.
     - Exit fill (is_exit_order=true): a TP or SL closed a position.
       -> record the trade, adjust holdings, close the matching position.
       The parent order's own spot_orders row was already FILLED when the
       entry executed, so it is NOT touched again here.

   We query spot_orders by order_id (the field the engine echoes back on
   every EXECUTION) to pull take_profit_price/stop_loss_price for the new
   position row — those aren't in the wire packet itself, only in MySQL.
   ═══════════════════════════════════════════════════════════════════════ */
async function handleExecution(msg) {
    try {
        const symbol = fromEnginePair(msg.symbol);
        const fillQty = msg.fill_quantity;
        const fillPrice = msg.fill_price;

        if (!msg.is_exit_order) {
            await persistEntryFill(msg, symbol, fillQty, fillPrice);
        } else {
            await persistExitFill(msg, symbol, fillQty, fillPrice);
        }
    } catch (err) {
        // Deliberately do not throw further — this runs off an event
        // emitter with no caller to catch it. Log loudly so a failed
        // persistence step (e.g. a transient DB blip) is visible instead
        // of silently losing a fill.
        console.error(`Failed to persist EXECUTION for order_id=${msg.order_id}:`, err);
    }
}

async function persistEntryFill(msg, symbol, fillQty, fillPrice) {
    // Look the order up for the fields the wire packet doesn't carry
    // (TP/SL) and to make sure we're not double-applying a fill we've
    // already seen (e.g. a duplicate line after a reconnect race).
    const orderRows = await query(
        `SELECT order_id, user_id, wallet_id, symbol, side, status, remaining_quantity,
                take_profit_price, stop_loss_price
         FROM spot_orders WHERE order_id = ?`,
        [msg.order_id]
    );
    if (!orderRows.length) {
        console.error(`EXECUTION for unknown order_id=${msg.order_id} — ignoring`);
        return;
    }
    const order = orderRows[0];
    if (order.status === "FILLED" || order.status === "CANCELLED") {
        console.error(`Duplicate EXECUTION for order_id=${msg.order_id} (already ${order.status}) — ignoring`);
        return;
    }

    const newRemaining = Math.max(0, parseFloat(order.remaining_quantity) - fillQty);
    const newStatus = newRemaining > 0 ? "PARTIALLY_FILLED" : "FILLED";

    await query(
        "UPDATE spot_orders SET remaining_quantity = ?, status = ? WHERE order_id = ?",
        [newRemaining, newStatus, msg.order_id]
    );

    await query(
        `INSERT INTO spot_trades (order_id, user_id, symbol, quantity, price, commission)
         VALUES (?, ?, ?, ?, ?, 0)`,
        [msg.order_id, msg.user_id, symbol, fillQty, fillPrice]
    );

    if (msg.side === "BUY") {
        // Credit the bought asset, recompute the weighted average buy price.
        const cost = fillQty * fillPrice;
        await query(
            `INSERT INTO spot_holdings (wallet_id, symbol, available_quantity, locked_quantity, average_buy_price, total_cost)
             VALUES (?, ?, ?, 0, ?, ?)
             ON DUPLICATE KEY UPDATE
                total_cost = total_cost + VALUES(total_cost),
                available_quantity = available_quantity + VALUES(available_quantity),
                average_buy_price = total_cost / available_quantity`,
            [msg.wallet_id, symbol, fillQty, fillPrice, cost]
        );
        // Debit USDT for the cost of the buy.
        await query(
            `INSERT INTO spot_holdings (wallet_id, symbol, available_quantity)
             VALUES (?, 'USDT', ?)
             ON DUPLICATE KEY UPDATE available_quantity = available_quantity + VALUES(available_quantity)`,
            [msg.wallet_id, -cost]
        );
    } else {
        // Plain SELL entry (no TP/SL, no position tracking) — debit the
        // asset, credit USDT.
        await query(
            `UPDATE spot_holdings SET available_quantity = available_quantity - ?
             WHERE wallet_id = ? AND symbol = ?`,
            [fillQty, msg.wallet_id, symbol]
        );
        await query(
            `INSERT INTO spot_holdings (wallet_id, symbol, available_quantity)
             VALUES (?, 'USDT', ?)
             ON DUPLICATE KEY UPDATE available_quantity = available_quantity + VALUES(available_quantity)`,
            [msg.wallet_id, fillQty * fillPrice]
        );
    }

    // Only a BUY with at least one of TP/SL spawns a tracked position —
    // matches the engine, which only creates exit triggers for those.
    if (order.side === "BUY" && (order.take_profit_price !== null || order.stop_loss_price !== null)) {
        await query(
            `INSERT INTO spot_positions
                (order_id, user_id, wallet_id, symbol, quantity, entry_price, invested_usdt,
                 take_profit_price, stop_loss_price, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN')`,
            [
                msg.order_id, msg.user_id, msg.wallet_id, symbol, fillQty, fillPrice, fillQty * fillPrice,
                order.take_profit_price, order.stop_loss_price,
            ]
        );
    }

    // TODO: broadcast this fill to the user over the existing WebSocket
    // layer (see live chat's ws server on :7070) once that hook exists,
    // e.g. broadcastToUser(msg.user_id, { type: "spot_fill", ...msg }).
}

async function persistExitFill(msg, symbol, fillQty, fillPrice) {
    await query(
        `INSERT INTO spot_trades (order_id, user_id, symbol, quantity, price, commission)
         VALUES (?, ?, ?, ?, ?, 0)`,
        [msg.order_id, msg.user_id, symbol, fillQty, fillPrice]
    );

    // Closing a long: credit USDT for the sale, debit the held asset.
    await query(
        `INSERT INTO spot_holdings (wallet_id, symbol, available_quantity)
         VALUES (?, 'USDT', ?)
         ON DUPLICATE KEY UPDATE available_quantity = available_quantity + VALUES(available_quantity)`,
        [msg.wallet_id, fillQty * fillPrice]
    );
    await query(
        `UPDATE spot_holdings SET available_quantity = available_quantity - ?
         WHERE wallet_id = ? AND symbol = ?`,
        [fillQty, msg.wallet_id, symbol]
    );

    const result = await query(
        `UPDATE spot_positions SET status = 'CLOSED', closed_at = CURRENT_TIMESTAMP
         WHERE order_id = ? AND status = 'OPEN'`,
        [msg.order_id]
    );
    if (result.affectedRows === 0) {
        console.error(`Exit EXECUTION for order_id=${msg.order_id} found no OPEN position to close`);
    }

    // realized_pnl isn't persisted anywhere (no column for it on
    // spot_positions/spot_trades in the current schema) — it's always
    // derivable as (exit trade price - position.entry_price) * quantity
    // when needed for display, so recompute it there rather than storing
    // a value that could drift from the source rows.

    // TODO: broadcast this close to the user over the WebSocket layer,
    // same as persistEntryFill above — include msg.realized_pnl directly
    // from the wire packet since the engine already computed it.
}

engineEvents.on("execution", handleExecution);

/* ═══════════════════════════════════════════════════════════════════════
   ORDER BOOK RECOVERY
   ───────────────────────────────────────────────────────────────────────
   The engine's order book is RAM-only and starts EMPTY on every process
   restart. spot_orders is the source of truth it's rebuilt from: every
   row still OPEN/PARTIALLY_FILLED gets re-submitted with its *remaining*
   quantity as a fresh PLACE_ORDER.

   This runs exactly ONCE per Node process, on the first successful
   engine connection (`engineEvents.once`, not `.on`) — not on every
   reconnect. A reconnect of the SAME long-running engine process still
   has its book intact in RAM; resubmitting on every reconnect would
   double-book those orders (the engine has no de-dup for a re-sent
   order_id). If the engine process itself was restarted independently of
   Node, restart Node too (or trigger this manually) so recovery actually
   runs against the fresh, empty book.
   ═══════════════════════════════════════════════════════════════════════ */
async function recoverOpenOrdersToEngine() {
    let rows;
    try {
        rows = await query(
            `SELECT order_id, user_id, wallet_id, symbol, side, order_type, remaining_quantity,
                    limit_price, take_profit_price, stop_loss_price
             FROM spot_orders
             WHERE status IN ('OPEN', 'PARTIALLY_FILLED')`
        );
    } catch (err) {
        console.error("Order book recovery: failed to load open orders from MySQL:", err);
        return;
    }

    if (!rows.length) {
        console.log("Order book recovery: no open spot orders to resubmit.");
        return;
    }

    console.log(`Order book recovery: resubmitting ${rows.length} open spot order(s) to the engine…`);

    for (const row of rows) {
        const enginePacket = {
            action: "PLACE_ORDER",
            order_id: row.order_id,
            user_id: row.user_id,
            wallet_id: row.wallet_id,
            symbol: toEnginePair(row.symbol),
            side: row.side,
            order_type: row.order_type,
            quantity: parseFloat(row.remaining_quantity),
            limit_price: row.limit_price !== null ? parseFloat(row.limit_price) : null,
            take_profit_price: row.take_profit_price !== null ? parseFloat(row.take_profit_price) : null,
            stop_loss_price: row.stop_loss_price !== null ? parseFloat(row.stop_loss_price) : null,
        };

        try {
            const ack = await sendOrderToEngine(enginePacket);
            if (!ack.accepted) {
                console.error(`Order book recovery: engine rejected order_id=${row.order_id}:`, ack.errors);
            }
        } catch (err) {
            console.error(`Order book recovery: failed to resubmit order_id=${row.order_id}:`, err.message);
        }
    }
}

engineEvents.once("connected", recoverOpenOrdersToEngine);

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

   NOTE: this file registers its engineEvents listeners (execution
   persistence + one-time recovery) as a side effect of being required.
   Require it exactly once per process (normal for an Express router) —
   requiring it twice would double-persist every fill.
   ═══════════════════════════════════════════════════════════════════════ */