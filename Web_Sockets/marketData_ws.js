const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const { sendPriceUpdate } = require('../Spot_Engine/engineClient');
const { conn } = require('../db_connection');

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

  const price = parseFloat(t.c); // last traded price

  liveData[coin.id] = {
    id: coin.id, symbol: coin.symbol, name: coin.name, rank: coin.rank,
    price,
    changePct: parseFloat(t.P), // 24h change %
    high:      parseFloat(t.h),
    low:       parseFloat(t.l),
    quoteVol:  parseFloat(t.q), // 24h volume in USDT
  };

  // Feed this tick to the trade engine as its reference price for the
  // symbol. This is what flips the engine's has_price_ flag to true and
  // lets MARKET orders / resting LIMIT orders / TP/SL actually execute —
  // without this call the engine never learns any price and every
  // MARKET order is rejected with "No reference price available yet".
  // Fire-and-forget: we don't need to await the ack here, and we
  // deliberately swallow rejections (e.g. engine mid-reconnect) so one
  // dropped tick never becomes an unhandled promise rejection — the next
  // tick, ~1s later, just tries again.
  sendPriceUpdate(coin.symbol + 'USDT', price).catch(() => {});
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

/* ── Shared price lookup, usable from anywhere (routes, order engine) ──
   Falls back to a coin's staticPrice (e.g. USDT/USDC pegged at 1.0) if
   the Binance feed hasn't produced a tick for it yet — those coins have
   no stream to begin with. Returns null only for a totally unknown
   symbol. */
function getLivePrice(symbol) {
  const coin = COINS.find(c => c.symbol === symbol);
  if (!coin) return null;
  const entry = liveData[coin.id];
  if (entry) return entry.price;
  return coin.staticPrice != null ? coin.staticPrice : null;
}

/* ── Public snapshot broadcast — goes to every connected browser ─────── */
function broadcastSnapshot() {
  if (clients.size === 0) return;
  const payload = JSON.stringify({
    type: 'snapshot',
    data: liveData,   // unchanged shape — existing Homepage/Dashboard code keeps working
    klines,            // latest candle per coin/interval, used by Spot Trading page
    ts: Date.now(),
  });
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}

/* ── Per-user portfolio broadcast — no extra Binance calls, just a DB
   read for quantities priced against the in-memory liveData cache. ──── */
function priceHoldings(holdingRows) {
  let totalValue = 0;
  const holdings = holdingRows.map(h => {
    const price = getLivePrice(h.symbol) ?? parseFloat(h.average_buy_price) ?? 0;
    const available = parseFloat(h.available_quantity);
    const locked = parseFloat(h.locked_quantity);
    const value = (available + locked) * price;
    totalValue += value;
    return {
      symbol: h.symbol,
      availableQuantity: available,
      lockedQuantity: locked,
      averageBuyPrice: parseFloat(h.average_buy_price),
      currentPrice: price,
      value,
    };
  });
  return { totalValue, holdings };
}

function pushPortfolioForUser(userId, socketsForUser) {
  conn.query(
    `SELECT sw.wallet_id, sw.status, sh.symbol, sh.available_quantity, sh.locked_quantity, sh.average_buy_price
     FROM spot_wallet sw
     LEFT JOIN spot_holdings sh ON sh.wallet_id = sw.wallet_id
        AND (sh.available_quantity > 0 OR sh.locked_quantity > 0)
     WHERE sw.user_id = ?`,
    [userId],
    (err, rows) => {
      if (err || !rows.length) return;
      const { wallet_id, status } = rows[0];
      const holdingRows = rows.filter(r => r.symbol);
      const { totalValue, holdings } = priceHoldings(holdingRows);

      const payload = JSON.stringify({
        type: 'portfolio',
        data: { walletId: wallet_id, status, totalValue, holdings },
        ts: Date.now(),
      });
      for (const ws of socketsForUser) {
        if (ws.readyState === WebSocket.OPEN) ws.send(payload);
      }
    }
  );
}

function broadcastPortfolios() {
  const byUser = new Map();
  for (const ws of clients) {
    if (!ws.userId) continue; // anonymous viewers only get the public snapshot
    if (!byUser.has(ws.userId)) byUser.set(ws.userId, []);
    byUser.get(ws.userId).push(ws);
  }
  for (const [userId, sockets] of byUser) {
    pushPortfolioForUser(userId, sockets);
  }
}

/* ── Targeted push: "one of your orders just did something, go refresh"
   ───────────────────────────────────────────────────────────────────────
   Called by spotPanel_Route.js's handleExecution() right after a fill is
   committed to MySQL. Sends a small 'trade_update' event ONLY to sockets
   tagged with this userId (there can be more than one — multiple tabs/
   devices) — everyone else's connection is untouched. The frontend
   treats this purely as a "go refetch" signal; it does not carry enough
   to fully re-render on its own, by design, so the client always ends up
   consistent with the DB rather than trusting a push payload blindly.
   Silently a no-op if the user has no open socket right now — the next
   time they load the panel, loadWallet()/loadOrders() will already
   reflect the fill anyway. ─────────────────────────────────────────── */
function notifyUserTradeUpdate(userId, payload) {
  if (!userId) return;
  let delivered = 0;
  for (const ws of clients) {
    if (ws.userId === userId && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'trade_update', ts: Date.now(), ...payload }));
      delivered++;
    }
  }
  return delivered;
}

/* ── Resolve userId from the same auth cookie your middleware uses.
   ⚠ CONFIRM the cookie name, JWT_SECRET, and payload field name against
   middle/middleware.js before relying on this — these are best-effort
   guesses based on common patterns. If your middleware differs, update
   the `cookies.token` key and `decoded.id || decoded.userId` fallback
   below to match exactly. ─────────────────────────────────────────── */
function getUserIdFromRequest(req) {
  try {
    const raw = req.headers.cookie || '';
    const cookies = Object.fromEntries(
      raw.split(';').filter(Boolean).map(c => {
        const idx = c.indexOf('=');
        return [c.slice(0, idx).trim(), decodeURIComponent(c.slice(idx + 1).trim())];
      })
    );
    const token = cookies.token; // ⚠ confirm cookie name
    if (!token) return null;
    const decoded = jwt.verify(token, process.env.JWT_SECRET); // ⚠ confirm secret + field name
    return decoded.id || decoded.userId || null;
  } catch (e) {
    return null; // anonymous — not a crash
  }
}

/**
 * Call this once from your server.js, passing the same `http.Server`
 * instance you pass to attachChatWebSocketServer / your other wss setup.
 * Uses `req` from the 'connection' event to tag each socket with a
 * userId (if the visitor is logged in), so broadcastPortfolios() and
 * notifyUserTradeUpdate() know which sockets to push per-user data to.
 */
function initialize(wss) {

    wss.on("connection", (ws, req) => {

        ws.userId = getUserIdFromRequest(req); // tags this socket to a user, if any
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

    setInterval(broadcastSnapshot, 1000);     // public prices, all clients
    setInterval(broadcastPortfolios, 2500);   // per-user, only to their own sockets

}

module.exports = {

    initialize,

    WS_PATH,

    COINS,

    KLINE_INTERVALS,

    getLivePrice, // exported so wallet routes & the order engine can reuse the same cache

    notifyUserTradeUpdate, // exported so spotPanel_Route.js can push fill events to the user

};