/**
 * chat/Wsserver.js
 * -----------------------------------------------------------------------
 * Chat Gateway
 *
 * This file no longer attaches to the HTTP server.
 * The WebSocketManager is responsible for routing upgrade requests.
 *
 * WebSocketManager creates the WebSocketServer and passes it here by
 * calling initialize(wss).
 * -----------------------------------------------------------------------
 */

const { authenticateUpgrade } = require('../chat/chatAuth');
const MessageHandler = require('../chat/handlers/MessageHandler');

const CHAT_WS_PATH = '/ws/chat';

function initialize(wss) {

  wss.on('connection', (ws, request) => {

    // Authenticate the user using the same cookie as Express
    const user = authenticateUpgrade(request);

    if (!user) {
      ws.close(1008, 'Unauthorized');
      return;
    }

    // Store authenticated user on socket
    ws.chatUser = user;
    ws.roomId = null;

    // ---------------- Incoming Messages ----------------
    ws.on('message', (raw) => {
      MessageHandler.handle(ws, raw.toString()).catch((err) => {
        console.error('[chat] Message Handler Error:', err);
      });
    });

    // ---------------- Disconnect ----------------

    ws.on('close', () => {
      MessageHandler.handleDisconnect(ws);
    });

    // ---------------- Errors ----------------
    
    ws.on('error', (err) => {
      console.error('[chat] Socket Error:', err.message);
    });

  });

}

module.exports = {
  initialize,
  CHAT_WS_PATH
};