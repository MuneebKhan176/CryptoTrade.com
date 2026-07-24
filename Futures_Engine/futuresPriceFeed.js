// Futures_Engine/futuresPriceFeed.js
// -----------------------------------------------------------------------
// Feeds PRICE_UPDATE (drives resting LIMIT matching) and MARK_PRICE_UPDATE
// (drives unrealized PnL / margin / liquidation / TP-SL — see
// AccountManager::checkRisk in futures_engine.cpp) into the C++ engine on
// an interval, for every symbol this site actually trades (see
// tradableSymbols.js) — not the engine's full compiled-in symbol list.
// -----------------------------------------------------------------------

const https = require('https');
const { sendPriceUpdate, sendMarkPriceUpdate } = require('./futuresEngineClient');
const { TRADABLE_SYMBOLS } = require('./tradableSymbols');

// Was hardcoded here before (and included DOGEUSDT/ADAUSDT, which
// futures_trade.html never offers) — now pulled from the one shared list.
const SYMBOLS = TRADABLE_SYMBOLS;

const PRICE_TICK_MS = 1000; // last-traded print -> matches resting LIMIT orders
const MARK_TICK_MS = 2000;  // mark price -> PnL / margin / liquidation / TP-SL

function fetchJson(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            let body = '';
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => {
                try { resolve(JSON.parse(body)); }
                catch (err) { reject(err); }
            });
        }).on('error', reject);
    });
}

async function fetchPrices() {
    const symbolsParam = encodeURIComponent(JSON.stringify(SYMBOLS));
    const url = `https://api.binance.com/api/v3/ticker/price?symbols=${symbolsParam}`;
    const rows = await fetchJson(url); // [{ symbol: 'BTCUSDT', price: '65123.45' }, ...]
    const out = {};
    for (const row of rows) {
        const p = parseFloat(row.price);
        if (!isNaN(p)) out[row.symbol] = p;
    }
    return out;
}

let priceTimer = null;
let markTimer = null;

function startFuturesPriceFeed() {
    if (priceTimer || markTimer) return; // idempotent, in case bootstrap() ever runs twice

    priceTimer = setInterval(async () => {
        try {
            const prices = await fetchPrices();
            for (const symbol of SYMBOLS) {
                if (prices[symbol] != null) {
                    sendPriceUpdate(symbol, prices[symbol]).catch((err) => {
                        console.error(`futuresPriceFeed: PRICE_UPDATE(${symbol}) failed:`, err.message);
                    });
                }
            }
        } catch (err) {
            console.error('futuresPriceFeed: failed to fetch prices for PRICE_UPDATE tick:', err.message);
        }
    }, PRICE_TICK_MS);

    markTimer = setInterval(async () => {
        try {
            const prices = await fetchPrices();
            for (const symbol of SYMBOLS) {
                if (prices[symbol] != null) {
                    sendMarkPriceUpdate(symbol, prices[symbol]).catch((err) => {
                        console.error(`futuresPriceFeed: MARK_PRICE_UPDATE(${symbol}) failed:`, err.message);
                    });
                }
            }
        } catch (err) {
            console.error('futuresPriceFeed: failed to fetch prices for MARK_PRICE_UPDATE tick:', err.message);
        }
    }, MARK_TICK_MS);

}

function stopFuturesPriceFeed() {
    clearInterval(priceTimer); priceTimer = null;
    clearInterval(markTimer); markTimer = null;
}

module.exports = { startFuturesPriceFeed, stopFuturesPriceFeed, SYMBOLS };