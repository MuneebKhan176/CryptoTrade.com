const WebSocket = require('ws');

// Path browsers connect to on YOUR server (not Binance directly).
const WS_PATH = '/ws/market-data';

// Coins we track. `stream` is the Binance symbol (lowercase) used in the
// combined-stream URL. Stablecoins pegged 1:1 to USD with no USDT pair on
// Binance are seeded with a static price instead of streamed.
const COINS = [
  { id: 'bitcoin',     stream: 'btcusdt',  symbol: 'BTC',  name: 'Bitcoin',  rank: 1 },
  { id: 'ethereum',    stream: 'ethusdt',  symbol: 'ETH',  name: 'Ethereum', rank: 2 },
  { id: 'tether',      stream: null,       symbol: 'USDT', name: 'Tether',   rank: 3, staticPrice: 1.0 },
  { id: 'binancecoin', stream: 'bnbusdt',  symbol: 'BNB',  name: 'BNB',      rank: 4 },
  { id: 'solana',      stream: 'solusdt',  symbol: 'SOL',  name: 'Solana',   rank: 5 },
  { id: 'usd-coin',    stream: 'usdcusdt', symbol: 'USDC', name: 'USD Coin', rank: 6, staticPrice: 1.0 },
  { id: 'ripple',      stream: 'xrpusdt',  symbol: 'XRP',  name: 'XRP',      rank: 7 },
];

// Timeframes the Spot Trading chart offers. These map 1:1 onto Binance's
// own kline interval strings, so no translation layer is needed.
const KLINE_INTERVALS = ['15m', '1h', '4h', '12h', '1d', '1w', '1M'];

// Coins that actually have a tradable USDT pair on Binance (i.e. have a
// `stream`). Kline subscriptions only make sense for these.
const STREAMED_COINS = COINS.filter(c => c.stream);

const tickerStreams = STREAMED_COINS.map(c => c.stream + '@ticker');
const klineStreams = [];
STREAMED_COINS.forEach(c => {
  KLINE_INTERVALS.forEach(iv => klineStreams.push(c.stream + '@kline_' + iv));
});

const BINANCE_URL =
  'wss://stream.binance.com:9443/stream?streams=' +
  [...tickerStreams, ...klineStreams].join('/');

// In-memory snapshot of the latest price for every coin.
const liveData = {};
COINS.filter(c => c.staticPrice != null).forEach(c => {
  liveData[c.id] = {
    id: c.id, symbol: c.symbol, name: c.name, rank: c.rank,
    price: c.staticPrice, changePct: 0, high: c.staticPrice, low: c.staticPrice, quoteVol: 0,
  };
});

// In-memory snapshot of the latest (in-progress or just-closed) candle for
// every coin/interval combination: klines[coinId][interval] = {
//   t: openTime (ms), o, h, l, c, v, x: isFinal(boolean)
// }
const klines = {};

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
    const payload = msg.data;
    if (!payload || !payload.e) return;

    if (payload.e === '24hrTicker') {
      handleTickerPayload(payload);
    } else if (payload.e === 'kline') {
      handleKlinePayload(payload);
    }
  });

  binanceSocket.on('close', () => {
    console.warn('[market_data] Binance upstream closed — reconnecting in 3s');
    scheduleBinanceReconnect();
  });

  binanceSocket.on('error', (err) => {
    console.error('[market_data] Binance upstream error:', err.message);
  });
}

function handleTickerPayload(t) {
  const coin = STREAMED_COINS.find(c => c.stream === t.s.toLowerCase());
  if (!coin) return;

  liveData[coin.id] = {
    id: coin.id, symbol: coin.symbol, name: coin.name, rank: coin.rank,
    price:     parseFloat(t.c), // last traded price
    changePct: parseFloat(t.P), // 24h change %
    high:      parseFloat(t.h),
    low:       parseFloat(t.l),
    quoteVol:  parseFloat(t.q), // 24h volume in USDT
  };
}

function handleKlinePayload(payload) {
  const coin = STREAMED_COINS.find(c => c.stream === payload.s.toLowerCase());
  if (!coin) return;

  const k = payload.k;
  if (!k || !KLINE_INTERVALS.includes(k.i)) return;

  if (!klines[coin.id]) klines[coin.id] = {};
  klines[coin.id][k.i] = {
    t: k.t,                 // candle open time (ms)
    o: parseFloat(k.o),
    h: parseFloat(k.h),
    l: parseFloat(k.l),
    c: parseFloat(k.c),
    v: parseFloat(k.v),
    x: !!k.x,                // true once this candle has closed
  };
}

function scheduleBinanceReconnect() {
  clearTimeout(binanceReconnectTimer);
  binanceReconnectTimer = setTimeout(connectToBinance, 3000);
}

/* ── Downstream: broadcast snapshot to every connected browser ──────── */
function broadcastSnapshot() {
  if (clients.size === 0) return;
  const payload = JSON.stringify({
    type: 'snapshot',
    data: liveData,   // unchanged shape — existing Homepage/Dashboard code keeps working
    klines,            // NEW — latest candle per coin/interval, used by Spot Trading page
    ts: Date.now(),
  });
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
            klines,
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

    COINS,

    KLINE_INTERVALS

};