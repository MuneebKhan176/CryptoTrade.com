const express = require('express');
const path = require('path');
const http = require('http');
const mongoConnection = require('./Social_Platform/mongo_connection');

// Connect to MongoDB 

mongoConnection();

const authRoutes = require('./routes/authRoutes');
const homeRoutes = require('./routes/homeRoutes');
const transferRoutes = require('./routes/bankingAuth');
const chatRoutes = require('./routes/chatRoutes');
const aiChatbotRoutes = require('./AI_chatbot/chatbotController');
const socialProfile = require('../NodeJS/Social_Platform/profile');
const follow_Unfollow=require('./Social_Platform/follow_unfollow');


const RoomManager = require('./chat/managers/RoomManager');
const { attachChatWebSocketServer } = require('./chat/Wsserver');

const app = express();
const port_num = 7070;

const cookieParser = require('cookie-parser');
app.use(cookieParser());

// ---------------- BODY PARSERS ----------------
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '5mb' }));

// ---------------- STATIC FILES ----------------
app.use(express.static(path.join(__dirname), { index: false }));

// ---------------- USING ROUTES ----------------
app.use(homeRoutes);
app.use(authRoutes);
app.use(transferRoutes);
app.use(chatRoutes);
app.use(aiChatbotRoutes);
app.use(socialProfile);
app.use(follow_Unfollow)

// ---------------- 404 ----------------
app.use((req, res) => res.status(404).send("Route not found"));

const server = http.createServer(app);
attachChatWebSocketServer(server);

RoomManager.init()
  .then(() => {
    server.listen(port_num);
  })
  .catch((err) => {
    console.error('Failed to initialize chat system:', err);
    process.exit(1);
  });