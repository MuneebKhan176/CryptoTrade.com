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
const { lockForOrder, unlockOnCancel, releaseOnFill } = require("../Wallets_Config/spotHoldings_Lock");

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
   ORDER VALIDATION — unchanged from before
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
                limit_price, locked_price, take_profit_price, stop_loss_price, status, created_at
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
   Flow (fixed):
     1. verifyToken already confirmed the JWT — req.user.id is trusted.
     2. Fetch a fresh, server-side market price for the requested symbol.
     3. Run the full validation checklist against that price.
     4. Check out ONE dedicated connection and start a transaction:
          a. lockForOrder() — reserves USDT (BUY) or the base asset
             (SELL) against spot_holdings, FOR UPDATE. This is the actual
             fix for "orders never locked funds": until this call
             existed, available_quantity was untouched between placement
             and fill, so a transfer or a second order could spend money
             that was already spoken for.
          b. INSERT the order as OPEN, persisting locked_price — the
             exact price the lock was computed against (market price for
             MARKET, limit_price for LIMIT). Cancel/fill later recompute
             the exact reserved amount from remaining_quantity *
             locked_price (BUY) or remaining_quantity alone (SELL),
             without needing any extra bookkeeping table.
          c. commit. If the lock fails (insufficient funds) or the insert
             fails, roll back — nothing is written, nothing reaches the
             engine.
     5. Forward the DB-assigned order_id to the engine as `order_id`.
     6. If the engine rejects the packet, or is unreachable, open a
        SEPARATE transaction to unlock what was reserved and mark the row
        CANCELLED — never leave a rejected order holding a lock forever.
        If the engine is unreachable, we genuinely don't know whether it
        received the order, so the row (and its lock) are left in place;
        recovery reconciles it on the next connect.
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

        // Reserve funds/asset BEFORE the order exists — this is the
        // core fix. entry_price_reference is what the lock is sized
        // against, and is persisted below as locked_price.
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
                 limit_price, locked_price, take_profit_price, stop_loss_price, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN')`,
            [
                userId, wallet.wallet_id, packet.symbol, packet.side, packet.order_type,
                packet.quantity, packet.quantity, packet.limit_price, packet.entry_price_reference,
                packet.take_profit_price, packet.stop_loss_price,
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
        take_profit_price: packet.take_profit_price,
        stop_loss_price: packet.stop_loss_price,
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
        take_profit_price: packet.take_profit_price,
        stop_loss_price: packet.stop_loss_price,
        entry_price_reference: packet.entry_price_reference,
        market_price_reference: packet.market_price_reference,
        status: "OPEN",
    });
});

/**
 * Shared unlock-and-cancel helper — used both when the engine rejects a
 * brand-new order and when a resting order is cancelled by the user.
 * Recomputes exactly what was reserved from remaining_quantity and the
 * persisted locked_price, so no separate ledger of "how much did we
 * lock" needs to be maintained anywhere else.
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
   for a BUY, remaining_quantity alone for a SELL) inside the same
   transaction that marks the order CANCELLED.
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
   Two shapes of EXECUTION come through here:
     - Entry fill (is_exit_order=false): a BUY or SELL order filled.
     - Exit fill (is_exit_order=true): a TP or SL closed a position.

   Both run on ONE dedicated connection wrapped in a transaction. Both
   release the lock reserved at placement time via releaseOnFill(), which
   credits the reserved amount back to available_quantity (see the fixed
   contract documented in spotHoldings_Lock.js), and then immediately
   debit back out exactly what's actually being spent/consumed. That
   release-then-debit symmetry is what was missing before and caused the
   double-debit bug — see the comments inline below for each case.
   ═══════════════════════════════════════════════════════════════════════ */
async function handleExecution(msg) {
    let connection;
    try {
        connection = await getConnection();
        await beginTransaction(connection);

        const symbol = fromEnginePair(msg.symbol);
        const fillQty = msg.fill_quantity;
        const fillPrice = msg.fill_price;

        if (!msg.is_exit_order) {
            await persistEntryFill(connection, msg, symbol, fillQty, fillPrice);
        } else {
            await persistExitFill(connection, msg, symbol, fillQty, fillPrice);
        }

        await commit(connection);
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

async function persistEntryFill(connection, msg, symbol, fillQty, fillPrice) {
    const orderRows = await txQuery(
        connection,
        `SELECT order_id, user_id, wallet_id, symbol, side, status, remaining_quantity,
                locked_price, take_profit_price, stop_loss_price
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

        // Release the USDT lock for this filled slice first — this now
        // credits releaseAmount back into available_quantity (fixed
        // contract), then the debit below takes actualCost back out.
        // When lockedPrice === fillPrice (the normal case) those two
        // cancel out to a net-zero change beyond the original
        // reservation. Any difference (slippage between the reference
        // price used to lock and the engine's actual fill price) flows
        // through available_quantity correctly here.
        await releaseOnFill(connection, { walletId: msg.wallet_id, lockSymbol: "USDT", filledLockAmount: releaseAmount });
        await txQuery(
            connection,
            `UPDATE spot_holdings SET available_quantity = available_quantity - ?
             WHERE wallet_id = ? AND symbol = 'USDT'`,
            [actualCost, msg.wallet_id]
        );

        // Does this fill spawn/feed a TP/SL-tracked position? If so, the
        // bought asset must land in locked_quantity, not available —
        // it's earmarked for a resting exit trigger and must NOT be
        // freely transferable until that exit fires. This closes the
        // "TP/SL asset fully transferable" hole.
        const hasExitTrigger = order.take_profit_price !== null || order.stop_loss_price !== null;
        const cost = fillQty * fillPrice;

        if (hasExitTrigger) {
            await txQuery(
                connection,
                `INSERT INTO spot_holdings (wallet_id, symbol, available_quantity, locked_quantity, average_buy_price, total_cost)
                 VALUES (?, ?, 0, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                    total_cost = total_cost + VALUES(total_cost),
                    locked_quantity = locked_quantity + VALUES(locked_quantity),
                    average_buy_price = total_cost / (available_quantity + locked_quantity)`,
                [msg.wallet_id, symbol, fillQty, fillPrice, cost]
            );
        } else {
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
        }
    } else {
        // Plain SELL entry (no TP/SL, no position tracking). The asset
        // was already moved from available_quantity into locked_quantity
        // at placement time. Release the lock for this fill — which now
        // credits fillQty back into available_quantity (fixed contract)
        // — then immediately debit that same fillQty back out, since
        // it's being sold, not returned to the user. Net effect on
        // available_quantity is a drop of fillQty overall, same as
        // before, but nothing is left dangling in locked_quantity with
        // no corresponding credit. Finally, credit the USDT proceeds.
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

    if (order.side === "BUY" && (order.take_profit_price !== null || order.stop_loss_price !== null)) {
        await txQuery(
            connection,
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
    // layer once that hook exists, e.g.
    // broadcastToUser(msg.user_id, { type: "spot_fill", ...msg }).
}

async function persistExitFill(connection, msg, symbol, fillQty, fillPrice) {
    await txQuery(
        connection,
        `INSERT INTO spot_trades (order_id, user_id, symbol, quantity, price, commission)
         VALUES (?, ?, ?, ?, ?, 0)`,
        [msg.order_id, msg.user_id, symbol, fillQty, fillPrice]
    );

    // The position's asset has been sitting in locked_quantity since the
    // entry fill (see persistEntryFill above). Release it — which now
    // credits fillQty back into available_quantity (fixed contract,
    // same as a cancel) — then debit that same fillQty straight back
    // out, since it's being sold to close the position rather than
    // returned to the user. Then credit the USDT proceeds.
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

    const result = await txQuery(
        connection,
        `UPDATE spot_positions SET status = 'CLOSED', closed_at = CURRENT_TIMESTAMP
         WHERE order_id = ? AND status = 'OPEN'`,
        [msg.order_id]
    );
    if (result.affectedRows === 0) {
        console.error(`Exit EXECUTION for order_id=${msg.order_id} found no OPEN position to close`);
    }

    // realized_pnl isn't persisted anywhere — it's always derivable as
    // (exit trade price - position.entry_price) * quantity when needed
    // for display, so recompute it there rather than storing a value
    // that could drift from the source rows.

    // TODO: broadcast this close to the user over the WebSocket layer,
    // same as persistEntryFill above.
}

engineEvents.on("execution", handleExecution);

/* ═══════════════════════════════════════════════════════════════════════
   ORDER BOOK RECOVERY — unchanged from before
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
   REQUIRED SCHEMA CHANGE

   spot_orders needs one new column to persist the price a lock was
   computed against, so cancel/fill can recompute the exact reserved
   amount without a separate ledger table:

     ALTER TABLE spot_orders
       ADD COLUMN locked_price DECIMAL(20,8) DEFAULT NULL AFTER limit_price;

   For BUY orders this is set once, at placement, to entry_price_reference
   (market price for MARKET orders, limit_price for LIMIT orders). It is
   never updated afterwards — remaining_quantity already shrinks with
   each partial fill, so remaining_quantity * locked_price always equals
   what's still actually reserved. SELL orders don't need it (their lock
   amount is just remaining_quantity of the base asset), so it stays NULL
   there.

   WIRE-UP (in your main server file, next to the other routers):
     const spotTradeRoutes = require("./routes/spotPanel_Route");
     app.use("/", spotTradeRoutes);

   Requires Node 18+ for the global `fetch` used in getMarketPrice().
   Requires the C++ engine (trade_engine.cpp) running and reachable.
   This file registers engineEvents listeners as a side effect of being
   required — require it exactly once per process.
   ═══════════════════════════════════════════════════════════════════════ */