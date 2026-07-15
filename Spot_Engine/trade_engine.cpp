// trade_engine.cpp
// -----------------------------------------------------------------------
// CryptoTrade Spot Trading Engine — persistent TCP order-execution service.
//
// LAYERING (per architecture doc):
//   - Node.js does ALL pre-trade validation (auth, balance checks, business
//     rules) BEFORE an order ever reaches this process. By the time a
//     PLACE_ORDER packet arrives here, Node has already inserted the order
//     into MySQL `spot_orders` as OPEN and is just forwarding it for
//     execution.
//   - This engine does ONLY engine-specific validation (packet integrity,
//     known trading pair, internal consistency) and LIVE TRADING LOGIC:
//     it owns one in-memory order book per symbol, executes MARKET orders
//     immediately, holds LIMIT orders until the reference price crosses
//     them, and manages TP/SL as OCO (one-cancels-other) exit orders
//     attached to a filled BUY entry.
//   - The order book lives ONLY in RAM. It is never loaded from or synced
//     to MySQL — on process restart the book starts empty. Persistence of
//     fills/positions/history is entirely Node's job, done in response to
//     the EXECUTION packets this engine sends back.
//
// CONNECTION MODEL (unchanged from the original skeleton):
//   Node keeps exactly ONE long-lived TCP connection open to this engine
//   (see engineClient.js) and pipelines every user's orders and price
//   ticks over it. Newline-delimited JSON, both directions.
//
// WIRE PROTOCOL — Node -> Engine ("action" field):
//   PLACE_ORDER   { request_id, action, order_id, user_id, wallet_id,
//                    symbol, side, order_type, quantity, limit_price?,
//                    take_profit_price?, stop_loss_price? }
//   CANCEL_ORDER  { request_id, action, order_id, symbol }
//   PRICE_UPDATE  { request_id, action, symbol, price }
//
// WIRE PROTOCOL — Engine -> Node ("type" field). A single inbound packet
// can produce SEVERAL outbound lines (an ack, zero or more fills,
// possibly a book snapshot) — Node must read/process all of them, not
// just the first line matching request_id:
//   ORDER_ACK          { type, request_id, order_id, engine_order_id,
//                          accepted, message, errors[] }
//   CANCEL_ACK          { type, request_id, order_id, cancelled, message }
//   EXECUTION           { type, request_id, order_id, engine_order_id,
//                          user_id, wallet_id, symbol, side, order_type,
//                          fill_quantity, fill_price, remaining_quantity,
//                          status, is_exit_order, trigger_type,
//                          parent_order_id, realized_pnl? }
//   ORDER_BOOK_UPDATE   { type, symbol, last_price, best_bid, best_bid_qty,
//                          best_ask, best_ask_qty, timestamp }
//   ERROR               { type, request_id, message }
//
// Only EXECUTION and ORDER_BOOK_UPDATE are "push" style — they can arrive
// with no live Node-side promise waiting on their request_id (e.g. a
// resting LIMIT order filling minutes later on a PRICE_UPDATE). Node's
// client must treat these as events, not just RPC replies.
//
// Build:
//   g++ -std=c++17 -O2 -I/path/to/asio/asio/include -DASIO_STANDALONE \
//       -pthread trade_engine.cpp -o trade_engine
//
// Run:
//   ./trade_engine
// -----------------------------------------------------------------------

#define ASIO_STANDALONE

#include <asio.hpp>
#include <iostream>
#include <sstream>
#include <iomanip>
#include <string>
#include <optional>
#include <cmath>
#include <vector>
#include <map>
#include <deque>
#include <unordered_map>
#include <algorithm>
#include <chrono>
#include <atomic>

using asio::ip::tcp;

/* ═══════════════════════════════════════════════════════════════════════
   MINI JSON HELPERS
   ───────────────────────────────────────────────────────────────────────
   The wire format has a small, fixed set of keys, so a hand-rolled
   reader/writer is enough here — no need for a full JSON library.
   ═══════════════════════════════════════════════════════════════════════ */
namespace tinyjson {

std::optional<std::string> extractRaw(const std::string& json, const std::string& key) {
    std::string pattern = "\"" + key + "\"";
    size_t keyPos = json.find(pattern);
    if (keyPos == std::string::npos) return std::nullopt;

    size_t colon = json.find(':', keyPos + pattern.size());
    if (colon == std::string::npos) return std::nullopt;

    size_t i = colon + 1;
    while (i < json.size() && std::isspace(static_cast<unsigned char>(json[i]))) i++;
    if (i >= json.size()) return std::nullopt;

    if (json[i] == '"') {
        size_t start = i + 1;
        size_t end = json.find('"', start);
        if (end == std::string::npos) return std::nullopt;
        return json.substr(start, end - start);
    }

    size_t start = i;
    size_t end = start;
    while (end < json.size() && json[end] != ',' && json[end] != '}' &&
           !std::isspace(static_cast<unsigned char>(json[end]))) {
        end++;
    }
    return json.substr(start, end - start);
}

std::optional<std::string> getString(const std::string& json, const std::string& key) {
    return extractRaw(json, key);
}

std::optional<double> getNumber(const std::string& json, const std::string& key) {
    auto raw = extractRaw(json, key);
    if (!raw || *raw == "null" || raw->empty()) return std::nullopt;
    try {
        return std::stod(*raw);
    } catch (...) {
        return std::nullopt;
    }
}

std::optional<long long> getInt(const std::string& json, const std::string& key) {
    auto v = getNumber(json, key);
    if (!v) return std::nullopt;
    return static_cast<long long>(*v);
}

std::string esc(const std::string& s) {
    std::string out;
    out.reserve(s.size());
    for (char c : s) {
        if (c == '"' || c == '\\') out.push_back('\\');
        out.push_back(c);
    }
    return out;
}

// Fixed-precision numeric formatting so numbers never render in
// scientific notation on the wire (crypto quantities can be tiny).
std::string num(double v, int precision = 8) {
    std::ostringstream out;
    out << std::fixed << std::setprecision(precision) << v;
    return out.str();
}

} // namespace tinyjson

/* ═══════════════════════════════════════════════════════════════════════
   ENUMS & CONVERSIONS
   ═══════════════════════════════════════════════════════════════════════ */
enum class Side { BUY, SELL };
enum class OrderType { MARKET, LIMIT };
enum class OrderStatus { OPEN, PARTIALLY_FILLED, FILLED, CANCELLED, REJECTED };
enum class TriggerType { NONE, TAKE_PROFIT, STOP_LOSS };

std::optional<Side> parseSide(const std::string& s) {
    if (s == "BUY") return Side::BUY;
    if (s == "SELL") return Side::SELL;
    return std::nullopt;
}
std::string sideToStr(Side s) { return s == Side::BUY ? "BUY" : "SELL"; }

std::optional<OrderType> parseOrderType(const std::string& s) {
    if (s == "MARKET") return OrderType::MARKET;
    if (s == "LIMIT") return OrderType::LIMIT;
    return std::nullopt;
}
std::string orderTypeToStr(OrderType t) { return t == OrderType::MARKET ? "MARKET" : "LIMIT"; }

std::string statusToStr(OrderStatus s) {
    switch (s) {
        case OrderStatus::OPEN: return "OPEN";
        case OrderStatus::PARTIALLY_FILLED: return "PARTIALLY_FILLED";
        case OrderStatus::FILLED: return "FILLED";
        case OrderStatus::CANCELLED: return "CANCELLED";
        case OrderStatus::REJECTED: return "REJECTED";
    }
    return "OPEN";
}

std::string triggerTypeToStr(TriggerType t) {
    switch (t) {
        case TriggerType::TAKE_PROFIT: return "TAKE_PROFIT";
        case TriggerType::STOP_LOSS: return "STOP_LOSS";
        default: return "";
    }
}

long long nowMillis() {
    using namespace std::chrono;
    return duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count();
}

/* ═══════════════════════════════════════════════════════════════════════
   SUPPORTED TRADING PAIRS
   ───────────────────────────────────────────────────────────────────────
   Node already whitelists symbols as part of pre-trade validation; this
   is just a defense-in-depth safety net + it is what "known trading
   pair" validation refers to in the architecture doc. Extend as needed.
   ═══════════════════════════════════════════════════════════════════════ */
static const std::vector<std::string> SUPPORTED_SYMBOLS = {
    "BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT", "ADAUSDT"
};

bool isSupportedSymbol(const std::string& s) {
    for (const auto& sym : SUPPORTED_SYMBOLS) if (sym == s) return true;
    return false;
}

/* ═══════════════════════════════════════════════════════════════════════
   ORDER MODEL
   ═══════════════════════════════════════════════════════════════════════ */
struct SpotOrder {
    long long engine_order_id = 0;   // assigned by this engine, process-lifetime unique
    long long db_order_id = 0;       // Node's spot_orders.order_id — the real correlation key
    long long user_id = 0;
    long long wallet_id = 0;
    std::string symbol;
    Side side = Side::BUY;
    OrderType order_type = OrderType::MARKET;

    double quantity = 0;
    double remaining_quantity = 0;

    bool has_limit_price = false;
    double limit_price = 0;

    bool has_take_profit = false;
    double take_profit_price = 0;

    bool has_stop_loss = false;
    double stop_loss_price = 0;

    OrderStatus status = OrderStatus::OPEN;
    long long sequence = 0;          // insertion order, for FIFO tie-breaking / logging

    // Only set on synthetic TP/SL exit orders spawned after a BUY entry fills:
    bool is_exit_order = false;
    TriggerType trigger_type = TriggerType::NONE;
    long long parent_engine_order_id = 0;
    long long oco_sibling_engine_id = 0;   // the other leg of the TP/SL pair, 0 if none
    double entry_reference_price = 0;      // the price the parent entry filled at, for PnL
};

/* ═══════════════════════════════════════════════════════════════════════
   OUTBOUND MESSAGE STRUCTS
   ═══════════════════════════════════════════════════════════════════════ */
struct ExecutionMsg {
    std::string request_id;
    long long db_order_id = 0;
    long long engine_order_id = 0;
    long long user_id = 0;
    long long wallet_id = 0;
    std::string symbol;
    std::string side;
    std::string order_type;
    double fill_quantity = 0;
    double fill_price = 0;
    double remaining_quantity = 0;
    OrderStatus status = OrderStatus::FILLED;
    bool is_exit_order = false;
    TriggerType trigger_type = TriggerType::NONE;
    long long parent_engine_order_id = 0;
    bool has_realized_pnl = false;
    double realized_pnl = 0;
};

std::string executionToJson(const ExecutionMsg& e) {
    std::ostringstream out;
    out << "{";
    out << "\"type\":\"EXECUTION\",";
    out << "\"request_id\":\"" << tinyjson::esc(e.request_id) << "\",";
    out << "\"order_id\":" << e.db_order_id << ",";
    out << "\"engine_order_id\":" << e.engine_order_id << ",";
    out << "\"user_id\":" << e.user_id << ",";
    out << "\"wallet_id\":" << e.wallet_id << ",";
    out << "\"symbol\":\"" << tinyjson::esc(e.symbol) << "\",";
    out << "\"side\":\"" << e.side << "\",";
    out << "\"order_type\":\"" << e.order_type << "\",";
    out << "\"fill_quantity\":" << tinyjson::num(e.fill_quantity, 10) << ",";
    out << "\"fill_price\":" << tinyjson::num(e.fill_price, 8) << ",";
    out << "\"remaining_quantity\":" << tinyjson::num(e.remaining_quantity, 10) << ",";
    out << "\"status\":\"" << statusToStr(e.status) << "\",";
    out << "\"is_exit_order\":" << (e.is_exit_order ? "true" : "false") << ",";
    out << "\"trigger_type\":\"" << triggerTypeToStr(e.trigger_type) << "\",";
    out << "\"parent_order_id\":" << e.parent_engine_order_id << ",";
    if (e.has_realized_pnl) {
        out << "\"realized_pnl\":" << tinyjson::num(e.realized_pnl, 2) << ",";
    }
    out << "\"timestamp\":" << nowMillis();
    out << "}";
    return out.str();
}

std::string orderAckToJson(const std::string& request_id, long long db_order_id,
                            long long engine_order_id, bool accepted,
                            const std::string& message, const std::vector<std::string>& errors) {
    std::ostringstream out;
    out << "{";
    out << "\"type\":\"ORDER_ACK\",";
    out << "\"request_id\":\"" << tinyjson::esc(request_id) << "\",";
    out << "\"order_id\":" << db_order_id << ",";
    out << "\"engine_order_id\":" << engine_order_id << ",";
    out << "\"accepted\":" << (accepted ? "true" : "false") << ",";
    out << "\"message\":\"" << tinyjson::esc(message) << "\",";
    out << "\"errors\":[";
    for (size_t i = 0; i < errors.size(); i++) {
        out << "\"" << tinyjson::esc(errors[i]) << "\"";
        if (i + 1 < errors.size()) out << ",";
    }
    out << "]}";
    return out.str();
}

std::string cancelAckToJson(const std::string& request_id, long long db_order_id,
                             bool cancelled, const std::string& message) {
    std::ostringstream out;
    out << "{";
    out << "\"type\":\"CANCEL_ACK\",";
    out << "\"request_id\":\"" << tinyjson::esc(request_id) << "\",";
    out << "\"order_id\":" << db_order_id << ",";
    out << "\"cancelled\":" << (cancelled ? "true" : "false") << ",";
    out << "\"message\":\"" << tinyjson::esc(message) << "\"";
    out << "}";
    return out.str();
}

std::string errorToJson(const std::string& request_id, const std::string& message) {
    std::ostringstream out;
    out << "{\"type\":\"ERROR\",\"request_id\":\"" << tinyjson::esc(request_id)
        << "\",\"message\":\"" << tinyjson::esc(message) << "\"}";
    return out.str();
}

/* ═══════════════════════════════════════════════════════════════════════
   ORDER BOOK  (one instance per symbol, RAM-only)
   ───────────────────────────────────────────────────────────────────────
   This is a REFERENCE-PRICE paper-trading book, not a two-sided matching
   engine: orders are never matched against each other. Instead, resting
   LIMIT orders and TP/SL exit orders are matched against the latest
   price tick Node forwards from Binance. Liquidity is assumed infinite
   at the reference price, same as the existing PaperOrderBook model.
   ═══════════════════════════════════════════════════════════════════════ */
class OrderBook {
public:
    explicit OrderBook(std::string symbol) : symbol_(std::move(symbol)) {}

    // ---- price feed -----------------------------------------------------
    void onPriceUpdate(double price, std::vector<ExecutionMsg>& execs) {
        last_price_ = price;
        has_price_ = true;
        // Loop to catch cascades: a limit fill can spawn TP/SL triggers
        // that are already satisfied by this same tick.
        bool progressed = true;
        while (progressed) {
            size_t before = execs.size();
            matchLimits(execs);
            matchTriggers(execs);
            progressed = execs.size() > before;
        }
    }

    // ---- order entry ------------------------------------------------------
    // Returns true if the order was accepted onto the book / executed.
    // On MARKET orders with no reference price yet, returns false and
    // fills `rejectReason`.
    bool placeOrder(SpotOrder order, std::vector<ExecutionMsg>& execs, std::string& rejectReason) {
        if (order.order_type == OrderType::MARKET) {
            if (!has_price_) {
                rejectReason = "No reference price available yet for " + symbol_ + "; try again shortly";
                return false;
            }
            fillOrderCompletely(order, last_price_, execs);
            return true;
        }

        // LIMIT order: rest it on the book, then see if it's already
        // marketable against the current reference price.
        order.status = OrderStatus::OPEN;
        if (order.side == Side::BUY) {
            buyLimits_[order.limit_price].push_back(order);
        } else {
            sellLimits_[order.limit_price].push_back(order);
        }
        entryIndex_[order.db_order_id] = { order.limit_price, order.side == Side::BUY, order.engine_order_id };

        if (has_price_) {
            bool progressed = true;
            while (progressed) {
                size_t before = execs.size();
                matchLimits(execs);
                matchTriggers(execs);
                progressed = execs.size() > before;
            }
        }
        return true;
    }

    // Cancels a resting LIMIT entry order by Node's db_order_id.
    // (TP/SL exit legs are managed automatically via OCO and are not
    // directly cancellable by Node in this version.)
    bool cancelOrder(long long dbOrderId, std::string& message) {
        auto it = entryIndex_.find(dbOrderId);
        if (it == entryIndex_.end()) {
            message = "Order not found on the book (already filled/cancelled, or unknown to this engine)";
            return false;
        }
        double price = it->second.price;
        bool isBuy = it->second.isBuy;

        // buyLimits_ and sellLimits_ use different comparator types, so we
        // can't unify them behind a single reference — handle each branch
        // explicitly instead.
        if (isBuy) {
            auto lvlIt = buyLimits_.find(price);
            if (lvlIt != buyLimits_.end()) {
                auto& dq = lvlIt->second;
                for (auto dqIt = dq.begin(); dqIt != dq.end(); ++dqIt) {
                    if (dqIt->db_order_id == dbOrderId) { dq.erase(dqIt); break; }
                }
                if (dq.empty()) buyLimits_.erase(lvlIt);
            }
        } else {
            auto lvlIt = sellLimits_.find(price);
            if (lvlIt != sellLimits_.end()) {
                auto& dq = lvlIt->second;
                for (auto dqIt = dq.begin(); dqIt != dq.end(); ++dqIt) {
                    if (dqIt->db_order_id == dbOrderId) { dq.erase(dqIt); break; }
                }
                if (dq.empty()) sellLimits_.erase(lvlIt);
            }
        }
        entryIndex_.erase(it);
        message = "Order cancelled";
        return true;
    }

    // ---- snapshot for ORDER_BOOK_UPDATE ---------------------------------
    struct TopOfBook {
        double last_price = 0;
        bool has_price = false;
        double best_bid = 0;
        double best_bid_qty = 0;
        bool has_bid = false;
        double best_ask = 0;
        double best_ask_qty = 0;
        bool has_ask = false;
    };

    TopOfBook topOfBook() const {
        TopOfBook tb;
        tb.last_price = last_price_;
        tb.has_price = has_price_;
        if (!buyLimits_.empty()) {
            const auto& lvl = *buyLimits_.begin();
            tb.best_bid = lvl.first;
            tb.has_bid = true;
            for (const auto& o : lvl.second) tb.best_bid_qty += o.remaining_quantity;
        }
        if (!sellLimits_.empty()) {
            const auto& lvl = *sellLimits_.begin();
            tb.best_ask = lvl.first;
            tb.has_ask = true;
            for (const auto& o : lvl.second) tb.best_ask_qty += o.remaining_quantity;
        }
        return tb;
    }

    const std::string& symbol() const { return symbol_; }

private:
    std::string symbol_;
    double last_price_ = 0;
    bool has_price_ = false;

    // Resting LIMIT entry orders. Buy side keyed highest-price-first
    // (most eager buyer fills first); sell side lowest-price-first
    // (most eager seller fills first).
    std::map<double, std::deque<SpotOrder>, std::greater<double>> buyLimits_;
    std::map<double, std::deque<SpotOrder>> sellLimits_;

    // TP/SL exit triggers (always SELL orders closing a long spot
    // position). tpTriggers_ ascending (lowest target fires first as
    // price rises); slTriggers_ descending (highest stop fires first as
    // price falls).
    std::map<double, std::deque<SpotOrder>> tpTriggers_;
    std::map<double, std::deque<SpotOrder>, std::greater<double>> slTriggers_;

    struct EntryLoc { double price; bool isBuy; long long engine_order_id; };
    std::unordered_map<long long, EntryLoc> entryIndex_;      // db_order_id -> location

    struct ExitLoc { double price; bool isTakeProfit; };
    std::unordered_map<long long, ExitLoc> exitIndex_;        // engine_order_id -> location

    // ---- internals --------------------------------------------------------
    void fillOrderCompletely(SpotOrder order, double price, std::vector<ExecutionMsg>& execs) {
        order.status = OrderStatus::FILLED;
        order.remaining_quantity = 0;
        execs.push_back(toExecutionMsg(order, order.quantity, price));

        if (order.side == Side::BUY && (order.has_take_profit || order.has_stop_loss)) {
            spawnExitTriggers(order, price, execs);
        }
    }

    void matchLimits(std::vector<ExecutionMsg>& execs) {
        if (!has_price_) return;

        while (!buyLimits_.empty()) {
            auto it = buyLimits_.begin();          // highest limit price first
            if (it->first < last_price_) break;    // BUY fires when last_price <= limit_price
            fillLevelFIFO(it->second, execs);
            if (it->second.empty()) buyLimits_.erase(it);
        }
        while (!sellLimits_.empty()) {
            auto it = sellLimits_.begin();         // lowest limit price first
            if (it->first > last_price_) break;    // SELL fires when last_price >= limit_price
            fillLevelFIFO(it->second, execs);
            if (it->second.empty()) sellLimits_.erase(it);
        }
    }

    void fillLevelFIFO(std::deque<SpotOrder>& level, std::vector<ExecutionMsg>& execs) {
        while (!level.empty()) {
            SpotOrder order = level.front();
            level.pop_front();
            entryIndex_.erase(order.db_order_id);
            fillOrderCompletely(order, last_price_, execs);
        }
    }

    void matchTriggers(std::vector<ExecutionMsg>& execs) {
        if (!has_price_) return;

        while (!tpTriggers_.empty()) {
            auto it = tpTriggers_.begin();          // smallest target first
            if (it->first > last_price_) break;     // TP fires when last_price >= target
            fireTriggerLevel(it->second, execs);
            if (it->second.empty()) tpTriggers_.erase(it);
        }
        while (!slTriggers_.empty()) {
            auto it = slTriggers_.begin();          // largest stop first
            if (it->first < last_price_) break;     // SL fires when last_price <= stop
            fireTriggerLevel(it->second, execs);
            if (it->second.empty()) slTriggers_.erase(it);
        }
    }

    void fireTriggerLevel(std::deque<SpotOrder>& level, std::vector<ExecutionMsg>& execs) {
        while (!level.empty()) {
            SpotOrder order = level.front();
            level.pop_front();
            exitIndex_.erase(order.engine_order_id);

            // OCO: cancel the sibling leg, if it hasn't fired already.
            if (order.oco_sibling_engine_id != 0) {
                cancelExitById(order.oco_sibling_engine_id);
            }

            order.status = OrderStatus::FILLED;
            order.remaining_quantity = 0;
            ExecutionMsg msg = toExecutionMsg(order, order.quantity, last_price_);
            msg.has_realized_pnl = true;
            msg.realized_pnl = (last_price_ - order.entry_reference_price) * order.quantity;
            execs.push_back(msg);
        }
    }

    bool cancelExitById(long long engineOrderId) {
        auto it = exitIndex_.find(engineOrderId);
        if (it == exitIndex_.end()) return false;
        double price = it->second.price;
        bool isTP = it->second.isTakeProfit;

        // tpTriggers_ and slTriggers_ use different comparator types, so
        // handle each branch explicitly (same reason as cancelOrder above).
        if (isTP) {
            auto lvlIt = tpTriggers_.find(price);
            if (lvlIt != tpTriggers_.end()) {
                auto& dq = lvlIt->second;
                for (auto dqIt = dq.begin(); dqIt != dq.end(); ++dqIt) {
                    if (dqIt->engine_order_id == engineOrderId) { dq.erase(dqIt); break; }
                }
                if (dq.empty()) tpTriggers_.erase(lvlIt);
            }
        } else {
            auto lvlIt = slTriggers_.find(price);
            if (lvlIt != slTriggers_.end()) {
                auto& dq = lvlIt->second;
                for (auto dqIt = dq.begin(); dqIt != dq.end(); ++dqIt) {
                    if (dqIt->engine_order_id == engineOrderId) { dq.erase(dqIt); break; }
                }
                if (dq.empty()) slTriggers_.erase(lvlIt);
            }
        }
        exitIndex_.erase(it);
        return true;
    }

    void spawnExitTriggers(const SpotOrder& filledEntry, double fillPrice, std::vector<ExecutionMsg>& execs) {
        long long tpId = filledEntry.has_take_profit ? nextEngineOrderId() : 0;
        long long slId = filledEntry.has_stop_loss ? nextEngineOrderId() : 0;

        if (filledEntry.has_take_profit) {
            SpotOrder tp = makeExitOrder(filledEntry, TriggerType::TAKE_PROFIT,
                                          filledEntry.take_profit_price, tpId, slId, fillPrice);
            tpTriggers_[filledEntry.take_profit_price].push_back(tp);
            exitIndex_[tpId] = { filledEntry.take_profit_price, true };
        }
        if (filledEntry.has_stop_loss) {
            SpotOrder sl = makeExitOrder(filledEntry, TriggerType::STOP_LOSS,
                                          filledEntry.stop_loss_price, slId, tpId, fillPrice);
            slTriggers_[filledEntry.stop_loss_price].push_back(sl);
            exitIndex_[slId] = { filledEntry.stop_loss_price, false };
        }

        // Handle the case where price has already gapped through a target
        // by the time the entry filled (e.g. a MARKET buy immediately
        // followed by a big tick move).
        matchTriggers(execs);
    }

    SpotOrder makeExitOrder(const SpotOrder& parent, TriggerType trigger, double triggerPrice,
                             long long engineOrderId, long long siblingId, double entryFillPrice) const {
        SpotOrder exit;
        exit.engine_order_id = engineOrderId;
        exit.db_order_id = parent.db_order_id;   // same DB row; Node treats this as that order's exit fill
        exit.user_id = parent.user_id;
        exit.wallet_id = parent.wallet_id;
        exit.symbol = parent.symbol;
        exit.side = Side::SELL;                  // closing a long spot position
        exit.order_type = OrderType::LIMIT;
        exit.quantity = parent.quantity;
        exit.remaining_quantity = parent.quantity;
        exit.limit_price = triggerPrice;
        exit.has_limit_price = true;
        exit.status = OrderStatus::OPEN;
        exit.is_exit_order = true;
        exit.trigger_type = trigger;
        exit.parent_engine_order_id = parent.engine_order_id;
        exit.oco_sibling_engine_id = siblingId;
        exit.entry_reference_price = entryFillPrice;
        return exit;
    }

    ExecutionMsg toExecutionMsg(const SpotOrder& order, double fillQty, double fillPrice) const {
        ExecutionMsg msg;
        msg.db_order_id = order.db_order_id;
        msg.engine_order_id = order.engine_order_id;
        msg.user_id = order.user_id;
        msg.wallet_id = order.wallet_id;
        msg.symbol = order.symbol;
        msg.side = sideToStr(order.side);
        msg.order_type = orderTypeToStr(order.order_type);
        msg.fill_quantity = fillQty;
        msg.fill_price = fillPrice;
        msg.remaining_quantity = order.remaining_quantity;
        msg.status = order.status;
        msg.is_exit_order = order.is_exit_order;
        msg.trigger_type = order.trigger_type;
        msg.parent_engine_order_id = order.parent_engine_order_id;
        return msg;
    }

    static long long nextEngineOrderId() {
        static std::atomic<long long> counter{1};
        return counter.fetch_add(1);
    }

public:
    // Exposed so the top-level engine can stamp entry orders with an id
    // before insertion (kept static/shared across all books so ids are
    // globally unique regardless of symbol).
    static long long allocateEngineOrderId() { return nextEngineOrderId(); }
};

/* ═══════════════════════════════════════════════════════════════════════
   ENGINE — owns one OrderBook per symbol and dispatches inbound packets
   ═══════════════════════════════════════════════════════════════════════ */
struct InboundPacket {
    std::string request_id;
    std::string action;
    long long order_id = 0;
    long long user_id = 0;
    long long wallet_id = 0;
    std::string symbol;
    std::string side;
    std::string order_type;
    double quantity = 0;
    std::optional<double> limit_price;
    std::optional<double> take_profit_price;
    std::optional<double> stop_loss_price;
    std::optional<double> price; // PRICE_UPDATE
};

InboundPacket parseInbound(const std::string& json) {
    InboundPacket p;
    if (auto v = tinyjson::getString(json, "request_id")) p.request_id = *v;
    if (auto v = tinyjson::getString(json, "action")) p.action = *v;
    if (auto v = tinyjson::getInt(json, "order_id")) p.order_id = *v;
    if (auto v = tinyjson::getInt(json, "user_id")) p.user_id = *v;
    if (auto v = tinyjson::getInt(json, "wallet_id")) p.wallet_id = *v;
    if (auto v = tinyjson::getString(json, "symbol")) p.symbol = *v;
    if (auto v = tinyjson::getString(json, "side")) p.side = *v;
    if (auto v = tinyjson::getString(json, "order_type")) p.order_type = *v;
    if (auto v = tinyjson::getNumber(json, "quantity")) p.quantity = *v;
    p.limit_price = tinyjson::getNumber(json, "limit_price");
    p.take_profit_price = tinyjson::getNumber(json, "take_profit_price");
    p.stop_loss_price = tinyjson::getNumber(json, "stop_loss_price");
    p.price = tinyjson::getNumber(json, "price");
    return p;
}

class Engine {
public:
    // Returns the set of newline-terminated JSON lines to write back to Node.
    std::vector<std::string> handlePacket(const InboundPacket& in) {
        std::vector<std::string> out;

        if (in.action == "PLACE_ORDER") {
            handlePlaceOrder(in, out);
        } else if (in.action == "CANCEL_ORDER") {
            handleCancelOrder(in, out);
        } else if (in.action == "PRICE_UPDATE") {
            handlePriceUpdate(in, out);
        } else {
            out.push_back(errorToJson(in.request_id, "Unknown action: '" + in.action + "'"));
        }
        return out;
    }

private:
    std::unordered_map<std::string, OrderBook> books_;

    OrderBook& bookFor(const std::string& symbol) {
        auto it = books_.find(symbol);
        if (it == books_.end()) {
            it = books_.emplace(symbol, OrderBook(symbol)).first;
        }
        return it->second;
    }

    void appendBookUpdate(const std::string& symbol, std::vector<std::string>& out) {
        auto& book = bookFor(symbol);
        auto tb = book.topOfBook();
        std::ostringstream o;
        o << "{";
        o << "\"type\":\"ORDER_BOOK_UPDATE\",";
        o << "\"symbol\":\"" << tinyjson::esc(symbol) << "\",";
        if (tb.has_price) o << "\"last_price\":" << tinyjson::num(tb.last_price, 8) << ","; else o << "\"last_price\":null,";
        if (tb.has_bid) {
            o << "\"best_bid\":" << tinyjson::num(tb.best_bid, 8) << ",";
            o << "\"best_bid_qty\":" << tinyjson::num(tb.best_bid_qty, 10) << ",";
        } else {
            o << "\"best_bid\":null,\"best_bid_qty\":0,";
        }
        if (tb.has_ask) {
            o << "\"best_ask\":" << tinyjson::num(tb.best_ask, 8) << ",";
            o << "\"best_ask_qty\":" << tinyjson::num(tb.best_ask_qty, 10) << ",";
        } else {
            o << "\"best_ask\":null,\"best_ask_qty\":0,";
        }
        o << "\"timestamp\":" << nowMillis();
        o << "}";
        out.push_back(o.str());
    }

    // ---- engine-level (defense-in-depth) validation ------------------------
    std::vector<std::string> validatePlaceOrder(const InboundPacket& in, Side side, OrderType type) {
        std::vector<std::string> errors;

        if (in.order_id <= 0) errors.push_back("Missing or invalid order_id");
        if (in.user_id <= 0) errors.push_back("Missing or invalid user_id");
        if (in.wallet_id <= 0) errors.push_back("Missing or invalid wallet_id");
        if (in.symbol.empty() || !isSupportedSymbol(in.symbol)) errors.push_back("Symbol is missing or not a known trading pair");
        if (in.side != "BUY" && in.side != "SELL") errors.push_back("side must be BUY or SELL");
        if (in.order_type != "MARKET" && in.order_type != "LIMIT") errors.push_back("order_type must be MARKET or LIMIT");
        if (in.quantity <= 0 || std::isnan(in.quantity)) errors.push_back("quantity must be greater than 0");

        if (in.order_type == "LIMIT") {
            if (!in.limit_price || *in.limit_price <= 0) errors.push_back("LIMIT orders require a positive limit_price");
        } else if (in.order_type == "MARKET" && in.limit_price) {
            errors.push_back("MARKET orders must not include a limit_price");
        }

        if (in.take_profit_price && *in.take_profit_price <= 0) errors.push_back("take_profit_price must be greater than 0");
        if (in.stop_loss_price && *in.stop_loss_price <= 0) errors.push_back("stop_loss_price must be greater than 0");

        // TP/SL only make sense on the entry (BUY) side for spot — this
        // engine only tracks long positions, matching spot_positions.
        if ((in.take_profit_price || in.stop_loss_price) && in.side == "SELL") {
            errors.push_back("take_profit_price / stop_loss_price are only supported on BUY (entry) orders");
        }

        // Sanity-check TP/SL relative to the reference price if we already
        // have one for this symbol (best-effort; Node did the authoritative
        // check pre-trade).
        double refPrice = 0;
        bool haveRef = false;
        auto it = books_.find(in.symbol);
        if (it != books_.end()) {
            auto tb = it->second.topOfBook();
            if (tb.has_price) { refPrice = tb.last_price; haveRef = true; }
        }
        double anchor = (in.order_type == "LIMIT" && in.limit_price) ? *in.limit_price : (haveRef ? refPrice : 0);
        if (anchor > 0 && in.side == "BUY") {
            if (in.take_profit_price && *in.take_profit_price <= anchor)
                errors.push_back("take_profit_price must be above the entry price");
            if (in.stop_loss_price && *in.stop_loss_price >= anchor)
                errors.push_back("stop_loss_price must be below the entry price");
        }

        return errors;
    }

    void handlePlaceOrder(const InboundPacket& in, std::vector<std::string>& out) {
        auto side = parseSide(in.side);
        auto type = parseOrderType(in.order_type);

        // Run validation even if side/type failed to parse, so the errors
        // list is complete rather than short-circuited.
        auto errors = validatePlaceOrder(in, side.value_or(Side::BUY), type.value_or(OrderType::MARKET));
        if (!errors.empty()) {
            out.push_back(orderAckToJson(in.request_id, in.order_id, 0, false, "Engine rejected order", errors));
            return;
        }

        SpotOrder order;
        order.engine_order_id = OrderBook::allocateEngineOrderId();
        order.db_order_id = in.order_id;
        order.user_id = in.user_id;
        order.wallet_id = in.wallet_id;
        order.symbol = in.symbol;
        order.side = *side;
        order.order_type = *type;
        order.quantity = in.quantity;
        order.remaining_quantity = in.quantity;
        if (in.limit_price) { order.has_limit_price = true; order.limit_price = *in.limit_price; }
        if (in.take_profit_price) { order.has_take_profit = true; order.take_profit_price = *in.take_profit_price; }
        if (in.stop_loss_price) { order.has_stop_loss = true; order.stop_loss_price = *in.stop_loss_price; }
        order.sequence = order.engine_order_id;

        std::vector<ExecutionMsg> execs;
        std::string rejectReason;
        bool accepted = bookFor(in.symbol).placeOrder(order, execs, rejectReason);

        if (!accepted) {
            out.push_back(orderAckToJson(in.request_id, in.order_id, order.engine_order_id,
                                          false, "Engine rejected order", { rejectReason }));
            return;
        }

        out.push_back(orderAckToJson(in.request_id, in.order_id, order.engine_order_id,
                                      true, "Order accepted by engine", {}));
        for (auto& e : execs) {
            e.request_id = in.request_id;
            out.push_back(executionToJson(e));
        }
        if (!execs.empty() || order.order_type == OrderType::LIMIT) {
            appendBookUpdate(in.symbol, out);
        }
    }

    void handleCancelOrder(const InboundPacket& in, std::vector<std::string>& out) {
        if (in.order_id <= 0 || in.symbol.empty()) {
            out.push_back(cancelAckToJson(in.request_id, in.order_id, false, "order_id and symbol are required"));
            return;
        }
        std::string message;
        bool cancelled = bookFor(in.symbol).cancelOrder(in.order_id, message);
        out.push_back(cancelAckToJson(in.request_id, in.order_id, cancelled, message));
        if (cancelled) appendBookUpdate(in.symbol, out);
    }

    void handlePriceUpdate(const InboundPacket& in, std::vector<std::string>& out) {
        if (in.symbol.empty() || !in.price) {
            out.push_back(errorToJson(in.request_id, "PRICE_UPDATE requires symbol and price"));
            return;
        }
        std::vector<ExecutionMsg> execs;
        bookFor(in.symbol).onPriceUpdate(*in.price, execs);

        for (auto& e : execs) {
            e.request_id = in.request_id;
            out.push_back(executionToJson(e));
        }
        appendBookUpdate(in.symbol, out);
    }
};

/* ═══════════════════════════════════════════════════════════════════════
   HANDLE ONE PERSISTENT CONNECTION
   ───────────────────────────────────────────────────────────────────────
   Node opens this connection ONCE (shared across every user/order) and
   keeps it open. The streambuf stays alive across the whole loop since
   several pipelined messages can arrive in a single TCP read.
   ═══════════════════════════════════════════════════════════════════════ */
void handleConnection(tcp::socket socket, Engine& engine) {
    std::cout << "Node.js connected (shared connection): " << socket.remote_endpoint() << "\n";

    asio::streambuf buffer;

    while (true) {
        asio::error_code ec;
        asio::read_until(socket, buffer, '\n', ec);
        if (ec) {
            std::cout << "Connection closed by Node (" << ec.message() << ")\n\n";
            break;
        }

        std::istream is(&buffer);
        std::string line;
        std::getline(is, line);
        if (line.empty()) continue;

        std::cout << "Received: " << line << "\n";

        try {
            InboundPacket packet = parseInbound(line);
            std::vector<std::string> replies = engine.handlePacket(packet);

            std::ostringstream batch;
            for (auto& r : replies) batch << r << "\n";
            std::string outBytes = batch.str();
            if (!outBytes.empty()) {
                asio::write(socket, asio::buffer(outBytes));
            }

            std::cout << "-> sent " << replies.size() << " reply line(s)\n\n";
        } catch (std::exception& msgEx) {
            std::cerr << "Failed to process message: " << msgEx.what() << "\n\n";
        }
    }
}

/* ═══════════════════════════════════════════════════════════════════════
   MAIN — accept the (single) shared connection, then keep serving orders
   over it until it drops, then go back to waiting for a reconnect.
   ═══════════════════════════════════════════════════════════════════════ */
int main() {
    try {
        asio::io_context io;
        tcp::acceptor acceptor(io, tcp::endpoint(tcp::v4(), 9000));
        Engine engine; // one engine instance for the whole process lifetime — RAM-only order books live here

        std::cout << "=====================================\n";
        std::cout << " CryptoTrade Spot Trading Engine Started\n";
        std::cout << " Listening on port 9000...\n";
        std::cout << " Expecting one shared connection from Node.\n";
        std::cout << "=====================================\n\n";

        while (true) {
            tcp::socket socket(io);
            acceptor.accept(socket);
            handleConnection(std::move(socket), engine);
            // Loop back and wait for Node to reconnect if it ever drops.
            // NOTE: order books are NOT reset on reconnect — they persist
            // for the life of this process, only wiped on process restart.
        }
    } catch (std::exception& e) {
        std::cerr << "Fatal error: " << e.what() << std::endl;
    }

    return 0;
}