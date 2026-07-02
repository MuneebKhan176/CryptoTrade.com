const express = require('express');
const path = require('path');
const http = require('http');

const authRoutes = require('./routes/authRoutes');
const homeRoutes = require('./routes/homeRoutes');
const transferRoutes = require('./routes/bankingAuth');
const chatRoutes = require('./routes/chatRoutes');

const RoomManager = require('./chat/managers/RoomManager');
const { attachChatWebSocketServer } = require('./chat/Wsserver');

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
app.use(chatRoutes);

// ---------------- 404 ----------------
app.use((req, res) => res.status(404).send("Route not found"));

const server = http.createServer(app);
attachChatWebSocketServer(server);

RoomManager.init()
  .then(() => {
    server.listen(port_num, () => {
      console.log(`Server (HTTP + WebSocket chat) running on port ${port_num}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize chat system:', err);
    process.exit(1);
  });