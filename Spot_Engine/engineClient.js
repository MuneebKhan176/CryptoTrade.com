// engineClient.js
// -----------------------------------------------------------------------
// Shared TCP client for the CryptoTrade C++ spot trading engine
// (trade_engine.cpp).
//
// IMPORTANT: this module opens exactly ONE TCP connection to the engine
// for the whole Node process, and every call reuses it — regardless of
// which user placed the order. We do NOT open a new socket per request.
//
// Two kinds of traffic flow back over that one socket:
//
//   1. REQUEST/RESPONSE — Node sends PLACE_ORDER / CANCEL_ORDER /
//      PRICE_UPDATE with a request_id, and gets back an immediate
//      ORDER_ACK / CANCEL_ACK carrying that same request_id. This module
//      resolves the matching pending promise for those.
//
//   2. PUSH EVENTS — the engine can also emit EXECUTION and
//      ORDER_BOOK_UPDATE messages that are NOT replies to a specific
//      call. A resting LIMIT order can fill minutes after it was placed,
//      triggered by a PRICE_UPDATE that had nothing to do with that
//      order; an OCO leg fires the same way. These arrive with the
//      request_id of whatever inbound packet triggered them (which is
//      usually a PRICE_UPDATE Node's price-poller sent, not something a
//      route handler is awaiting), so they are NOT resolved against
//      `pending` — they're emitted as events instead. Route handlers /
//      services subscribe with `engineEvents.on('execution', ...)` etc.
//
// This client is a thin, order-type-agnostic pass-through: it doesn't
// interpret order_type at all, so nothing here changed functionally when
// OCO was added as a first-class order type — the caller (spotPanel_Route.js)
// is responsible for populating limit_price / stop_price correctly per
// the wire protocol below.
//
// WIRE PROTOCOL — Node -> Engine PLACE_ORDER payload:
//   { order_id, user_id, wallet_id, symbol, side, order_type, quantity,
//     limit_price?,  // LIMIT: the limit price. OCO: upper/take-profit-style leg.
//     stop_price? }  // OCO only: the lower/stop-loss-style leg.
//   There is no take_profit_price / stop_loss_price on this wire anymore
//   — TP/SL-on-BUY was replaced by OCO as a standalone SELL order type.
//
// WIRE PROTOCOL — Engine -> Node EXECUTION payload includes:
//   { ..., is_oco_leg, oco_leg? }  // oco_leg is "LIMIT" or "STOP", present
//   only when is_oco_leg is true, identifying which leg fired. There is
//   no is_exit_order field anymore — every EXECUTION is a plain BUY or
//   SELL fill; OCO legs are SELL fills like any other.
//
// Framing: one JSON object per line (newline-delimited), in both
// directions, so multiple messages can be pipelined over the same socket
// — and a single inbound packet to the engine can produce MULTIPLE
// outbound lines (e.g. an ORDER_ACK followed by an EXECUTION followed by
// an ORDER_BOOK_UPDATE). Every line is processed independently.
//
// If the connection drops, this module automatically reconnects with a
// short backoff. Requests made while disconnected are queued and flushed
// once the connection is back up (up to a bounded wait — see PENDING
// TIMEOUT below), so a brief reconnect doesn't have to fail every order
// mid-blip.
//
// NOTE ON STATE: the engine's order books are RAM-only and are wiped on
// engine restart. If the connection drops and reconnects, any orders that
// were resting on the engine's book are gone from its memory — Node's
// MySQL `spot_orders` rows for those will still show OPEN. Whoever owns
// reconciliation (e.g. a startup job) is responsible for re-submitting
// still-OPEN LIMIT/OCO orders to the engine after a reconnect; this module
// does not do that automatically, since it can't tell "fresh engine
// process" apart from "same engine, brief network blip" on its own.
// (See recoverOpenOrdersToEngine() in spotPanel_Route.js.)
// -----------------------------------------------------------------------

const net = require("net");
const crypto = require("crypto");
const { EventEmitter } = require("events");

const ENGINE_HOST = process.env.TRADE_ENGINE_HOST || "127.0.0.1";
const ENGINE_PORT = parseInt(process.env.TRADE_ENGINE_PORT || "9000", 10);
const RECONNECT_DELAY_MS = 2000;
const PENDING_TIMEOUT_MS = 5000;

/* ═══════════════════════════════════════════════════════════════════════
   PUSH EVENT EMITTER
   ───────────────────────────────────────────────────────────────────────
   Subscribe to these from wherever fills/book updates need to be
   persisted to MySQL and broadcast over WebSockets, e.g.:
     const { engineEvents } = require("./engineClient");
     engineEvents.on("execution", (msg) => { ...persist + broadcast... });
     engineEvents.on("orderBookUpdate", (msg) => { ...broadcast... });
   ═══════════════════════════════════════════════════════════════════════ */
const engineEvents = new EventEmitter();

/* ═══════════════════════════════════════════════════════════════════════
   SHARED CONNECTION STATE (module-level singleton — one per Node process)
   ═══════════════════════════════════════════════════════════════════════ */
let socket = null;
let connected = false;
let recvBuffer = "";

// request_id -> { resolve, reject, timer, sent, expectedType }
// `sent` distinguishes two very different situations on disconnect:
//   - sent === true : the packet already went out on a socket that then
//     died, so we genuinely don't know if the engine processed it. Fail it.
//   - sent === false: the packet never made it onto the wire (we were
//     mid-reconnect), so it's safe to just leave it queued — it'll go out
//     as soon as the new connection is up, no data was lost.
const pending = new Map();

// Packets queued because the socket wasn't connected yet when they were sent.
const writeQueue = [];

function generateRequestId() {
    return crypto.randomUUID();
}

// Only fails requests that were actually in flight on the connection that
// just died — queued-but-unsent requests are left alone so they can be
// flushed once we reconnect.
function failInFlightPending(reason) {
    for (const [requestId, entry] of pending.entries()) {
        if (!entry.sent) continue;
        clearTimeout(entry.timer);
        entry.reject(new Error(reason));
        pending.delete(requestId);
    }
}

function flushWriteQueue() {
    while (writeQueue.length > 0 && connected) {
        const { requestId, line } = writeQueue.shift();
        const entry = pending.get(requestId);
        if (!entry) continue; // its timeout already fired and it was removed
        socket.write(line);
        entry.sent = true;
    }
}

// A single inbound Node->engine packet can produce several outbound
// lines. We route each one independently:
//   - ORDER_ACK / CANCEL_ACK  -> resolves the pending promise for that
//     request_id (the immediate reply to a PLACE_ORDER/CANCEL_ORDER call).
//   - EXECUTION / ORDER_BOOK_UPDATE -> always emitted as an event. If a
//     PRICE_UPDATE call is still awaiting its own ack, these are also
//     surfaced there so a direct caller can see synchronous fills too
//     (see sendPriceUpdate below), but they are never used to resolve
//     ORDER_ACK/CANCEL_ACK promises.
//   - ERROR -> rejects the pending promise for that request_id if one
//     exists, otherwise emitted as an event.
function handleLine(line) {
    if (!line) return;

    let msg;
    try {
        msg = JSON.parse(line);
    } catch (err) {
        console.error("Trade engine sent invalid JSON, dropping line:", line);
        return;
    }

    const type = msg.type;
    const requestId = msg.request_id;
    const entry = requestId ? pending.get(requestId) : undefined;

    switch (type) {
        case "ORDER_ACK":
        case "CANCEL_ACK": {
            if (entry) {
                pending.delete(requestId);
                clearTimeout(entry.timer);
                entry.resolve(msg);
            }
            break;
        }
        case "EXECUTION": {
            // msg.is_oco_leg / msg.oco_leg identify OCO fills; every
            // other field is the same shape as a plain BUY/SELL fill, so
            // downstream persistence doesn't need a separate code path.
            engineEvents.emit("execution", msg);
            if (entry && entry.collect) entry.collect.push(msg);
            break;
        }
        case "ORDER_BOOK_UPDATE": {
            engineEvents.emit("orderBookUpdate", msg);
            if (entry && entry.collect) entry.collect.push(msg);
            break;
        }
        case "ERROR": {
            if (entry) {
                pending.delete(requestId);
                clearTimeout(entry.timer);
                entry.reject(new Error(msg.message || "Trade engine error"));
            } else {
                console.error("Trade engine ERROR (unsolicited):", msg.message);
                engineEvents.emit("engineError", msg);
            }
            break;
        }
        default: {
            console.error("Trade engine sent unknown message type, dropping:", line);
        }
    }
}

function connect() {
    socket = new net.Socket();

    socket.connect(ENGINE_PORT, ENGINE_HOST, () => {
        connected = true;
        console.log(`Connected to trade engine at ${ENGINE_HOST}:${ENGINE_PORT} (shared connection)`);
        engineEvents.emit("connected");
        flushWriteQueue();
    });

    socket.on("data", (chunk) => {
        recvBuffer += chunk.toString();

        let newlineIndex;
        while ((newlineIndex = recvBuffer.indexOf("\n")) !== -1) {
            const line = recvBuffer.slice(0, newlineIndex);
            recvBuffer = recvBuffer.slice(newlineIndex + 1);
            handleLine(line);
        }
    });

    // 'error' and 'close' both fire for the same broken connection (a
    // socket error is always followed by a close), so reconnect scheduling
    // lives ONLY in the 'close' handler — otherwise a single failure would
    // schedule two separate reconnect attempts and open two sockets.
    let lastErrorMessage = "socket closed";

    socket.on("error", (err) => {
        lastErrorMessage = err.message;
    });

    socket.on("close", () => {
        if (connected) {
            console.error(`Trade engine connection lost (${lastErrorMessage}) — reconnecting in ${RECONNECT_DELAY_MS}ms`);
        }
        connected = false;
        recvBuffer = "";
        engineEvents.emit("disconnected", lastErrorMessage);
        failInFlightPending(`Trade engine connection was lost: ${lastErrorMessage}`);
        setTimeout(connect, RECONNECT_DELAY_MS);
    });
}

// Establish the shared connection once, as soon as this module is loaded.
connect();

/* ═══════════════════════════════════════════════════════════════════════
   INTERNAL: send one packet, wait for its ack, optionally collect any
   EXECUTION / ORDER_BOOK_UPDATE lines that arrive before the ack does
   (they're written by the engine in the same batch, so in practice they
   arrive first).
   ═══════════════════════════════════════════════════════════════════════ */
function sendPacket(packet, { collectPushMessages = false } = {}) {
    return new Promise((resolve, reject) => {
        const requestId = packet.request_id || generateRequestId();
        const packetWithId = { ...packet, request_id: requestId };
        const line = JSON.stringify(packetWithId) + "\n";

        const collect = collectPushMessages ? [] : undefined;

        const timer = setTimeout(() => {
            pending.delete(requestId);
            reject(new Error("Timed out waiting for the trade engine"));
        }, PENDING_TIMEOUT_MS);

        const wrappedResolve = (ackMsg) => {
            resolve(collect ? { ack: ackMsg, pushMessages: collect } : ackMsg);
        };

        if (connected) {
            pending.set(requestId, { resolve: wrappedResolve, reject, timer, sent: true, collect });
            socket.write(line);
        } else {
            // Engine is mid-reconnect — queue it, the pending timeout above
            // still protects us if it never comes back in time.
            pending.set(requestId, { resolve: wrappedResolve, reject, timer, sent: false, collect });
            writeQueue.push({ requestId, line });
        }
    });
}

/* ═══════════════════════════════════════════════════════════════════════
   PUBLIC API
   ───────────────────────────────────────────────────────────────────────
   Every caller — no matter which user's request triggered it — goes
   through these functions, which write onto the one shared socket.
   Node must have already run ALL pre-trade validation (auth, balance
   checks, business rules) before calling sendOrderToEngine; the engine
   only re-checks packet integrity / known trading pair.
   ═══════════════════════════════════════════════════════════════════════ */

// order: { order_id, user_id, wallet_id, symbol, side, order_type,
//          quantity, limit_price?, stop_price? }
//   - MARKET: no limit_price, no stop_price.
//   - LIMIT:  limit_price required, no stop_price.
//   - OCO:    limit_price (upper/take-profit leg) and stop_price
//             (lower/stop-loss leg) both required; side must be SELL.
// Resolves with the ORDER_ACK payload: { accepted, message, errors, engine_order_id, ... }
// Any EXECUTION this placement causes synchronously (a MARKET fill, or a
// LIMIT/OCO leg that was immediately marketable) is ALSO emitted on
// engineEvents as usual — persist/broadcast it there, don't rely on the
// ack alone for that.
function sendOrderToEngine(order) {
    return sendPacket({ action: "PLACE_ORDER", ...order }).then((ack) => {
        if (!ack || ack.type !== "ORDER_ACK") {
            throw new Error("Unexpected reply from trade engine for PLACE_ORDER");
        }
        return ack;
    });
}

// Cancels a resting LIMIT or OCO order by its MySQL spot_orders.order_id.
// For OCO the engine cancels both legs internally. Resolves with the
// CANCEL_ACK payload: { cancelled, message }.
function cancelOrderOnEngine(orderId, symbol) {
    return sendPacket({ action: "CANCEL_ORDER", order_id: orderId, symbol }).then((ack) => {
        if (!ack || ack.type !== "CANCEL_ACK") {
            throw new Error("Unexpected reply from trade engine for CANCEL_ORDER");
        }
        return ack;
    });
}

// Forwards a live price tick (e.g. from the Binance REST poller) to the
// engine so it can evaluate resting LIMIT orders and OCO legs for that
// symbol. Any resulting fills are emitted on engineEvents('execution')
// as they happen — this call's own return value is mostly useful for
// logging/debugging, not for driving persistence (subscribe to the event
// instead, since fills can also happen from OTHER callers' price ticks).
function sendPriceUpdate(symbol, price) {
    return sendPacket({ action: "PRICE_UPDATE", symbol, price }, { collectPushMessages: true });
}

module.exports = {
    sendOrderToEngine,
    cancelOrderOnEngine,
    sendPriceUpdate,
    engineEvents,
};