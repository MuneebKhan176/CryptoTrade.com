/**
 * RoomManager.js
 * -----------------------------------------------------------------------
 * The single authority for chat room lifecycle: creating rooms, validating
 * passwords, joining/removing users, checking capacity, broadcasting
 * events, and keeping MySQL in sync with in-memory state.
 *
 * Rooms now also own a `polls` map. Because polls live on the in-memory
 * room object (same lifetime as everything else — members, etc.), a
 * poll and every user's votes on it persist for as long as the room
 * exists, regardless of whether any individual user leaves and rejoins.
 * They're handed back to a (re)joining client via getPollsList().
 *
 * Polls are single-select: votePoll() clears a user's vote from every
 * option before (optionally) re-adding it to the chosen one, so a user
 * can only ever be "voted" on one option at a time in a given poll.
 *
 * Members now also carry an `avatarUrl`, resolved once at join time via
 * avatarService (backed by the SocialProfile collection + Cloudflare R2
 * URLs) and cached briefly there. This is what lets the chat UI show
 * profile photos next to messages, in the sidebar, and in the typing
 * indicator without a round trip per message.
 * -----------------------------------------------------------------------
 */

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const chatDb = require('../chatDb');
const { deleteRoomAttachments } = require('../services/uploadService');
const avatarService = require('../services/avatarService');

const HARD_CAPACITY_LIMIT = 100;

/** roomId -> { roomId, roomName, description, ownerId, ownerUsername,
 *              visibility, passwordHash, maxUsers, createdAt,
 *              members: Map<ws, { userId, username, avatarUrl }>,
 *              polls: Map<pollId, { pollId, question, createdBy, createdById,
 *                                    createdAt, options: [{ id, text, voterIds: Set<userId> }] }> } */
const rooms = new Map();

async function init() {
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
    polls: new Map(),
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

  // Resolved once per join (avatarService keeps its own short-lived cache,
  // so this is cheap even across many joins for the same user).
  let avatarUrl = null;
  try {
    avatarUrl = await avatarService.getAvatarUrl(user.id);
  } catch (err) {
    console.error('[chat] avatar lookup failed for user', user.id, err);
  }

  room.members.set(ws, { userId: user.id, username: user.username, avatarUrl });
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

  // Fire-and-forget-but-logged: don't block the delete response on R2
  // cleanup, but don't silently swallow failures either.
  deleteRoomAttachments(roomId)
    .then((count) => {
      if (count) console.log(`[chat] cleaned up ${count} R2 object(s) for room ${roomId}`);
    })
    .catch((err) => console.error('[chat] R2 cleanup failed for room', roomId, err));

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

/** Rich member list — {userId, username, avatarUrl} — used for the sidebar
 *  and for the roster sent back on join. */
function getMemberList(roomId) {
  const room = rooms.get(roomId);
  if (!room) return [];
  return Array.from(room.members.values()).map((m) => ({
    userId: m.userId,
    username: m.username,
    avatarUrl: m.avatarUrl || null,
  }));
}

/** Looks up a single connected member's avatar (used to stamp outgoing
 *  chat messages and typing events without re-querying the DB). */
function getMemberAvatar(roomId, userId) {
  const room = rooms.get(roomId);
  if (!room) return null;
  for (const info of room.members.values()) {
    if (info.userId === userId) return info.avatarUrl || null;
  }
  return null;
}

/* ────────────────────────────────────────────────────────────
   POLLS
   Stored on the room itself (in-memory, same lifetime as the
   room), so leaving/rejoining a room never loses poll state —
   only deleting the room (or a server restart) does.

   Single-select: a user's userId can appear in at most one
   option's voterIds at any time.
   ──────────────────────────────────────────────────────────── */

function toPublicPoll(poll) {
  return {
    pollId: poll.pollId,
    question: poll.question,
    createdBy: poll.createdBy,
    createdAt: poll.createdAt,
    options: poll.options.map((o) => ({ id: o.id, text: o.text, voterIds: Array.from(o.voterIds) })),
  };
}

function createPoll(roomId, user, question, optionTexts) {
  const room = rooms.get(roomId);
  if (!room) return null;

  const poll = {
    pollId: crypto.randomUUID(),
    question,
    createdBy: user.username,
    createdById: user.id,
    createdAt: new Date(),
    options: optionTexts.map((text) => ({ id: crypto.randomUUID(), text, voterIds: new Set() })),
  };

  room.polls.set(poll.pollId, poll);
  return toPublicPoll(poll);
}

/**
 * Single-select vote: clicking an option clears the user's vote from every
 * other option in the poll first, then adds them to the clicked option —
 * unless they were already on that exact option, in which case it's
 * treated as an un-vote (click your current choice again to clear it).
 */
function votePoll(roomId, userId, pollId, optionId) {
  const room = rooms.get(roomId);
  if (!room) return null;
  const poll = room.polls.get(pollId);
  if (!poll) return null;
  const targetOption = poll.options.find((o) => o.id === optionId);
  if (!targetOption) return null;

  const alreadyOnTarget = targetOption.voterIds.has(userId);

  // Clear this user from every option (enforces single-select).
  poll.options.forEach((o) => o.voterIds.delete(userId));

  // Re-add only if they weren't already on the option they just clicked.
  if (!alreadyOnTarget) targetOption.voterIds.add(userId);

  return toPublicPoll(poll);
}

function getPollsList(roomId) {
  const room = rooms.get(roomId);
  if (!room) return [];
  return Array.from(room.polls.values()).map(toPublicPoll);
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
  getMemberAvatar,
  createPoll,
  votePoll,
  getPollsList,
};