// Futures_Engine/futuresRehydrate.js
// -----------------------------------------------------------------------
// Re-populates the C++ engine's in-RAM AccountManager (wallets_ +
// positions_) from MySQL every time the TCP connection to the engine is
// (re-)established — including the very first connect at process
// startup. This is the missing half of the "RAM-only, re-hydrate via
// SYNC_WALLET/SYNC_POSITION" design already documented in
// futures_engine.cpp's WalletMirror comment and futuresEngineClient.js's
// syncWallet()/syncPosition() exports — those functions existed but
// nothing ever called them.
//
// Without this, any position that existed in MySQL before the engine
// process (or just the TCP link) restarted is permanently invisible to
// AccountManager::checkRisk()'s tick loop: no POSITION_UPDATE, no
// MARGIN_UPDATE, ever, for that position — which is what produced
// "positions / margin / mark price never update live" even though the
// static REST endpoints (backed by MySQL) showed the position just fine.
//
// Safe to re-run on every reconnect, not just true engine restarts:
// syncPosition()/syncWallet() just overwrite the engine's mirror with
// whatever MySQL currently says, and MySQL is already the authoritative
// source for every field they carry (quantity, entry_price, leverage,
// margin_mode, TP/SL, wallet_balance) — so re-syncing on a connection
// that never actually lost engine-side state is a harmless no-op.
// -----------------------------------------------------------------------
const { conn: pool } = require('../db_connection');
const { syncWallet, syncPosition } = require('./futuresEngineClient');

function queryAsync(sql, params = []) {
    return new Promise((resolve, reject) => {
        pool.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
    });
}

async function rehydrateEngineState() {
    try {
        // ── Wallets first, so getOrCreateWallet-adjacent lookups inside
        //    the engine have something to find before positions arrive.
        const wallets = await queryAsync(
            `SELECT user_id, wallet_id, wallet_balance FROM futures_wallet`
        );
        for (const w of wallets) {
            try {
                await syncWallet(w.user_id, w.wallet_id, parseFloat(w.wallet_balance) || 0, 'ONE_WAY');
            } catch (err) {
                console.error(`futuresRehydrate: SYNC_WALLET failed for user ${w.user_id}:`, err.message);
            }
        }

        // ── Then every OPEN position, so the engine's positions_ map
        //    matches MySQL exactly before the next mark-price tick.
        const openPositions = await queryAsync(
            `SELECT user_id, wallet_id, symbol, position_side, margin_mode,
                    quantity, entry_price, leverage, take_profit, stop_loss
             FROM positions
             WHERE status = 'OPEN'`
        );
        for (const p of openPositions) {
            try {
                await syncPosition({
                    userId: p.user_id,
                    walletId: p.wallet_id,
                    symbol: p.symbol,
                    positionSide: p.position_side,
                    marginMode: p.margin_mode || 'ISOLATED',
                    quantity: parseFloat(p.quantity),
                    entryPrice: parseFloat(p.entry_price),
                    leverage: p.leverage || 1,
                    takeProfit: p.take_profit != null ? parseFloat(p.take_profit) : undefined,
                    stopLoss: p.stop_loss != null ? parseFloat(p.stop_loss) : undefined,
                });
            } catch (err) {
                console.error(
                    `futuresRehydrate: SYNC_POSITION failed for user ${p.user_id} ${p.symbol} ${p.position_side}:`,
                    err.message
                );
            }
        }

    } catch (err) {
        console.error('futuresRehydrate: failed to rehydrate engine state from MySQL:', err.message);
    }
}

module.exports = { rehydrateEngineState };