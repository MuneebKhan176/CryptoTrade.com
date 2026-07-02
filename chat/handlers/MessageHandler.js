/**
 * MessageHandler.js
 * -----------------------------------------------------------------------
 * Parses and routes every inbound WebSocket message.
 *
 * Per-connection state (`ws.chatUser`, `ws.roomId`) now lives directly on
 * the socket object itself instead of a separate UserManager Map keyed by
 * `ws`. That Map approach could get out of sync if this file and
 * wsServer.js ever ended up with two different module instances of
 * UserManager (a real risk on some Windows/nodemon setups) — properties
 * on the socket object itself can't have that problem, since it's
 * guaranteed to be the exact same object reference on every event for
 * that connection's lifetime.
 * -----------------------------------------------------------------------
 */

const RoomManager = require('../managers/RoomManager');

const MAX_MESSAGE_LENGTH = 2000;

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

function sendError(ws, message) {
  send(ws, { type: 'error', message });
}

async function handle(ws, raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch (e) {
    return sendError(ws, 'Malformed message');
  }

  if (!msg || typeof msg.type !== 'string') {
    return sendError(ws, 'Malformed message');
  }

  const user = ws.chatUser;
  if (!user || user.id == null) return sendError(ws, 'Not authenticated');

  switch (msg.type) {
    case 'join':
      return handleJoin(ws, user, msg);
    case 'message':
      return handleMessage(ws, user, msg);
    case 'delete_room':
      return handleDeleteRoom(ws, user);
    case 'leave':
      return handleLeave(ws, user);
    case 'ping':
      return send(ws, { type: 'pong' });
    default:
      return sendError(ws, `Unknown message type: ${msg.type}`);
  }
}

async function handleJoin(ws, user, msg) {
  if (ws.roomId) return sendError(ws, 'You are already in a room. Leave it before joining another.');

  const roomId = msg.roomId;
  if (!roomId || typeof roomId !== 'string') return sendError(ws, 'A room ID is required');

  const result = await RoomManager.joinRoom(roomId, msg.password, ws, user);
  if (!result.ok) return sendError(ws, result.reason);

  ws.roomId = roomId;
  const room = result.room;

  send(ws, {
    type: 'joined',
    room: {
      room_id: room.roomId,
      room_name: room.roomName,
      description: room.description,
      owner_username: room.ownerUsername,
      is_owner: room.ownerId === user.id,
      max_users: room.maxUsers,
      visibility: room.visibility,
    },
    users: RoomManager.getMemberList(roomId),
  });

  send(ws, { type: 'system', text: `Welcome to "${room.roomName}", ${user.username}! 👋` });

  RoomManager.broadcast(roomId, { type: 'system', text: `${user.username} has joined the room` }, ws);
  RoomManager.broadcast(roomId, { type: 'user_list', users: RoomManager.getMemberList(roomId) });
}

function handleMessage(ws, user, msg) {
  if (!ws.roomId) return sendError(ws, 'Join a room before sending messages');

  const text = (msg.text || '').toString().trim();
  if (!text) return sendError(ws, 'Message cannot be empty');
  if (text.length > MAX_MESSAGE_LENGTH) {
    return sendError(ws, `Messages must be under ${MAX_MESSAGE_LENGTH} characters`);
  }

  RoomManager.broadcast(ws.roomId, {
    type: 'message',
    from: user.username,
    fromId: user.id,
    text,
    timestamp: new Date().toISOString(),
  });
}

async function handleDeleteRoom(ws, user) {
  if (!ws.roomId) return sendError(ws, 'You are not in a room');
  const result = await RoomManager.deleteRoom(ws.roomId, user.id);
  if (!result.ok) return sendError(ws, result.reason);
  // RoomManager.deleteRoom already broadcasts room_deleted and closes member sockets.
}

function handleLeave(ws, user) {
  if (!ws.roomId) return;
  const roomId = ws.roomId;
  const info = RoomManager.leaveRoom(roomId, ws);
  ws.roomId = null;
  if (info) {
    RoomManager.broadcast(roomId, { type: 'system', text: `${info.username} has left the room` });
    RoomManager.broadcast(roomId, { type: 'user_list', users: RoomManager.getMemberList(roomId) });
  }
}

function handleDisconnect(ws) {
  if (ws.roomId) {
    const roomId = ws.roomId;
    const info = RoomManager.leaveRoom(roomId, ws);
    ws.roomId = null;
    if (info) {
      RoomManager.broadcast(roomId, { type: 'system', text: `${info.username} has left the room` });
      RoomManager.broadcast(roomId, { type: 'user_list', users: RoomManager.getMemberList(roomId) });
    }
  }
}

module.exports = { handle, handleDisconnect };