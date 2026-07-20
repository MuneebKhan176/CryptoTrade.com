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
 *
 * ── PHASE 1: message store ──────────────────────────────────────────
 * Rooms previously never stored chat messages — they were only ever
 * broadcast, live, to whoever happened to be connected. That makes
 * replies, edits, deletes, reactions, read receipts, pinning, infinite
 * scroll, and search all impossible, since there's nothing to point back
 * at. Each room now keeps a bounded in-memory array (`messages`), capped
 * at MAX_STORED_MESSAGES so long-lived rooms don't grow without bound.
 * Like everything else here, this is in-memory only — it does not
 * survive a server restart, matching the existing "rooms are ephemeral"
 * architecture (see init(): chat_rooms is wiped on boot).
 *
 * ── PHASE 2: link previews ──────────────────────────────────────────
 * Each stored message now also carries a `linkPreview` field. It starts
 * out null and is filled in asynchronously (see MessageHandler.js /
 * setLinkPreview below) after linkPreviewService resolves the first URL
 * in the message text, if any. It's part of the same message object and
 * travels with it through toPublicMessage()/getHistory() exactly like
 * every other field, so a client that joins after the preview resolved
 * just sees it already attached — no separate fetch needed.
 *
 * ── PHASE 3: single-active-reaction-per-user ────────────────────────
 * toggleReaction() now enforces that a given user can have at most one
 * active emoji reaction on any single message at a time (matching the
 * client's documented behavior). Clicking a new emoji clears the user's
 * previous reaction on that message before applying the new one;
 * clicking the same emoji they already reacted with clears it (un-react).
 * -----------------------------------------------------------------------
 */

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const chatDb = require('../chatDb');
const { deleteRoomAttachments } = require('../services/uploadService');
const avatarService = require('../services/avatarService');

const HARD_CAPACITY_LIMIT = 100;
const MAX_STORED_MESSAGES = 500;
const DEFAULT_HISTORY_PAGE = 30;
const MAX_HISTORY_PAGE = 100;

/** roomId -> { roomId, roomName, description, ownerId, ownerUsername,
 *              visibility, passwordHash, maxUsers, createdAt,
 *              members: Map<ws, { userId, username, avatarUrl }>,
 *              polls: Map<pollId, {...}>,
 *              messages: [{ id, clientId, fromId, from, fromAvatar, text,
 *                            attachments, linkPreview, replyTo,
 *                            reactions: Map<emoji,Set<userId>>,
 *                            edited, editedAt, deletedForEveryone,
 *                            readBy: Set<userId>, timestamp }],
 *              pinnedMessageId: string|null } */
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
    messages: [],
    pinnedMessageId: null,
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

/** Returns the number of sockets the payload was actually sent to
 *  (excluding `excludeWs` and any socket that isn't OPEN). Used by
 *  MessageHandler to approximate a "delivered" status for the sender. */
function broadcast(roomId, payload, excludeWs) {
  const room = rooms.get(roomId);
  if (!room) return 0;
  const data = JSON.stringify(payload);
  let count = 0;
  for (const ws of room.members.keys()) {
    if (ws === excludeWs) continue;
    if (ws.readyState === ws.OPEN) {
      ws.send(data);
      count++;
    }
  }
  return count;
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

/* ────────────────────────────────────────────────────────────
   MESSAGES
   In-memory, capped store per room. Every chat message now has a
   stable server-assigned id, which is what replies, reactions,
   edits, deletes, read receipts, pinning, and (Phase 2) link
   previews all key off of.
   ──────────────────────────────────────────────────────────── */

function attachmentSummaryLabel(atts) {
  if (!atts || !atts.length) return '';
  const a = atts[0];
  if (a.kind === 'image') return atts.length > 1 ? `\uD83D\uDCF7 ${atts.length} photos` : '\uD83D\uDCF7 Photo';
  if (a.kind === 'video') return '\uD83C\uDFA5 Video';
  return `\uD83D\uDCC4 ${a.name || 'Document'}`;
}

function findMessage(room, messageId) {
  if (!messageId) return null;
  return room.messages.find((m) => m.id === messageId) || null;
}

/** Converts a stored message (Maps/Sets) into the plain-JSON shape sent
 *  over the wire. `pinned` is derived live from room.pinnedMessageId
 *  rather than stored on the message itself, so there's only ever one
 *  source of truth for what's pinned. */
function toPublicMessage(room, msg) {
  const reactions = {};
  for (const [emoji, voterSet] of msg.reactions.entries()) {
    if (voterSet.size) reactions[emoji] = Array.from(voterSet);
  }
  return {
    id: msg.id,
    clientId: msg.clientId,
    fromId: msg.fromId,
    from: msg.from,
    fromAvatar: msg.fromAvatar,
    text: msg.deletedForEveryone ? '' : msg.text,
    attachments: msg.deletedForEveryone ? [] : msg.attachments,
    linkPreview: msg.deletedForEveryone ? null : msg.linkPreview, // PHASE 2
    replyTo: msg.replyTo,
    reactions,
    edited: msg.edited,
    editedAt: msg.editedAt,
    deletedForEveryone: msg.deletedForEveryone,
    pinned: room.pinnedMessageId === msg.id,
    readBy: Array.from(msg.readBy),
    timestamp: msg.timestamp,
  };
}

/** Stores a new message and returns its public representation. Reply
 *  previews are snapshotted at send time (text/author at that moment),
 *  the same way WhatsApp/Telegram/Discord all do it, so an edit or
 *  delete of the original doesn't retroactively rewrite quotes of it. */
function postMessage(roomId, user, { text, attachments, replyToId, clientId }) {
  const room = rooms.get(roomId);
  if (!room) return null;

  let replyTo = null;
  if (replyToId) {
    const target = findMessage(room, replyToId);
    if (target && !target.deletedForEveryone) {
      replyTo = {
        id: target.id,
        from: target.from,
        textPreview: (target.text || attachmentSummaryLabel(target.attachments)).slice(0, 120),
        kind: target.attachments && target.attachments.length ? target.attachments[0].kind : 'text',
      };
    }
  }

  const msg = {
    id: crypto.randomUUID(),
    clientId: clientId || null,
    fromId: user.id,
    from: user.username,
    fromAvatar: getMemberAvatar(roomId, user.id),
    text,
    attachments,
    linkPreview: null, // PHASE 2 — filled in asynchronously, see setLinkPreview()
    replyTo,
    reactions: new Map(),
    edited: false,
    editedAt: null,
    deletedForEveryone: false,
    readBy: new Set([user.id]), // the sender has implicitly "read" their own message
    timestamp: new Date().toISOString(),
  };

  room.messages.push(msg);
  if (room.messages.length > MAX_STORED_MESSAGES) {
    room.messages.splice(0, room.messages.length - MAX_STORED_MESSAGES);
  }

  return toPublicMessage(room, msg);
}

/** Only the author may edit, and only while the message hasn't been
 *  deleted for everyone. Attachments are untouched — edit is text-only,
 *  matching the product spec. */
function editMessage(roomId, userId, messageId, text) {
  const room = rooms.get(roomId);
  if (!room) return null;
  const msg = findMessage(room, messageId);
  if (!msg || msg.fromId !== userId || msg.deletedForEveryone) return null;

  msg.text = text;
  msg.edited = true;
  msg.editedAt = new Date().toISOString();
  return toPublicMessage(room, msg);
}

/**
 * PHASE 2: Attaches a resolved link preview to an already-sent message.
 * Called asynchronously after postMessage() returns (fetching a page's
 * OG tags takes real network time, so we don't make the sender wait on
 * it before their message shows up — see MessageHandler.resolveLinkPreview).
 * No-ops quietly if the message was since deleted, since there's nothing
 * sensible to attach a preview to anymore.
 */
function setLinkPreview(roomId, messageId, preview) {
  const room = rooms.get(roomId);
  if (!room) return null;
  const msg = findMessage(room, messageId);
  if (!msg || msg.deletedForEveryone) return null;

  msg.linkPreview = preview;
  return toPublicMessage(room, msg);
}

/**
 * scope 'everyone': author or room owner only. Wipes text/attachments/
 * reactions/linkPreview server-side and unpins the message if it was
 * pinned, so every client (present and future joiners) sees the tombstone.
 *
 * scope 'me': this is a purely per-viewer preference (WhatsApp/Telegram
 * behaviour) — there is nothing to change in shared room state, so this
 * just validates the message exists and tells the caller so, leaving the
 * actual hiding to the requesting client.
 */
function deleteMessage(roomId, userId, messageId, scope, isOwner) {
  const room = rooms.get(roomId);
  if (!room) return { ok: false, reason: 'Message not found' };
  const msg = findMessage(room, messageId);
  if (!msg) return { ok: false, reason: 'Message not found' };

  if (scope === 'everyone') {
    if (msg.fromId !== userId && !isOwner) return { ok: false, reason: 'You can only delete your own messages' };
    msg.deletedForEveryone = true;
    msg.text = '';
    msg.attachments = [];
    msg.linkPreview = null;
    msg.reactions.clear();
    if (room.pinnedMessageId === msg.id) room.pinnedMessageId = null;
    return { ok: true, message: toPublicMessage(room, msg) };
  }

  return { ok: true, message: toPublicMessage(room, msg), localOnly: true };
}

/**
 * Toggle with single-active-reaction-per-user enforcement: a user may
 * only have ONE active emoji reaction on a given message at a time.
 * Clicking a different emoji than their current one moves their
 * reaction to the new emoji (removing it from the old one). Clicking
 * their current emoji again clears it (un-react).
 */
function toggleReaction(roomId, userId, messageId, emoji) {
  const room = rooms.get(roomId);
  if (!room) return null;
  const msg = findMessage(room, messageId);
  if (!msg || msg.deletedForEveryone) return null;

  const targetSet = msg.reactions.get(emoji);
  const alreadyOnThis = targetSet ? targetSet.has(userId) : false;

  // Clear this user from every emoji on this message first, so they can
  // never end up "reacted" with more than one emoji at once.
  for (const voterSet of msg.reactions.values()) voterSet.delete(userId);

  // Re-add only if this wasn't already their active reaction (clicking
  // the same emoji again is treated as an un-react).
  if (!alreadyOnThis) {
    if (!msg.reactions.has(emoji)) msg.reactions.set(emoji, new Set());
    msg.reactions.get(emoji).add(userId);
  }

  return toPublicMessage(room, msg);
}

/** Returns null (nothing to broadcast) if the user had already read this
 *  message, so callers can skip a no-op broadcast. */
function markRead(roomId, userId, messageId) {
  const room = rooms.get(roomId);
  if (!room) return null;
  const msg = findMessage(room, messageId);
  if (!msg || msg.readBy.has(userId)) return null;

  msg.readBy.add(userId);
  return toPublicMessage(room, msg);
}

/** Only one pinned message per room at a time, and only the room owner
 *  may set/clear it. */
function pinMessage(roomId, userId, messageId) {
  const room = rooms.get(roomId);
  if (!room) return { ok: false, reason: 'Room not found' };
  if (room.ownerId !== userId) return { ok: false, reason: 'Only the room owner can pin messages' };
  const msg = findMessage(room, messageId);
  if (!msg || msg.deletedForEveryone) return { ok: false, reason: 'Message not found' };

  room.pinnedMessageId = msg.id;
  return { ok: true, message: toPublicMessage(room, msg) };
}

function unpinMessage(roomId, userId) {
  const room = rooms.get(roomId);
  if (!room) return { ok: false, reason: 'Room not found' };
  if (room.ownerId !== userId) return { ok: false, reason: 'Only the room owner can unpin messages' };

  room.pinnedMessageId = null;
  return { ok: true };
}

function getPinnedMessage(roomId) {
  const room = rooms.get(roomId);
  if (!room || !room.pinnedMessageId) return null;
  const msg = findMessage(room, room.pinnedMessageId);
  return msg ? toPublicMessage(room, msg) : null;
}

/** Paginated, newest-first-page / oldest-first-within-page history for
 *  infinite scroll. Pass no `beforeId` for the initial (most recent)
 *  page. `messages` is always returned in ascending (old -> new) order
 *  so the client can render it top-to-bottom without re-sorting. */
function getHistory(roomId, beforeId, limit) {
  const room = rooms.get(roomId);
  if (!room) return { messages: [], hasMore: false };

  const pageSize = Math.min(Math.max(parseInt(limit, 10) || DEFAULT_HISTORY_PAGE, 1), MAX_HISTORY_PAGE);

  let endIdx = room.messages.length;
  if (beforeId) {
    const idx = room.messages.findIndex((m) => m.id === beforeId);
    if (idx !== -1) endIdx = idx;
  }
  const startIdx = Math.max(0, endIdx - pageSize);
  const slice = room.messages.slice(startIdx, endIdx);

  return {
    messages: slice.map((m) => toPublicMessage(room, m)),
    hasMore: startIdx > 0,
  };
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
  postMessage,
  editMessage,
  deleteMessage,
  toggleReaction,
  markRead,
  pinMessage,
  unpinMessage,
  getPinnedMessage,
  getHistory,
  setLinkPreview, // PHASE 2
};