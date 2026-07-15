# CryptoTrade Spot Engine — Wire Protocol

One shared, persistent TCP connection (port 9000). Newline-delimited JSON,
both directions. **A single inbound packet can produce multiple outbound
lines** — always read/process every line, don't assume one reply per request.

## Division of responsibility

- **Node**: JWT auth, balance checks, business rules, all pre-trade
  validation. Inserts the order into `spot_orders` as `OPEN` *before*
  forwarding it. Owns all persistence and WebSocket broadcast.
- **Engine**: packet integrity, known trading pair, in-memory order book
  per symbol, MARKET/LIMIT execution, TP/SL as OCO exit orders. RAM only —
  never reads or writes MySQL, and the book is empty on every restart.

## Node → Engine

| action | required fields | notes |
|---|---|---|
| `PLACE_ORDER` | `request_id, order_id, user_id, wallet_id, symbol, side, order_type, quantity` + `limit_price` (LIMIT only), `take_profit_price?`, `stop_loss_price?` | `order_id` is the MySQL `spot_orders.order_id` PK — the durable correlation key. TP/SL only valid on `side: "BUY"`. |
| `CANCEL_ORDER` | `request_id, order_id, symbol` | Only cancels a resting LIMIT entry order. TP/SL legs are managed automatically (OCO) and aren't individually cancellable yet. |
| `PRICE_UPDATE` | `request_id, symbol, price` | Forward every Binance tick here for symbols with open interest. Drives all matching. |

## Engine → Node

| type | when | key fields |
|---|---|---|
| `ORDER_ACK` | immediate reply to `PLACE_ORDER` | `accepted, message, errors[], engine_order_id` |
| `CANCEL_ACK` | immediate reply to `CANCEL_ORDER` | `cancelled, message` |
| `EXECUTION` | **push** — a fill happened (entry or TP/SL exit), sync or async | `order_id, engine_order_id, side, order_type, fill_quantity, fill_price, remaining_quantity, status, is_exit_order, trigger_type, parent_order_id, realized_pnl?` |
| `ORDER_BOOK_UPDATE` | **push** — after anything that can change the book | `symbol, last_price, best_bid, best_bid_qty, best_ask, best_ask_qty` |
| `ERROR` | malformed/unknown packet | `message` |

`EXECUTION` and `ORDER_BOOK_UPDATE` are **events, not RPC replies** — a
resting LIMIT order can fill minutes later on someone else's price tick,
carrying that tick's `request_id`, not the original order's. Subscribe to
`engineEvents.on('execution', ...)` in `engineClient.js` rather than
reading these off the original `sendOrderToEngine()` promise.

## TP/SL model

TP/SL are attached to a BUY entry order. The moment that entry **fills**,
the engine spawns two internal SELL exit triggers (OCO-linked): a
take-profit at `take_profit_price` and a stop-loss at `stop_loss_price`,
both carrying the entry fill price for PnL. Whichever crosses first fires
as an `EXECUTION` with `is_exit_order: true`, `trigger_type`, and
`realized_pnl`; the other leg is cancelled automatically. Both legs share
the *same* `order_id` as the entry (the exit is the closing fill for that
same DB row, not a new order).

## Reconnect behavior

The engine's book is wiped on process restart. `engineClient.js`
reconnects automatically on drop, but does **not** re-submit orders that
were resting on the old book — a reconciliation job should re-send any
still-`OPEN` LIMIT orders from MySQL after a fresh engine process comes
up (a plain reconnect of the same long-running engine process needs no
action, since its in-memory book was never lost).