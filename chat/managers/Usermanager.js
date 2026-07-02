/**
 * UserManager.js
 * -----------------------------------------------------------------------
 * Tracks live WebSocket connections: which authenticated user a socket
 * belongs to, and which room (if any) it currently occupies. Kept
 * separate from RoomManager so connection bookkeeping and room lifecycle
 * logic don't get tangled together.
 * -----------------------------------------------------------------------
 */

/** ws -> { userId, username, roomId } */
const connections = new Map();

function registerConnection(ws, user) {
  connections.set(ws, { userId: user.id, username: user.username, roomId: null });
}

function setRoom(ws, roomId) {
  const ctx = connections.get(ws);
  if (ctx) ctx.roomId = roomId;
}

function getContext(ws) {
  return connections.get(ws) || null;
}

function removeConnection(ws) {
  const ctx = connections.get(ws) || null;
  connections.delete(ws);
  return ctx;
}

module.exports = { registerConnection, setRoom, getContext, removeConnection };