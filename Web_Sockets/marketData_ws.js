/**
 * Market_Stream/market_data.js
 * ─────────────────────────────────────────────────────────────────────────
 * ONE upstream connection to Binance's public WebSocket feed, shared by
 * every browser tab/user connected to this server. We never open a new
 * Binance connection per user — this module connects once, keeps an
 * in-memory snapshot of the latest prices, and re-broadcasts that snapshot
 * to all locally-connected clients over our own WebSocket endpoint
 * (WS_PATH below).
 *
 * Requires the `ws` package:
 *   npm install ws
 * ─────────────────────────────────────────────────────────────────────────
 */

const WebSocket = require('ws');

// Path browsers connect to on YOUR server (not Binance directly).
const WS_PATH = '/ws/market-data';

// Coins we track. `stream` is the Binance symbol (lowercase) used in the
// combined-stream URL. Stablecoins pegged 1:1 to USD have no USDT pair on
// Binance, so they're seeded with a static price instead of streamed.
const COINS = [
  { id: 'bitcoin',     stream: 'btcusdt',  symbol: 'BTC',  name: 'Bitcoin',  rank: 1 },
  { id: 'ethereum',    stream: 'ethusdt',  symbol: 'ETH',  name: 'Ethereum', rank: 2 },
  { id: 'tether',      stream: null,       symbol: 'USDT', name: 'Tether',   rank: 3, staticPrice: 1.0 },
  { id: 'binancecoin', stream: 'bnbusdt',  symbol: 'BNB',  name: 'BNB',      rank: 4 },
  { id: 'solana',      stream: 'solusdt',  symbol: 'SOL',  name: 'Solana',   rank: 5 },
  { id: 'usd-coin',    stream: 'usdcusdt', symbol: 'USDC', name: 'USD Coin', rank: 6, staticPrice: 1.0 },
  { id: 'ripple',      stream: 'xrpusdt',  symbol: 'XRP',  name: 'XRP',      rank: 7 },
];

const BINANCE_URL =
  'wss://stream.binance.com:9443/stream?streams=' +
  COINS.filter(c => c.stream).map(c => c.stream + '@ticker').join('/');

// In-memory snapshot of the latest price for every coin.
const liveData = {};
COINS.filter(c => c.staticPrice != null).forEach(c => {
  liveData[c.id] = {
    id: c.id, symbol: c.symbol, name: c.name, rank: c.rank,
    price: c.staticPrice, changePct: 0, high: c.staticPrice, low: c.staticPrice, quoteVol: 0,
  };
});

let binanceSocket = null;
let binanceReconnectTimer = null;
const clients = new Set(); // every locally-connected browser WebSocket

/* ── Upstream: single connection to Binance ─────────────────────────── */
function connectToBinance() {
  binanceSocket = new WebSocket(BINANCE_URL);

  binanceSocket.on('open', () => {});

  binanceSocket.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    const t = msg.data; // 24hr ticker payload
    if (!t || !t.s) return;

    const coin = COINS.find(c => c.stream === t.s.toLowerCase());
    if (!coin) return;

    liveData[coin.id] = {
      id: coin.id, symbol: coin.symbol, name: coin.name, rank: coin.rank,
      price:     parseFloat(t.c), // last traded price
      changePct: parseFloat(t.P), // 24h change %
      high:      parseFloat(t.h),
      low:       parseFloat(t.l),
      quoteVol:  parseFloat(t.q), // 24h volume in USDT
    };
  });

  binanceSocket.on('close', () => {
    console.warn('[market_data] Binance upstream closed — reconnecting in 3s');
    scheduleBinanceReconnect();
  });

  binanceSocket.on('error', (err) => {
    console.error('[market_data] Binance upstream error:', err.message);
  });
}

function scheduleBinanceReconnect() {
  clearTimeout(binanceReconnectTimer);
  binanceReconnectTimer = setTimeout(connectToBinance, 3000);
}

/* ── Downstream: broadcast snapshot to every connected browser ──────── */
function broadcastSnapshot() {
  if (clients.size === 0) return;
  const payload = JSON.stringify({ type: 'snapshot', data: liveData, ts: Date.now() });
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}

/**
 * Call this once from your server.js, passing the same `http.Server`
 * instance you pass to attachChatWebSocketServer. It hooks the shared
 * server's 'upgrade' event and only handles requests for WS_PATH,
 * so it coexists cleanly with your other WebSocket server(s).
 */


function initialize(wss) {

    wss.on("connection", (ws) => {

        clients.add(ws);

        ws.send(JSON.stringify({
            type: "snapshot",
            data: liveData,
            ts: Date.now()
        }));

        ws.on("close", () => clients.delete(ws));

        ws.on("error", () => clients.delete(ws));

    });

    connectToBinance();

    setInterval(broadcastSnapshot,1000);

}

module.exports = {

    initialize,

    WS_PATH,

    COINS

};