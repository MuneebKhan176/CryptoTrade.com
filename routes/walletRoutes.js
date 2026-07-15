const express = require("express");
const path = require("path");
const router = express.Router();

// Same db module your authRoutes.js already uses.
const { conn } = require("../db_connection");

// Same auth middleware /dashboard already uses — sets req.user.id from the JWT cookie.
const verifyToken = require("../middle/middleware");

// Wallet-to-wallet internal transfer logic lives in its own file.
const { transferBetweenWallets } = require("../Wallets_Config/walletTransfer");

// Shared live-price cache from the Binance feed — adjust path if your
// market_data.js lives somewhere else.
const { getLivePrice } = require("../Web_Sockets/marketData_ws");

function sendResponse(res, statusCode, success, message, data = null) {
    return res.status(statusCode).json({ success, message, data });
}

// ═══════════════════════════════════════════════════════
// PAGES
// ═══════════════════════════════════════════════════════
router.get("/funding-wallet", verifyToken, (req, res) => {
    res.sendFile(path.join(__dirname, "../Frontend/Wallets_UI/funding-wallet.html"));
});
router.get("/spot-wallet", verifyToken, (req, res) => {
    res.sendFile(path.join(__dirname, "../Frontend/Wallets_UI/spot-wallet.html"));
});
router.get("/futures-wallet", verifyToken, (req, res) => {
    res.sendFile(path.join(__dirname, "../Frontend/Wallets_UI/futures-wallet.html"));
});

// ═══════════════════════════════════════════════════════
// FUNDING WALLET DATA
// ═══════════════════════════════════════════════════════
// There's no separate funding_wallet table — the Funding wallet IS the
// accounts row, held entirely as a single USDT balance. This is what
// funding-wallet.html's loadFundingWallet() is fetching.
router.get("/api/wallets/funding", verifyToken, (req, res) => {
    const userId = req.user.id;

    conn.query(
        "SELECT account_number, balance, status FROM accounts WHERE user_id = ?",
        [userId],
        (err, result) => {
            if (err) return sendResponse(res, 500, false, "Database error");
            if (!result.length) return sendResponse(res, 404, false, "Account not found");

            const acc = result[0];
            const balance = parseFloat(acc.balance || 0);

            // Only show a USDT row once there's actually a balance, so a
            // brand-new $0 account gets the nicer "No funding balance yet"
            // empty state instead of a row full of zeros.
            const holdings = balance > 0
                ? [{ symbol: "USDT", availableQuantity: balance, valueUsd: balance }]
                : [];

            return sendResponse(res, 200, true, "Funding wallet loaded", {
                accountNumber: acc.account_number,
                status: acc.status,
                totalValue: balance,
                holdings,
            });
        }
    );
});

// ═══════════════════════════════════════════════════════
// SPOT WALLET DATA
// ═══════════════════════════════════════════════════════
// spot_wallet (one row per user) + spot_holdings (per-asset rows, joined
// on wallet_id) — this is what spot-wallet.html's loadSpotWallet() expects.
router.get("/api/wallets/spot", verifyToken, (req, res) => {
    const userId = req.user.id;

    conn.query(
        "SELECT wallet_id, status FROM spot_wallet WHERE user_id = ?",
        [userId],
        (err, walletResult) => {
            if (err) return sendResponse(res, 500, false, "Database error");
            if (!walletResult.length) return sendResponse(res, 404, false, "Spot wallet not found");

            const wallet = walletResult[0];

            conn.query(
                `SELECT symbol, available_quantity, locked_quantity, average_buy_price
                 FROM spot_holdings
                 WHERE wallet_id = ?`,
                [wallet.wallet_id],
                (holdingsErr, holdingsResult) => {
                    if (holdingsErr) return sendResponse(res, 500, false, "Database error");

                    // Drop zero-balance rows (e.g. the default USDT row created
                    // at signup) so an untouched wallet shows the empty state
                    // instead of a $0.00 line item.
                    const holdings = holdingsResult
                        .filter(h => parseFloat(h.available_quantity) > 0 || parseFloat(h.locked_quantity) > 0)
                        .map(h => {
                            // Price from the shared live Binance cache, falling
                            // back to avg_buy_price only if the feed hasn't
                            // produced a tick yet (e.g. right after server start).
                            const currentPrice = getLivePrice(h.symbol) ?? parseFloat(h.average_buy_price) ?? 0;
                            const available = parseFloat(h.available_quantity);
                            const locked = parseFloat(h.locked_quantity);
                            return {
                                symbol: h.symbol,
                                availableQuantity: available,
                                lockedQuantity: locked,
                                averageBuyPrice: parseFloat(h.average_buy_price),
                                currentPrice,
                                value: (available + locked) * currentPrice,
                            };
                        });

                    // totalValue now driven by live price, not avg_buy_price.
                    const totalValue = holdings.reduce((sum, h) => sum + h.value, 0);

                    return sendResponse(res, 200, true, "Spot wallet loaded", {
                        walletId: wallet.wallet_id,
                        status: wallet.status,
                        totalValue,
                        holdings,
                    });
                }
            );
        }
    );
});

// ═══════════════════════════════════════════════════════
// FUTURES WALLET DATA
// ═══════════════════════════════════════════════════════
// futures_wallet is already a flat one-row-per-user table, so this is a
// straight read — this is what futures-wallet.html's loadFuturesWallet()
// expects.
router.get("/api/wallets/futures", verifyToken, (req, res) => {
    const userId = req.user.id;

    conn.query(
        `SELECT wallet_id, status, wallet_balance, available_margin, used_margin
         FROM futures_wallet WHERE user_id = ?`,
        [userId],
        (err, result) => {
            if (err) return sendResponse(res, 500, false, "Database error");
            if (!result.length) return sendResponse(res, 404, false, "Futures wallet not found");

            const w = result[0];

            return sendResponse(res, 200, true, "Futures wallet loaded", {
                walletId: w.wallet_id,
                status: w.status,
                walletBalance: parseFloat(w.wallet_balance || 0),
                availableMargin: parseFloat(w.available_margin || 0),
                usedMargin: parseFloat(w.used_margin || 0),
            });
        }
    );
});

// ═══════════════════════════════════════════════════════
// INTERNAL WALLET-TO-WALLET TRANSFER
// ═══════════════════════════════════════════════════════
// body: { fromWallet: 'funding'|'spot'|'futures', toWallet: same, amount }
// All validation, locking, and the debit/credit transaction live in
// walletTransfer.js — this route just wires it up. No changes needed
// here: walletTransfer.js already reads available_quantity (not
// available_quantity + locked_quantity) via getSpotBalance, FOR UPDATE
// inside a transaction, so once orders correctly move funds into
// locked_quantity, transfers already respect the lock automatically.
router.post("/api/wallets/transfer", verifyToken, transferBetweenWallets);

module.exports = router;