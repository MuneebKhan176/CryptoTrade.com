// Futures_Engine/futuresWalletMerge.js
// -----------------------------------------------------------------------
// The single place that answers "what does this user's futures wallet
// look like right now" for REST consumers (routes/futuresPanel_Route.js
// and wherever /api/wallets/futures lives — see the wiring note at the
// bottom of this file). Used by BOTH the trading page's wallet card and
// the dedicated Futures Wallet page, so they can never drift apart.
//
// wallet_balance is DB-authoritative (futuresPersistence.js updates it
// transactionally on every fill/liquidation/funding — see that file).
// used_margin / available_margin / margin_ratio are NOT persisted
// anywhere (see futuresEngineClient.js's STATIC vs LIVE header) — they
// only exist as a byproduct of the engine ticking MARK_PRICE_UPDATE and
// pushing MARGIN_UPDATE, cached in RAM by liveStateStore.js. That's why
// wallet numbers looked broken/missing after the WebSocket refactor:
// nothing was reading that RAM cache from the REST side, and — see
// futuresPriceFeed.js — nothing was even ticking mark prices into the
// engine in the first place, so the cache stayed permanently empty.
// -----------------------------------------------------------------------

const { conn: pool } = require('../db_connection');
const { getWalletSnapshot } = require('./LiveStateStore');

function queryAsync(sql, params = []) {
    return new Promise((resolve, reject) => {
        pool.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
    });
}

/**
 * @param {number} userId
 * @returns {Promise<null | {
 *   walletId: number, status: string, walletBalance: number,
 *   usedMargin: number, availableMargin: number, marginRatio: number,
 *   live: boolean   // true if this came from a real MARGIN_UPDATE tick,
 *                    // false if it's the DB-only approximation below
 * }>}
 */
async function getMergedFuturesWallet(userId) {
    const rows = await queryAsync(
        `SELECT wallet_id, wallet_balance, status FROM futures_wallet WHERE user_id = ? LIMIT 1`,
        [userId]
    );
    const row = rows[0];
    if (!row) return null;

    const live = getWalletSnapshot(userId); // null until this user's first MARGIN_UPDATE tick lands

    if (live) {
        return {
            walletId: row.wallet_id,
            status: row.status || 'ACTIVE',
            walletBalance: live.wallet_balance,
            usedMargin: live.used_margin,
            availableMargin: live.available_margin,
            marginRatio: live.margin_ratio,
            live: true,
        };
    }

    // Fallback before any tick has landed for this user (right after
    // server start, or before the price feed's first cycle). Approximate
    // used_margin the same way AccountManager::recomputeMargin does for
    // the initial-margin component — sum of initial_margin across every
    // OPEN position — since that figure IS persisted (positions.initial_margin).
    // What this fallback can't reproduce is unrealized CROSS PnL (unknown
    // without a mark price), so availableMargin is a slight approximation
    // until the live feed catches up — corrected within one price-feed cycle.
    const marginRows = await queryAsync(
        `SELECT COALESCE(SUM(initial_margin), 0) AS used FROM positions WHERE user_id = ? AND status = 'OPEN'`,
        [userId]
    );
    const usedMargin = Number(marginRows[0].used) || 0;
    const walletBalance = Number(row.wallet_balance) || 0;
    const availableMargin = Math.max(0, walletBalance - usedMargin);

    return {
        walletId: row.wallet_id,
        status: row.status || 'ACTIVE',
        walletBalance,
        usedMargin,
        availableMargin,
        marginRatio: walletBalance > 0 ? usedMargin / walletBalance : 0,
        live: false,
    };
}

module.exports = { getMergedFuturesWallet };

/* ═══════════════════════════════════════════════════════════════════════
   WIRING NOTE — /api/wallets/futures
   ───────────────────────────────────────────────────────────────────────
   I don't have the file that currently serves GET /api/wallets/futures
   (it's used by futures_wallet.html's balance card and by the transfer
   modal's "Available" hint) — it's presumably in routes/walletRoutes.js
   alongside the funding/spot equivalents. Wherever that handler lives,
   replace whatever it currently does for the futures branch with:

       const { getMergedFuturesWallet } = require('../Futures_Engine/futuresWalletMerge');

       router.get('/api/wallets/futures', verifyToken, async (req, res) => {
           try {
               const wallet = await getMergedFuturesWallet(req.user.id);
               if (!wallet) return res.status(404).json({ success: false, message: 'No futures wallet found.' });
               res.json({
                   success: true,
                   data: {
                       walletId: wallet.walletId,
                       status: wallet.status,
                       walletBalance: wallet.walletBalance,
                       availableMargin: wallet.availableMargin,
                       usedMargin: wallet.usedMargin,
                   },
               });
           } catch (err) {
               console.error('GET /api/wallets/futures error:', err);
               res.status(500).json({ success: false, message: 'Could not load futures wallet.' });
           }
       });

   This is the same merge used by GET /api/futures/wallet in
   futuresPanel_Route.js — both routes now read from one place, so the
   Futures Wallet page and the Futures Trading page can never show two
   different numbers for the same account.
   ═══════════════════════════════════════════════════════════════════════ *////