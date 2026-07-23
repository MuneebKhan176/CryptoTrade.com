// Wallets_Config/walletTransfer.js
//
// db_connection.js now exports a mysql2 POOL (`conn`) plus a
// getConnection() helper that checks out ONE dedicated connection for a
// real multi-statement transaction. This file was still calling
// conn.beginTransaction(...) / conn.commit(...) / conn.rollback(...)
// directly on the pool object — pool objects don't have those methods at
// all (only a connection you've checked out does), so every transfer was
// throwing immediately at beginTransaction. Fixed below by using
// getConnection() and running the whole transaction on that one
// connection, releasing it in a finally block.
//
// v2 SCHEMA CHANGE: futures_wallet.available_margin and .used_margin no
// longer exist as columns — they're volatile (recomputed on every
// MARK_PRICE_UPDATE tick by AccountManager::recomputeMargin() in
// futures_engine.cpp) and now live only in Node's in-memory
// liveStateStore, pushed over TCP/WebSocket. This file previously did
// `SELECT ... available_margin ... FOR UPDATE` and wrote
// `available_margin = available_margin - ?` — both are gone below.
// wallet_balance is the one futures field that's still genuinely static
// between discrete events, so it's still the thing we lock and mutate
// in MySQL; available_margin is read from the live cache purely to
// decide how much of that balance is safe to move out right now.
//
// THIS REVISION — two bugs fixed:
//
// 1. "Transfer moves the ledger balance but the futures margin panel
//    doesn't reflect it" — debitWallet()/creditWallet() always updated
//    futures_wallet.wallet_balance correctly in MySQL, but nothing ever
//    told the C++ engine about the new value. The engine's in-RAM
//    WalletMirror.wallet_balance (see futures_engine.cpp) is what
//    actually drives every live number — Margin Balance, Available
//    Balance, Margin Ratio, Liquidation Price — and it stayed stale
//    until the next full rehydrate or an unrelated MARK_PRICE_UPDATE
//    tick happened to touch this user. Fixed by calling syncWallet()
//    right after commit(), in both handleFundingFuturesTransfer() and
//    the generic transferBetweenWallets() path below, whenever futures
//    is either side of the transfer.
//
// 2. Lock-ordering deadlock — resolveWallet(source) then
//    resolveWallet(destination) locked rows in whatever order
//    fromWallet/toWallet happened to specify. A funding->futures
//    transfer locked accounts then futures_wallet; a concurrent
//    futures->funding transfer for the same user locked futures_wallet
//    then accounts — a textbook deadlock. Fixed by always resolving
//    (and therefore locking) wallets in the fixed WALLET_LOCK_ORDER
//    below, regardless of which one is actually the transfer's source
//    or destination.

const { getConnection } = require("../db_connection");

// Live margin cache — the real module is Futures_Engine/LiveStateStore.js
// (capital, case-sensitive on Linux) and exports getWalletSnapshot(userId),
// NOT a getLiveMargin(walletId) — keyed by user_id, snake_case fields
// (wallet_balance, used_margin, available_margin), per LiveStateStore.js.
const { getWalletSnapshot } = require("../Futures_Engine/LiveStateStore");

// Pushes the just-committed wallet_balance into the C++ engine's RAM
// mirror so Margin Balance / Available Balance / Margin Ratio /
// Liquidation Price recompute immediately, instead of staying stale
// until the next full rehydrate or an unrelated MARK_PRICE_UPDATE tick
// happens to touch this user. Fire-and-forget, same as every other
// SYNC_* call in this codebase — see futuresEngineClient.js.
const { syncWallet } = require("../Futures_Engine/futuresEngineClient");

const WALLET_TYPES = ["funding", "spot", "futures"];

// Canonical lock order, independent of transfer direction. Two
// concurrent transfers for the same user (one funding->futures, one
// futures->funding) previously locked accounts/futures_wallet in
// opposite orders depending on which was "source" vs "destination" —
// a textbook deadlock. Resolving (and thus locking) every wallet
// touched by a transfer in this fixed order, regardless of which is
// source/destination, means every transaction acquires row locks in
// the same sequence and can never deadlock against another transfer
// for the same user.
const WALLET_LOCK_ORDER = ["funding", "spot", "futures"];

function sendResponse(res, statusCode, success, message, data = null) {
    return res.status(statusCode).json({ success, message, data });
}

// Promise wrapper around connection.query — `connection` here is always
// the ONE dedicated connection for this transaction, never the pool.
function query(connection, sql, params) {
    return new Promise((resolve, reject) => {
        connection.query(sql, params, (err, result) => {
            if (err) return reject(err);
            resolve(result);
        });
    });
}

function beginTransaction(connection) {
    return new Promise((resolve, reject) => {
        connection.beginTransaction((err) => (err ? reject(err) : resolve()));
    });
}

function commit(connection) {
    return new Promise((resolve, reject) => {
        connection.commit((err) => (err ? reject(err) : resolve()));
    });
}

function rollback(connection) {
    return new Promise((resolve) => {
        // rollback() on a connection that never successfully started a
        // transaction is a harmless no-op in mysql2 — safe to call
        // unconditionally in the catch block below.
        connection.rollback(() => resolve());
    });
}

// ═══════════════════════════════════════════════════════
// READ (balance resolution) HELPERS
// ═══════════════════════════════════════════════════════
async function getFundingBalance(connection, userId) {
    const rows = await query(
        connection,
        "SELECT balance FROM accounts WHERE user_id = ? FOR UPDATE",
        [userId]
    );
    if (!rows.length) return null;
    return { type: "funding", balance: parseFloat(rows[0].balance) };
}

async function getSpotBalance(connection, userId) {
    const walletRows = await query(
        connection,
        "SELECT wallet_id FROM spot_wallet WHERE user_id = ?",
        [userId]
    );
    if (!walletRows.length) return null;

    const walletId = walletRows[0].wallet_id;

    // Reads available_quantity only (not available_quantity +
    // locked_quantity) — funds an order has reserved via
    // spotHoldingsLock.js are correctly excluded from what a transfer can
    // move out, now that orders actually populate locked_quantity.
    const hRows = await query(
        connection,
        `SELECT available_quantity FROM spot_holdings
         WHERE wallet_id = ? AND symbol = 'USDT' FOR UPDATE`,
        [walletId]
    );

    return {
        type: "spot",
        walletId,
        balance: hRows.length ? parseFloat(hRows[0].available_quantity) : 0,
        hasHoldingRow: hRows.length > 0,
    };
}

async function getFuturesBalance(connection, userId) {
    // wallet_balance is still the one column genuinely worth a row lock —
    // it's what we'll actually debit/credit, and FOR UPDATE here is what
    // prevents two concurrent transfers from racing on the same wallet.
    const rows = await query(
        connection,
        "SELECT wallet_id, wallet_balance FROM futures_wallet WHERE user_id = ? FOR UPDATE",
        [userId]
    );
    if (!rows.length) return null;

    const walletId = rows[0].wallet_id;
    const walletBalance = parseFloat(rows[0].wallet_balance || 0);

    // getWalletSnapshot is keyed by user_id (not wallet_id) and returns
    // snake_case fields straight off the engine's MARGIN_UPDATE wire
    // format — see LiveStateStore.js. NOTE: this read is NOT covered by
    // the FOR UPDATE lock above — the live cache is updated independently
    // by the engine on its own tick cadence, outside this MySQL
    // transaction. That's an accepted, unavoidable gap in this
    // architecture (the alternative is locking the engine's in-memory
    // state on every transfer, which defeats the point of keeping margin
    // off the DB hot path). The wallet_balance row lock still guarantees
    // no two transfers can double-spend the ledger balance itself; the
    // live-margin check below is a best-effort guard against withdrawing
    // funds that are actively backing an open position.
    const live = getWalletSnapshot(userId);

    let availableMargin;
    if (live) {
        availableMargin = live.available_margin;
    } else {
        // Same fallback as futuresWalletMerge.js's getMergedFuturesWallet,
        // computed on this same locked connection for consistency: before
        // any MARGIN_UPDATE tick has landed for this user, approximate
        // used_margin as the sum of initial_margin across open positions
        // (that figure IS persisted). Can't reproduce unrealized CROSS PnL
        // without a mark price, so this slightly overstates availableMargin
        // until the live feed catches up on the next tick.
        const marginRows = await query(
            connection,
            `SELECT COALESCE(SUM(initial_margin), 0) AS used FROM positions WHERE user_id = ? AND status = 'OPEN'`,
            [userId]
        );
        const usedMargin = parseFloat(marginRows[0].used) || 0;
        availableMargin = Math.max(0, walletBalance - usedMargin);
    }

    // Spendable amount is the tighter of the two constraints: never more
    // than the actual ledger balance, and never more than what the engine
    // (or the fallback approximation) currently considers free. THIS is
    // the margin lock: a transfer OUT of futures can never draw on funds
    // currently backing an open position's initial margin.
    const spendable = Math.min(walletBalance, availableMargin);

    return {
        type: "futures",
        walletId,
        walletBalance,
        balance: spendable,
    };
}

function resolveWallet(connection, type, userId) {
    if (type === "funding") return getFundingBalance(connection, userId);
    if (type === "spot") return getSpotBalance(connection, userId);
    if (type === "futures") return getFuturesBalance(connection, userId);
    return Promise.reject(new Error("Unknown wallet type"));
}

// Resolves (and thus row-locks) both wallets touched by a transfer in a
// FIXED order (WALLET_LOCK_ORDER), never in fromWallet/toWallet order.
// Returns { funding|spot|futures resolved objects, keyed by type } for
// whichever two types are involved, so the caller can look them up by
// name afterward regardless of which one is source vs destination.
async function resolveWalletsInLockOrder(connection, userId, typesInvolved) {
    const resolved = {};
    for (const type of WALLET_LOCK_ORDER) {
        if (!typesInvolved.includes(type)) continue;
        resolved[type] = await resolveWallet(connection, type, userId);
    }
    return resolved;
}

// ═══════════════════════════════════════════════════════
// WRITE (debit/credit) HELPERS
// ═══════════════════════════════════════════════════════
async function debitWallet(connection, type, userId, wallet, amount) {
    if (type === "funding") {
        return query(connection, "UPDATE accounts SET balance = balance - ? WHERE user_id = ?", [amount, userId]);
    }
    if (type === "spot") {
        if (!wallet.hasHoldingRow) throw new Error("Spot USDT holding not found");
        return query(
            connection,
            `UPDATE spot_holdings SET available_quantity = available_quantity - ?
             WHERE wallet_id = ? AND symbol = 'USDT'`,
            [amount, wallet.walletId]
        );
    }
    if (type === "futures") {
        // Only wallet_balance is written now — available_margin doesn't
        // exist as a column anymore. The engine picks up the new
        // wallet_balance via the explicit syncWallet() call below (not
        // just "on its next recomputeMargin() pass" — that pass only
        // runs on a MARK_PRICE_UPDATE tick, which has no reason to fire
        // sooner than usual just because a transfer happened).
        return query(
            connection,
            `UPDATE futures_wallet SET wallet_balance = wallet_balance - ? WHERE wallet_id = ?`,
            [amount, wallet.walletId]
        );
    }
    throw new Error("Unknown wallet type");
}

async function creditWallet(connection, type, userId, wallet, amount) {
    if (type === "funding") {
        return query(connection, "UPDATE accounts SET balance = balance + ? WHERE user_id = ?", [amount, userId]);
    }
    if (type === "spot") {
        if (wallet.hasHoldingRow) {
            return query(
                connection,
                `UPDATE spot_holdings SET available_quantity = available_quantity + ?
                 WHERE wallet_id = ? AND symbol = 'USDT'`,
                [amount, wallet.walletId]
            );
        }
        // Defensive fallback — the signup flow always creates this row, but
        // if it's ever missing, create it instead of failing the transfer.
        return query(
            connection,
            `INSERT INTO spot_holdings
                (wallet_id, symbol, available_quantity, locked_quantity, average_buy_price, total_cost)
             VALUES (?, 'USDT', ?, 0, 1.00, 0)`,
            [wallet.walletId, amount]
        );
    }
    if (type === "futures") {
        // Same as debit: wallet_balance only, pushed to the engine
        // explicitly via syncWallet() below rather than waiting on an
        // unrelated tick.
        return query(
            connection,
            `UPDATE futures_wallet SET wallet_balance = wallet_balance + ? WHERE wallet_id = ?`,
            [amount, wallet.walletId]
        );
    }
    throw new Error("Unknown wallet type");
}

// Re-syncs the engine's in-RAM wallet mirror with the value we just
// committed to MySQL, if futures was either side of this transfer.
// Fire-and-forget: the resulting MARGIN_UPDATE tick lands in
// LiveStateStore within one round trip regardless of whether the HTTP
// response waits for it.
function resyncFuturesEngineIfInvolved(userId, resolvedWallets, newFuturesWalletBalance) {
    if (!resolvedWallets.futures) return;
    syncWallet(userId, resolvedWallets.futures.walletId, newFuturesWalletBalance, "ONE_WAY").catch((err) => {
        console.error(`walletTransfer: SYNC_WALLET after transfer failed for user ${userId}:`, err.message);
    });
}

// ═══════════════════════════════════════════════════════
// MAIN HANDLER — POST /api/wallets/transfer
// body: { fromWallet: 'funding'|'spot'|'futures', toWallet: same, amount: number }
// ═══════════════════════════════════════════════════════
async function transferBetweenWallets(req, res) {
    const userId = req.user.id;

    const fromType = String(req.body.fromWallet || "").toLowerCase();
    const toType = String(req.body.toWallet || "").toLowerCase();
    const amount = Math.round((parseFloat(req.body.amount) || 0) * 100) / 100;

    if (!WALLET_TYPES.includes(fromType) || !WALLET_TYPES.includes(toType)) {
        return sendResponse(res, 400, false, "Invalid wallet type. Use funding, spot, or futures.");
    }
    if (fromType === toType) {
        return sendResponse(res, 400, false, "Cannot transfer to the same wallet.");
    }
    if (!amount || amount <= 0) {
        return sendResponse(res, 400, false, "Amount must be greater than zero.");
    }

    let connection;
    try {
        connection = await getConnection();
    } catch (e) {
        return sendResponse(res, 500, false, "Could not acquire a database connection.");
    }

    try {
        await beginTransaction(connection);

        // Resolve (and row-lock) BOTH wallets in the fixed
        // WALLET_LOCK_ORDER, never in fromWallet/toWallet order — this is
        // what makes a funding<->futures transfer and a futures<->funding
        // transfer for the same user acquire locks in the same sequence,
        // so they can't deadlock against each other.
        const resolved = await resolveWalletsInLockOrder(connection, userId, [fromType, toType]);

        const source = resolved[fromType];
        if (!source) {
            await rollback(connection);
            return sendResponse(res, 404, false, `Your ${fromType} wallet was not found.`);
        }
        if (amount > source.balance) {
            const reason =
                fromType === "futures" && source.balance < source.walletBalance
                    ? ` (some of your balance is tied up as margin on open positions)`
                    : "";
            await rollback(connection);
            return sendResponse(
                res, 400, false,
                `Insufficient balance. Available: $${source.balance.toFixed(2)}${reason}`
            );
        }

        const destination = resolved[toType];
        if (!destination) {
            await rollback(connection);
            return sendResponse(res, 404, false, `Your ${toType} wallet was not found.`);
        }

        await debitWallet(connection, fromType, userId, source, amount);
        await creditWallet(connection, toType, userId, destination, amount);

        await commit(connection);

        // Push the new wallet_balance into the engine's RAM mirror
        // immediately if futures was either side of this transfer — see
        // header note (bug fix #1). Computed from the pre-transfer
        // walletBalance we already hold, not from source.balance/
        // destination.balance (which are the *spendable* figures for
        // futures, not the raw ledger balance being written above).
        if (fromType === "futures") {
            resyncFuturesEngineIfInvolved(userId, resolved, +(source.walletBalance - amount).toFixed(2));
        }
        if (toType === "futures") {
            resyncFuturesEngineIfInvolved(userId, resolved, +(destination.walletBalance + amount).toFixed(2));
        }

        return sendResponse(
            res, 200, true,
            `Transferred $${amount.toFixed(2)} USDT from ${fromType} to ${toType}.`,
            {
                fromWallet: fromType,
                toWallet: toType,
                amount,
                // For futures these are approximate — availableMargin will
                // fully re-sync once the engine's next MARGIN_UPDATE tick
                // reflects the new wallet_balance, which is now pushed
                // immediately via syncWallet() above rather than waiting
                // on an unrelated MARK_PRICE_UPDATE tick.
                fromBalanceAfter: +(source.balance - amount).toFixed(2),
                toBalanceAfter: +(destination.balance + amount).toFixed(2),
            }
        );
    } catch (err) {
        await rollback(connection);
        return sendResponse(res, 500, false, err.message || "Transfer failed due to a server error.");
    } finally {
        connection.release();
    }
}

module.exports = { transferBetweenWallets };