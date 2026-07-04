/**
 * wsServer.js
 * -----------------------------------------------------------------------
 * Wires a `ws` WebSocketServer onto your existing HTTP server's
 * 'upgrade' event, authenticates the connection using the same cookie
 * your Express auth uses, and hands every message off to MessageHandler.
 *
 * ws.chatUser is set once at upgrade time; ws.roomId is initialized here
 * and updated by MessageHandler as the connection joins/leaves rooms.
 * Both live directly on the socket object — see the comment at the top
 * of MessageHandler.js for why.
 * -----------------------------------------------------------------------
 */

const { WebSocketServer } = require('ws');
const { authenticateUpgrade } = require('./chatAuth');
const MessageHandler = require('./handlers/MessageHandler');

const CHAT_WS_PATH = '/ws/chat';

function attachChatWebSocketServer(httpServer) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (request, socket, head) => {
    let pathname;
    try {
      pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
    } catch (e) {
      socket.destroy();
      return;
    }

    if (pathname !== CHAT_WS_PATH) {
      socket.destroy();
      return;
    }

    const user = authenticateUpgrade(request);
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      ws.chatUser = user;
      wss.emit('connection', ws, request);
    });
  });

  wss.on('connection', (ws) => {
    ws.roomId = null;

    ws.on('message', (raw) => {
      MessageHandler.handle(ws, raw.toString()).catch((err) => {
        console.error('[chat] message handler error:', err);
      });
    });

    ws.on('close', () => {
      MessageHandler.handleDisconnect(ws);
    });

    ws.on('error', (err) => {
      console.error('[chat] socket error:', err.message);
    });
  });
  
  return wss;
}

module.exports = { attachChatWebSocketServer, CHAT_WS_PATH };