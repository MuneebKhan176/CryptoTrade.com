const express = require("express");
const path = require("path");
const router = express.Router();

// Same db module used across the app (authRoutes.js, walletRoutes.js …)
// `conn` = the shared pool, safe for one-shot queries. `getConnection` =
// checks out ONE dedicated connection for a real transaction (BEGIN ...
// FOR UPDATE ... COMMIT) — required any time locking is involved.
const { conn, getConnection } = require("../db_connection");

// Same auth middleware used by /dashboard, /funding-wallet, etc. — sets req.user.id from the JWT cookie.
const verifyToken = require("../middle/middleware");

// TCP client for the C++ CryptoTrade engine (see engine/trade_engine.cpp).
const { sendOrderToEngine, cancelOrderOnEngine, engineEvents } = require("../Spot_Engine/engineClient");

// Locking module — every function here takes the SAME dedicated
// connection as the surrounding transaction, never the shared pool.
// Unchanged by the OCO migration: OCO is placed with side='SELL', and
// lockForOrder already reserves the base asset quantity for any non-BUY
// side, exactly like a plain SELL.
const { lockForOrder, unlockOnCancel, releaseOnFill } = require("../Wallets_Config/spotHoldings_Lock");

// Push notifier over the same market-data WebSocket layer — lets us tell
// a user's browser "go refresh your balance/orders" the instant one of
// their orders fills, even if that fill happened minutes later off a
// resting LIMIT/OCO leg with no HTTP request in flight to piggyback on.
const { notifyUserTradeUpdate } = require("../Web_Sockets/marketData_ws");

function sendResponse(res, statusCode, success, message, data = null) {
    return res.status(statusCode).json({ success, message, data });
}

// Promise-flavored query helper for the shared pool — fine for one-shot,
// non-transactional reads (GET endpoints below).
function query(sql, params) {
    return new Promise((resolve, reject) => {
        conn.query(sql, params, (err, result) => {
            if (err) return reject(err);
            resolve(result);
        });
    });
}

// Same helper, but bound to a specific dedicated connection — use this
// for anything that must run inside a transaction alongside a lock/
// unlock/release call.
function txQuery(connection, sql, params) {
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
        connection.rollback(() => resolve());
    });
}

/* ═══════════════════════════════════════════════════════════════════════
   SUPPORTED SYMBOLS
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
   ORDER VALIDATION
   ───────────────────────────────────────────────────────────────────────
   Rewritten for the OCO migration:
     - No more take_profit_price / stop_loss_price attached to BUY orders.
     - OCO is its own order_type: SELL-only, carries limit_price (the
       upper, take-profit-style leg) and the new stop_price (the lower,
       stop-loss-style leg). Whichever leg the market reaches first fires;
       same semantics as the engine's OCO handling.
   ═══════════════════════════════════════════════════════════════════════ */
function validateOrderRequest(body, marketPrice) {
    const errors = [];

    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return { valid: false, errors: ["Malformed request body"] };
    }

    const { symbol, side, order_type, quantity, limit_price, stop_price } = body;

    if (!symbol || typeof symbol !== "string") errors.push("Symbol is required");
    if (side !== "BUY" && side !== "SELL") errors.push("Side must be BUY or SELL");
    if (order_type !== "MARKET" && order_type !== "LIMIT" && order_type !== "OCO") {
        errors.push("Order type must be MARKET, LIMIT, or OCO");
    }

    if (errors.length) return { valid: false, errors };

    const upperSymbol = symbol.toUpperCase();
    if (!SUPPORTED_SYMBOLS.includes(upperSymbol)) {
        errors.push(`Symbol '${upperSymbol}' is not supported for trading`);
    }

    const qty = parseFloat(quantity);
    if (quantity === undefined || quantity === null || isNaN(qty) || qty <= 0) {
        errors.push("Quantity must be a number greater than 0");
    }

    if (order_type === "OCO" && side !== "SELL") {
        errors.push("OCO orders are only supported on the SELL side");
    }

    let limitPrice = null;
    let stopPrice = null;

    if (order_type === "LIMIT") {
        limitPrice = parseFloat(limit_price);
        if (limit_price === undefined || limit_price === null || isNaN(limitPrice) || limitPrice <= 0) {
            errors.push("LIMIT orders require a limit_price greater than 0");
        }
        if (stop_price !== undefined && stop_price !== null && stop_price !== "") {
            errors.push("LIMIT orders must not include a stop_price");
        }
    } else if (order_type === "MARKET") {
        if (limit_price !== undefined && limit_price !== null && limit_price !== "") {
            errors.push("MARKET orders must not include a limit_price");
        }
        if (stop_price !== undefined && stop_price !== null && stop_price !== "") {
            errors.push("MARKET orders must not include a stop_price");
        }
    } else if (order_type === "OCO") {
        limitPrice = parseFloat(limit_price);
        stopPrice = parseFloat(stop_price);
        if (limit_price === undefined || limit_price === null || isNaN(limitPrice) || limitPrice <= 0) {
            errors.push("OCO orders require a positive limit_price (take-profit leg)");
        }
        if (stop_price === undefined || stop_price === null || isNaN(stopPrice) || stopPrice <= 0) {
            errors.push("OCO orders require a positive stop_price (stop-loss leg)");
        }
        if (!isNaN(limitPrice) && !isNaN(stopPrice) && limitPrice <= stopPrice) {
            errors.push("OCO limit_price (take-profit leg) must be above stop_price (stop-loss leg)");
        }
    }

    if (errors.length) return { valid: false, errors };

    if (order_type === "LIMIT") {
        if (side === "BUY" && limitPrice >= marketPrice) {
            errors.push(`Buy limit price must be below the current market price (${marketPrice})`);
        } else if (side === "SELL" && limitPrice <= marketPrice) {
            errors.push(`Sell limit price must be above the current market price (${marketPrice})`);
        }
    } else if (order_type === "OCO") {
        // Same shape as a SELL limit check, applied to both legs: the
        // take-profit leg sits above market, the stop leg sits below it.
        if (limitPrice <= marketPrice) {
            errors.push(`OCO take-profit price must be above the current market price (${marketPrice})`);
        }
        if (stopPrice >= marketPrice) {
            errors.push(`OCO stop price must be below the current market price (${marketPrice})`);
        }
    }

    if (errors.length) return { valid: false, errors };

    // entry_price_reference only matters for sizing a BUY's USDT lock.
    // SELL and OCO lock the base asset quantity itself, independent of
    // price, so there's nothing to reference there.
    const entryPrice =
        order_type === "MARKET" ? marketPrice :
        order_type === "LIMIT" ? limitPrice :
        null;

    return {
        valid: true,
        errors: [],
        normalized: {
            symbol: upperSymbol,
            side,
            order_type,
            quantity: qty,
            limit_price: limitPrice,   // LIMIT: the limit price. OCO: upper/take-profit-style leg.
            stop_price: stopPrice,     // OCO only: lower/stop-loss-style leg.
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
                limit_price, locked_price, stop_price, status, created_at
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
                locked_price: o.locked_price !== null ? parseFloat(o.locked_price) : null,
                stop_price: o.stop_price !== null ? parseFloat(o.stop_price) : null,
                status: o.status,
                created_at: o.created_at,
            }));

            return sendResponse(res, 200, true, "Open orders loaded", orders);
        }
    );
});

/* ═══════════════════════════════════════════════════════════════════════
   TRADE HISTORY  (GET /api/spot/trades)
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
   ───────────────────────────────────────────────────────────────────────
   Includes both LIMIT and OCO order types now. Only limit_price is used
   in the grouping/aggregation — for an OCO row that's the upper,
   take-profit-style leg, so it shows up as a resting ask exactly like a
   plain SELL limit order would. The lower stop leg is intentionally left
   out of the book (same convention real exchanges use: stop orders are
   hidden from depth until triggered).
   ═══════════════════════════════════════════════════════════════════════ */
router.get("/api/spot/orderbook", verifyToken, (req, res) => {
    const symbol = (req.query.symbol || "").toUpperCase();
    if (!symbol) return sendResponse(res, 400, false, "Missing symbol query param");

    const bookQuery = `
        SELECT side, limit_price, SUM(remaining_quantity) AS total_qty
        FROM spot_orders
        WHERE symbol = ?
          AND order_type IN ('LIMIT', 'OCO')
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
     4. Check out ONE dedicated connection and start a transaction:
          a. lockForOrder() — reserves USDT (BUY) or the base asset
             (SELL / OCO — OCO locks exactly like a plain SELL, since
             it's placed directly against an asset the user already
             holds) against spot_holdings, FOR UPDATE.
          b. INSERT the order as OPEN, persisting locked_price (BUY
             only — the price the USDT lock was computed against) and,
             for OCO, stop_price alongside limit_price.
          c. commit. If the lock fails (insufficient funds) or the insert
             fails, roll back — nothing is written, nothing reaches the
             engine.
     5. Forward the DB-assigned order_id to the engine as `order_id`.
     6. If the engine rejects the packet, or is unreachable, open a
        SEPARATE transaction to unlock what was reserved and mark the row
        CANCELLED. If the engine is unreachable, we genuinely don't know
        whether it received the order, so the row (and its lock) are left
        in place; recovery reconciles it on the next connect.
   Fills are NOT persisted here — see handleExecution().
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

    let connection;
    try {
        connection = await getConnection();
    } catch (e) {
        return sendResponse(res, 500, false, "Could not acquire a database connection.");
    }

    let orderId;
    let wallet;
    try {
        await beginTransaction(connection);

        const walletRows = await txQuery(connection, "SELECT wallet_id, status FROM spot_wallet WHERE user_id = ?", [userId]);
        if (!walletRows.length) {
            await rollback(connection);
            return sendResponse(res, 404, false, "Spot wallet not found");
        }
        wallet = walletRows[0];
        if (wallet.status !== "ACTIVE") {
            await rollback(connection);
            return sendResponse(res, 403, false, "Spot wallet is blocked");
        }

        // Reserve funds/asset BEFORE the order exists. For BUY,
        // estimatedPrice sizes the USDT lock (persisted below as
        // locked_price). For SELL and OCO it's unused — the lock is just
        // `quantity` of the base asset, regardless of price.
        try {
            await lockForOrder(connection, {
                walletId: wallet.wallet_id,
                side: packet.side,
                symbol: packet.symbol,
                quantity: packet.quantity,
                estimatedPrice: packet.entry_price_reference,
            });
        } catch (lockErr) {
            await rollback(connection);
            return sendResponse(res, 400, false, lockErr.message);
        }

        const insertResult = await txQuery(
            connection,
            `INSERT INTO spot_orders
                (user_id, wallet_id, symbol, side, order_type, quantity, remaining_quantity,
                 limit_price, locked_price, stop_price, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN')`,
            [
                userId, wallet.wallet_id, packet.symbol, packet.side, packet.order_type,
                packet.quantity, packet.quantity, packet.limit_price, packet.entry_price_reference,
                packet.stop_price,
            ]
        );
        orderId = insertResult.insertId;

        await commit(connection);
    } catch (dbErr) {
        await rollback(connection);
        return sendResponse(res, 500, false, "Database error while placing order");
    } finally {
        connection.release();
    }

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
        stop_price: packet.stop_price,
    };

    let engineReply;
    try {
        engineReply = await sendOrderToEngine(enginePacket);
    } catch (engineErr) {
        // Unreachable / timed out — leave the row + its lock in place;
        // recovery reconciles it against whatever engine is live next.
        return sendResponse(res, 502, false,
            `Trade engine unavailable: ${engineErr.message}. Your order (#${orderId}) was saved and will be retried automatically.`,
            { order_id: orderId }
        );
    }

    if (!engineReply.accepted) {
        // Engine rejected it — release the reservation and mark
        // CANCELLED in its own transaction, since the placement
        // transaction already committed.
        await releaseRejectedOrder(orderId, packet.side, packet.symbol, packet.quantity, packet.entry_price_reference, wallet.wallet_id);
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
        stop_price: packet.stop_price,
        entry_price_reference: packet.entry_price_reference,
        market_price_reference: packet.market_price_reference,
        status: "OPEN",
    });
});

/**
 * Shared unlock-and-cancel helper — used both when the engine rejects a
 * brand-new order and when a resting order is cancelled by the user.
 * Recomputes exactly what was reserved from remaining_quantity and the
 * persisted locked_price (BUY only), so no separate ledger of "how much
 * did we lock" needs to be maintained anywhere else. Works unchanged for
 * OCO since it's stored with side='SELL', same lock shape as a plain
 * SELL.
 */
async function releaseRejectedOrder(orderId, side, symbol, remainingQuantity, lockedPrice, walletId) {
    const lockSymbol = side === "BUY" ? "USDT" : symbol;
    const lockAmount = side === "BUY" ? remainingQuantity * lockedPrice : remainingQuantity;

    let connection;
    try {
        connection = await getConnection();
        await beginTransaction(connection);
        await unlockOnCancel(connection, { walletId, lockSymbol, lockAmount });
        await txQuery(connection, "UPDATE spot_orders SET status = 'CANCELLED' WHERE order_id = ?", [orderId]);
        await commit(connection);
    } catch (err) {
        if (connection) await rollback(connection);
        console.error(`Failed to release rejected order_id=${orderId}:`, err);
    } finally {
        if (connection) connection.release();
    }
}

/* ═══════════════════════════════════════════════════════════════════════
   CANCEL ORDER  (POST /api/spot/order/:order_id/cancel)
   ───────────────────────────────────────────────────────────────────────
   Cancels on the engine FIRST, then reflects the outcome in MySQL —
   unlocking whatever remains reserved (remaining_quantity * locked_price
   for a BUY, remaining_quantity alone for a SELL/OCO) inside the same
   transaction that marks the order CANCELLED. Unchanged by the OCO
   migration: the engine's CANCEL_ORDER handler already looks up both its
   plain-order index and its OCO index by db_order_id, and cancels
   whichever leg(s) exist.
   ═══════════════════════════════════════════════════════════════════════ */
router.post("/api/spot/order/:order_id/cancel", verifyToken, async (req, res) => {
    const userId = req.user.id;
    const orderId = req.params.order_id;

    try {
        const rows = await query(
            "SELECT order_id, wallet_id, symbol, side, status, remaining_quantity, locked_price FROM spot_orders WHERE order_id = ? AND user_id = ?",
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

        const remaining = parseFloat(order.remaining_quantity);
        const lockedPrice = order.locked_price !== null ? parseFloat(order.locked_price) : null;
        const lockSymbol = order.side === "BUY" ? "USDT" : order.symbol;
        const lockAmount = order.side === "BUY" ? remaining * lockedPrice : remaining;

        let connection;
        try {
            connection = await getConnection();
            await beginTransaction(connection);
            await unlockOnCancel(connection, { walletId: order.wallet_id, lockSymbol, lockAmount });
            await txQuery(connection, "UPDATE spot_orders SET status = 'CANCELLED' WHERE order_id = ? AND user_id = ?", [orderId, userId]);
            await commit(connection);
        } catch (dbErr) {
            if (connection) await rollback(connection);
            return sendResponse(res, 500, false, "Database error while cancelling order");
        } finally {
            if (connection) connection.release();
        }

        return sendResponse(res, 200, true, "Order cancelled", { order_id: orderId });
    } catch (dbErr) {
        return sendResponse(res, 500, false, "Database error while cancelling order");
    }
});

/* ═══════════════════════════════════════════════════════════════════════
   FILL PERSISTENCE  (driven by the engine's EXECUTION push events)
   ───────────────────────────────────────────────────────────────────────
   Rewritten for the OCO migration: there is no more "entry fill" vs.
   "exit fill" split, no is_exit_order flag, and no spot_positions table.
   Every EXECUTION is now just a BUY fill or a SELL fill:
     - BUY:  release the USDT lock for this slice, debit the actual fill
       cost, credit the bought asset into holdings.
     - SELL: covers plain SELL, LIMIT SELL, AND both OCO legs
       (msg.is_oco_leg is true for those) — release the base-asset lock
       for this slice, debit it back out (it's being sold, not returned),
       credit the USDT proceeds. The engine has already cancelled the
       sibling OCO leg internally by the time this EXECUTION arrives, so
       there's nothing OCO-specific left to do here; is_oco_leg /
       oco_leg on the message are available if you want to tag the trade
       row, but aren't required for correct balance bookkeeping.
   Runs on ONE dedicated connection wrapped in a transaction. Once the
   fill is committed, pushes a 'trade_update' event over the WebSocket to
   that user's browser(s) so the panel refreshes immediately — this is
   what closes the gap for LIMIT/OCO fills that happen later, off of a
   price tick that had no HTTP request waiting on it.
   ═══════════════════════════════════════════════════════════════════════ */
async function handleExecution(msg) {
    let connection;
    try {
        connection = await getConnection();
        await beginTransaction(connection);

        const symbol = fromEnginePair(msg.symbol);
        const fillQty = msg.fill_quantity;
        const fillPrice = msg.fill_price;

        await persistFill(connection, msg, symbol, fillQty, fillPrice);

        await commit(connection);

        // Fire only after the transaction actually commits — no point
        // telling the browser to refresh balances that aren't updated yet.
        try {
            notifyUserTradeUpdate(msg.user_id, {
                order_id: msg.order_id,
                symbol,
                side: msg.side,
                order_type: msg.order_type,
                status: msg.status,
                is_oco_leg: !!msg.is_oco_leg,
                oco_leg: msg.oco_leg || null,
                fill_quantity: fillQty,
                fill_price: fillPrice,
            });
        } catch (notifyErr) {
            // Never let a broadcast failure look like a persistence
            // failure — the fill is safely committed either way.
            console.error(`Failed to push trade_update for order_id=${msg.order_id}:`, notifyErr);
        }
    } catch (err) {
        if (connection) await rollback(connection);
        // Deliberately do not throw further — this runs off an event
        // emitter with no caller to catch it. Log loudly so a failed
        // persistence step (e.g. a transient DB blip) is visible instead
        // of silently losing a fill.
        console.error(`Failed to persist EXECUTION for order_id=${msg.order_id}:`, err);
    } finally {
        if (connection) connection.release();
    }
}

async function persistFill(connection, msg, symbol, fillQty, fillPrice) {
    const orderRows = await txQuery(
        connection,
        `SELECT order_id, user_id, wallet_id, symbol, side, status, remaining_quantity, locked_price
         FROM spot_orders WHERE order_id = ? FOR UPDATE`,
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

    await txQuery(connection, "UPDATE spot_orders SET remaining_quantity = ?, status = ? WHERE order_id = ?", [newRemaining, newStatus, msg.order_id]);

    await txQuery(
        connection,
        `INSERT INTO spot_trades (order_id, user_id, symbol, quantity, price, commission)
         VALUES (?, ?, ?, ?, ?, 0)`,
        [msg.order_id, msg.user_id, symbol, fillQty, fillPrice]
    );

    if (msg.side === "BUY") {
        const lockedPrice = parseFloat(order.locked_price);
        const releaseAmount = fillQty * lockedPrice; // exactly what was reserved for this slice
        const actualCost = fillQty * fillPrice;       // what actually got spent

        // Release the USDT lock for this filled slice first — credits
        // releaseAmount back into available_quantity — then the debit
        // below takes actualCost back out. When lockedPrice === fillPrice
        // (the normal case) those cancel out to a net-zero change beyond
        // the original reservation; any slippage flows through correctly.
        await releaseOnFill(connection, { walletId: msg.wallet_id, lockSymbol: "USDT", filledLockAmount: releaseAmount });
        await txQuery(
            connection,
            `UPDATE spot_holdings SET available_quantity = available_quantity - ?
             WHERE wallet_id = ? AND symbol = 'USDT'`,
            [actualCost, msg.wallet_id]
        );

        const cost = fillQty * fillPrice;
        await txQuery(
            connection,
            `INSERT INTO spot_holdings (wallet_id, symbol, available_quantity, locked_quantity, average_buy_price, total_cost)
             VALUES (?, ?, ?, 0, ?, ?)
             ON DUPLICATE KEY UPDATE
                total_cost = total_cost + VALUES(total_cost),
                available_quantity = available_quantity + VALUES(available_quantity),
                average_buy_price = total_cost / (available_quantity + locked_quantity)`,
            [msg.wallet_id, symbol, fillQty, fillPrice, cost]
        );
    } else {
        // SELL fill — plain SELL, LIMIT SELL, or an OCO leg. The asset
        // was already moved from available_quantity into locked_quantity
        // at placement time. Release the lock for this fill — credits
        // fillQty back into available_quantity — then immediately debit
        // that same fillQty back out, since it's being sold, not
        // returned. Net effect on available_quantity is a drop of
        // fillQty overall, with nothing left dangling in locked_quantity.
        await releaseOnFill(connection, { walletId: msg.wallet_id, lockSymbol: symbol, filledLockAmount: fillQty });
        await txQuery(
            connection,
            `UPDATE spot_holdings SET available_quantity = available_quantity - ?
             WHERE wallet_id = ? AND symbol = ?`,
            [fillQty, msg.wallet_id, symbol]
        );
        await txQuery(
            connection,
            `INSERT INTO spot_holdings (wallet_id, symbol, available_quantity)
             VALUES (?, 'USDT', ?)
             ON DUPLICATE KEY UPDATE available_quantity = available_quantity + VALUES(available_quantity)`,
            [msg.wallet_id, fillQty * fillPrice]
        );
    }
}

engineEvents.on("execution", handleExecution);

/* ═══════════════════════════════════════════════════════════════════════
   ORDER BOOK RECOVERY
   ───────────────────────────────────────────────────────────────────────
   Unchanged in shape, updated fields: forwards stop_price instead of
   take_profit_price/stop_loss_price. For a recovered OCO row,
   remaining_quantity is always the full original quantity (OCO fires
   atomically — see fillOrderCompletely in the engine), so resubmitting it
   as-is recreates both legs fresh with new engine_order_ids.
   ═══════════════════════════════════════════════════════════════════════ */
async function recoverOpenOrdersToEngine() {
    let rows;
    try {
        rows = await query(
            `SELECT order_id, user_id, wallet_id, symbol, side, order_type, remaining_quantity,
                    limit_price, stop_price
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
            stop_price: row.stop_price !== null ? parseFloat(row.stop_price) : null,
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
   SCHEMA

   Apply the migration that ships alongside this file (drops
   take_profit_price/stop_loss_price and spot_positions, adds stop_price,
   widens order_type to include 'OCO'). See that migration for the full
   from-scratch CREATE TABLE reference too.

   WIRE-UP (in your main server file, next to the other routers):
     const spotTradeRoutes = require("./routes/spotPanel_Route");
     app.use("/", spotTradeRoutes);

   Requires Node 18+ for the global `fetch` used in getMarketPrice().
   Requires the C++ engine (trade_engine.cpp) running and reachable.
   This file registers engineEvents listeners as a side effect of being
   required — require it exactly once per process.

   Requires Web_Sockets/marketData_ws.js to export `notifyUserTradeUpdate`
   (added alongside this file) so fills can push a 'trade_update' event to
   the placing user's browser(s) over the existing market-data WebSocket.
   ═══════════════════════════════════════════════════════════════════════ */