// liveStateStore.js
// -----------------------------------------------------------------------
// In-memory cache for everything that changes every tick: mark price,
// unrealized PnL, margin ratio, liquidation price, used/available margin.
// This is the piece that replaces "query MySQL per position, thousands
// of times a second" — it's a plain object graph in Node's process
// memory, updated directly from futures engine push events, and read
// directly by whatever pushes updates to the frontend (WebSocket/SSE/
// your own TCP-to-browser bridge). No DB round trip anywhere in this file.
//
// LIFECYCLE:
//   - Populated by subscribing to engineEvents('positionUpdate') and
//     engineEvents('marginUpdate') from futuresEngineClient.js — wire
//     attachLiveStateListeners() once at server startup, alongside (not
//     instead of) whatever persists discrete events to MySQL (see
//     futuresPersistence.js).
//   - Read by REST endpoints (getPositionSnapshot / getWalletSnapshot)
//     for "give me the current state right now" (e.g. page load) and by
//     your WebSocket layer for "push this to the browser" on the same
//     events, so the frontend never has to poll MySQL either.
//   - NOT persisted. If the Node process restarts, this cache is empty
//     until MARK_PRICE_UPDATE/UPDATE_TP_SL/etc. ticks repopulate it —
//     that's fine, because on engine restart you're already re-hydrating
//     the engine itself via syncWallet()/syncPosition() (see
//     futuresEngineClient.js), and those SYNC_* calls' resulting
//     MARGIN_UPDATE/POSITION_UPDATE responses repopulate this cache too.
//   - Static fields (quantity, entry_price, leverage, take_profit, ...)
//     are intentionally NOT duplicated in here beyond what's needed to
//     merge with a DB row for display — this store's job is the live
//     slice only. See mergeForFrontend() for how a full position view
//     is assembled: static half from MySQL (fetched once, on page load /
//     reconnect), live half from here (fetched every tick, from RAM).
//
// THIS REVISION: also caches initial_margin off each POSITION_UPDATE
// tick, now that the engine sends it on every tick (it always did on
// positionUpdateToJson — see futures_engine.cpp) and mirrors margin_mode
// there — so a live tick can override a momentarily-stale DB value the
// same way mark_price/unrealized_pnl already do, instead of leaving
// initial_margin as purely a one-time-fetched DB field.
// -----------------------------------------------------------------------

const { engineEvents } = require("./futuresEngineClient");

// position_key ("<user_id>:<symbol>:<LONG|SHORT>") -> live snapshot
const livePositions = new Map();

// user_id -> live margin snapshot
const liveMargins = new Map();

function positionKey(userId, symbol, positionSide) {
    return `${userId}:${symbol}:${positionSide}`;
}

/**
 * Call once at server startup. Wires POSITION_UPDATE / MARGIN_UPDATE
 * push events straight into the in-memory maps above, and re-emits a
 * normalized 'liveTick' event your WebSocket/broadcast layer can
 * subscribe to without knowing anything about the engine wire format.
 */
function attachLiveStateListeners() {
    engineEvents.on("positionUpdate", (msg) => {
        const key = msg.position_key || positionKey(msg.user_id, msg.symbol, msg.position_side);

        if (msg.status === "CLOSED") {
            // Nothing left to show live for a closed position — drop it
            // from the cache. The static CLOSED record lives in MySQL
            // (positions.status), written by futuresPersistence.js off
            // the same underlying EXECUTION/LIQUIDATION event.
            livePositions.delete(key);
        } else {
            livePositions.set(key, {
                position_key: key,
                user_id: msg.user_id,
                wallet_id: msg.wallet_id,
                symbol: msg.symbol,
                position_side: msg.position_side,
                mark_price: msg.mark_price,
                unrealized_pnl: msg.unrealized_pnl,
                maintenance_margin: msg.maintenance_margin,
                initial_margin: msg.initial_margin,        // NEW — see file header
                liquidation_price: msg.liquidation_price, // null for CROSS, see engine header
                updated_at: Date.now(),
            });
        }

        engineEvents.emit("liveTick", { kind: "position", key, snapshot: livePositions.get(key) || { position_key: key, status: "CLOSED" } });
    });

    engineEvents.on("marginUpdate", (msg) => {
        // margin_ratio = used_margin / equity. Equity isn't sent directly
        // on the wire (the engine sends wallet_balance, used_margin,
        // available_margin), but equity = used_margin + available_margin
        // by construction (see AccountManager::recomputeMargin), so it's
        // derived here rather than requested as a separate field.
        const equity = msg.used_margin + msg.available_margin;
        const snapshot = {
            user_id: msg.user_id,
            wallet_id: msg.wallet_id,
            wallet_balance: msg.wallet_balance,
            used_margin: msg.used_margin,
            available_margin: msg.available_margin,
            margin_ratio: equity > 0 ? msg.used_margin / equity : 0,
            updated_at: Date.now(),
        };

        liveMargins.set(msg.user_id, snapshot);
        engineEvents.emit("liveTick", { kind: "margin", key: msg.user_id, snapshot });
    });
}

/** Live-only snapshot for one position, or null if none cached yet (e.g. position not opened, or engine hasn't ticked mark price for it yet). */
function getPositionSnapshot(userId, symbol, positionSide) {
    return livePositions.get(positionKey(userId, symbol, positionSide)) || null;
}

/** All cached live positions for a user (for a "my positions" live panel). */
function getUserPositionSnapshots(userId) {
    const out = [];
    for (const snap of livePositions.values()) {
        if (snap.user_id === userId) out.push(snap);
    }
    return out;
}

/** Live-only margin snapshot for one user, or null if not cached yet. */
function getWalletSnapshot(userId) {
    return liveMargins.get(userId) || null;
}

/**
 * Merge a static DB row (fetched once — page load, reconnect, or right
 * after the discrete event that changed it) with the live cache, for a
 * single "here's everything about this position" object to hand to the
 * frontend. This is the ONLY place static and live data are expected to
 * be combined — keep it that way rather than letting live fields leak
 * back into anything that gets persisted.
 *
 * initial_margin now prefers the live cache when a tick has already
 * updated it (e.g. right after a DCA fill or partial close/liquidation,
 * before the corresponding MySQL write has landed), falling back to the
 * DB row otherwise — same pattern already used for mark_price/uPnL.
 */
function mergeForFrontend(positionRow) {
    const live = getPositionSnapshot(positionRow.user_id, positionRow.symbol, positionRow.position_side);
    return {
        // static, from MySQL
        position_id: positionRow.position_id,
        user_id: positionRow.user_id,
        symbol: positionRow.symbol,
        position_side: positionRow.position_side,
        margin_mode: positionRow.margin_mode,
        quantity: positionRow.quantity,
        entry_price: positionRow.entry_price,
        leverage: positionRow.leverage,
        initial_margin: live && live.initial_margin != null ? live.initial_margin : positionRow.initial_margin,
        take_profit: positionRow.take_profit,
        stop_loss: positionRow.stop_loss,
        realized_pnl: positionRow.realized_pnl,
        status: positionRow.status,
        // live, from RAM — null until the engine's next tick populates it
        mark_price: live ? live.mark_price : null,
        unrealized_pnl: live ? live.unrealized_pnl : null,
        maintenance_margin: live ? live.maintenance_margin : null,
        liquidation_price: live ? live.liquidation_price : null,
        live_updated_at: live ? live.updated_at : null,
    };
}

module.exports = {
    attachLiveStateListeners,
    getPositionSnapshot,
    getUserPositionSnapshots,
    getWalletSnapshot,
    mergeForFrontend,
    positionKey,
};