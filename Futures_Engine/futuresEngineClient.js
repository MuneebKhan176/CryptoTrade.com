// futuresEngineClient.js
const net = require("net");
const crypto = require("crypto");
const { EventEmitter } = require("events");

const ENGINE_HOST = process.env.FUTURES_ENGINE_HOST || "127.0.0.1";
const ENGINE_PORT = parseInt(process.env.FUTURES_ENGINE_PORT || "9001", 10);
const RECONNECT_DELAY_MS = 2000;
const PENDING_TIMEOUT_MS = 5000;

const engineEvents = new EventEmitter();

let socket = null;
let connected = false;
let recvBuffer = "";

// request_id -> { resolve, reject, timer, sent, collect }
// Only used for PLACE_ORDER / CANCEL_ORDER, the only two actions that
// get a real ORDER_ACK / CANCEL_ACK back from the engine.
const pending = new Map();
const writeQueue = [];

// Plain lines waiting to go out once reconnected, for the fire-and-forget
// actions below (PRICE_UPDATE, MARK_PRICE_UPDATE, FUNDING_TICK,
// UPDATE_TP_SL, SYNC_WALLET, SYNC_POSITION). No promise/timeout tracking
// here — there is nothing on the wire to resolve against for these, see
// the STATIC vs LIVE header note below.
const fireAndForgetQueue = [];

function generateRequestId() {
    return crypto.randomUUID();
}

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
        if (!entry) continue;
        socket.write(line);
        entry.sent = true;
    }
}

function flushFireAndForgetQueue() {
    while (fireAndForgetQueue.length > 0 && connected) {
        socket.write(fireAndForgetQueue.shift());
    }
}

// ─────────────────────────────────────────────────────────────────────
// WIRE PROTOCOL NOTE: the C++ engine only ever sends ORDER_ACK /
// CANCEL_ACK in direct response to PLACE_ORDER / CANCEL_ORDER. Every
// other action (PRICE_UPDATE, MARK_PRICE_UPDATE, FUNDING_TICK,
// UPDATE_TP_SL, SYNC_WALLET, SYNC_POSITION) either produces no reply at
// all (nothing to report — e.g. MARK_PRICE_UPDATE with no open
// positions for that symbol) or produces a push-style message
// (ORDER_BOOK_UPDATE / POSITION_UPDATE / MARGIN_UPDATE / etc.) that is
// NOT correlated back to a specific request via an ack. Routing those
// six actions through the same pending/timeout machinery as
// PLACE_ORDER means the promise can never resolve — it always times
// out at PENDING_TIMEOUT_MS, even though the engine handled the packet
// correctly. That was the cause of the "Timed out waiting for the
// futures engine" spam despite the C++ side logging a normal reply.
// ─────────────────────────────────────────────────────────────────────

function handleLine(line) {
    if (!line) return;
    let msg;
    try {
        msg = JSON.parse(line);
    } catch (err) {
        console.error("Futures engine sent invalid JSON, dropping line:", line);
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
            engineEvents.emit("execution", msg);
            if (entry && entry.collect) entry.collect.push(msg);
            break;
        }
        case "POSITION_UPDATE": {
            engineEvents.emit("positionUpdate", msg);
            if (entry && entry.collect) entry.collect.push(msg);
            break;
        }
        case "MARGIN_UPDATE": {
            engineEvents.emit("marginUpdate", msg);
            if (entry && entry.collect) entry.collect.push(msg);
            break;
        }
        case "LIQUIDATION": {
            engineEvents.emit("liquidation", msg);
            if (entry && entry.collect) entry.collect.push(msg);
            break;
        }
        case "FUNDING_APPLIED": {
            engineEvents.emit("fundingApplied", msg);
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
                entry.reject(new Error(msg.message || "Futures engine error"));
            } else {
                console.error("Futures engine ERROR (unsolicited):", msg.message);
                engineEvents.emit("engineError", msg);
            }
            break;
        }
        default: {
            console.error("Futures engine sent unknown message type, dropping:", line);
        }
    }
}

function connect() {
    socket = new net.Socket();

    socket.connect(ENGINE_PORT, ENGINE_HOST, () => {
        connected = true;
        console.log(`Connected to futures engine at ${ENGINE_HOST}:${ENGINE_PORT} (shared connection)`);
        engineEvents.emit("connected");
        flushWriteQueue();
        flushFireAndForgetQueue();
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

    let lastErrorMessage = "socket closed";
    socket.on("error", (err) => { lastErrorMessage = err.message; });

    socket.on("close", () => {
        if (connected) {
            console.error(`Futures engine connection lost (${lastErrorMessage}) — reconnecting in ${RECONNECT_DELAY_MS}ms`);
        }
        connected = false;
        recvBuffer = "";
        engineEvents.emit("disconnected", lastErrorMessage);
        failInFlightPending(`Futures engine connection was lost: ${lastErrorMessage}`);
        setTimeout(connect, RECONNECT_DELAY_MS);
    });
}

connect();

// Request/reply path — ONLY for actions that get a real ORDER_ACK /
// CANCEL_ACK back (PLACE_ORDER, CANCEL_ORDER).
function sendPacket(packet, { collectPushMessages = false } = {}) {
    return new Promise((resolve, reject) => {
        const requestId = packet.request_id || generateRequestId();
        const packetWithId = { ...packet, request_id: requestId };
        const line = JSON.stringify(packetWithId) + "\n";
        const collect = collectPushMessages ? [] : undefined;

        const timer = setTimeout(() => {
            pending.delete(requestId);
            reject(new Error("Timed out waiting for the futures engine"));
        }, PENDING_TIMEOUT_MS);

        const wrappedResolve = (ackMsg) => {
            resolve(collect ? { ack: ackMsg, pushMessages: collect } : ackMsg);
        };

        if (connected) {
            pending.set(requestId, { resolve: wrappedResolve, reject, timer, sent: true, collect });
            socket.write(line);
        } else {
            pending.set(requestId, { resolve: wrappedResolve, reject, timer, sent: false, collect });
            writeQueue.push({ requestId, line });
        }
    });
}

// Fire-and-forget path — for every action that has no ack on the wire
// (PRICE_UPDATE, MARK_PRICE_UPDATE, FUNDING_TICK, UPDATE_TP_SL,
// SYNC_WALLET, SYNC_POSITION). Resolves immediately once the line is on
// the wire (or queued for the next reconnect) — there is nothing to wait
// for. Any resulting POSITION_UPDATE/MARGIN_UPDATE/etc. from the engine
// still arrives normally and is still emitted on engineEvents by
// handleLine above; this function just doesn't block on it.
function sendFireAndForget(packet) {
    const requestId = packet.request_id || generateRequestId();
    const packetWithId = { ...packet, request_id: requestId };
    const line = JSON.stringify(packetWithId) + "\n";

    if (connected) {
        socket.write(line);
    } else {
        fireAndForgetQueue.push(line);
    }
    return Promise.resolve({ request_id: requestId });
}

/* ═══════════════════════════════════════════════════════════════════════
   PUBLIC API
   ═══════════════════════════════════════════════════════════════════════ */

function sendOrderToEngine(order) {
    return sendPacket({ action: "PLACE_ORDER", ...order }, { collectPushMessages: true }).then((result) => {
        if (!result.ack || result.ack.type !== "ORDER_ACK") {
            throw new Error("Unexpected reply from futures engine for PLACE_ORDER");
        }
        return result;
    });
}

function cancelOrderOnEngine(orderId, symbol) {
    return sendPacket({ action: "CANCEL_ORDER", order_id: orderId, symbol }).then((ack) => {
        if (!ack || ack.type !== "CANCEL_ACK") {
            throw new Error("Unexpected reply from futures engine for CANCEL_ORDER");
        }
        return ack;
    });
}

// CHANGED: fire-and-forget — was routed through sendPacket() before,
// which could never resolve since PRICE_UPDATE has no ack reply.
function sendPriceUpdate(symbol, price) {
    return sendFireAndForget({ action: "PRICE_UPDATE", symbol, price });
}

// CHANGED: fire-and-forget — same reason. This is the highest-frequency
// call in the module; it must not carry a 5s timeout per tick.
function sendMarkPriceUpdate(symbol, markPrice) {
    return sendFireAndForget({ action: "MARK_PRICE_UPDATE", symbol, mark_price: markPrice });
}

// CHANGED: fire-and-forget — FUNDING_TICK has no ack either.
function sendFundingTick(symbol, fundingRate) {
    return sendFireAndForget({ action: "FUNDING_TICK", symbol, funding_rate: fundingRate });
}

// CHANGED: fire-and-forget — UPDATE_TP_SL replies with POSITION_UPDATE
// or ERROR, never an ack. Callers that persist TP/SL to MySQL after a
// "successful" call should instead persist optimistically and rely on
// the resulting POSITION_UPDATE / 'positionUpdate' event to confirm,
// since this promise no longer reflects the engine's actual outcome.
function updateTakeProfitStopLoss(userId, symbol, positionSide, { take_profit, stop_loss } = {}) {
    const packet = { action: "UPDATE_TP_SL", user_id: userId, symbol, position_side: positionSide };
    if (take_profit !== undefined) packet.take_profit = take_profit;
    if (stop_loss !== undefined) packet.stop_loss = stop_loss;
    return sendFireAndForget(packet);
}

// CHANGED: fire-and-forget — SYNC_WALLET only ever replies with
// MARGIN_UPDATE, never an ack.
function syncWallet(userId, walletId, walletBalance, positionMode) {
    return sendFireAndForget({
        action: "SYNC_WALLET",
        user_id: userId,
        wallet_id: walletId,
        wallet_balance: walletBalance,
        position_mode: positionMode,
    });
}

// CHANGED: fire-and-forget — SYNC_POSITION only ever replies with
// MARGIN_UPDATE, never an ack.
function syncPosition(position) {
    const { userId, walletId, symbol, positionSide, marginMode, quantity, entryPrice, leverage, takeProfit, stopLoss } = position;
    const packet = {
        action: "SYNC_POSITION",
        user_id: userId,
        wallet_id: walletId,
        symbol,
        position_side: positionSide,
        margin_mode: marginMode,
        quantity,
        limit_price: entryPrice,
        leverage,
    };
    if (takeProfit !== undefined && takeProfit !== null) packet.take_profit = takeProfit;
    if (stopLoss !== undefined && stopLoss !== null) packet.stop_loss = stopLoss;
    return sendFireAndForget(packet);
}

module.exports = {
    sendOrderToEngine,
    cancelOrderOnEngine,
    sendPriceUpdate,
    sendMarkPriceUpdate,
    sendFundingTick,
    updateTakeProfitStopLoss,
    syncWallet,
    syncPosition,
    engineEvents,
};