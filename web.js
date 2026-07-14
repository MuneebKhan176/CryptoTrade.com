const express = require('express');
const path = require('path');
const http = require('http');

const mongoConnection = require('./Social_Platform/mongo_connection');

// ---------------- MongoDB ----------------

mongoConnection();

// ---------------- Routes ----------------

const authRoutes = require('./routes/authRoutes');
const homeRoutes = require('./routes/homeRoutes');
const transferRoutes = require('./routes/bankingAuth');
const chatRoutes = require('./routes/chatRoom_Routes');
const aiChatbotRoutes = require('./AI_chatbot/chatbotController');
const walletRoutes = require('./routes/walletRoutes');
const socialProfile = require('./Social_Platform/profile');
const follow_Unfollow = require('./Social_Platform/follow_unfollow');
const create_Post = require('./Social_Platform/posts');
const crypto_square=require('./Social_Platform/insights')
const spotPanel = require('./routes/spotPanel_Route');
const futuresPanel= require('./routes/futuresPanel_Route');

// ---------------- Managers ----------------

const RoomManager = require('./chat/managers/RoomManager');

// ---------------- WebSocket Manager ----------------

const attachWebSocketManager = require('./Web_Sockets/ws_manager');

const app = express();
const port_num = 7070;

// ---------------- Middleware ----------------

const cookieParser = require('cookie-parser');

app.use(cookieParser());

app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '5mb' }));

// ---------------- Static Files ----------------

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.static(path.join(__dirname), { index: false }));

// ---------------- Routes ----------------

app.use(homeRoutes);
app.use(authRoutes);
app.use(transferRoutes);
app.use(chatRoutes);
app.use(aiChatbotRoutes);
app.use(walletRoutes);
app.use(socialProfile);
app.use(follow_Unfollow);
app.use(create_Post);
app.use(crypto_square);
app.use(spotPanel);
app.use(futuresPanel);

// ---------------- 404 ----------------

app.use((req, res) => {
    res.status(404).send("Route not found");
});

// ---------------- HTTP Server ----------------

const server = http.createServer(app);

// Attach ALL websocket gateways
attachWebSocketManager(server);

// ---------------- Start Server ----------------

RoomManager.init()
    .then(() => {

        server.listen(port_num);

    })
    .catch((err) => {

        console.error('Failed to initialize chat system:', err);

        process.exit(1);

    });