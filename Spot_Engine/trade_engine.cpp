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
//     them, and manages OCO orders as two linked SELL legs.
//   - The order book lives ONLY in RAM. It is never loaded from or synced
//     to MySQL — on process restart the book starts empty. Persistence of
//     fills/history is entirely Node's job, done in response to the
//     EXECUTION packets this engine sends back.
//
// ORDER TYPES:
//   - MARKET: fills immediately against the last reference price.
//   - LIMIT:  rests on the book until the reference price crosses it.
//   - OCO:    "One-Cancels-the-Other" — a SELL-only order type placed
//     directly by the user against an asset they already hold (Node
//     locks the base asset quantity exactly like a plain SELL). It
//     carries TWO prices: limit_price (the upper, take-profit-style leg
//     — fires when the reference price rises to/above it) and stop_price
//     (the lower, stop-loss-style leg — fires when the reference price
//     falls to/below it). Whichever leg the market reaches first fills
//     at that reference price; the sibling leg is cancelled
//     automatically. There is no "position" concept and no auto-spawning
//     from a filled BUY anymore — OCO is a first-class order type placed
//     directly, same as MARKET or LIMIT.
//
// CONNECTION MODEL (unchanged from the original skeleton):
//   Node keeps exactly ONE long-lived TCP connection open to this engine
//   (see engineClient.js) and pipelines every user's orders and price
//   ticks over it. Newline-delimited JSON, both directions.
//
// WIRE PROTOCOL — Node -> Engine ("action" field):
//   PLACE_ORDER   { request_id, action, order_id, user_id, wallet_id,
//                    symbol, side, order_type, quantity,
//                    limit_price?,     // LIMIT: the limit price. OCO: upper/take-profit-style leg.
//                    stop_price? }     // OCO only: the lower/stop-loss-style leg.
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
//                          status, is_oco_leg, oco_leg? }
//                        -- oco_leg is "LIMIT" or "STOP", present only
//                        -- when is_oco_leg is true, identifying which of
//                        -- the two OCO legs fired.
//   ORDER_BOOK_UPDATE   { type, symbol, last_price, best_bid, best_bid_qty,
//                          best_ask, best_ask_qty, timestamp }
//   ERROR               { type, request_id, message }
//
// Only EXECUTION and ORDER_BOOK_UPDATE are "push" style — they can arrive
// with no live Node-side promise waiting on their request_id (e.g. a
// resting LIMIT order, or an OCO leg, filling minutes later on a
// PRICE_UPDATE). Node's client must treat these as events, not just RPC
// replies.
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
enum class OrderType { MARKET, LIMIT, OCO };
enum class OrderStatus { OPEN, PARTIALLY_FILLED, FILLED, CANCELLED, REJECTED };

std::optional<Side> parseSide(const std::string& s) {
    if (s == "BUY") return Side::BUY;
    if (s == "SELL") return Side::SELL;
    return std::nullopt;
}
std::string sideToStr(Side s) { return s == Side::BUY ? "BUY" : "SELL"; }

std::optional<OrderType> parseOrderType(const std::string& s) {
    if (s == "MARKET") return OrderType::MARKET;
    if (s == "LIMIT") return OrderType::LIMIT;
    if (s == "OCO") return OrderType::OCO;
    return std::nullopt;
}
std::string orderTypeToStr(OrderType t) {
    switch (t) {
        case OrderType::MARKET: return "MARKET";
        case OrderType::LIMIT: return "LIMIT";
        case OrderType::OCO: return "OCO";
    }
    return "MARKET";
}

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

long long nowMillis() {
    using namespace std::chrono;
    return duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count();
}

/* ═══════════════════════════════════════════════════════════════════════
   SUPPORTED TRADING PAIRS
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
    double limit_price = 0;      // LIMIT: the limit price. OCO leg: this leg's trigger price.

    OrderStatus status = OrderStatus::OPEN;
    long long sequence = 0;          // insertion order, for FIFO tie-breaking / logging

    // Set only on the two synthetic legs an OCO order is split into
    // internally (both share db_order_id, but each gets its own
    // engine_order_id). A plain MARKET/LIMIT order never sets these.
    bool is_oco_leg = false;
    bool is_upper_leg = false;            // true = the take-profit-style (limit_price) leg, false = the stop-style leg
    long long oco_sibling_engine_id = 0;  // the other leg — cancelled automatically when this one fires
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
    bool is_oco_leg = false;
    bool is_upper_leg = false; // meaningful only when is_oco_leg is true
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
    out << "\"is_oco_leg\":" << (e.is_oco_leg ? "true" : "false");
    if (e.is_oco_leg) {
        out << ",\"oco_leg\":\"" << (e.is_upper_leg ? "LIMIT" : "STOP") << "\"";
    }
    out << ",\"timestamp\":" << nowMillis();
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
   ═══════════════════════════════════════════════════════════════════════ */
class OrderBook {
public:
    explicit OrderBook(std::string symbol) : symbol_(std::move(symbol)) {}

    void onPriceUpdate(double price, std::vector<ExecutionMsg>& execs) {
        last_price_ = price;
        has_price_ = true;
        bool progressed = true;
        while (progressed) {
            size_t before = execs.size();
            matchLimits(execs);
            matchOco(execs);
            progressed = execs.size() > before;
        }
    }

    bool placeOrder(SpotOrder order, std::vector<ExecutionMsg>& execs, std::string& rejectReason) {
        if (order.order_type == OrderType::MARKET) {
            if (!has_price_) {
                rejectReason = "No reference price available yet for " + symbol_ + "; try again shortly";
                return false;
            }
            fillOrderCompletely(order, last_price_, execs);
            return true;
        }

        order.status = OrderStatus::OPEN;
        if (order.side == Side::BUY) {
            buyLimits_[order.limit_price].push_back(order);
        } else {
            sellLimits_[order.limit_price].push_back(order);
        }
        entryIndex_[order.db_order_id] = { order.limit_price, order.side == Side::BUY };

        if (has_price_) {
            bool progressed = true;
            while (progressed) {
                size_t before = execs.size();
                matchLimits(execs);
                matchOco(execs);
                progressed = execs.size() > before;
            }
        }
        return true;
    }

    void placeOco(long long dbOrderId, long long userId, long long walletId, const std::string& symbol,
                  double quantity, double limitPrice, double stopPrice, std::vector<ExecutionMsg>& execs) {
        long long upperId = allocateEngineOrderId();
        long long lowerId = allocateEngineOrderId();

        SpotOrder upper = makeOcoLeg(dbOrderId, userId, walletId, symbol, quantity, limitPrice, upperId, lowerId, true);
        SpotOrder lower = makeOcoLeg(dbOrderId, userId, walletId, symbol, quantity, stopPrice, lowerId, upperId, false);

        ocoUpperTriggers_[limitPrice].push_back(upper);
        ocoLowerTriggers_[stopPrice].push_back(lower);
        ocoLegIndex_[upperId] = { limitPrice, true };
        ocoLegIndex_[lowerId] = { stopPrice, false };
        ocoOrderIndex_[dbOrderId] = { limitPrice, stopPrice, upperId, lowerId };

        if (has_price_) {
            bool progressed = true;
            while (progressed) {
                size_t before = execs.size();
                matchLimits(execs);
                matchOco(execs);
                progressed = execs.size() > before;
            }
        }
    }

    bool cancelOrder(long long dbOrderId, std::string& message) {
        auto it = entryIndex_.find(dbOrderId);
        if (it != entryIndex_.end()) {
            double price = it->second.price;
            bool isBuy = it->second.isBuy;

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

        auto ocoIt = ocoOrderIndex_.find(dbOrderId);
        if (ocoIt != ocoOrderIndex_.end()) {
            cancelOcoLegById(ocoIt->second.upperEngineId);
            cancelOcoLegById(ocoIt->second.lowerEngineId);
            ocoOrderIndex_.erase(ocoIt);
            message = "OCO order cancelled";
            return true;
        }

        message = "Order not found on the book (already filled/cancelled, or unknown to this engine)";
        return false;
    }

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

    std::map<double, std::deque<SpotOrder>, std::greater<double>> buyLimits_;
    std::map<double, std::deque<SpotOrder>> sellLimits_;

    std::map<double, std::deque<SpotOrder>> ocoUpperTriggers_;
    std::map<double, std::deque<SpotOrder>, std::greater<double>> ocoLowerTriggers_;

    struct EntryLoc { double price; bool isBuy; };
    std::unordered_map<long long, EntryLoc> entryIndex_;

    struct OcoLegLoc { double price; bool isUpper; };
    std::unordered_map<long long, OcoLegLoc> ocoLegIndex_;

    struct OcoOrderLoc { double upperPrice; double lowerPrice; long long upperEngineId; long long lowerEngineId; };
    std::unordered_map<long long, OcoOrderLoc> ocoOrderIndex_;

    void fillOrderCompletely(SpotOrder order, double price, std::vector<ExecutionMsg>& execs) {
        order.status = OrderStatus::FILLED;
        order.remaining_quantity = 0;
        execs.push_back(toExecutionMsg(order, order.quantity, price));
    }

    void matchLimits(std::vector<ExecutionMsg>& execs) {
        if (!has_price_) return;

        while (!buyLimits_.empty()) {
            auto it = buyLimits_.begin();
            if (it->first < last_price_) break;
            fillLevelFIFO(it->second, execs);
            if (it->second.empty()) buyLimits_.erase(it);
        }
        while (!sellLimits_.empty()) {
            auto it = sellLimits_.begin();
            if (it->first > last_price_) break;
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

    void matchOco(std::vector<ExecutionMsg>& execs) {
        if (!has_price_) return;

        while (!ocoUpperTriggers_.empty()) {
            auto it = ocoUpperTriggers_.begin();
            if (it->first > last_price_) break;
            fireOcoLevel(it->second, execs);
            if (it->second.empty()) ocoUpperTriggers_.erase(it);
        }
        while (!ocoLowerTriggers_.empty()) {
            auto it = ocoLowerTriggers_.begin();
            if (it->first < last_price_) break;
            fireOcoLevel(it->second, execs);
            if (it->second.empty()) ocoLowerTriggers_.erase(it);
        }
    }

    void fireOcoLevel(std::deque<SpotOrder>& level, std::vector<ExecutionMsg>& execs) {
        while (!level.empty()) {
            SpotOrder order = level.front();
            level.pop_front();
            ocoLegIndex_.erase(order.engine_order_id);
            ocoOrderIndex_.erase(order.db_order_id);

            if (order.oco_sibling_engine_id != 0) {
                cancelOcoLegById(order.oco_sibling_engine_id);
            }

            order.status = OrderStatus::FILLED;
            order.remaining_quantity = 0;
            execs.push_back(toExecutionMsg(order, order.quantity, last_price_));
        }
    }

    bool cancelOcoLegById(long long engineOrderId) {
        auto it = ocoLegIndex_.find(engineOrderId);
        if (it == ocoLegIndex_.end()) return false;
        double price = it->second.price;
        bool isUpper = it->second.isUpper;

        if (isUpper) {
            auto lvlIt = ocoUpperTriggers_.find(price);
            if (lvlIt != ocoUpperTriggers_.end()) {
                auto& dq = lvlIt->second;
                for (auto dqIt = dq.begin(); dqIt != dq.end(); ++dqIt) {
                    if (dqIt->engine_order_id == engineOrderId) { dq.erase(dqIt); break; }
                }
                if (dq.empty()) ocoUpperTriggers_.erase(lvlIt);
            }
        } else {
            auto lvlIt = ocoLowerTriggers_.find(price);
            if (lvlIt != ocoLowerTriggers_.end()) {
                auto& dq = lvlIt->second;
                for (auto dqIt = dq.begin(); dqIt != dq.end(); ++dqIt) {
                    if (dqIt->engine_order_id == engineOrderId) { dq.erase(dqIt); break; }
                }
                if (dq.empty()) ocoLowerTriggers_.erase(lvlIt);
            }
        }
        ocoLegIndex_.erase(it);
        return true;
    }

    SpotOrder makeOcoLeg(long long dbOrderId, long long userId, long long walletId, const std::string& symbol,
                          double quantity, double legPrice, long long engineOrderId, long long siblingEngineId,
                          bool isUpper) const {
        SpotOrder leg;
        leg.engine_order_id = engineOrderId;
        leg.db_order_id = dbOrderId;
        leg.user_id = userId;
        leg.wallet_id = walletId;
        leg.symbol = symbol;
        leg.side = Side::SELL;
        leg.order_type = OrderType::OCO;
        leg.quantity = quantity;
        leg.remaining_quantity = quantity;
        leg.limit_price = legPrice;
        leg.has_limit_price = true;
        leg.status = OrderStatus::OPEN;
        leg.is_oco_leg = true;
        leg.is_upper_leg = isUpper;
        leg.oco_sibling_engine_id = siblingEngineId;
        return leg;
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
        msg.is_oco_leg = order.is_oco_leg;
        msg.is_upper_leg = order.is_upper_leg;
        return msg;
    }

    static long long nextEngineOrderId() {
        static std::atomic<long long> counter{1};
        return counter.fetch_add(1);
    }

public:
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
    std::optional<double> stop_price;
    std::optional<double> price;
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
    p.stop_price = tinyjson::getNumber(json, "stop_price");
    p.price = tinyjson::getNumber(json, "price");
    return p;
}

class Engine {
public:
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

    std::vector<std::string> validatePlaceOrder(const InboundPacket& in) {
        std::vector<std::string> errors;

        if (in.order_id <= 0) errors.push_back("Missing or invalid order_id");
        if (in.user_id <= 0) errors.push_back("Missing or invalid user_id");
        if (in.wallet_id <= 0) errors.push_back("Missing or invalid wallet_id");
        if (in.symbol.empty() || !isSupportedSymbol(in.symbol)) errors.push_back("Symbol is missing or not a known trading pair");
        if (in.side != "BUY" && in.side != "SELL") errors.push_back("side must be BUY or SELL");
        if (in.order_type != "MARKET" && in.order_type != "LIMIT" && in.order_type != "OCO") {
            errors.push_back("order_type must be MARKET, LIMIT, or OCO");
        }
        if (in.quantity <= 0 || std::isnan(in.quantity)) errors.push_back("quantity must be greater than 0");

        if (in.order_type == "LIMIT") {
            if (!in.limit_price || *in.limit_price <= 0) errors.push_back("LIMIT orders require a positive limit_price");
            if (in.stop_price) errors.push_back("LIMIT orders must not include a stop_price");
        } else if (in.order_type == "MARKET") {
            if (in.limit_price) errors.push_back("MARKET orders must not include a limit_price");
            if (in.stop_price) errors.push_back("MARKET orders must not include a stop_price");
        } else if (in.order_type == "OCO") {
            if (in.side != "SELL") errors.push_back("OCO orders are only supported on the SELL side");
            if (!in.limit_price || *in.limit_price <= 0) errors.push_back("OCO orders require a positive limit_price (take-profit leg)");
            if (!in.stop_price || *in.stop_price <= 0) errors.push_back("OCO orders require a positive stop_price (stop-loss leg)");
            if (in.limit_price && in.stop_price && *in.limit_price <= *in.stop_price) {
                errors.push_back("OCO limit_price (take-profit leg) must be above stop_price (stop-loss leg)");
            }
        }

        return errors;
    }

    void handlePlaceOrder(const InboundPacket& in, std::vector<std::string>& out) {
        auto side = parseSide(in.side);
        auto type = parseOrderType(in.order_type);

        auto errors = validatePlaceOrder(in);
        if (!errors.empty()) {
            out.push_back(orderAckToJson(in.request_id, in.order_id, 0, false, "Engine rejected order", errors));
            return;
        }

        if (*type == OrderType::OCO) {
            std::vector<ExecutionMsg> execs;
            bookFor(in.symbol).placeOco(in.order_id, in.user_id, in.wallet_id, in.symbol,
                                         in.quantity, *in.limit_price, *in.stop_price, execs);

            out.push_back(orderAckToJson(in.request_id, in.order_id, 0, true, "OCO order accepted by engine", {}));
            for (auto& e : execs) {
                e.request_id = in.request_id;
                out.push_back(executionToJson(e));
            }
            appendBookUpdate(in.symbol, out);
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
   MAIN
   ═══════════════════════════════════════════════════════════════════════ */
int main() {
    try {
        asio::io_context io;
        tcp::acceptor acceptor(io, tcp::endpoint(tcp::v4(), 9000));
        Engine engine;

        std::cout << "=====================================\n";
        std::cout << " CryptoTrade Spot Trading Engine Started\n";
        std::cout << " Listening on port 9000...\n";
        std::cout << " Expecting one shared connection from Node.\n";
        std::cout << "=====================================\n\n";

        while (true) {
            tcp::socket socket(io);
            acceptor.accept(socket);
            handleConnection(std::move(socket), engine);
        }
    } catch (std::exception& e) {
        std::cerr << "Fatal error: " << e.what() << std::endl;
    }

    return 0;
}