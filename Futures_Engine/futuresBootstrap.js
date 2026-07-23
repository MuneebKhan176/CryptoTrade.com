// futuresBootstrap.js
// -----------------------------------------------------------------------
// Wires the futures engine's two event-consuming layers together at
// process startup:
//   - liveStateStore.js      (RAM only  — mark price / uPnL / margin)
//   - futures_Persistence.js (MySQL only — fills / liquidations / funding)
//
// Just requiring "./futuresEngineClient" (transitively, via the two
// requires below) opens the TCP socket to the C++ engine on
// FUTURES_ENGINE_PORT (default 9001) — that connect() call runs as a
// side effect at module load time. Call bootstrap() once, before
// app.listen(), so every listener below is attached before the engine's
// async TCP connect callback can fire — engineEvents.emit("connected")
// only runs after a real network round trip, which can't complete
// before this synchronous function returns, so attaching the
// "connected" listener here is always in time for the first firing,
// not just later reconnects.
//
// THIS REVISION: added rehydrateEngineState() on every "connected"
// event. Root cause being fixed: the C++ engine's AccountManager is
// RAM-only (see WalletMirror's comment in futures_engine.cpp), and
// syncWallet()/syncPosition() existed in futuresEngineClient.js
// specifically to repopulate it from MySQL — but nothing ever called
// them. Every position that existed before an engine restart (or even
// just a dropped TCP link) was therefore invisible to
// AccountManager::checkRisk()'s per-tick loop: no POSITION_UPDATE, no
// MARGIN_UPDATE, ever, for that position. That's what was producing
// "positions / margin balance / mark price not updating live" — the
// frontend's live socket and REST fallback were both working correctly,
// there was just nothing feeding the engine the position in the first
// place. See Futures_Engine/futuresRehydrate.js for the fix.
// -----------------------------------------------------------------------

const { engineEvents } = require("./futuresEngineClient");
const { attachLiveStateListeners } = require("./LiveStateStore");
const { attachPersistenceHandlers } = require("./futures_Persistence");
const { startFuturesPriceFeed } = require("./futuresPriceFeed");
const { rehydrateEngineState } = require("./futuresRehydrate");

function bootstrap() {
    // Order doesn't matter between these two — they subscribe to
    // disjoint event subsets (see futuresEngineClient.js header).
    attachLiveStateListeners();    // RAM only — mark price, uPnL, margin ratio, liq price. Never touches MySQL.
    attachPersistenceHandlers();   // MySQL only — open/DCA/decrease/close/liquidation/funding. Uses getConnection()+transactions for every read-modify-write.

    // Without this, the engine never receives a reference price for any
    // symbol at all — margin/PnL/liquidation never compute, and every
    // live cache above stays permanently empty.
    startFuturesPriceFeed();

    // NEW — re-sync every wallet and OPEN position from MySQL into the
    // engine's RAM on every connect AND every reconnect (see
    // futuresRehydrate.js header for why re-running this on a plain
    // reconnect, not just a true restart, is safe). This must run before
    // the price feed's first MARK_PRICE_UPDATE tick reaches the engine,
    // or the very first checkRisk() pass will iterate an empty
    // positions_ map for that symbol and skip every existing position's
    // routine push once again — so it's attached to "connected" (fires
    // BEFORE any tick can possibly be in flight) rather than called
    // once here inline, which would only cover the very first connect
    // and miss any later reconnect.
    engineEvents.on("connected", () => {
        rehydrateEngineState();
    });

    // Surface anything the engine sends that nobody was waiting on
    // (e.g. an unsolicited ERROR line) so it doesn't fail silently.
    engineEvents.on("engineError", (msg) => {
        console.error("Futures engine reported an error with no matching request:", msg.message);
    });

    engineEvents.on("disconnected", (reason) => {
        console.warn("Futures engine TCP connection lost:", reason);
    });

    console.log("Futures live-state + persistence layers attached.");
}

module.exports = { bootstrap };