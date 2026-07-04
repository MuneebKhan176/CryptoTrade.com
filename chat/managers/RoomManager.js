/**
 * RoomManager.js
 * -----------------------------------------------------------------------
 * The single authority for chat room lifecycle: creating rooms, validating
 * passwords, joining/removing users, checking capacity, broadcasting
 * events, and keeping MySQL in sync with in-memory state.
 *
 * Rooms live in an in-memory Map because each room holds live WebSocket
 * references — those can never be persisted. `chatDb` mirrors metadata
 * and current_users for visibility/reporting only.
 * -----------------------------------------------------------------------
 */

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const chatDb = require('../db/chatDb');

const HARD_CAPACITY_LIMIT = 100;

/** roomId -> { roomId, roomName, description, ownerId, ownerUsername,
 *              visibility, passwordHash, maxUsers, createdAt,
 *              members: Map<ws, { userId, username }> } */
const rooms = new Map();

async function init() {
  await chatDb.initChatTable();
  await chatDb.clearAllRooms();
}

function roomNameTaken(name) {
  const lower = name.toLowerCase();
  for (const r of rooms.values()) {
    if (r.roomName.toLowerCase() === lower) return true;
  }
  return false;
}

function toPublicSummary(room) {
  return {
    room_id: room.roomId,
    room_name: room.roomName,
    description: room.description,
    owner_username: room.ownerUsername,
    visibility: room.visibility,
    has_password: room.visibility === 'private',
    current_users: room.members.size,
    max_users: room.maxUsers,
    created_at: room.createdAt,
  };
}

async function createRoom({ ownerId, ownerUsername, roomName, description, visibility, password, maxUsers }) {
  if (roomNameTaken(roomName)) {
    const err = new Error('Room name already exists');
    err.code = 'DUPLICATE_NAME';
    throw err;
  }

  let capacity = parseInt(maxUsers, 10);
  if (!Number.isFinite(capacity) || capacity < 2) capacity = HARD_CAPACITY_LIMIT;
  if (capacity > HARD_CAPACITY_LIMIT) capacity = HARD_CAPACITY_LIMIT;

  let passwordHash = null;
  if (visibility === 'private') {
    passwordHash = await bcrypt.hash(String(password), 10);
  }

  const roomId = crypto.randomUUID();

  const room = {
    roomId,
    roomName,
    description: description || '',
    ownerId,
    ownerUsername,
    visibility,
    passwordHash,
    maxUsers: capacity,
    members: new Map(),
    createdAt: new Date(),
  };

  rooms.set(roomId, room);

  await chatDb.insertRoom({
    room_id: roomId,
    room_name: roomName,
    description: room.description,
    owner_id: ownerId,
    owner_username: ownerUsername,
    visibility,
    password_hash: passwordHash,
    max_users: capacity,
  });

  return toPublicSummary(room);
}

/** All open (non-full) rooms, most active first. Used by the lobby page. */
function getRoomListing() {
  return Array.from(rooms.values())
    .filter((r) => r.members.size < r.maxUsers)
    .sort((a, b) => b.members.size - a.members.size || a.createdAt - b.createdAt)
    .map(toPublicSummary);
}

function getRoom(roomId) {
  return rooms.get(roomId) || null;
}

/** Synchronous pre-check used by the REST join-validation endpoint. */
function validateJoin(roomId, password, userId) {
  const room = rooms.get(roomId);
  if (!room) return { ok: false, status: 404, reason: 'This room no longer exists' };
  if (room.members.size >= room.maxUsers) return { ok: false, status: 409, reason: 'This room is full' };

  const isOwnerUser = room.ownerId === userId;
  if (room.visibility === 'private' && !isOwnerUser) {
    if (!password) return { ok: false, status: 401, reason: 'A password is required for this room' };
    if (!bcrypt.compareSync(String(password), room.passwordHash)) {
      return { ok: false, status: 401, reason: 'Incorrect room password' };
    }
  }
  return { ok: true };
}

/** Actual seat assignment, called once the WebSocket is open. */
async function joinRoom(roomId, password, ws, user) {
  const room = rooms.get(roomId);
  if (!room) return { ok: false, reason: 'This room no longer exists' };
  if (room.members.size >= room.maxUsers) return { ok: false, reason: 'This room is full' };

  const isOwnerUser = room.ownerId === user.id;
  if (room.visibility === 'private' && !isOwnerUser) {
    const match = password ? await bcrypt.compare(String(password), room.passwordHash) : false;
    if (!match) return { ok: false, reason: 'Incorrect room password' };
  }

  for (const info of room.members.values()) {
    if (info.userId === user.id) {
      return { ok: false, reason: 'You are already connected to this room in another tab' };
    }
  }

  room.members.set(ws, { userId: user.id, username: user.username });
  await chatDb.updateUserCount(roomId, room.members.size);

  return { ok: true, room };
}

function leaveRoom(roomId, ws) {
  const room = rooms.get(roomId);
  if (!room) return null;
  const info = room.members.get(ws) || null;
  room.members.delete(ws);
  chatDb.updateUserCount(roomId, room.members.size).catch((err) => console.error('[chat] count sync failed', err));
  return info;
}

async function deleteRoom(roomId, requesterId) {
  const room = rooms.get(roomId);
  if (!room) return { ok: false, status: 404, reason: 'This room no longer exists' };
  if (room.ownerId !== requesterId) {
    return { ok: false, status: 403, reason: 'Only the room owner can delete this room' };
  }

  broadcast(roomId, { type: 'room_deleted', message: `The room "${room.roomName}" was closed by its owner.` });

  for (const ws of room.members.keys()) {
    try {
      ws.close(1000, 'Room deleted');
    } catch (_) {
      /* ignore */
    }
  }

  rooms.delete(roomId);
  await chatDb.deleteRoomById(roomId);

  return { ok: true };
}

function broadcast(roomId, payload, excludeWs) {
  const room = rooms.get(roomId);
  if (!room) return;
  const data = JSON.stringify(payload);
  for (const ws of room.members.keys()) {
    if (ws === excludeWs) continue;
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

function getMemberList(roomId) {
  const room = rooms.get(roomId);
  if (!room) return [];
  return Array.from(room.members.values()).map((m) => m.username);
}

module.exports = {
  init,
  createRoom,
  getRoomListing,
  getRoom,
  validateJoin,
  joinRoom,
  leaveRoom,
  deleteRoom,
  broadcast,
  getMemberList,
};