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
#include <set>
#include <deque>
#include <unordered_map>
#include <algorithm>
#include <chrono>
#include <atomic>

using asio::ip::tcp;

/* ═══════════════════════════════════════════════════════════════════════
   MINI JSON HELPERS (same approach as trade_engine.cpp, + getBool)
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

std::optional<bool> getBool(const std::string& json, const std::string& key) {
    auto raw = extractRaw(json, key);
    if (!raw) return std::nullopt;
    if (*raw == "true") return true;
    if (*raw == "false") return false;
    return std::nullopt;
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
enum class OrderType { MARKET, LIMIT };
enum class PositionSide { LONG, SHORT };
enum class MarginMode { ISOLATED, CROSS };
enum class PositionMode { ONE_WAY, HEDGE };
enum class OrderStatus { OPEN, PARTIALLY_FILLED, FILLED, CANCELLED, REJECTED };
enum class PositionStatus { OPEN, CLOSED };
enum class TriggerType { NONE, TAKE_PROFIT, STOP_LOSS, LIQUIDATION };
enum class PositionAction { OPEN, INCREASE, DECREASE, CLOSE, REVERSE };

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

std::optional<PositionSide> parsePositionSide(const std::string& s) {
    if (s == "LONG") return PositionSide::LONG;
    if (s == "SHORT") return PositionSide::SHORT;
    return std::nullopt;
}
std::string positionSideToStr(PositionSide s) { return s == PositionSide::LONG ? "LONG" : "SHORT"; }

std::optional<MarginMode> parseMarginMode(const std::string& s) {
    if (s == "ISOLATED") return MarginMode::ISOLATED;
    if (s == "CROSS") return MarginMode::CROSS;
    return std::nullopt;
}
std::string marginModeToStr(MarginMode m) { return m == MarginMode::ISOLATED ? "ISOLATED" : "CROSS"; }

std::optional<PositionMode> parsePositionMode(const std::string& s) {
    if (s == "ONE_WAY") return PositionMode::ONE_WAY;
    if (s == "HEDGE") return PositionMode::HEDGE;
    return std::nullopt;
}
std::string positionModeToStr(PositionMode m) { return m == PositionMode::ONE_WAY ? "ONE_WAY" : "HEDGE"; }

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

std::string positionActionToStr(PositionAction a) {
    switch (a) {
        case PositionAction::OPEN: return "OPEN";
        case PositionAction::INCREASE: return "INCREASE";
        case PositionAction::DECREASE: return "DECREASE";
        case PositionAction::CLOSE: return "CLOSE";
        case PositionAction::REVERSE: return "REVERSE";
    }
    return "OPEN";
}

std::string triggerToStr(TriggerType t) {
    switch (t) {
        case TriggerType::NONE: return "NONE";
        case TriggerType::TAKE_PROFIT: return "TAKE_PROFIT";
        case TriggerType::STOP_LOSS: return "STOP_LOSS";
        case TriggerType::LIQUIDATION: return "LIQUIDATION";
    }
    return "NONE";
}

long long nowMillis() {
    using namespace std::chrono;
    return duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count();
}

/* ═══════════════════════════════════════════════════════════════════════
   SUPPORTED SYMBOLS & RISK CONSTANTS
   ═══════════════════════════════════════════════════════════════════════ */
static const std::vector<std::string> SUPPORTED_SYMBOLS = {
    "BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT", "USDCUSDT"
};

bool isSupportedSymbol(const std::string& s) {
    for (const auto& sym : SUPPORTED_SYMBOLS) if (sym == s) return true;
    return false;
}

static const int MIN_LEVERAGE = 1;
static const int MAX_LEVERAGE = 125;
static const double TAKER_FEE_RATE = 0.0004; // 4 bps, flat — see file header

// Simplified tiered maintenance-margin schedule, keyed by position
// notional (quantity * mark_price). Real exchanges publish a much longer
// table per symbol; this is a stand-in with the same shape so it's a
// one-function change to plug in the real one later.
double maintenanceMarginRate(double notional) {
    if (notional <= 50000.0)   return 0.004;  // 0.40%
    if (notional <= 250000.0)  return 0.005;  // 0.50%
    if (notional <= 1000000.0) return 0.010;  // 1.00%
    return 0.020;                              // 2.00%
}

/* ═══════════════════════════════════════════════════════════════════════
   POSITION MODEL
   ═══════════════════════════════════════════════════════════════════════ */
struct Position {
    std::string position_key;   // "<user_id>:<symbol>:<LONG|SHORT>"
    long long user_id = 0;
    long long wallet_id = 0;
    std::string symbol;
    PositionSide side = PositionSide::LONG;
    MarginMode margin_mode = MarginMode::ISOLATED;

    double quantity = 0;
    double entry_price = 0;
    int leverage = 1;

    double initial_margin = 0;  // sum of (added_qty * price / leverage) over the position's life so far

    bool has_take_profit = false;
    double take_profit = 0;
    bool has_stop_loss = false;
    double stop_loss = 0;

    PositionStatus status = PositionStatus::OPEN;
};

// Engine-side mirror of a user's futures wallet. RAM-only — see file
// header on SYNC_WALLET for how Node re-hydrates this after a restart.
struct WalletMirror {
    long long user_id = 0;
    long long wallet_id = 0;
    double wallet_balance = 0;
    PositionMode position_mode = PositionMode::ONE_WAY;
    bool known = false; // false until seeded by a PLACE_ORDER hint or SYNC_WALLET
};

struct MarginSnapshot {
    double wallet_balance = 0;
    double used_margin = 0;
    double available_margin = 0;
};

/* ═══════════════════════════════════════════════════════════════════════
   OUTBOUND MESSAGE BUILDERS
   ═══════════════════════════════════════════════════════════════════════ */
std::string orderAckToJson(const std::string& request_id, long long db_order_id,
                            long long engine_order_id, bool accepted,
                            const std::string& message, const std::vector<std::string>& errors) {
    std::ostringstream out;
    out << "{\"type\":\"ORDER_ACK\",\"request_id\":\"" << tinyjson::esc(request_id) << "\","
        << "\"order_id\":" << db_order_id << ",\"engine_order_id\":" << engine_order_id << ","
        << "\"accepted\":" << (accepted ? "true" : "false") << ","
        << "\"message\":\"" << tinyjson::esc(message) << "\",\"errors\":[";
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
    out << "{\"type\":\"CANCEL_ACK\",\"request_id\":\"" << tinyjson::esc(request_id) << "\","
        << "\"order_id\":" << db_order_id << ",\"cancelled\":" << (cancelled ? "true" : "false") << ","
        << "\"message\":\"" << tinyjson::esc(message) << "\"}";
    return out.str();
}

std::string errorToJson(const std::string& request_id, const std::string& message) {
    std::ostringstream out;
    out << "{\"type\":\"ERROR\",\"request_id\":\"" << tinyjson::esc(request_id)
        << "\",\"message\":\"" << tinyjson::esc(message) << "\"}";
    return out.str();
}

struct ExecutionMsg {
    std::string request_id;
    long long db_order_id = 0;
    long long engine_order_id = 0;
    long long user_id = 0;
    long long wallet_id = 0;
    std::string symbol;
    Side side = Side::BUY;
    OrderType order_type = OrderType::MARKET;
    PositionSide position_side = PositionSide::LONG;
    PositionAction position_action = PositionAction::OPEN;
    double fill_quantity = 0;
    double fill_price = 0;
    double remaining_quantity = 0;
    OrderStatus status = OrderStatus::FILLED;
    double realized_pnl = 0;
    TriggerType trigger = TriggerType::NONE;
    int leverage = 1;
    MarginMode margin_mode = MarginMode::ISOLATED;   // wire needs the mode actually applied to
                                                        // this fill, not just whatever the
                                                        // position started as.
    double initial_margin = 0;   // FIX (bug #2): so Node can persist positions.initial_margin
                                    // instead of it staying permanently NULL.
};

std::string executionToJson(const ExecutionMsg& e) {
    std::ostringstream out;
    out << "{\"type\":\"EXECUTION\",\"request_id\":\"" << tinyjson::esc(e.request_id) << "\","
        << "\"order_id\":" << e.db_order_id << ",\"engine_order_id\":" << e.engine_order_id << ","
        << "\"user_id\":" << e.user_id << ",\"wallet_id\":" << e.wallet_id << ","
        << "\"symbol\":\"" << tinyjson::esc(e.symbol) << "\","
        << "\"side\":\"" << sideToStr(e.side) << "\","
        << "\"order_type\":\"" << orderTypeToStr(e.order_type) << "\","
        << "\"position_side\":\"" << positionSideToStr(e.position_side) << "\","
        << "\"position_action\":\"" << positionActionToStr(e.position_action) << "\","
        << "\"fill_quantity\":" << tinyjson::num(e.fill_quantity, 10) << ","
        << "\"fill_price\":" << tinyjson::num(e.fill_price, 8) << ","
        << "\"remaining_quantity\":" << tinyjson::num(e.remaining_quantity, 10) << ","
        << "\"status\":\"" << statusToStr(e.status) << "\","
        << "\"realized_pnl\":" << tinyjson::num(e.realized_pnl, 2) << ","
        << "\"trigger\":\"" << triggerToStr(e.trigger) << "\","
        << "\"leverage\":" << e.leverage << ","
        << "\"margin_mode\":\"" << marginModeToStr(e.margin_mode) << "\","
        << "\"initial_margin\":" << tinyjson::num(e.initial_margin, 2) << ","   // FIX (bug #2)
        << "\"timestamp\":" << nowMillis() << "}";
    return out.str();
}

std::string positionUpdateToJson(const std::string& request_id, const Position& p,
                                  double liquidation_price, bool has_liq_price,
                                  double unrealized_pnl, double mark_price,
                                  double maintenance_margin) {
    std::ostringstream out;
    out << "{\"type\":\"POSITION_UPDATE\",\"request_id\":\"" << tinyjson::esc(request_id) << "\","
        << "\"position_key\":\"" << tinyjson::esc(p.position_key) << "\","
        << "\"user_id\":" << p.user_id << ",\"wallet_id\":" << p.wallet_id << ","
        << "\"symbol\":\"" << tinyjson::esc(p.symbol) << "\","
        << "\"position_side\":\"" << positionSideToStr(p.side) << "\","
        << "\"margin_mode\":\"" << marginModeToStr(p.margin_mode) << "\","
        << "\"quantity\":" << tinyjson::num(p.quantity, 10) << ","
        << "\"entry_price\":" << tinyjson::num(p.entry_price, 8) << ","
        << "\"leverage\":" << p.leverage << ","
        << "\"initial_margin\":" << tinyjson::num(p.initial_margin, 2) << ","
        << "\"maintenance_margin\":" << tinyjson::num(maintenance_margin, 2) << ",";
    if (has_liq_price) out << "\"liquidation_price\":" << tinyjson::num(liquidation_price, 8) << ",";
    else out << "\"liquidation_price\":null,";
    out << "\"unrealized_pnl\":" << tinyjson::num(unrealized_pnl, 2) << ","
        << "\"mark_price\":" << tinyjson::num(mark_price, 8) << ","
        << "\"status\":\"" << (p.status == PositionStatus::OPEN ? "OPEN" : "CLOSED") << "\",";
    if (p.has_take_profit) out << "\"take_profit\":" << tinyjson::num(p.take_profit, 8) << ",";
    else out << "\"take_profit\":null,";
    if (p.has_stop_loss) out << "\"stop_loss\":" << tinyjson::num(p.stop_loss, 8) << ",";
    else out << "\"stop_loss\":null,";
    out << "\"timestamp\":" << nowMillis() << "}";
    return out.str();
}

std::string marginUpdateToJson(const std::string& request_id, long long user_id, long long wallet_id,
                                const MarginSnapshot& m) {
    std::ostringstream out;
    out << "{\"type\":\"MARGIN_UPDATE\",\"request_id\":\"" << tinyjson::esc(request_id) << "\","
        << "\"user_id\":" << user_id << ",\"wallet_id\":" << wallet_id << ","
        << "\"wallet_balance\":" << tinyjson::num(m.wallet_balance, 2) << ","
        << "\"used_margin\":" << tinyjson::num(m.used_margin, 2) << ","
        << "\"available_margin\":" << tinyjson::num(m.available_margin, 2) << ","
        << "\"timestamp\":" << nowMillis() << "}";
    return out.str();
}

std::string liquidationToJson(const std::string& request_id, const Position& p,
                               double liquidated_qty, double remaining_qty,
                               double liquidation_price, double mark_price,
                               double realized_pnl, bool is_partial) {
    std::ostringstream out;
    out << "{\"type\":\"LIQUIDATION\",\"request_id\":\"" << tinyjson::esc(request_id) << "\","
        << "\"position_key\":\"" << tinyjson::esc(p.position_key) << "\","
        << "\"user_id\":" << p.user_id << ",\"wallet_id\":" << p.wallet_id << ","
        << "\"symbol\":\"" << tinyjson::esc(p.symbol) << "\","
        << "\"position_side\":\"" << positionSideToStr(p.side) << "\","
        << "\"margin_mode\":\"" << marginModeToStr(p.margin_mode) << "\","
        << "\"initial_margin\":" << tinyjson::num(p.initial_margin, 2) << ","   // FIX (bug #2):
                                                                                    // p is already
                                                                                    // leg->position_after,
                                                                                    // which carries the
                                                                                    // correct post-
                                                                                    // liquidation value.
        << "\"liquidated_quantity\":" << tinyjson::num(liquidated_qty, 10) << ","
        << "\"remaining_quantity\":" << tinyjson::num(remaining_qty, 10) << ","
        << "\"liquidation_price\":" << tinyjson::num(liquidation_price, 8) << ","
        << "\"mark_price\":" << tinyjson::num(mark_price, 8) << ","
        << "\"realized_pnl\":" << tinyjson::num(realized_pnl, 2) << ","
        << "\"is_partial\":" << (is_partial ? "true" : "false") << ","
        << "\"timestamp\":" << nowMillis() << "}";
    return out.str();
}

std::string fundingAppliedToJson(const std::string& request_id, const Position& p,
                                  double funding_rate, double funding_fee, double mark_price) {
    std::ostringstream out;
    out << "{\"type\":\"FUNDING_APPLIED\",\"request_id\":\"" << tinyjson::esc(request_id) << "\","
        << "\"position_key\":\"" << tinyjson::esc(p.position_key) << "\","
        << "\"user_id\":" << p.user_id << ",\"wallet_id\":" << p.wallet_id << ","
        << "\"symbol\":\"" << tinyjson::esc(p.symbol) << "\","
        << "\"position_side\":\"" << positionSideToStr(p.side) << "\","
        << "\"funding_rate\":" << tinyjson::num(funding_rate, 8) << ","
        << "\"funding_fee\":" << tinyjson::num(funding_fee, 2) << ","
        << "\"mark_price\":" << tinyjson::num(mark_price, 8) << ","
        << "\"timestamp\":" << nowMillis() << "}";
    return out.str();
}

/* ═══════════════════════════════════════════════════════════════════════
   ACCOUNT MANAGER — Position Engine + Margin Engine + PnL Engine +
   Risk/Liquidation Engine + Funding Engine.
   Kept as one class because every one of those computations reads and
   writes the same two maps (wallets_, positions_); splitting them into
   separate classes would just mean passing both maps around everywhere.
   The public methods below are grouped by which "engine" they represent.
   ═══════════════════════════════════════════════════════════════════════ */
class AccountManager {
public:
    static std::string keyFor(long long user_id, const std::string& symbol, PositionSide side) {
        return std::to_string(user_id) + ":" + symbol + ":" + positionSideToStr(side);
    }

    WalletMirror& getOrCreateWallet(long long user_id, long long wallet_id,
                                     double wallet_balance_hint, PositionMode mode_hint) {
        auto it = wallets_.find(user_id);
        if (it != wallets_.end()) return it->second;
        WalletMirror w;
        w.user_id = user_id;
        w.wallet_id = wallet_id;
        w.wallet_balance = wallet_balance_hint;
        w.position_mode = mode_hint;
        w.known = true;
        return wallets_.emplace(user_id, w).first->second;
    }

    bool hasWallet(long long user_id) const { return wallets_.find(user_id) != wallets_.end(); }

    void syncWallet(long long user_id, long long wallet_id, double wallet_balance, PositionMode mode) {
        WalletMirror w;
        w.user_id = user_id;
        w.wallet_id = wallet_id;
        w.wallet_balance = wallet_balance;
        w.position_mode = mode;
        w.known = true;
        wallets_[user_id] = w;
    }

    void syncPosition(long long user_id, long long wallet_id, const std::string& symbol,
                       PositionSide side, MarginMode marginMode, double quantity, double entry_price,
                       int leverage, std::optional<double> tp, std::optional<double> sl) {
        Position p;
        p.position_key = keyFor(user_id, symbol, side);
        p.user_id = user_id;
        p.wallet_id = wallet_id;
        p.symbol = symbol;
        p.side = side;
        p.margin_mode = marginMode;
        p.quantity = quantity;
        p.entry_price = entry_price;
        p.leverage = leverage;
        p.initial_margin = (quantity * entry_price) / std::max(1, leverage);
        if (tp) { p.has_take_profit = true; p.take_profit = *tp; }
        if (sl) { p.has_stop_loss = true; p.stop_loss = *sl; }
        p.status = PositionStatus::OPEN;
        positions_[p.position_key] = p;
    }

    void setMarkPrice(const std::string& symbol, double price) { markPrices_[symbol] = price; }

    double markPriceOr(const std::string& symbol, double fallback) const {
        auto it = markPrices_.find(symbol);
        return it == markPrices_.end() ? fallback : it->second;
    }

    Position* findPosition(long long user_id, const std::string& symbol, PositionSide side) {
        auto it = positions_.find(keyFor(user_id, symbol, side));
        if (it == positions_.end() || it->second.status != PositionStatus::OPEN) return nullptr;
        return &it->second;
    }

    /* ── PnL Engine ────────────────────────────────────────────────── */
    static double unrealizedPnl(const Position& p, double markPrice) {
        return p.side == PositionSide::LONG
            ? (markPrice - p.entry_price) * p.quantity
            : (p.entry_price - markPrice) * p.quantity;
    }

    static double maintenanceMargin(const Position& p, double markPrice) {
        double notional = p.quantity * markPrice;
        return notional * maintenanceMarginRate(notional);
    }

    // Simplified liquidation-price formula (ignores funding accrued since
    // entry and folds fees into the maintenance-margin rate). For
    // ISOLATED only — a CROSS position's liquidation price depends on
    // the rest of the user's book/wallet, which this static function has
    // no access to. Use computeLiquidationPriceForPosition() below for
    // the mode-aware version; this one remains as its ISOLATED building
    // block (and for any caller that's already confirmed ISOLATED).
    static std::optional<double> computeLiquidationPrice(const Position& p) {
        if (p.margin_mode != MarginMode::ISOLATED || p.quantity <= 0) return std::nullopt;
        double mmr = maintenanceMarginRate(p.quantity * p.entry_price);
        double marginRatioPerUnit = p.initial_margin / p.quantity; // ~ entry_price / leverage
        if (p.side == PositionSide::LONG) {
            return p.entry_price - marginRatioPerUnit + p.entry_price * mmr;
        } else {
            return p.entry_price + marginRatioPerUnit - p.entry_price * mmr;
        }
    }

    // Mode-aware liquidation price. For ISOLATED, delegates to the
    // formula above unchanged. For CROSS, solves for the mark price of
    // THIS symbol at which the user's total CROSS equity (wallet_balance
    // + unrealized PnL across all their CROSS positions) would equal
    // their total CROSS maintenance margin, holding every other CROSS
    // position's mark price fixed at its current value. That's the same
    // simplification real "isolated view" cross-liquidation estimates
    // make — it's an estimate for display, not the literal trigger
    // condition; checkCrossLiquidations() below is what actually decides
    // liquidation, evaluated fresh each tick against the true
    // multi-symbol state.
    std::optional<double> computeLiquidationPriceForPosition(const Position& p) {
        if (p.quantity <= 0) return std::nullopt;
        if (p.margin_mode == MarginMode::ISOLATED) return computeLiquidationPrice(p);

        auto wIt = wallets_.find(p.user_id);
        if (wIt == wallets_.end()) return std::nullopt;

        double otherEquity = wIt->second.wallet_balance;
        double otherMaint = 0.0;
        for (auto& kv : positions_) {
            const Position& other = kv.second;
            if (other.user_id != p.user_id || other.status != PositionStatus::OPEN ||
                other.margin_mode != MarginMode::CROSS || other.position_key == p.position_key) {
                continue;
            }
            double mp = markPriceOr(other.symbol, other.entry_price);
            otherEquity += unrealizedPnl(other, mp);
            otherMaint += maintenanceMargin(other, mp);
        }

        double mmr = maintenanceMarginRate(p.quantity * p.entry_price);
        double mp;
        if (p.side == PositionSide::LONG) {
            // Solve: otherEquity + (mp - entry)*qty == otherMaint + qty*mp*mmr
            double denom = p.quantity * (1.0 - mmr);
            if (denom <= 0) return std::nullopt;
            mp = (otherMaint - otherEquity + p.quantity * p.entry_price) / denom;
        } else {
            // Solve: otherEquity + (entry - mp)*qty == otherMaint + qty*mp*mmr
            double denom = p.quantity * (1.0 + mmr);
            if (denom <= 0) return std::nullopt;
            mp = (otherEquity + p.quantity * p.entry_price - otherMaint) / denom;
        }
        if (mp < 0) return std::nullopt; // account already unhealthy independent of this position
        return mp;
    }

    /* ── Margin Engine ─────────────────────────────────────────────── */
    MarginSnapshot recomputeMargin(long long user_id) {
        MarginSnapshot snap;
        auto wIt = wallets_.find(user_id);
        if (wIt == wallets_.end()) return snap;
        WalletMirror& w = wIt->second;

        double sumInitialMargin = 0;
        double sumUnrealizedCross = 0;
        for (auto& kv : positions_) {
            Position& p = kv.second;
            if (p.user_id != user_id || p.status != PositionStatus::OPEN) continue;
            double mp = markPriceOr(p.symbol, p.entry_price);
            sumInitialMargin += p.initial_margin;
            if (p.margin_mode == MarginMode::CROSS) {
                sumUnrealizedCross += unrealizedPnl(p, mp);
            }
        }

        double equity = w.wallet_balance + sumUnrealizedCross;
        double used = sumInitialMargin;
        double available = equity - used;
        if (available < 0) available = 0;

        w.wallet_balance = w.wallet_balance; // unchanged here — only mutated by realize/funding/liquidation
        snap.wallet_balance = w.wallet_balance;
        snap.used_margin = used;
        snap.available_margin = available;
        return snap;
    }

    /* ── Position Engine ───────────────────────────────────────────── */
    // Result of applying one fill. `filled` may be less than requested
    // (reduce-only clamped to available position size, or nothing to
    // reduce at all) — caller decides how to report the shortfall.
    struct FillLeg {
        PositionAction action;
        double filled_qty;
        double fill_price;
        double realized_pnl;
        Position position_after; // snapshot for POSITION_UPDATE
        bool position_still_open;
    };

    struct FillResult {
        std::vector<FillLeg> legs; // usually 1, up to 2 for a one-way reversal (close opposite + open new)
        double total_filled = 0;
    };

    FillResult applyFill(long long user_id, long long wallet_id, const std::string& symbol,
                          PositionSide targetSide, MarginMode marginMode, int leverage,
                          bool reduceOnly, PositionMode mode, double qty, double price,
                          std::optional<double> take_profit, std::optional<double> stop_loss) {
        FillResult result;
        getOrCreateWallet(user_id, wallet_id, 0.0, mode); // no-op if already known

        if (reduceOnly) {
            auto leg = closeAgainst(user_id, wallet_id, symbol, targetSide, qty, price, TriggerType::NONE);
            if (leg) { result.legs.push_back(*leg); result.total_filled += leg->filled_qty; }
            return result;
        }

        PositionSide opposite = (targetSide == PositionSide::LONG) ? PositionSide::SHORT : PositionSide::LONG;

        if (mode == PositionMode::ONE_WAY) {
            Position* oppPos = findPosition(user_id, symbol, opposite);
            double oppQty = oppPos ? oppPos->quantity : 0;
            if (oppQty > 1e-12) {
                double closeQty = std::min(qty, oppQty);
                auto closeLeg = closeAgainst(user_id, wallet_id, symbol, opposite, closeQty, price, TriggerType::NONE);
                if (closeLeg) {
                    closeLeg->action = (closeQty >= oppQty - 1e-12) ? PositionAction::REVERSE : PositionAction::DECREASE;
                    result.legs.push_back(*closeLeg);
                    result.total_filled += closeLeg->filled_qty;
                }
                double remainder = qty - closeQty;
                if (remainder > 1e-12) {
                    auto openLeg = openOrIncrease(user_id, wallet_id, symbol, targetSide, marginMode,
                                                   leverage, remainder, price, take_profit, stop_loss);
                    result.legs.push_back(openLeg);
                    result.total_filled += openLeg.filled_qty;
                }
                return result;
            }
        }

        auto openLeg = openOrIncrease(user_id, wallet_id, symbol, targetSide, marginMode,
                                       leverage, qty, price, take_profit, stop_loss);
        result.legs.push_back(openLeg);
        result.total_filled += openLeg.filled_qty;
        return result;
    }

    void updateTpSl(long long user_id, const std::string& symbol, PositionSide side,
                     std::optional<double> tp, bool clearTp,
                     std::optional<double> sl, bool clearSl) {
        Position* p = findPosition(user_id, symbol, side);
        if (!p) return;
        if (clearTp) { p->has_take_profit = false; }
        else if (tp) { p->has_take_profit = true; p->take_profit = *tp; }
        if (clearSl) { p->has_stop_loss = false; }
        else if (sl) { p->has_stop_loss = true; p->stop_loss = *sl; }
    }

    /* ── Risk Engine / Liquidation Engine ────────────────────────────
       Called on every MARK_PRICE_UPDATE for `symbol`. Appends
       LIQUIDATION / EXECUTION / POSITION_UPDATE / MARGIN_UPDATE lines
       for anything it liquidates, plus TP/SL triggers it fires, plus a
       routine POSITION_UPDATE/MARGIN_UPDATE for every other open
       position on this symbol, so mark price / uPnL / margin /
       liquidation price stay live on ticks where nothing triggers. */
    void checkRisk(const std::string& request_id, const std::string& symbol, double markPrice,
                    std::vector<std::string>& out) {
        setMarkPrice(symbol, markPrice);

        // Tracks which position_keys already got a POSITION_UPDATE /
        // MARGIN_UPDATE this tick (via TP/SL or liquidation), so the
        // routine pass at the end doesn't double-send for them.
        std::set<std::string> alreadyEmitted;

        // 1) TP/SL triggers (evaluated before liquidation — closing on a
        //    TP/SL is the user's own instruction and should win if both
        //    would fire on the same tick).
        for (auto& kv : positions_) {
            Position& p = kv.second;
            if (p.symbol != symbol || p.status != PositionStatus::OPEN) continue;
            TriggerType fired = TriggerType::NONE;
            if (p.has_take_profit) {
                bool hit = (p.side == PositionSide::LONG) ? (markPrice >= p.take_profit)
                                                            : (markPrice <= p.take_profit);
                if (hit) fired = TriggerType::TAKE_PROFIT;
            }
            if (fired == TriggerType::NONE && p.has_stop_loss) {
                bool hit = (p.side == PositionSide::LONG) ? (markPrice <= p.stop_loss)
                                                            : (markPrice >= p.stop_loss);
                if (hit) fired = TriggerType::STOP_LOSS;
            }
            if (fired == TriggerType::NONE) continue;

            long long user_id = p.user_id;
            std::string sym = p.symbol;
            PositionSide side = p.side;
            double qty = p.quantity;
            auto leg = closeAgainst(user_id, p.wallet_id, sym, side, qty, markPrice, fired);
            if (!leg) continue;

            ExecutionMsg ex;
            ex.request_id = request_id;
            ex.db_order_id = 0; // not tied to a specific Node order row — TP/SL fires from the position
            ex.user_id = user_id;
            ex.wallet_id = leg->position_after.wallet_id;
            ex.symbol = sym;
            ex.side = (side == PositionSide::LONG) ? Side::SELL : Side::BUY;
            ex.order_type = OrderType::MARKET;
            ex.position_side = side;
            ex.position_action = PositionAction::CLOSE;
            ex.fill_quantity = leg->filled_qty;
            ex.fill_price = markPrice;
            ex.remaining_quantity = 0;
            ex.status = OrderStatus::FILLED;
            ex.realized_pnl = leg->realized_pnl;
            ex.trigger = fired;
            ex.margin_mode = leg->position_after.margin_mode;
            ex.leverage = leg->position_after.leverage;                 // FIX (bug #1)
            ex.initial_margin = leg->position_after.initial_margin;     // FIX (bug #2)
            out.push_back(executionToJson(ex));
            emitPositionAndMargin(request_id, leg->position_after, leg->position_still_open, out);
            alreadyEmitted.insert(leg->position_after.position_key);
        }

        // 2) Liquidation checks — ISOLATED positions individually, CROSS
        //    accounts in aggregate. See file header for the simplifications.
        checkIsolatedLiquidations(request_id, symbol, markPrice, out, alreadyEmitted);
        checkCrossLiquidations(request_id, symbol, markPrice, out, alreadyEmitted);

        // 3) Routine push for every open position on this symbol that
        //    wasn't already reported above. This is the fix for "not
        //    showing any changes in current positions": previously a
        //    normal tick where nothing triggered emitted nothing at all,
        //    so mark price / uPnL / margin / liquidation price all
        //    looked frozen between triggers.
        for (auto& kv : positions_) {
            Position& p = kv.second;
            if (p.symbol != symbol || p.status != PositionStatus::OPEN) continue;
            if (alreadyEmitted.count(p.position_key)) continue;
            emitPositionAndMargin(request_id, p, true, out);
        }
    }

    /* ── Funding Engine ──────────────────────────────────────────────
       payment = notional * rate. LONG pays when rate > 0 (debit),
       SHORT receives when rate > 0 (credit); signs flip when rate < 0. */
    void applyFunding(const std::string& request_id, const std::string& symbol,
                       double fundingRate, std::vector<std::string>& out) {
        double mp = markPriceOr(symbol, 0);
        for (auto& kv : positions_) {
            Position& p = kv.second;
            if (p.symbol != symbol || p.status != PositionStatus::OPEN) continue;
            double markPrice = mp > 0 ? mp : p.entry_price;
            double notional = p.quantity * markPrice;
            double signedFee = (p.side == PositionSide::LONG ? 1.0 : -1.0) * notional * fundingRate;

            auto wIt = wallets_.find(p.user_id);
            if (wIt == wallets_.end()) continue;
            wIt->second.wallet_balance -= signedFee;

            out.push_back(fundingAppliedToJson(request_id, p, fundingRate, signedFee, markPrice));
            out.push_back(marginUpdateToJson(request_id, p.user_id, p.wallet_id, recomputeMargin(p.user_id)));
        }
    }

private:
    std::unordered_map<long long, WalletMirror> wallets_;
    std::unordered_map<std::string, Position> positions_; // key = keyFor(...)
    std::unordered_map<std::string, double> markPrices_;

    FillLeg openOrIncrease(long long user_id, long long wallet_id, const std::string& symbol,
                            PositionSide side, MarginMode marginMode, int leverage, double qty,
                            double price, std::optional<double> tp, std::optional<double> sl) {
        std::string key = keyFor(user_id, symbol, side);
        Position& p = positions_[key]; // creates a zeroed Position if new
        bool isNew = (p.quantity <= 0);
        if (isNew) {
            p.position_key = key;
            p.user_id = user_id;
            p.wallet_id = wallet_id;
            p.symbol = symbol;
            p.side = side;
            p.leverage = std::max(1, leverage);
            p.quantity = 0;
            p.entry_price = 0;
            p.initial_margin = 0;
            p.status = PositionStatus::OPEN;
        }

        // Resync margin_mode on EVERY fill, not just the first one.
        // Previously this line lived inside `if (isNew)` above, so a DCA
        // fill made with a different mode selected on the order ticket
        // silently left the position on its original mode — the ticket
        // said CROSS, the position was secretly still ISOLATED, and
        // ISOLATED's tighter per-position cushion is what produced
        // "liquidating before it should" from a CROSS mindset.
        p.margin_mode = marginMode;

        double newQty = p.quantity + qty;
        p.entry_price = (p.quantity * p.entry_price + qty * price) / newQty;
        p.quantity = newQty;
        p.initial_margin += (qty * price) / std::max(1, p.leverage);
        if (tp) { p.has_take_profit = true; p.take_profit = *tp; }
        if (sl) { p.has_stop_loss = true; p.stop_loss = *sl; }

        FillLeg leg;
        leg.action = isNew ? PositionAction::OPEN : PositionAction::INCREASE;
        leg.filled_qty = qty;
        leg.fill_price = price;
        leg.realized_pnl = 0;
        leg.position_after = p;
        leg.position_still_open = true;
        return leg;
    }

    // Closes up to `qty` of the named slot. Returns nullopt if there is
    // nothing open on that slot (nothing to reduce). Clamps qty to the
    // slot's current size — a reduce-only fill can never exceed it.
    std::optional<FillLeg> closeAgainst(long long user_id, long long wallet_id, const std::string& symbol,
                                         PositionSide side, double qty, double price, TriggerType trigger) {
        std::string key = keyFor(user_id, symbol, side);
        auto it = positions_.find(key);
        if (it == positions_.end() || it->second.status != PositionStatus::OPEN || it->second.quantity <= 1e-12) {
            return std::nullopt;
        }
        Position& p = it->second;
        double filled = std::min(qty, p.quantity);
        double rawPnl = (p.side == PositionSide::LONG)
            ? (price - p.entry_price) * filled
            : (p.entry_price - price) * filled;
        double fee = filled * price * TAKER_FEE_RATE;

        double marginPortion = (p.quantity > 0) ? p.initial_margin * (filled / p.quantity) : 0;
        // Isolated positions can't drag the wallet below zero from their
        // own loss — cap the realized loss at what was allocated to them.
        double realized = rawPnl - fee;
        if (p.margin_mode == MarginMode::ISOLATED && realized < -marginPortion) {
            realized = -marginPortion;
        }

        p.quantity -= filled;
        p.initial_margin -= marginPortion;
        bool stillOpen = p.quantity > 1e-9;
        if (!stillOpen) {
            p.quantity = 0;
            p.initial_margin = 0;
            p.status = PositionStatus::CLOSED;
        }

        auto wIt = wallets_.find(user_id);
        if (wIt != wallets_.end()) wIt->second.wallet_balance += realized;

        FillLeg leg;
        leg.action = stillOpen ? PositionAction::DECREASE : PositionAction::CLOSE;
        leg.filled_qty = filled;
        leg.fill_price = price;
        leg.realized_pnl = realized;
        leg.position_after = p;
        leg.position_still_open = stillOpen;
        return leg;
    }

    void emitPositionAndMargin(const std::string& request_id, const Position& p, bool stillOpen,
                                std::vector<std::string>& out) {
        double mp = markPriceOr(p.symbol, p.entry_price);
        double upnl = stillOpen ? unrealizedPnl(p, mp) : 0;
        double maint = stillOpen ? maintenanceMargin(p, mp) : 0;
        // Mode-aware liquidation price instead of the ISOLATED-only
        // static helper, so CROSS positions get a real (estimated)
        // liquidation price instead of always null.
        auto liq = stillOpen ? computeLiquidationPriceForPosition(p) : std::nullopt;
        out.push_back(positionUpdateToJson(request_id, p, liq.value_or(0), liq.has_value(), upnl, mp, maint));
        out.push_back(marginUpdateToJson(request_id, p.user_id, p.wallet_id, recomputeMargin(p.user_id)));
    }

    void checkIsolatedLiquidations(const std::string& request_id, const std::string& symbol,
                                    double markPrice, std::vector<std::string>& out,
                                    std::set<std::string>& alreadyEmitted) {
        // Collect keys first — liquidating can erase/shrink map entries
        // and we don't want to invalidate the iterator we're walking.
        std::vector<std::string> keys;
        for (auto& kv : positions_) {
            if (kv.second.symbol == symbol && kv.second.status == PositionStatus::OPEN &&
                kv.second.margin_mode == MarginMode::ISOLATED) {
                keys.push_back(kv.first);
            }
        }
        for (auto& key : keys) {
            auto it = positions_.find(key);
            if (it == positions_.end() || it->second.status != PositionStatus::OPEN) continue;
            liquidateIsolatedIfUnhealthy(request_id, it->second, markPrice, out, alreadyEmitted);
        }
    }

    // Isolated margin balance = initial_margin + unrealized PnL. If that
    // drops to/below maintenance margin, liquidate. Tries a 50% partial
    // liquidation first (real exchanges do this in slices); if the
    // position is still unhealthy afterward, finishes it off.
    void liquidateIsolatedIfUnhealthy(const std::string& request_id, Position& p, double markPrice,
                                       std::vector<std::string>& out,
                                       std::set<std::string>& alreadyEmitted) {
        double upnl = unrealizedPnl(p, markPrice);
        double maint = maintenanceMargin(p, markPrice);
        double marginBalance = p.initial_margin + upnl;
        if (marginBalance > maint) return; // healthy

        double originalQty = p.quantity;
        double partialQty = originalQty * 0.5;
        bool didPartial = false;

        if (partialQty > 1e-9) {
            auto leg = closeAgainst(p.user_id, p.wallet_id, p.symbol, p.side, partialQty, markPrice, TriggerType::LIQUIDATION);
            if (leg) {
                out.push_back(liquidationToJson(request_id, leg->position_after, leg->filled_qty,
                                                 leg->position_after.quantity, markPrice, markPrice,
                                                 leg->realized_pnl, true));
                emitPositionAndMargin(request_id, leg->position_after, leg->position_still_open, out);
                alreadyEmitted.insert(leg->position_after.position_key);
                didPartial = leg->position_still_open;
            }
        }

        if (!didPartial) return; // fully closed by the "partial" (it was <= remaining), nothing more to do

        // Re-check health after the partial; if still unhealthy, finish it.
        auto it2 = positions_.find(p.position_key);
        if (it2 == positions_.end() || it2->second.status != PositionStatus::OPEN) return;
        Position& p2 = it2->second;
        double upnl2 = unrealizedPnl(p2, markPrice);
        double maint2 = maintenanceMargin(p2, markPrice);
        if (p2.initial_margin + upnl2 > maint2) return; // partial brought it back to health

        auto leg2 = closeAgainst(p2.user_id, p2.wallet_id, p2.symbol, p2.side, p2.quantity, markPrice, TriggerType::LIQUIDATION);
        if (leg2) {
            out.push_back(liquidationToJson(request_id, leg2->position_after, leg2->filled_qty, 0,
                                             markPrice, markPrice, leg2->realized_pnl, false));
            emitPositionAndMargin(request_id, leg2->position_after, leg2->position_still_open, out);
            alreadyEmitted.insert(leg2->position_after.position_key);
        }
    }

    // Account-level: equity (wallet_balance + unrealized PnL of CROSS
    // positions) vs total maintenance margin of CROSS positions. If
    // unhealthy, liquidate whole CROSS positions one at a time (largest
    // maintenance requirement first) until healthy or out of positions.
    void checkCrossLiquidations(const std::string& request_id, const std::string& symbol,
                                 double markPrice, std::vector<std::string>& out,
                                 std::set<std::string>& alreadyEmitted) {
        // Only users with an open CROSS position on this symbol are
        // candidates; a symbol-level mark price tick can only threaten
        // accounts holding that symbol (their other CROSS positions'
        // health hasn't changed on this tick).
        std::vector<long long> affectedUsers;
        for (auto& kv : positions_) {
            if (kv.second.symbol == symbol && kv.second.status == PositionStatus::OPEN &&
                kv.second.margin_mode == MarginMode::CROSS) {
                affectedUsers.push_back(kv.second.user_id);
            }
        }
        std::sort(affectedUsers.begin(), affectedUsers.end());
        affectedUsers.erase(std::unique(affectedUsers.begin(), affectedUsers.end()), affectedUsers.end());

        for (long long user_id : affectedUsers) {
            for (int guard = 0; guard < 50; guard++) { // bounded loop, never truly infinite
                double equity = 0, totalMaint = 0;
                std::vector<std::pair<double, std::string>> crossPositions; // (maintenance, key), largest first
                auto wIt = wallets_.find(user_id);
                if (wIt == wallets_.end()) break;
                equity = wIt->second.wallet_balance;

                for (auto& kv : positions_) {
                    Position& p = kv.second;
                    if (p.user_id != user_id || p.status != PositionStatus::OPEN || p.margin_mode != MarginMode::CROSS) continue;
                    double mp = markPriceOr(p.symbol, p.entry_price);
                    equity += unrealizedPnl(p, mp);
                    double maint = maintenanceMargin(p, mp);
                    totalMaint += maint;
                    crossPositions.push_back({ maint, kv.first });
                }
                if (crossPositions.empty() || equity > totalMaint) break; // healthy or nothing left

                std::sort(crossPositions.begin(), crossPositions.end(),
                          [](auto& a, auto& b) { return a.first > b.first; });
                auto worstIt = positions_.find(crossPositions.front().second);
                if (worstIt == positions_.end()) break;
                Position& worst = worstIt->second;
                double mp = markPriceOr(worst.symbol, worst.entry_price);

                auto leg = closeAgainst(worst.user_id, worst.wallet_id, worst.symbol, worst.side,
                                         worst.quantity, mp, TriggerType::LIQUIDATION);
                if (!leg) break;
                out.push_back(liquidationToJson(request_id, leg->position_after, leg->filled_qty, 0,
                                                 mp, mp, leg->realized_pnl, false));
                emitPositionAndMargin(request_id, leg->position_after, leg->position_still_open, out);
                alreadyEmitted.insert(leg->position_after.position_key);
            }
        }
    }
};

/* ═══════════════════════════════════════════════════════════════════════
   SYMBOL BOOK — Matching Engine (price-time priority, same shape as the
   spot OrderBook). MARKET fills immediately at the last-traded price;
   LIMIT rests until the last-traded price crosses it. On any fill, hands
   off to AccountManager instead of emitting a plain asset transfer.
   ═══════════════════════════════════════════════════════════════════════ */
struct RestingOrder {
    long long engine_order_id = 0;
    long long db_order_id = 0;
    long long user_id = 0;
    long long wallet_id = 0;
    std::string symbol;
    Side side = Side::BUY;
    PositionSide position_side = PositionSide::LONG;
    MarginMode margin_mode = MarginMode::ISOLATED;
    PositionMode position_mode = PositionMode::ONE_WAY;
    int leverage = 1;
    bool reduce_only = false;
    double quantity = 0;
    double remaining_quantity = 0;
    double limit_price = 0;
    std::optional<double> take_profit;
    std::optional<double> stop_loss;
};

class SymbolBook {
public:
    explicit SymbolBook(std::string symbol, AccountManager& accounts)
        : symbol_(std::move(symbol)), accounts_(accounts) {}

    static long long allocateEngineOrderId() {
        static std::atomic<long long> counter{1};
        return counter.fetch_add(1);
    }

    // Returns false only for "MARKET order but no reference price yet".
    // On success, appends ORDER_ACK-adjacent EXECUTION/POSITION_UPDATE/
    // MARGIN_UPDATE lines to `out` for whatever filled immediately.
    bool placeOrder(const std::string& request_id, RestingOrder order, OrderType type,
                     std::vector<std::string>& out, std::string& rejectReason) {
        if (type == OrderType::MARKET) {
            if (!has_price_) {
                rejectReason = "No reference price available yet for " + symbol_ + "; try again shortly";
                return false;
            }
            fillOrder(request_id, order, order.quantity, last_price_, out);
            return true;
        }

        // LIMIT — rest it, then try to match immediately in case it's
        // already marketable against the current last price.
        entryIndex_[order.db_order_id] = { order.limit_price, order.side == Side::BUY };
        if (order.side == Side::BUY) buyLimits_[order.limit_price].push_back(order);
        else sellLimits_[order.limit_price].push_back(order);

        if (has_price_) matchLimitsAgainstLastPrice(request_id, out);
        return true;
    }

    bool cancelOrder(long long dbOrderId, std::string& message) {
        auto it = entryIndex_.find(dbOrderId);
        if (it == entryIndex_.end()) {
            message = "Order not found on the book (already filled/cancelled, or unknown to this engine)";
            return false;
        }
        double price = it->second.price;
        bool isBuy = it->second.isBuy;
        // buyLimits_ and sellLimits_ are different std::map instantiations
        // (buy side uses std::greater<double> for highest-price-first), so
        // they can't share a reference via a ternary — branch explicitly,
        // same as the spot engine's cancelOrder.
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

    void onPriceUpdate(const std::string& request_id, double price, std::vector<std::string>& out) {
        last_price_ = price;
        has_price_ = true;
        matchLimitsAgainstLastPrice(request_id, out);
    }

    struct TopOfBook {
        double last_price = 0; bool has_price = false;
        double best_bid = 0; double best_bid_qty = 0; bool has_bid = false;
        double best_ask = 0; double best_ask_qty = 0; bool has_ask = false;
    };
    TopOfBook topOfBook() const {
        TopOfBook tb;
        tb.last_price = last_price_; tb.has_price = has_price_;
        if (!buyLimits_.empty()) {
            const auto& lvl = *buyLimits_.begin();
            tb.best_bid = lvl.first; tb.has_bid = true;
            for (auto& o : lvl.second) tb.best_bid_qty += o.remaining_quantity;
        }
        if (!sellLimits_.empty()) {
            const auto& lvl = *sellLimits_.begin();
            tb.best_ask = lvl.first; tb.has_ask = true;
            for (auto& o : lvl.second) tb.best_ask_qty += o.remaining_quantity;
        }
        return tb;
    }

private:
    std::string symbol_;
    AccountManager& accounts_;
    double last_price_ = 0;
    bool has_price_ = false;

    std::map<double, std::deque<RestingOrder>, std::greater<double>> buyLimits_;
    std::map<double, std::deque<RestingOrder>> sellLimits_;
    struct EntryLoc { double price; bool isBuy; };
    std::unordered_map<long long, EntryLoc> entryIndex_;

    void matchLimitsAgainstLastPrice(const std::string& request_id, std::vector<std::string>& out) {
        bool progressed = true;
        while (progressed) {
            progressed = false;
            while (!buyLimits_.empty()) {
                auto it = buyLimits_.begin();
                if (it->first < last_price_) break;
                fillLevelFIFO(request_id, it->second, out);
                if (it->second.empty()) buyLimits_.erase(it);
                progressed = true;
            }
            while (!sellLimits_.empty()) {
                auto it = sellLimits_.begin();
                if (it->first > last_price_) break;
                fillLevelFIFO(request_id, it->second, out);
                if (it->second.empty()) sellLimits_.erase(it);
                progressed = true;
            }
        }
    }

    void fillLevelFIFO(const std::string& request_id, std::deque<RestingOrder>& level, std::vector<std::string>& out) {
        while (!level.empty()) {
            RestingOrder order = level.front();
            level.pop_front();
            entryIndex_.erase(order.db_order_id);
            fillOrder(request_id, order, order.quantity, last_price_, out);
        }
    }

    void fillOrder(const std::string& request_id, const RestingOrder& order, double qty, double price,
                    std::vector<std::string>& out) {
        auto result = accounts_.applyFill(order.user_id, order.wallet_id, order.symbol,
                                           order.position_side, order.margin_mode, order.leverage,
                                           order.reduce_only, order.position_mode, qty, price,
                                           order.take_profit, order.stop_loss);

        double totalFilled = result.total_filled;
        double remaining = qty - totalFilled; // >0 only if reduce-only had nothing left to reduce

        for (auto& leg : result.legs) {
            ExecutionMsg ex;
            ex.request_id = request_id;
            ex.db_order_id = order.db_order_id;
            ex.engine_order_id = order.engine_order_id;
            ex.user_id = order.user_id;
            ex.wallet_id = order.wallet_id;
            ex.symbol = order.symbol;
            ex.side = order.side;
            ex.order_type = order.limit_price > 0 ? OrderType::LIMIT : OrderType::MARKET;
            ex.position_side = leg.position_after.side;
            ex.position_action = leg.action;
            ex.fill_quantity = leg.filled_qty;
            ex.fill_price = leg.fill_price;
            ex.remaining_quantity = remaining;
            ex.status = remaining > 1e-9 ? OrderStatus::PARTIALLY_FILLED : OrderStatus::FILLED;
            ex.realized_pnl = leg.realized_pnl;
            ex.trigger = TriggerType::NONE;
            ex.margin_mode = leg.position_after.margin_mode;
            ex.leverage = leg.position_after.leverage;                 // FIX (bug #1): was left at
                                                                          // the struct default of 1
                                                                          // on every fill.
            ex.initial_margin = leg.position_after.initial_margin;     // FIX (bug #2)
            out.push_back(executionToJson(ex));

            double mp = accounts_.markPriceOr(order.symbol, leg.fill_price);
            double upnl = leg.position_still_open ? AccountManager::unrealizedPnl(leg.position_after, mp) : 0;
            double maint = leg.position_still_open ? AccountManager::maintenanceMargin(leg.position_after, mp) : 0;
            // Mode-aware liquidation price so CROSS fills also get a
            // computed liquidation price instead of null.
            auto liq = leg.position_still_open ? accounts_.computeLiquidationPriceForPosition(leg.position_after) : std::nullopt;
            out.push_back(positionUpdateToJson(request_id, leg.position_after, liq.value_or(0), liq.has_value(),
                                                upnl, mp, maint));
            out.push_back(marginUpdateToJson(request_id, order.user_id, order.wallet_id,
                                              accounts_.recomputeMargin(order.user_id)));
        }

        if (totalFilled <= 1e-12) {
            out.push_back(errorToJson(request_id,
                "Reduce-only order for " + order.symbol + " had no matching open position to reduce"));
        }
    }
};

/* ═══════════════════════════════════════════════════════════════════════
   INBOUND PACKET PARSING
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
    int leverage = 1;
    std::string margin_mode;
    std::string position_side;
    std::string position_mode;
    std::optional<bool> reduce_only;
    std::optional<double> take_profit;
    std::optional<double> stop_loss;
    std::optional<double> wallet_balance;
    std::optional<double> price;       // PRICE_UPDATE
    std::optional<double> mark_price;  // MARK_PRICE_UPDATE
    std::optional<double> funding_rate; // FUNDING_TICK
    bool clear_take_profit = false;
    bool clear_stop_loss = false;
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
    if (auto v = tinyjson::getInt(json, "leverage")) p.leverage = static_cast<int>(*v);
    if (auto v = tinyjson::getString(json, "margin_mode")) p.margin_mode = *v;
    if (auto v = tinyjson::getString(json, "position_side")) p.position_side = *v;
    if (auto v = tinyjson::getString(json, "position_mode")) p.position_mode = *v;
    p.reduce_only = tinyjson::getBool(json, "reduce_only");
    p.take_profit = tinyjson::getNumber(json, "take_profit");
    p.stop_loss = tinyjson::getNumber(json, "stop_loss");
    p.wallet_balance = tinyjson::getNumber(json, "wallet_balance");
    p.price = tinyjson::getNumber(json, "price");
    p.mark_price = tinyjson::getNumber(json, "mark_price");
    p.funding_rate = tinyjson::getNumber(json, "funding_rate");
    // "field present as explicit null" -> treat as clear. Our tinyjson
    // getNumber already returns nullopt for a literal null, so distinguish
    // "absent" vs "present-but-null" by checking raw presence separately.
    if (tinyjson::extractRaw(json, "take_profit").has_value() && !p.take_profit.has_value()) p.clear_take_profit = true;
    if (tinyjson::extractRaw(json, "stop_loss").has_value() && !p.stop_loss.has_value()) p.clear_stop_loss = true;
    return p;
}

/* ═══════════════════════════════════════════════════════════════════════
   ENGINE — dispatches inbound packets, owns one SymbolBook per symbol
   plus the single AccountManager shared by all of them.
   ═══════════════════════════════════════════════════════════════════════ */
class Engine {
public:
    std::vector<std::string> handlePacket(const InboundPacket& in) {
        std::vector<std::string> out;
        if (in.action == "PLACE_ORDER") handlePlaceOrder(in, out);
        else if (in.action == "CANCEL_ORDER") handleCancelOrder(in, out);
        else if (in.action == "PRICE_UPDATE") handlePriceUpdate(in, out);
        else if (in.action == "MARK_PRICE_UPDATE") handleMarkPriceUpdate(in, out);
        else if (in.action == "FUNDING_TICK") handleFundingTick(in, out);
        else if (in.action == "UPDATE_TP_SL") handleUpdateTpSl(in, out);
        else if (in.action == "SYNC_WALLET") handleSyncWallet(in, out);
        else if (in.action == "SYNC_POSITION") handleSyncPosition(in, out);
        else out.push_back(errorToJson(in.request_id, "Unknown action: '" + in.action + "'"));
        return out;
    }

private:
    AccountManager accounts_;
    std::unordered_map<std::string, SymbolBook> books_;

    SymbolBook& bookFor(const std::string& symbol) {
        auto it = books_.find(symbol);
        if (it == books_.end()) it = books_.emplace(symbol, SymbolBook(symbol, accounts_)).first;
        return it->second;
    }

    void appendBookUpdate(const std::string& symbol, std::vector<std::string>& out) {
        auto tb = bookFor(symbol).topOfBook();
        std::ostringstream o;
        o << "{\"type\":\"ORDER_BOOK_UPDATE\",\"symbol\":\"" << tinyjson::esc(symbol) << "\",";
        if (tb.has_price) o << "\"last_price\":" << tinyjson::num(tb.last_price, 8) << ","; else o << "\"last_price\":null,";
        if (tb.has_bid) o << "\"best_bid\":" << tinyjson::num(tb.best_bid, 8) << ",\"best_bid_qty\":" << tinyjson::num(tb.best_bid_qty, 10) << ",";
        else o << "\"best_bid\":null,\"best_bid_qty\":0,";
        if (tb.has_ask) o << "\"best_ask\":" << tinyjson::num(tb.best_ask, 8) << ",\"best_ask_qty\":" << tinyjson::num(tb.best_ask_qty, 10) << ",";
        else o << "\"best_ask\":null,\"best_ask_qty\":0,";
        o << "\"timestamp\":" << nowMillis() << "}";
        out.push_back(o.str());
    }

    std::vector<std::string> validatePlaceOrder(const InboundPacket& in) {
        std::vector<std::string> errors;
        if (in.order_id <= 0) errors.push_back("Missing or invalid order_id");
        if (in.user_id <= 0) errors.push_back("Missing or invalid user_id");
        if (in.wallet_id <= 0) errors.push_back("Missing or invalid wallet_id");
        if (in.symbol.empty() || !isSupportedSymbol(in.symbol)) errors.push_back("Symbol is missing or not a known trading pair");
        if (in.side != "BUY" && in.side != "SELL") errors.push_back("side must be BUY or SELL");
        if (in.order_type != "MARKET" && in.order_type != "LIMIT") errors.push_back("order_type must be MARKET or LIMIT");
        if (in.quantity <= 0 || std::isnan(in.quantity)) errors.push_back("quantity must be greater than 0");
        if (in.leverage < MIN_LEVERAGE || in.leverage > MAX_LEVERAGE) errors.push_back("leverage out of supported range");
        if (in.margin_mode != "ISOLATED" && in.margin_mode != "CROSS") errors.push_back("margin_mode must be ISOLATED or CROSS");
        if (in.position_side != "LONG" && in.position_side != "SHORT") errors.push_back("position_side must be LONG or SHORT");
        if (!in.position_mode.empty() && in.position_mode != "ONE_WAY" && in.position_mode != "HEDGE") {
            errors.push_back("position_mode must be ONE_WAY or HEDGE");
        }
        if (in.order_type == "LIMIT" && (!in.limit_price || *in.limit_price <= 0)) {
            errors.push_back("LIMIT orders require a positive limit_price");
        }
        if (in.order_type == "MARKET" && in.limit_price) {
            errors.push_back("MARKET orders must not include a limit_price");
        }
        if (in.take_profit && *in.take_profit <= 0) errors.push_back("take_profit must be positive if provided");
        if (in.stop_loss && *in.stop_loss <= 0) errors.push_back("stop_loss must be positive if provided");
        return errors;
    }

    void handlePlaceOrder(const InboundPacket& in, std::vector<std::string>& out) {
        auto errors = validatePlaceOrder(in);
        if (!errors.empty()) {
            out.push_back(orderAckToJson(in.request_id, in.order_id, 0, false, "Engine rejected order", errors));
            return;
        }

        // Seed the wallet mirror the first time we see this user (RAM
        // starts empty on every restart) — see SYNC_WALLET for the
        // explicit recovery path.
        if (!accounts_.hasWallet(in.user_id)) {
            PositionMode mode = in.position_mode == "HEDGE" ? PositionMode::HEDGE : PositionMode::ONE_WAY;
            accounts_.getOrCreateWallet(in.user_id, in.wallet_id, in.wallet_balance.value_or(0.0), mode);
        }

        RestingOrder order;
        order.engine_order_id = SymbolBook::allocateEngineOrderId();
        order.db_order_id = in.order_id;
        order.user_id = in.user_id;
        order.wallet_id = in.wallet_id;
        order.symbol = in.symbol;
        order.side = *parseSide(in.side);
        order.position_side = *parsePositionSide(in.position_side);
        order.margin_mode = *parseMarginMode(in.margin_mode);
        order.position_mode = in.position_mode == "HEDGE" ? PositionMode::HEDGE : PositionMode::ONE_WAY;
        order.leverage = in.leverage;
        order.reduce_only = in.reduce_only.value_or(false);
        order.quantity = in.quantity;
        order.remaining_quantity = in.quantity;
        order.limit_price = in.limit_price.value_or(0.0);
        if (!order.reduce_only) {
            order.take_profit = in.take_profit;
            order.stop_loss = in.stop_loss;
        }

        OrderType type = *parseOrderType(in.order_type);
        std::string rejectReason;
        bool accepted = bookFor(in.symbol).placeOrder(in.request_id, order, type, out, rejectReason);

        if (!accepted) {
            out.push_back(orderAckToJson(in.request_id, in.order_id, order.engine_order_id, false,
                                          "Engine rejected order", { rejectReason }));
            return;
        }
        // ORDER_ACK goes first, so insert it at the front of what
        // placeOrder already appended (fills/position/margin lines).
        out.insert(out.begin(), orderAckToJson(in.request_id, in.order_id, order.engine_order_id, true,
                                                "Order accepted by engine", {}));
        if (type == OrderType::LIMIT || out.size() > 1) appendBookUpdate(in.symbol, out);
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
        bookFor(in.symbol).onPriceUpdate(in.request_id, *in.price, out);
        appendBookUpdate(in.symbol, out);
    }

    void handleMarkPriceUpdate(const InboundPacket& in, std::vector<std::string>& out) {
        if (in.symbol.empty() || !in.mark_price) {
            out.push_back(errorToJson(in.request_id, "MARK_PRICE_UPDATE requires symbol and mark_price"));
            return;
        }
        accounts_.checkRisk(in.request_id, in.symbol, *in.mark_price, out);
    }

    void handleFundingTick(const InboundPacket& in, std::vector<std::string>& out) {
        if (in.symbol.empty() || !in.funding_rate) {
            out.push_back(errorToJson(in.request_id, "FUNDING_TICK requires symbol and funding_rate"));
            return;
        }
        accounts_.applyFunding(in.request_id, in.symbol, *in.funding_rate, out);
    }

    void handleUpdateTpSl(const InboundPacket& in, std::vector<std::string>& out) {
        if (in.user_id <= 0 || in.symbol.empty() || in.position_side.empty()) {
            out.push_back(errorToJson(in.request_id, "UPDATE_TP_SL requires user_id, symbol, and position_side"));
            return;
        }
        auto side = parsePositionSide(in.position_side);
        if (!side) {
            out.push_back(errorToJson(in.request_id, "position_side must be LONG or SHORT"));
            return;
        }
        accounts_.updateTpSl(in.user_id, in.symbol, *side, in.take_profit, in.clear_take_profit,
                              in.stop_loss, in.clear_stop_loss);
        Position* p = accounts_.findPosition(in.user_id, in.symbol, *side);
        if (p) {
            double mp = accounts_.markPriceOr(in.symbol, p->entry_price);
            double upnl = AccountManager::unrealizedPnl(*p, mp);
            double maint = AccountManager::maintenanceMargin(*p, mp);
            // Mode-aware liquidation price here too.
            auto liq = accounts_.computeLiquidationPriceForPosition(*p);
            out.push_back(positionUpdateToJson(in.request_id, *p, liq.value_or(0), liq.has_value(), upnl, mp, maint));
        } else {
            out.push_back(errorToJson(in.request_id, "No open position found for that user/symbol/position_side"));
        }
    }

    void handleSyncWallet(const InboundPacket& in, std::vector<std::string>& out) {
        if (in.user_id <= 0 || in.wallet_id <= 0 || !in.wallet_balance) {
            out.push_back(errorToJson(in.request_id, "SYNC_WALLET requires user_id, wallet_id, and wallet_balance"));
            return;
        }
        PositionMode mode = in.position_mode == "HEDGE" ? PositionMode::HEDGE : PositionMode::ONE_WAY;
        accounts_.syncWallet(in.user_id, in.wallet_id, *in.wallet_balance, mode);
        out.push_back(marginUpdateToJson(in.request_id, in.user_id, in.wallet_id, accounts_.recomputeMargin(in.user_id)));
    }

    void handleSyncPosition(const InboundPacket& in, std::vector<std::string>& out) {
        if (in.user_id <= 0 || in.symbol.empty() || in.position_side.empty() || in.quantity <= 0 || !in.limit_price) {
            // Reuses `limit_price` on the wire as `entry_price` for this
            // action only — see futuresEngineClient.js's syncPosition().
            out.push_back(errorToJson(in.request_id, "SYNC_POSITION requires user_id, symbol, position_side, quantity, and entry_price"));
            return;
        }
        auto side = parsePositionSide(in.position_side);
        auto mm = parseMarginMode(in.margin_mode.empty() ? "ISOLATED" : in.margin_mode);
        if (!side || !mm) {
            out.push_back(errorToJson(in.request_id, "Invalid position_side or margin_mode"));
            return;
        }
        accounts_.syncPosition(in.user_id, in.wallet_id, in.symbol, *side, *mm, in.quantity,
                                *in.limit_price, in.leverage, in.take_profit, in.stop_loss);
        out.push_back(marginUpdateToJson(in.request_id, in.user_id, in.wallet_id, accounts_.recomputeMargin(in.user_id)));
    }
};

/* ═══════════════════════════════════════════════════════════════════════
   TCP CONNECTION HANDLING — identical shape to trade_engine.cpp
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
            if (!outBytes.empty()) asio::write(socket, asio::buffer(outBytes));

            std::cout << "-> sent " << replies.size() << " reply line(s)\n\n";
        } catch (std::exception& msgEx) {
            std::cerr << "Failed to process message: " << msgEx.what() << "\n\n";
        }
    }
}

int main() {
    try {
        asio::io_context io;
        tcp::acceptor acceptor(io, tcp::endpoint(tcp::v4(), 9001)); // spot engine uses 9000
        Engine engine;

        std::cout << "=====================================\n";
        std::cout << " CryptoTrade Futures Trading Engine Started\n";
        std::cout << " Listening on port 9001...\n";
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