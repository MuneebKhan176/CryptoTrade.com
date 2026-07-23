// futuresLive_ws.js
// -----------------------------------------------------------------------
// WebSocket gateway for LIVE futures data — mark price, unrealized PnL,
// liquidation price, used/available margin. This is the piece that
// replaces polling /api/futures/positions and /api/futures/wallet for
// anything tick-driven. Static data (quantity, entry_price, leverage,
// TP/SL, order/position lifecycle) still comes from routes/
// futuresPanel_Route.js over plain REST, backed by MySQL — this file
// never touches the database, same as Futures_Engine/LiveStateStore.js,
// which is what it's reading from.
//
// Auth pattern is copied from Web_Sockets/marketData_ws.js on purpose,
// since both need to tag a socket with a userId from the same cookie.
// ⚠ Same caveat as that file: CONFIRM the cookie name and the decoded
// payload's id field against middle/middleware.js. It reads:
//     const token = req.cookies?.token || req.headers['authorization']?.split(' ')[1];
//     jwt.verify(token, jwtSecret) -> decoded, then req.user = decoded
// so this file mirrors that exactly (cookie name 'token', jwtSecret from
// db_connection.js, decoded.id as the user id) rather than re-guessing.
//
// Unlike marketData_ws.js, this gateway has (almost) nothing useful to
// say to an anonymous visitor — positions and margin are private. An
// unauthenticated connection is still accepted (so a stray reconnect
// attempt doesn't throw on the client) but gets no snapshot and is
// dropped from every per-user push.
// -----------------------------------------------------------------------

const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const { jwtSecret } = require('../db_connection');
const { engineEvents } = require('../Futures_Engine/futuresEngineClient');
const { getUserPositionSnapshots, getWalletSnapshot, } = require('../Futures_Engine/LiveStateStore');

const WS_PATH = '/ws/futures-data';

const clients = new Set();

function getUserIdFromRequest(req) {
  try {
    const raw = req.headers.cookie || '';
    const cookies = Object.fromEntries(
      raw.split(';').filter(Boolean).map(c => {
        const idx = c.indexOf('=');
        return [c.slice(0, idx).trim(), decodeURIComponent(c.slice(idx + 1).trim())];
      })
    );
    const token = cookies.token || req.headers['authorization']?.split(' ')[1];
    if (!token) return null;
    const decoded = jwt.verify(token, jwtSecret);
    return decoded.id || decoded.userId || null;
  } catch (e) {
    return null; // anonymous — not a crash
  }
}

function sendTo(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

/* ── Per-user snapshot sent right after connect, so the panel isn't
   empty while waiting for the next mark-price tick. ────────────────── */
function sendInitialSnapshot(ws) {
  if (!ws.userId) return;
  const positions = getUserPositionSnapshots(ws.userId); // live-only fields, keyed by position_key
  const margin = getWalletSnapshot(ws.userId);
  sendTo(ws, { type: 'snapshot', positions, margin, ts: Date.now() });
}

/* ── engineEvents wiring — same events Futures_Engine/LiveStateStore.js
   already normalizes, just fanned out to the matching user's sockets
   instead of into an in-memory Map. ─────────────────────────────────── */
function attachEngineListeners() {
  // 'liveTick' is LiveStateStore's own normalized re-emit (kind:
  // 'position' | 'margin') — subscribe to that, not the raw
  // positionUpdate/marginUpdate events, so this file doesn't have to
  // duplicate LiveStateStore's parsing.
  engineEvents.on('liveTick', (tick) => {
    const userId = tick.snapshot && tick.snapshot.user_id;
    if (!userId) return;
    for (const ws of clients) {
      if (ws.userId === userId) {
        sendTo(ws, { type: 'liveTick', kind: tick.kind, snapshot: tick.snapshot, ts: Date.now() });
      }
    }
  });

  // Structural changes — nudge the affected user's sockets to refetch
  // the static REST endpoints (positions list, orders, history, wallet
  // balance). Mirrors marketData_ws.js's notifyUserTradeUpdate pattern:
  // the payload is intentionally thin, the client always re-fetches
  // rather than trusting a push body to fully describe the new state.
  const nudge = (eventName) => (msg) => {
    const userId = msg.user_id;
    if (!userId) return;
    for (const ws of clients) {
      if (ws.userId === userId) {
        sendTo(ws, { type: 'trade_update', reason: eventName, symbol: msg.symbol, ts: Date.now() });
      }
    }
  };
  engineEvents.on('execution', nudge('execution'));
  engineEvents.on('liquidation', nudge('liquidation'));
  engineEvents.on('fundingApplied', nudge('fundingApplied'));

  // Order book top-of-book is public, not per-user — broadcast to every
  // connected client on this path regardless of auth. Purely additive:
  // the frontend's existing 4s REST poll stays as a fallback.
  engineEvents.on('orderBookUpdate', (msg) => {
    for (const ws of clients) sendTo(ws, { type: 'orderBookUpdate', data: msg, ts: Date.now() });
  });
}

let listenersAttached = false;

/**
 * Call once from Web_Sockets/ws_manager.js, the same way it already
 * calls marketData_ws.js's initialize(wss) — pass a `ws.Server` bound to
 * WS_PATH. See the note at the bottom of this file for the exact wiring
 * to add there.
 */
function initialize(wss) {
  if (!listenersAttached) {
    attachEngineListeners();
    listenersAttached = true; // engineEvents is a module-level singleton — only wire it once even if initialize() is ever called more than once
  }

  wss.on('connection', (ws, req) => {
    ws.userId = getUserIdFromRequest(req);
    clients.add(ws);

    sendInitialSnapshot(ws);

    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
  });
}

module.exports = { initialize, WS_PATH };

/* ═══════════════════════════════════════════════════════════════════════
   WIRING INTO Web_Sockets/ws_manager.js
   ───────────────────────────────────────────────────────────────────────
   I don't have that file's contents, so I can't edit it directly — but
   based on marketData_ws.js exporting { initialize, WS_PATH } and
   presumably being registered there already, add this module the same
   way, e.g.:

       const futuresLiveWs = require('./futuresLive_ws');
       // ... wherever marketData_ws's WS_PATH is bound to a
       // WebSocketServer / upgrade handler, do the same for
       // futuresLiveWs.WS_PATH -> futuresLiveWs.initialize(wss)

   If ws_manager.js uses a single `ws.Server({ noServer: true })` with a
   manual `server.on('upgrade', ...)` switch on `req.url`, add a branch
   for futuresLiveWs.WS_PATH there, same shape as the existing branch for
   marketData_ws.WS_PATH.
   ═══════════════════════════════════════════════════════════════════════ */