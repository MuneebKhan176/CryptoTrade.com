const express = require("express");
const path = require("path");

const router = express.Router();

// Funding Wallet
router.get("/funding-wallet", (req, res) => {
    res.sendFile(path.join(__dirname, "../Frontend/funding-wallet.html")); // hyphen
});
router.get("/spot-wallet", (req, res) => {
    res.sendFile(path.join(__dirname, "../Frontend/spot-wallet.html"));
});
router.get("/futures-wallet", (req, res) => {
    res.sendFile(path.join(__dirname, "../Frontend/futures-wallet.html"));
});

module.exports = router;