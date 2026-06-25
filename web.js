const express = require('express');
const path = require('path');

const authRoutes = require('./routes/authRoutes');
const homeRoutes = require('./routes/homeRoutes');
const transferRoutes = require('./routes/bankingAuth');

const app = express();
const port_num = 7070;


const cookieParser = require('cookie-parser');
app.use(cookieParser());

// ---------------- BODY PARSERS ----------------
app.use(express.urlencoded({ extended: true }));
app.use(express.json()); // 🔥 REQUIRED FOR YOUR TRANSFER API

// ---------------- STATIC FILES ----------------
app.use(express.static(path.join(__dirname), { index: false }));

// ---------------- USING ROUTES ----------------
app.use(homeRoutes);
app.use(authRoutes);
app.use(transferRoutes);

// ---------------- 404 ----------------
app.use((req, res) => res.status(404).send("Route not found"));

// ---------------- START SERVER ----------------
app.listen(port_num);