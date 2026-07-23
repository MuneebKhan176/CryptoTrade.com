// Futures_Engine/tradableSymbols.js
// -----------------------------------------------------------------------
// The list of perpetuals actually offered on futures_trade.html
// (TRADE_COINS in that file). Kept here as one shared list so the price
// feed and anything else that needs to know "what do we trade" can't
// drift out of sync with each other — that drift is exactly how
// DOGEUSDT/ADAUSDT ended up getting ticked despite never being
// selectable on the page.
//
// If you add or remove a tradable pair: update this list AND
// TRADE_COINS in futures_trade.html AND SUPPORTED_SYMBOLS in
// futures_engine.cpp (that one's compiled in, so it needs its own
// edit + rebuild — it can't require() this file).
// -----------------------------------------------------------------------
const TRADABLE_SYMBOLS = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT", "USDCUSDT"];

module.exports = { TRADABLE_SYMBOLS };