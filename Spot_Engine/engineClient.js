// engineClient.js
// -----------------------------------------------------------------------
// Shared TCP client for the CryptoTrade C++ engine (trade_engine.cpp).
//
// IMPORTANT: this module opens exactly ONE TCP connection to the engine
// for the whole Node process, and every call to sendOrderToEngine() reuses
// it — regardless of which user placed the order. We do NOT open a new
// socket per request; that's the whole point of this module.
//
// Because many orders from many users can be in flight on that single
// connection at the same time, each outgoing packet gets a unique
// request_id. The engine echoes it back on the matching reply, and this
// module uses it to resolve the right pending promise — so replies don't
// have to arrive in the same order the requests were sent.
//
// Framing: one JSON object per line (newline-delimited), in both
// directions, so multiple messages can be pipelined over the same socket.
//
// If the connection drops, this module automatically reconnects with a
// short backoff. Requests made while disconnected are queued and flushed
// once the connection is back up (up to a bounded wait — see PENDING
// TIMEOUT below), so a brief reconnect doesn't have to fail every order
// mid-blip.
// -----------------------------------------------------------------------

const net = require("net");
const crypto = require("crypto");

const ENGINE_HOST = process.env.TRADE_ENGINE_HOST || "127.0.0.1";
const ENGINE_PORT = parseInt(process.env.TRADE_ENGINE_PORT || "9000", 10);
const RECONNECT_DELAY_MS = 2000;
const PENDING_TIMEOUT_MS = 5000;

/* ═══════════════════════════════════════════════════════════════════════
   SHARED CONNECTION STATE (module-level singleton — one per Node process)
   ═══════════════════════════════════════════════════════════════════════ */
let socket = null;
let connected = false;
let recvBuffer = "";

// request_id -> { resolve, reject, timer, sent }
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

function handleLine(line) {
    if (!line) return;

    let reply;
    try {
        reply = JSON.parse(line);
    } catch (err) {
        console.error("Trade engine sent invalid JSON, dropping line:", line);
        return;
    }

    const requestId = reply.request_id;
    const entry = pending.get(requestId);
    if (!entry) {
        // No one is waiting on this anymore (e.g. it already timed out).
        return;
    }

    pending.delete(requestId);
    clearTimeout(entry.timer);
    entry.resolve(reply);
}

function connect() {
    socket = new net.Socket();

    socket.connect(ENGINE_PORT, ENGINE_HOST, () => {
        connected = true;
        console.log(`Connected to trade engine at ${ENGINE_HOST}:${ENGINE_PORT} (shared connection)`);
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
        failInFlightPending(`Trade engine connection was lost: ${lastErrorMessage}`);
        setTimeout(connect, RECONNECT_DELAY_MS);
    });
}

// Establish the shared connection once, as soon as this module is loaded.
connect();

/* ═══════════════════════════════════════════════════════════════════════
   PUBLIC API
   ───────────────────────────────────────────────────────────────────────
   Every caller — no matter which user's request triggered it — goes
   through this same function, which writes onto the one shared socket.
   ═══════════════════════════════════════════════════════════════════════ */
function sendOrderToEngine(orderPacket) {
    return new Promise((resolve, reject) => {
        const requestId = generateRequestId();
        const packetWithId = { request_id: requestId, ...orderPacket };
        const line = JSON.stringify(packetWithId) + "\n";

        const timer = setTimeout(() => {
            pending.delete(requestId);
            reject(new Error("Timed out waiting for the trade engine"));
        }, PENDING_TIMEOUT_MS);

        if (connected) {
            pending.set(requestId, { resolve, reject, timer, sent: true });
            socket.write(line);
        } else {
            // Engine is mid-reconnect — queue it, the pending timeout above
            // still protects us if it never comes back in time.
            pending.set(requestId, { resolve, reject, timer, sent: false });
            writeQueue.push({ requestId, line });
        }
    });
}

module.exports = { sendOrderToEngine };