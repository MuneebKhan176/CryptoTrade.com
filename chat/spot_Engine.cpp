// =====================================================================================
//  SPOT TRADING EXECUTION ENGINE  (C++17, single file)
//  Target toolchain : MSYS2 / MinGW-w64 (g++)
//  Persistence      : MySQL / MariaDB via the MariaDB Connector/C  (mysql.h, C API)
//  Node.js bridge   : raw TCP socket, newline-delimited JSON  (Winsock2)
//
//  ARCHITECTURE
//  ------------
//  This is NOT a peer-matching engine. Per spec this is a demo platform: the engine is
//  itself the counter-party. Node.js is responsible for sourcing real market prices
//  (e.g. a Binance WebSocket) and forwarding them into the engine with PRICE_UPDATE
//  messages. The engine:
//    1. Holds the live book (open LIMIT orders) and open positions (TP/SL) in RAM only.
//    2. On every PRICE_UPDATE tick, walks the book/trigger structures and fills/closes
//       anything the new price has crossed.
//    3. Fires-and-forgets persistence to MySQL on a background writer thread so the hot
//       path (order placement / price tick handling) never blocks on network I/O.
//    4. On startup, rehydrates RAM state (open orders, open positions, holdings) from
//       MySQL, so a restart is safe.
//
//  DATA STRUCTURES (as requested — proper DSA, no ad-hoc vectors-of-everything)
//  -----------------------------------------------------------------------------------
//   OrderBook (per symbol)
//     bids : std::map<price, std::list<OrderPtr>, greater<double>>   -> best bid = begin()
//     asks : std::map<price, std::list<OrderPtr>>                    -> best ask = begin()
//     Each Order caches its own list<>::iterator -> O(1) cancel, O(log P) insert,
//     where P = number of distinct price levels (not number of orders).
//
//   TriggerBook (per symbol, TP/SL)
//     tp : std::map<price, vector<PositionPtr>>  ascending, fires when price >= key
//     sl : std::map<price, vector<PositionPtr>>  ascending, fires when price <= key
//     A price tick does two range scans (map::upper_bound / lower_bound) instead of a
//     linear scan over every open position.
//
//   orderIndex   : std::unordered_map<uint64_t, OrderPtr>              O(1) lookup/cancel
//   userOrders   : std::unordered_map<int, std::unordered_set<uint64_t>> O(1) "my open orders"
//   positionIndex: std::unordered_map<uint64_t, PositionPtr>
//   userPositions: std::unordered_map<int, std::unordered_set<uint64_t>>
//   holdings     : std::unordered_map<int wallet_id, std::unordered_map<symbol, Holding>>
//   markPrice    : std::unordered_map<symbol, double>
//
//  BUILD (MSYS2 MinGW64 shell)
//  -----------------------------------------------------------------------------------
//   pacman -S mingw-w64-x86_64-mariadb-connector-c
//   g++ -std=c++17 -O2 -municode spot_trading_engine.cpp -o spot_engine.exe ^
//       -IC:/msys64/mingw64/include/mariadb -LC:/msys64/mingw64/lib ^
//       -lmariadb -lws2_32 -lpthread
//
//  NODE.JS SIDE
//  -----------------------------------------------------------------------------------
//   const net = require('net');
//   const sock = net.connect(5577, '127.0.0.1');
//   sock.write(JSON.stringify({action:'PLACE_ORDER', user_id:1, symbol:'BTC',
//                               side:'BUY', type:'LIMIT', quantity:0.01, price:65000}) + '\n');
//   sock.on('data', buf => { for (const line of buf.toString().split('\n'))
//                              if (line.trim()) console.log(JSON.parse(line)); });
//
// =====================================================================================

#ifdef _WIN32
  #define WIN32_LEAN_AND_MEAN
  #include <winsock2.h>
  #include <ws2tcpip.h>
  #pragma comment(lib, "ws2_32.lib")
  typedef SOCKET socket_t;
  #define CLOSESOCK closesocket
#else
  // Non-Windows fallback so the RAM-only core can still be exercised/tested on Linux.
  #include <sys/socket.h>
  #include <netinet/in.h>
  #include <unistd.h>
  typedef int socket_t;
  #define INVALID_SOCKET (-1)
  #define SOCKET_ERROR (-1)
  #define CLOSESOCK close
#endif

#if defined(USE_MYSQL)
  #include <mysql.h>
#endif

#include <iostream>
#include <sstream>
#include <fstream>
#include <string>
#include <cstring>
#include <cstdint>
#include <cctype>
#include <map>
#include <unordered_map>
#include <unordered_set>
#include <list>
#include <vector>
#include <memory>
#include <mutex>
#include <shared_mutex>
#include <thread>
#include <atomic>
#include <optional>
#include <functional>
#include <condition_variable>
#include <queue>
#include <algorithm>
#include <chrono>
#include <ctime>
#include <stdexcept>

static constexpr double EPS = 1e-9;

// =====================================================================================
//  SECTION 1 — MINIMAL EMBEDDED JSON  (no external dependency, keeps this one file)
// =====================================================================================
namespace json {

enum class Type { Null, Bool, Number, String, Array, Object };

class Value {
public:
    Type type = Type::Null;
    bool b = false;
    double num = 0;
    std::string str;
    std::vector<Value> arr;
    std::map<std::string, Value> obj;

    Value() = default;
    static Value makeObject() { Value v; v.type = Type::Object; return v; }
    static Value makeArray()  { Value v; v.type = Type::Array;  return v; }
    static Value fromNumber(double d) { Value v; v.type = Type::Number; v.num = d; return v; }
    static Value fromString(const std::string& s) { Value v; v.type = Type::String; v.str = s; return v; }
    static Value fromBool(bool bb) { Value v; v.type = Type::Bool; v.b = bb; return v; }

    Value& operator[](const std::string& key) { type = Type::Object; return obj[key]; }
    const Value& operator[](const std::string& key) const {
        static const Value nullVal;
        auto it = obj.find(key);
        return it != obj.end() ? it->second : nullVal;
    }
    bool has(const std::string& key) const { return type == Type::Object && obj.count(key) > 0; }

    double asDouble(double def = 0.0) const { return type == Type::Number ? num : def; }
    std::string asString(const std::string& def = "") const { return type == Type::String ? str : def; }
    bool asBool(bool def = false) const { return type == Type::Bool ? b : def; }
    int64_t asInt(int64_t def = 0) const { return type == Type::Number ? (int64_t)num : def; }

    std::string dump() const { std::ostringstream os; dumpTo(os); return os.str(); }

private:
    static void escapeInto(std::ostringstream& os, const std::string& s) {
        os << '"';
        for (char c : s) {
            switch (c) {
                case '"':  os << "\\\""; break;
                case '\\': os << "\\\\"; break;
                case '\n': os << "\\n";  break;
                case '\t': os << "\\t";  break;
                default:   os << c;
            }
        }
        os << '"';
    }

    void dumpTo(std::ostringstream& os) const {
        switch (type) {
            case Type::Null:   os << "null"; break;
            case Type::Bool:   os << (b ? "true" : "false"); break;
            case Type::Number: {
                if (num == (long long)num) os << (long long)num;
                else os << num;
                break;
            }
            case Type::String: escapeInto(os, str); break;
            case Type::Array: {
                os << "[";
                for (size_t i = 0; i < arr.size(); ++i) { if (i) os << ","; arr[i].dumpTo(os); }
                os << "]";
                break;
            }
            case Type::Object: {
                os << "{";
                bool first = true;
                for (auto& kv : obj) {
                    if (!first) os << ",";
                    first = false;
                    escapeInto(os, kv.first);
                    os << ":";
                    kv.second.dumpTo(os);
                }
                os << "}";
                break;
            }
        }
    }
};

class Parser {
public:
    explicit Parser(const std::string& s) : s_(s), i_(0) {}
    Value parse() { skipWs(); return parseValue(); }

private:
    const std::string& s_;
    size_t i_;

    void skipWs() { while (i_ < s_.size() && std::isspace((unsigned char)s_[i_])) ++i_; }
    char peek() { return i_ < s_.size() ? s_[i_] : '\0'; }
    char next() { return i_ < s_.size() ? s_[i_++] : '\0'; }

    void expect(char c) {
        skipWs();
        if (peek() != c) throw std::runtime_error(std::string("json: expected '") + c + "' at " + std::to_string(i_));
        ++i_;
    }

    Value parseValue() {
        skipWs();
        char c = peek();
        if (c == '{') return parseObject();
        if (c == '[') return parseArray();
        if (c == '"') return parseString();
        if (c == 't' || c == 'f') return parseBool();
        if (c == 'n') { i_ += 4; return Value(); }
        return parseNumber();
    }

    Value parseObject() {
        Value v = Value::makeObject();
        expect('{'); skipWs();
        if (peek() == '}') { ++i_; return v; }
        while (true) {
            skipWs();
            Value key = parseString();
            expect(':');
            v.obj[key.str] = parseValue();
            skipWs();
            if (peek() == ',') { ++i_; continue; }
            break;
        }
        expect('}');
        return v;
    }

    Value parseArray() {
        Value v = Value::makeArray();
        expect('['); skipWs();
        if (peek() == ']') { ++i_; return v; }
        while (true) {
            v.arr.push_back(parseValue());
            skipWs();
            if (peek() == ',') { ++i_; continue; }
            break;
        }
        expect(']');
        return v;
    }

    Value parseString() {
        expect('"');
        std::string out;
        while (true) {
            char c = next();
            if (c == '"' || c == '\0') break;
            if (c == '\\') {
                char e = next();
                switch (e) {
                    case 'n': out += '\n'; break;
                    case 't': out += '\t'; break;
                    case '"': out += '"'; break;
                    case '\\': out += '\\'; break;
                    default: out += e;
                }
            } else out += c;
        }
        return Value::fromString(out);
    }

    Value parseBool() {
        if (s_.compare(i_, 4, "true") == 0)  { i_ += 4; return Value::fromBool(true); }
        if (s_.compare(i_, 5, "false") == 0) { i_ += 5; return Value::fromBool(false); }
        throw std::runtime_error("json: invalid literal");
    }

    Value parseNumber() {
        size_t start = i_;
        if (peek() == '-') ++i_;
        while (i_ < s_.size() && (std::isdigit((unsigned char)s_[i_]) || s_[i_] == '.' ||
               s_[i_] == 'e' || s_[i_] == 'E' || s_[i_] == '+' || s_[i_] == '-')) ++i_;
        return Value::fromNumber(std::stod(s_.substr(start, i_ - start)));
    }
};

inline Value parse(const std::string& s) { Parser p(s); return p.parse(); }

} // namespace json

// =====================================================================================
//  SECTION 2 — DOMAIN MODEL  (mirrors the SQL schema field-for-field)
// =====================================================================================

enum class Side { BUY, SELL };
enum class OrderType { MARKET, LIMIT };
enum class OrderStatus { OPEN, PARTIALLY_FILLED, FILLED, CANCELLED };
enum class PositionStatus { OPEN, CLOSED };

inline std::string toStr(Side s) { return s == Side::BUY ? "BUY" : "SELL"; }
inline std::string toStr(OrderType t) { return t == OrderType::MARKET ? "MARKET" : "LIMIT"; }
inline std::string toStr(OrderStatus s) {
    switch (s) {
        case OrderStatus::OPEN: return "OPEN";
        case OrderStatus::PARTIALLY_FILLED: return "PARTIALLY_FILLED";
        case OrderStatus::FILLED: return "FILLED";
        case OrderStatus::CANCELLED: return "CANCELLED";
    }
    return "OPEN";
}
inline std::string toStr(PositionStatus s) { return s == PositionStatus::OPEN ? "OPEN" : "CLOSED"; }
inline Side sideFromStr(const std::string& s) { return s == "BUY" ? Side::BUY : Side::SELL; }
inline OrderType typeFromStr(const std::string& s) { return s == "MARKET" ? OrderType::MARKET : OrderType::LIMIT; }

// spot_orders row
struct Order {
    uint64_t order_id = 0;
    int user_id = 0;
    int wallet_id = 0;
    std::string symbol;
    Side side = Side::BUY;
    OrderType type = OrderType::LIMIT;
    double quantity = 0;
    double remaining_quantity = 0;
    double limit_price = 0.0;      // 0 for MARKET
    double tp_price = 0.0;         // optional, applied to the resulting position, 0 = none
    double sl_price = 0.0;         // optional, applied to the resulting position, 0 = none
    OrderStatus status = OrderStatus::OPEN;

    // book bookkeeping — populated only while the order rests in an OrderBook
    bool in_book = false;
    double book_price_key = 0.0;
    std::list<std::shared_ptr<Order>>::iterator book_it{};
};
using OrderPtr = std::shared_ptr<Order>;

// spot_positions row
struct Position {
    uint64_t position_id = 0;
    uint64_t order_id = 0;         // originating (opening) order
    int user_id = 0;
    std::string symbol;
    double quantity = 0;
    double entry_price = 0;
    double invested_usdt = 0;
    double tp_price = 0.0;
    double sl_price = 0.0;
    PositionStatus status = PositionStatus::OPEN;
};
using PositionPtr = std::shared_ptr<Position>;

// spot_holdings row
struct Holding {
    int wallet_id = 0;
    std::string symbol;
    double available_quantity = 0;
    double locked_quantity = 0;
    double average_buy_price = 0;
    double total_cost = 0;
};

// spot_trades row (fill record)
struct Trade {
    uint64_t trade_id = 0;
    uint64_t order_id = 0;
    int user_id = 0;
    std::string symbol;
    double quantity = 0;
    double price = 0;
    double commission = 0;
};

static const double COMMISSION_RATE = 0.001; // 0.1% demo taker fee

// =====================================================================================
//  SECTION 3 — ORDER BOOK  (per symbol)
// =====================================================================================
class OrderBook {
public:
    std::map<double, std::list<OrderPtr>, std::greater<double>> bids; // best = begin()
    std::map<double, std::list<OrderPtr>> asks;                       // best = begin()

    void insert(const OrderPtr& o) {
        std::list<OrderPtr>* lst = (o->side == Side::BUY) ? &bids[o->limit_price] : &asks[o->limit_price];
        lst->push_back(o);
        auto it = lst->end();
        --it;
        o->in_book = true;
        o->book_price_key = o->limit_price;
        o->book_it = it;
    }

    void erase(const OrderPtr& o) {
        if (!o->in_book) return;
        if (o->side == Side::BUY) {
            auto mit = bids.find(o->book_price_key);
            if (mit != bids.end()) { mit->second.erase(o->book_it); if (mit->second.empty()) bids.erase(mit); }
        } else {
            auto mit = asks.find(o->book_price_key);
            if (mit != asks.end()) { mit->second.erase(o->book_it); if (mit->second.empty()) asks.erase(mit); }
        }
        o->in_book = false;
    }

    std::optional<double> bestBid() const { return bids.empty() ? std::nullopt : std::optional<double>(bids.begin()->first); }
    std::optional<double> bestAsk() const { return asks.empty() ? std::nullopt : std::optional<double>(asks.begin()->first); }

    // Collect (not remove) every BUY-limit at or above `price` and every SELL-limit at or
    // below `price` — i.e. everything the incoming mark price has crossed.
    std::vector<OrderPtr> crossed(double price) const {
        std::vector<OrderPtr> out;
        for (auto it = bids.begin(); it != bids.end() && it->first >= price; ++it)
            for (auto& o : it->second) out.push_back(o);
        for (auto it = asks.begin(); it != asks.end() && it->first <= price; ++it)
            for (auto& o : it->second) out.push_back(o);
        return out;
    }
};

// =====================================================================================
//  SECTION 4 — TRIGGER BOOK  (TP / SL on open positions)
// =====================================================================================
class TriggerBook {
public:
    std::map<double, std::vector<PositionPtr>> tp; // ascending; fires when price >= key
    std::map<double, std::vector<PositionPtr>> sl; // ascending; fires when price <= key

    void addTP(double price, const PositionPtr& p) { if (price > EPS) tp[price].push_back(p); }
    void addSL(double price, const PositionPtr& p) { if (price > EPS) sl[price].push_back(p); }

    void removePosition(const PositionPtr& p) {
        if (p->tp_price > EPS) {
            auto it = tp.find(p->tp_price);
            if (it != tp.end()) {
                auto& v = it->second;
                v.erase(std::remove(v.begin(), v.end(), p), v.end());
                if (v.empty()) tp.erase(it);
            }
        }
        if (p->sl_price > EPS) {
            auto it = sl.find(p->sl_price);
            if (it != sl.end()) {
                auto& v = it->second;
                v.erase(std::remove(v.begin(), v.end(), p), v.end());
                if (v.empty()) sl.erase(it);
            }
        }
    }

    // Removes and returns every position whose TP or SL the given mark price has crossed.
    std::vector<std::pair<PositionPtr, std::string>> collectTriggered(double price) {
        std::vector<std::pair<PositionPtr, std::string>> out;
        auto tp_end = tp.upper_bound(price);
        for (auto it = tp.begin(); it != tp_end; ++it)
            for (auto& p : it->second) out.push_back({p, "TP"});
        tp.erase(tp.begin(), tp_end);

        auto sl_begin = sl.lower_bound(price);
        for (auto it = sl_begin; it != sl.end(); ++it)
            for (auto& p : it->second) out.push_back({p, "SL"});
        sl.erase(sl_begin, sl.end());

        return out;
    }
};

// =====================================================================================
//  SECTION 5 — ID GENERATION  (atomic counters seeded from DB MAX(id) at startup)
// =====================================================================================
class IdGenerator {
public:
    std::atomic<uint64_t> order_id{1};
    std::atomic<uint64_t> trade_id{1};
    std::atomic<uint64_t> position_id{1};
    uint64_t nextOrder()    { return order_id.fetch_add(1); }
    uint64_t nextTrade()    { return trade_id.fetch_add(1); }
    uint64_t nextPosition() { return position_id.fetch_add(1); }
};

// =====================================================================================
//  SECTION 6 — PERSISTENCE  (MySQL / MariaDB via C API, async write-behind queue)
// =====================================================================================
//  All writes are queued as closures and drained on a single background thread. The
//  in-RAM engine never blocks on a DB round trip. Reads (startup rehydration) are
//  synchronous because they only happen once, before the server starts accepting.
// =====================================================================================
class Database {
public:
    bool connect(const std::string& host, const std::string& user, const std::string& pass,
                 const std::string& schema, unsigned port) {
#if defined(USE_MYSQL)
        conn_ = mysql_init(nullptr);
        if (!conn_) return false;
        if (!mysql_real_connect(conn_, host.c_str(), user.c_str(), pass.c_str(),
                                 schema.c_str(), port, nullptr, 0)) {
            std::cerr << "MySQL connect failed: " << mysql_error(conn_) << "\n";
            return false;
        }
        return true;
#else
        (void)host; (void)user; (void)pass; (void)schema; (void)port;
        std::cerr << "[Database] Built without USE_MYSQL — running with persistence disabled.\n";
        return true;
#endif
    }

    void exec(const std::string& sql) {
#if defined(USE_MYSQL)
        std::lock_guard<std::mutex> lk(mu_);
        if (mysql_query(conn_, sql.c_str()) != 0)
            std::cerr << "MySQL error: " << mysql_error(conn_) << " | sql=" << sql << "\n";
#else
        (void)sql;
#endif
    }

    // ---- startup rehydration ----------------------------------------------------
    void loadOpenOrders(std::vector<Order>& out) {
#if defined(USE_MYSQL)
        exec("SELECT order_id,user_id,wallet_id,symbol,side,order_type,quantity,"
             "remaining_quantity,limit_price,status FROM spot_orders "
             "WHERE status IN ('OPEN','PARTIALLY_FILLED')");
        std::lock_guard<std::mutex> lk(mu_);
        MYSQL_RES* res = mysql_store_result(conn_);
        if (!res) return;
        MYSQL_ROW row;
        while ((row = mysql_fetch_row(res))) {
            Order o;
            o.order_id = strtoull(row[0], nullptr, 10);
            o.user_id = atoi(row[1]);
            o.wallet_id = atoi(row[2]);
            o.symbol = row[3];
            o.side = sideFromStr(row[4]);
            o.type = typeFromStr(row[5]);
            o.quantity = atof(row[6]);
            o.remaining_quantity = atof(row[7]);
            o.limit_price = row[8] ? atof(row[8]) : 0.0;
            o.status = row[9][0] == 'O' ? OrderStatus::OPEN : OrderStatus::PARTIALLY_FILLED;
            out.push_back(o);
        }
        mysql_free_result(res);
#else
        (void)out;
#endif
    }

    void loadOpenPositions(std::vector<Position>& out) {
#if defined(USE_MYSQL)
        exec("SELECT position_id,order_id,user_id,symbol,quantity,entry_price,"
             "invested_usdt,tp_price,sl_price FROM spot_positions WHERE status='OPEN'");
        std::lock_guard<std::mutex> lk(mu_);
        MYSQL_RES* res = mysql_store_result(conn_);
        if (!res) return;
        MYSQL_ROW row;
        while ((row = mysql_fetch_row(res))) {
            Position p;
            p.position_id = strtoull(row[0], nullptr, 10);
            p.order_id = strtoull(row[1], nullptr, 10);
            p.user_id = atoi(row[2]);
            p.symbol = row[3];
            p.quantity = atof(row[4]);
            p.entry_price = atof(row[5]);
            p.invested_usdt = atof(row[6]);
            p.tp_price = row[7] ? atof(row[7]) : 0.0;
            p.sl_price = row[8] ? atof(row[8]) : 0.0;
            p.status = PositionStatus::OPEN;
            out.push_back(p);
        }
        mysql_free_result(res);
#else
        (void)out;
#endif
    }

    void loadHoldings(std::vector<Holding>& out) {
#if defined(USE_MYSQL)
        exec("SELECT wallet_id,symbol,available_quantity,locked_quantity,average_buy_price,"
             "total_cost FROM spot_holdings");
        std::lock_guard<std::mutex> lk(mu_);
        MYSQL_RES* res = mysql_store_result(conn_);
        if (!res) return;
        MYSQL_ROW row;
        while ((row = mysql_fetch_row(res))) {
            Holding h;
            h.wallet_id = atoi(row[0]);
            h.symbol = row[1];
            h.available_quantity = atof(row[2]);
            h.locked_quantity = atof(row[3]);
            h.average_buy_price = atof(row[4]);
            h.total_cost = atof(row[5]);
            out.push_back(h);
        }
        mysql_free_result(res);
#else
        (void)out;
#endif
    }

    // wallet_id lookup / auto-provision for a user (spot_wallet has UNIQUE user_id)
    int loadOrCreateWallet(int user_id) {
#if defined(USE_MYSQL)
        {
            std::ostringstream q;
            q << "SELECT wallet_id FROM spot_wallet WHERE user_id=" << user_id;
            exec(q.str());
            std::lock_guard<std::mutex> lk(mu_);
            MYSQL_RES* res = mysql_store_result(conn_);
            if (res) {
                MYSQL_ROW row = mysql_fetch_row(res);
                if (row) { int wid = atoi(row[0]); mysql_free_result(res); return wid; }
                mysql_free_result(res);
            }
        }
        {
            std::ostringstream q;
            q << "INSERT INTO spot_wallet (user_id) VALUES (" << user_id << ")";
            exec(q.str());
            std::lock_guard<std::mutex> lk(mu_);
            return (int)mysql_insert_id(conn_);
        }
#else
        return user_id; // 1:1 fallback when persistence is disabled
#endif
    }

    // ---- write-behind helpers (called only from the persistence thread) ----------
    void insertOrder(const Order& o) {
        std::ostringstream q;
        q << "INSERT INTO spot_orders (order_id,user_id,wallet_id,symbol,side,order_type,"
             "quantity,remaining_quantity,limit_price,status) VALUES ("
          << o.order_id << "," << o.user_id << "," << o.wallet_id << ",'" << o.symbol << "','"
          << toStr(o.side) << "','" << toStr(o.type) << "'," << o.quantity << ","
          << o.remaining_quantity << "," << (o.limit_price > 0 ? std::to_string(o.limit_price) : "NULL")
          << ",'" << toStr(o.status) << "')";
        exec(q.str());
    }

    void updateOrder(const Order& o) {
        std::ostringstream q;
        q << "UPDATE spot_orders SET remaining_quantity=" << o.remaining_quantity
          << ", status='" << toStr(o.status) << "' WHERE order_id=" << o.order_id;
        exec(q.str());
    }

    void insertTrade(const Trade& t) {
        std::ostringstream q;
        q << "INSERT INTO spot_trades (trade_id,order_id,user_id,symbol,quantity,price,commission) "
             "VALUES (" << t.trade_id << "," << t.order_id << "," << t.user_id << ",'" << t.symbol
          << "'," << t.quantity << "," << t.price << "," << t.commission << ")";
        exec(q.str());
    }

    void upsertHolding(const Holding& h) {
        std::ostringstream q;
        q << "INSERT INTO spot_holdings (wallet_id,symbol,available_quantity,locked_quantity,"
             "average_buy_price,total_cost) VALUES (" << h.wallet_id << ",'" << h.symbol << "',"
          << h.available_quantity << "," << h.locked_quantity << "," << h.average_buy_price << ","
          << h.total_cost << ") ON DUPLICATE KEY UPDATE available_quantity=" << h.available_quantity
          << ", locked_quantity=" << h.locked_quantity << ", average_buy_price=" << h.average_buy_price
          << ", total_cost=" << h.total_cost;
        exec(q.str());
    }

    void insertPosition(const Position& p) {
        std::ostringstream q;
        q << "INSERT INTO spot_positions (position_id,order_id,user_id,symbol,quantity,entry_price,"
             "invested_usdt,tp_price,sl_price,status) VALUES (" << p.position_id << "," << p.order_id
          << "," << p.user_id << ",'" << p.symbol << "'," << p.quantity << "," << p.entry_price << ","
          << p.invested_usdt << "," << (p.tp_price > 0 ? std::to_string(p.tp_price) : "NULL") << ","
          << (p.sl_price > 0 ? std::to_string(p.sl_price) : "NULL") << ",'" << toStr(p.status) << "')";
        exec(q.str());
    }

    void updatePosition(const Position& p) {
        std::ostringstream q;
        q << "UPDATE spot_positions SET quantity=" << p.quantity << ", invested_usdt=" << p.invested_usdt
          << ", entry_price=" << p.entry_price << ", status='" << toStr(p.status) << "'"
          << (p.status == PositionStatus::CLOSED ? ", closed_at=NOW()" : "")
          << " WHERE position_id=" << p.position_id;
        exec(q.str());
    }

private:
#if defined(USE_MYSQL)
    MYSQL* conn_ = nullptr;
#endif
    std::mutex mu_;
};


// Background write-behind queue: keeps the engine's hot path free of DB latency.
class PersistenceWorker {
public:
    explicit PersistenceWorker(Database& db) : db_(db) {
        thread_ = std::thread([this] { run(); });
    }
    ~PersistenceWorker() { stop(); }

    void push(std::function<void(Database&)> job) {
        {
            std::lock_guard<std::mutex> lk(mu_);
            queue_.push(std::move(job));
        }
        cv_.notify_one();
    }

    void stop() {
        if (stopped_.exchange(true)) return;
        cv_.notify_all();
        if (thread_.joinable()) thread_.join();
    }

private:
    void run() {
        while (!stopped_) {
            std::function<void(Database&)> job;
            {
                std::unique_lock<std::mutex> lk(mu_);
                cv_.wait(lk, [this] { return stopped_ || !queue_.empty(); });
                if (stopped_ && queue_.empty()) return;
                job = std::move(queue_.front());
                queue_.pop();
            }
            try { job(db_); } catch (const std::exception& e) {
                std::cerr << "[PersistenceWorker] job failed: " << e.what() << "\n";
            }
        }
    }

    Database& db_;
    std::queue<std::function<void(Database&)>> queue_;
    std::mutex mu_;
    std::condition_variable cv_;
    std::thread thread_;
    std::atomic<bool> stopped_{false};
};

// =====================================================================================
//  SECTION 7 — EXECUTION ENGINE  (the RAM-resident core)
// =====================================================================================
class SpotExecutionEngine {
public:
    SpotExecutionEngine(Database& db, PersistenceWorker& writer)
        : db_(db), writer_(writer) {}

    // Broadcast hook — wired to the TCP layer in main(); called for every fill / trigger.
    std::function<void(const json::Value&)> onEvent;

    void loadStateFromDB() {
        std::vector<Order> orders; db_.loadOpenOrders(orders);
        std::vector<Position> positions; db_.loadOpenPositions(positions);
        std::vector<Holding> hs; db_.loadHoldings(hs);

        std::lock_guard<std::mutex> lk(mu_);
        for (auto& h : hs) holdings_[h.wallet_id][h.symbol] = h;

        for (auto& o : orders) {
            auto op = std::make_shared<Order>(o);
            orderIndex_[op->order_id] = op;
            userOrders_[op->user_id].insert(op->order_id);
            if (op->type == OrderType::LIMIT) book(op->symbol).insert(op);
            ids_.order_id.store(std::max(ids_.order_id.load(), op->order_id + 1));
        }
        for (auto& p : positions) {
            auto pp = std::make_shared<Position>(p);
            positionIndex_[pp->position_id] = pp;
            userPositions_[pp->user_id].insert(pp->position_id);
            if (pp->tp_price > EPS) triggers(pp->symbol).addTP(pp->tp_price, pp);
            if (pp->sl_price > EPS) triggers(pp->symbol).addSL(pp->sl_price, pp);
            ids_.position_id.store(std::max(ids_.position_id.load(), pp->position_id + 1));
        }
        std::cout << "[Engine] rehydrated " << orders.size() << " open orders, "
                  << positions.size() << " open positions, " << hs.size() << " holdings.\n";
    }

    // ---------------------------------------------------------------------------
    //  PLACE ORDER
    // ---------------------------------------------------------------------------
    json::Value placeOrder(const json::Value& req) {
        std::lock_guard<std::mutex> lk(mu_);

        int user_id = (int)req["user_id"].asInt();
        std::string symbol = req["symbol"].asString();
        Side side = sideFromStr(req["side"].asString());
        OrderType type = typeFromStr(req["type"].asString());
        double quantity = req["quantity"].asDouble();
        double limit_price = req.has("price") ? req["price"].asDouble() : 0.0;
        double tp = req.has("tp") ? req["tp"].asDouble() : 0.0;
        double sl = req.has("sl") ? req["sl"].asDouble() : 0.0;

        if (quantity <= EPS) return errorResponse("quantity must be > 0");
        if (type == OrderType::LIMIT && limit_price <= EPS) return errorResponse("limit price required");

        int wallet_id = walletOf(user_id);
        double mark = markPrice_.count(symbol) ? markPrice_[symbol] : limit_price;
        if (mark <= EPS) return errorResponse("no mark price known for symbol yet");

        // ---- fund reservation --------------------------------------------------
        if (side == Side::BUY) {
            double refPrice = (type == OrderType::LIMIT) ? limit_price : mark;
            double needed = quantity * refPrice;
            Holding& usdt = holdingRef(wallet_id, "USDT");
            if (usdt.available_quantity < needed - EPS) return errorResponse("insufficient USDT balance");
            usdt.available_quantity -= needed;
            usdt.locked_quantity += needed;
            persistHolding(usdt);
        } else {
            Holding& base = holdingRef(wallet_id, symbol);
            if (base.available_quantity < quantity - EPS) return errorResponse("insufficient " + symbol + " balance");
            base.available_quantity -= quantity;
            base.locked_quantity += quantity;
            persistHolding(base);
        }

        auto o = std::make_shared<Order>();
        o->order_id = ids_.nextOrder();
        o->user_id = user_id;
        o->wallet_id = wallet_id;
        o->symbol = symbol;
        o->side = side;
        o->type = type;
        o->quantity = quantity;
        o->remaining_quantity = quantity;
        o->limit_price = (type == OrderType::LIMIT) ? limit_price : 0.0;
        o->tp_price = tp;
        o->sl_price = sl;
        o->status = OrderStatus::OPEN;

        orderIndex_[o->order_id] = o;
        userOrders_[user_id].insert(o->order_id);
        writer_.push([o = *o](Database& db) { db.insertOrder(o); });

        if (type == OrderType::MARKET) {
            fill(o, mark, o->remaining_quantity);
        } else {
            bool crosses = (side == Side::BUY) ? (limit_price >= mark) : (limit_price <= mark);
            if (crosses) fill(o, mark, o->remaining_quantity);
            if (o->remaining_quantity > EPS) book(symbol).insert(o);
        }

        json::Value resp = json::Value::makeObject();
        resp["status"] = json::Value::fromString("ok");
        resp["order_id"] = json::Value::fromNumber((double)o->order_id);
        resp["order_status"] = json::Value::fromString(toStr(o->status));
        resp["filled_quantity"] = json::Value::fromNumber(o->quantity - o->remaining_quantity);
        return resp;
    }

    // ---------------------------------------------------------------------------
    //  CANCEL ORDER
    // ---------------------------------------------------------------------------
    json::Value cancelOrder(const json::Value& req) {
        std::lock_guard<std::mutex> lk(mu_);
        uint64_t order_id = (uint64_t)req["order_id"].asInt();
        int user_id = (int)req["user_id"].asInt();

        auto it = orderIndex_.find(order_id);
        if (it == orderIndex_.end()) return errorResponse("order not found");
        OrderPtr o = it->second;
        if (o->user_id != user_id) return errorResponse("not your order");
        if (o->status == OrderStatus::FILLED || o->status == OrderStatus::CANCELLED)
            return errorResponse("order already terminal");

        book(o->symbol).erase(o);
        o->status = OrderStatus::CANCELLED;

        // release remaining locked funds
        if (o->side == Side::BUY) {
            double refPrice = (o->type == OrderType::LIMIT) ? o->limit_price : markPrice_[o->symbol];
            double release = o->remaining_quantity * refPrice;
            Holding& usdt = holdingRef(o->wallet_id, "USDT");
            usdt.locked_quantity -= release;
            usdt.available_quantity += release;
            persistHolding(usdt);
        } else {
            Holding& base = holdingRef(o->wallet_id, o->symbol);
            base.locked_quantity -= o->remaining_quantity;
            base.available_quantity += o->remaining_quantity;
            persistHolding(base);
        }

        writer_.push([o = *o](Database& db) { db.updateOrder(o); });
        return okResponse();
    }

    // ---------------------------------------------------------------------------
    //  PRICE TICK — Node pushes real market prices in; this drives everything.
    // ---------------------------------------------------------------------------
    void onPriceTick(const std::string& symbol, double price) {
        std::lock_guard<std::mutex> lk(mu_);
        markPrice_[symbol] = price;

        // 1) fill any resting limit orders the new price has crossed
        auto crossedOrders = book(symbol).crossed(price);
        for (auto& o : crossedOrders) {
            if (o->status == OrderStatus::CANCELLED || o->status == OrderStatus::FILLED) continue;
            double qty = o->remaining_quantity;
            fill(o, o->limit_price, qty); // guaranteed fill at the resting limit price
        }

        // 2) trigger TP / SL on open positions
        auto trig = triggers(symbol).collectTriggered(price);
        for (auto& [pos, reason] : trig) closePosition(pos, price, reason);
    }

    json::Value orderBookSnapshot(const std::string& symbol) {
        std::lock_guard<std::mutex> lk(mu_);
        json::Value resp = json::Value::makeObject();
        json::Value bidsArr = json::Value::makeArray();
        json::Value asksArr = json::Value::makeArray();
        auto& b = book(symbol);
        for (auto& [price, lst] : b.bids) {
            double qty = 0; for (auto& o : lst) qty += o->remaining_quantity;
            json::Value lvl = json::Value::makeObject();
            lvl["price"] = json::Value::fromNumber(price);
            lvl["quantity"] = json::Value::fromNumber(qty);
            bidsArr.arr.push_back(lvl);
        }
        for (auto& [price, lst] : b.asks) {
            double qty = 0; for (auto& o : lst) qty += o->remaining_quantity;
            json::Value lvl = json::Value::makeObject();
            lvl["price"] = json::Value::fromNumber(price);
            lvl["quantity"] = json::Value::fromNumber(qty);
            asksArr.arr.push_back(lvl);
        }
        resp["symbol"] = json::Value::fromString(symbol);
        resp["bids"] = bidsArr;
        resp["asks"] = asksArr;
        return resp;
    }

    // Credits a wallet with an asset (USDT after a fiat deposit, or a symbol after an
    // external transfer). This is the funding hook Node.js calls once a deposit clears.
    json::Value creditBalance(const json::Value& req) {
        std::lock_guard<std::mutex> lk(mu_);
        int user_id = (int)req["user_id"].asInt();
        std::string symbol = req["symbol"].asString();
        double amount = req["amount"].asDouble();
        if (amount <= EPS) return errorResponse("amount must be > 0");
        int wallet_id = walletOf(user_id);
        Holding& h = holdingRef(wallet_id, symbol);
        h.available_quantity += amount;
        persistHolding(h);
        return okResponse();
    }

    json::Value userPositionsJson(int user_id) {
        std::lock_guard<std::mutex> lk(mu_);
        json::Value arr = json::Value::makeArray();
        auto it = userPositions_.find(user_id);
        if (it != userPositions_.end()) {
            for (auto pid : it->second) {
                auto pit = positionIndex_.find(pid);
                if (pit == positionIndex_.end()) continue;
                auto& p = pit->second;
                json::Value j = json::Value::makeObject();
                j["position_id"] = json::Value::fromNumber((double)p->position_id);
                j["symbol"] = json::Value::fromString(p->symbol);
                j["quantity"] = json::Value::fromNumber(p->quantity);
                j["entry_price"] = json::Value::fromNumber(p->entry_price);
                j["tp_price"] = json::Value::fromNumber(p->tp_price);
                j["sl_price"] = json::Value::fromNumber(p->sl_price);
                j["status"] = json::Value::fromString(toStr(p->status));
                arr.arr.push_back(j);
            }
        }
        return arr;
    }

private:
    // ---- helpers (all callers already hold mu_) --------------------------------
    OrderBook& book(const std::string& symbol) { return books_[symbol]; }
    TriggerBook& triggers(const std::string& symbol) { return triggers_[symbol]; }

    Holding& holdingRef(int wallet_id, const std::string& symbol) {
        auto& h = holdings_[wallet_id][symbol];
        if (h.symbol.empty()) { h.wallet_id = wallet_id; h.symbol = symbol; }
        return h;
    }

    int walletOf(int user_id) {
        auto it = userWallet_.find(user_id);
        if (it != userWallet_.end()) return it->second;
        int wid = db_.loadOrCreateWallet(user_id);
        userWallet_[user_id] = wid;
        return wid;
    }

    void persistHolding(const Holding& h) {
        writer_.push([h](Database& db) { db.upsertHolding(h); });
    }

    static json::Value errorResponse(const std::string& msg) {
        json::Value v = json::Value::makeObject();
        v["status"] = json::Value::fromString("error");
        v["message"] = json::Value::fromString(msg);
        return v;
    }
    static json::Value okResponse() {
        json::Value v = json::Value::makeObject();
        v["status"] = json::Value::fromString("ok");
        return v;
    }

    void emit(const json::Value& ev) { if (onEvent) onEvent(ev); }

    // Executes `qty` of `order` at `price`. Updates holdings, order status, position,
    // persists everything (async) and emits a FILL event for the Node bridge.
    void fill(const OrderPtr& o, double price, double qty) {
        if (qty <= EPS) return;
        qty = std::min(qty, o->remaining_quantity);
        double commission = qty * price * COMMISSION_RATE;

        Trade t;
        t.trade_id = ids_.nextTrade();
        t.order_id = o->order_id;
        t.user_id = o->user_id;
        t.symbol = o->symbol;
        t.quantity = qty;
        t.price = price;
        t.commission = commission;
        writer_.push([t](Database& db) { db.insertTrade(t); });

        if (o->side == Side::BUY) {
            double cost = qty * price;
            Holding& usdt = holdingRef(o->wallet_id, "USDT");
            usdt.locked_quantity -= cost;
            // refund any favorable slippage between the reserved price and the fill price
            double refPrice = (o->type == OrderType::LIMIT) ? o->limit_price : price;
            double reserved = qty * refPrice;
            if (reserved > cost) usdt.available_quantity += (reserved - cost);
            persistHolding(usdt);

            Holding& base = holdingRef(o->wallet_id, o->symbol);
            double receivedQty = qty - (commission / price); // fee taken in the base asset
            double newTotalCost = base.total_cost + cost;
            double newQty = base.available_quantity + base.locked_quantity + receivedQty; // pre-lock view for avg cost
            base.average_buy_price = newQty > EPS ? (newTotalCost / (base.total_cost > EPS ? (base.total_cost / std::max(base.average_buy_price, EPS)) + receivedQty : receivedQty)) : price;
            base.total_cost = newTotalCost;
            base.available_quantity += receivedQty;
            persistHolding(base);

            openOrAddPosition(o, receivedQty, price, cost);
        } else {
            double proceeds = qty * price - commission;
            Holding& base = holdingRef(o->wallet_id, o->symbol);
            base.locked_quantity -= qty;
            persistHolding(base);

            Holding& usdt = holdingRef(o->wallet_id, "USDT");
            usdt.available_quantity += proceeds;
            persistHolding(usdt);

            reducePosition(o->user_id, o->symbol, qty);
        }

        o->remaining_quantity -= qty;
        o->status = (o->remaining_quantity <= EPS) ? OrderStatus::FILLED : OrderStatus::PARTIALLY_FILLED;
        if (o->status == OrderStatus::FILLED) book(o->symbol).erase(o);
        writer_.push([snap = *o](Database& db) { db.updateOrder(snap); });

        json::Value ev = json::Value::makeObject();
        ev["event"] = json::Value::fromString("FILL");
        ev["user_id"] = json::Value::fromNumber(o->user_id);
        ev["order_id"] = json::Value::fromNumber((double)o->order_id);
        ev["symbol"] = json::Value::fromString(o->symbol);
        ev["side"] = json::Value::fromString(toStr(o->side));
        ev["price"] = json::Value::fromNumber(price);
        ev["quantity"] = json::Value::fromNumber(qty);
        ev["order_status"] = json::Value::fromString(toStr(o->status));
        emit(ev);
    }

    void openOrAddPosition(const OrderPtr& o, double qty, double price, double cost) {
        // merge into an existing OPEN position for (user,symbol) if one exists, else open a new one
        PositionPtr target;
        auto it = userPositions_.find(o->user_id);
        if (it != userPositions_.end()) {
            for (auto pid : it->second) {
                auto p = positionIndex_[pid];
                if (p->symbol == o->symbol && p->status == PositionStatus::OPEN) { target = p; break; }
            }
        }
        if (target) {
            double newQty = target->quantity + qty;
            target->entry_price = (target->invested_usdt + cost) / std::max(newQty, EPS);
            target->quantity = newQty;
            target->invested_usdt += cost;
            writer_.push([snap = *target](Database& db) { db.updatePosition(snap); });
        } else {
            auto p = std::make_shared<Position>();
            p->position_id = ids_.nextPosition();
            p->order_id = o->order_id;
            p->user_id = o->user_id;
            p->symbol = o->symbol;
            p->quantity = qty;
            p->entry_price = price;
            p->invested_usdt = cost;
            p->tp_price = o->tp_price;
            p->sl_price = o->sl_price;
            p->status = PositionStatus::OPEN;
            positionIndex_[p->position_id] = p;
            userPositions_[o->user_id].insert(p->position_id);
            if (p->tp_price > EPS) triggers(p->symbol).addTP(p->tp_price, p);
            if (p->sl_price > EPS) triggers(p->symbol).addSL(p->sl_price, p);
            writer_.push([snap = *p](Database& db) { db.insertPosition(snap); });
        }
    }

    void reducePosition(int user_id, const std::string& symbol, double qty) {
        auto it = userPositions_.find(user_id);
        if (it == userPositions_.end()) return;
        for (auto pid : it->second) {
            auto p = positionIndex_[pid];
            if (p->symbol != symbol || p->status != PositionStatus::OPEN) continue;
            double take = std::min(qty, p->quantity);
            p->quantity -= take;
            p->invested_usdt *= (p->quantity <= EPS ? 0.0 : (p->quantity / (p->quantity + take)));
            qty -= take;
            if (p->quantity <= EPS) {
                p->status = PositionStatus::CLOSED;
                triggers(symbol).removePosition(p);
            }
            writer_.push([snap = *p](Database& db) { db.updatePosition(snap); });
            if (qty <= EPS) break;
        }
    }

    // Auto-generated closing fill triggered by TP/SL — books it as a synthetic SELL.
    void closePosition(const PositionPtr& p, double price, const std::string& reason) {
        double proceeds = p->quantity * price * (1.0 - COMMISSION_RATE);
        int wallet_id = walletOf(p->user_id);

        Holding& base = holdingRef(wallet_id, p->symbol);
        double takeFromAvailable = std::min(p->quantity, base.available_quantity);
        base.available_quantity -= takeFromAvailable;
        persistHolding(base);

        Holding& usdt = holdingRef(wallet_id, "USDT");
        usdt.available_quantity += proceeds;
        persistHolding(usdt);

        Trade t;
        t.trade_id = ids_.nextTrade();
        t.order_id = p->order_id;
        t.user_id = p->user_id;
        t.symbol = p->symbol;
        t.quantity = p->quantity;
        t.price = price;
        t.commission = p->quantity * price * COMMISSION_RATE;
        writer_.push([t](Database& db) { db.insertTrade(t); });

        p->status = PositionStatus::CLOSED;
        p->quantity = 0;
        writer_.push([snap = *p](Database& db) { db.updatePosition(snap); });

        json::Value ev = json::Value::makeObject();
        ev["event"] = json::Value::fromString(reason == "TP" ? "TAKE_PROFIT" : "STOP_LOSS");
        ev["user_id"] = json::Value::fromNumber(p->user_id);
        ev["position_id"] = json::Value::fromNumber((double)p->position_id);
        ev["symbol"] = json::Value::fromString(p->symbol);
        ev["price"] = json::Value::fromNumber(price);
        emit(ev);
    }

    Database& db_;
    PersistenceWorker& writer_;
    IdGenerator ids_;

    std::mutex mu_;
    std::unordered_map<std::string, OrderBook> books_;
    std::unordered_map<std::string, TriggerBook> triggers_;
    std::unordered_map<uint64_t, OrderPtr> orderIndex_;
    std::unordered_map<int, std::unordered_set<uint64_t>> userOrders_;
    std::unordered_map<uint64_t, PositionPtr> positionIndex_;
    std::unordered_map<int, std::unordered_set<uint64_t>> userPositions_;
    std::unordered_map<int, std::unordered_map<std::string, Holding>> holdings_; // wallet_id -> symbol -> Holding
    std::unordered_map<int, int> userWallet_; // user_id -> wallet_id
    std::unordered_map<std::string, double> markPrice_;
};

// =====================================================================================
//  SECTION 8 — TCP / JSON BRIDGE TO NODE.JS  (Winsock2, newline-delimited JSON)
// =====================================================================================
#ifdef _WIN32
class TcpServer {
public:
    TcpServer(SpotExecutionEngine& engine, unsigned short port) : engine_(engine), port_(port) {}

    bool start() {
        WSADATA wsa;
        if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) { std::cerr << "WSAStartup failed\n"; return false; }

        listenSock_ = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
        if (listenSock_ == INVALID_SOCKET) { std::cerr << "socket() failed\n"; return false; }

        sockaddr_in addr{};
        addr.sin_family = AF_INET;
        addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK); // 127.0.0.1 only — Node runs on the same host
        addr.sin_port = htons(port_);

        if (bind(listenSock_, (sockaddr*)&addr, sizeof(addr)) == SOCKET_ERROR) {
            std::cerr << "bind() failed: " << WSAGetLastError() << "\n"; return false;
        }
        if (listen(listenSock_, SOMAXCONN) == SOCKET_ERROR) {
            std::cerr << "listen() failed\n"; return false;
        }

        engine_.onEvent = [this](const json::Value& ev) { broadcast(ev.dump()); };

        std::cout << "[TcpServer] listening on 127.0.0.1:" << port_ << "\n";
        acceptLoop();
        return true;
    }

private:
    void acceptLoop() {
        while (true) {
            socket_t client = accept(listenSock_, nullptr, nullptr);
            if (client == INVALID_SOCKET) continue;
            {
                std::lock_guard<std::mutex> lk(clientsMu_);
                clients_.insert(client);
            }
            std::thread(&TcpServer::handleClient, this, client).detach();
        }
    }

    void handleClient(socket_t client) {
        std::string buf;
        char chunk[4096];
        while (true) {
            int n = recv(client, chunk, sizeof(chunk), 0);
            if (n <= 0) break;
            buf.append(chunk, n);
            size_t pos;
            while ((pos = buf.find('\n')) != std::string::npos) {
                std::string line = buf.substr(0, pos);
                buf.erase(0, pos + 1);
                if (!line.empty() && line.back() == '\r') line.pop_back();
                if (line.empty()) continue;
                std::string resp = dispatch(line) + "\n";
                send(client, resp.c_str(), (int)resp.size(), 0);
            }
        }
        {
            std::lock_guard<std::mutex> lk(clientsMu_);
            clients_.erase(client);
        }
        CLOSESOCK(client);
    }

    std::string dispatch(const std::string& line) {
        try {
            json::Value req = json::parse(line);
            std::string action = req["action"].asString();
            json::Value resp;
            if (action == "PLACE_ORDER") resp = engine_.placeOrder(req);
            else if (action == "CANCEL_ORDER") resp = engine_.cancelOrder(req);
            else if (action == "CREDIT_BALANCE") resp = engine_.creditBalance(req);
            else if (action == "PRICE_UPDATE") {
                engine_.onPriceTick(req["symbol"].asString(), req["price"].asDouble());
                resp = json::Value::makeObject();
                resp["status"] = json::Value::fromString("ok");
            } else if (action == "GET_ORDERBOOK") {
                resp = engine_.orderBookSnapshot(req["symbol"].asString());
            } else if (action == "GET_POSITIONS") {
                json::Value wrap = json::Value::makeObject();
                wrap["status"] = json::Value::fromString("ok");
                wrap["positions"] = engine_.userPositionsJson((int)req["user_id"].asInt());
                resp = wrap;
            } else {
                resp = json::Value::makeObject();
                resp["status"] = json::Value::fromString("error");
                resp["message"] = json::Value::fromString("unknown action");
            }
            return resp.dump();
        } catch (const std::exception& e) {
            json::Value err = json::Value::makeObject();
            err["status"] = json::Value::fromString("error");
            err["message"] = json::Value::fromString(std::string("bad request: ") + e.what());
            return err.dump();
        }
    }

    void broadcast(const std::string& payload) {
        std::string line = payload + "\n";
        std::lock_guard<std::mutex> lk(clientsMu_);
        for (auto s : clients_) send(s, line.c_str(), (int)line.size(), 0);
    }

    SpotExecutionEngine& engine_;
    unsigned short port_;
    socket_t listenSock_ = INVALID_SOCKET;
    std::unordered_set<socket_t> clients_;
    std::mutex clientsMu_;
};
#endif // _WIN32

// =====================================================================================
//  SECTION 9 — main()
// =====================================================================================
int main(int argc, char** argv) {
    std::string dbHost = "127.0.0.1", dbUser = "root", dbPass = "", dbSchema = "NodeJS_Exchange";
    unsigned dbPort = 3306;
    unsigned short tcpPort = 5577;
    for (int i = 1; i < argc; ++i) {
        std::string a = argv[i];
        if (a == "--db-host" && i + 1 < argc) dbHost = argv[++i];
        else if (a == "--db-user" && i + 1 < argc) dbUser = argv[++i];
        else if (a == "--db-pass" && i + 1 < argc) dbPass = argv[++i];
        else if (a == "--db-name" && i + 1 < argc) dbSchema = argv[++i];
        else if (a == "--port" && i + 1 < argc) tcpPort = (unsigned short)std::stoi(argv[++i]);
    }

    Database db;
    if (!db.connect(dbHost, dbUser, dbPass, dbSchema, dbPort)) {
        std::cerr << "Fatal: could not connect to MySQL.\n";
        return 1;
    }

    PersistenceWorker writer(db);
    SpotExecutionEngine engine(db, writer);
    engine.loadStateFromDB();

#ifdef _WIN32
    TcpServer server(engine, tcpPort);
    server.start(); // blocks, accepting Node.js connections
#else
    std::cerr << "[main] Non-Windows build: engine core is available but the Winsock TCP\n"
                 "bridge only compiles under _WIN32 (MinGW). Wire your own transport here,\n"
                 "or build this file with MSYS2 MinGW-w64 as documented at the top.\n";
#endif
    return 0;
}