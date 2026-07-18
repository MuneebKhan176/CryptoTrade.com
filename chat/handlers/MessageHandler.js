/**
 * MessageHandler.js
 * -----------------------------------------------------------------------
 * Parses and routes every inbound WebSocket message.
 *
 * Poll support: `create_poll` builds a poll on the room (persists for the
 * room's lifetime, independent of any single socket), and `vote_poll`
 * sets a user's single-select vote on one option (RoomManager.votePoll
 * clears any previous choice by that user before applying the new one).
 * Both broadcast a `poll_update` with the full poll state so every
 * client — including ones who join later — stays in sync. On `join`,
 * the current list of polls (and everyone's votes on them) is sent back
 * to the client, so a user who left and returned still sees the same
 * poll state.
 *
 * Typing indicator: `typing` messages are relayed (not stored) to the
 * rest of the room as soon as they arrive, stamped with the sender's
 * username/avatar so the UI can render an avatar-stack + "X is typing".
 *
 * Outgoing chat `message` events are stamped with `fromAvatar` (resolved
 * via RoomManager.getMemberAvatar) so the client doesn't need a separate
 * lookup per message.
 * -----------------------------------------------------------------------
 */

const RoomManager = require('../managers/RoomManager');

const MAX_MESSAGE_LENGTH = 2000;
const MAX_ATTACHMENTS = 10;
const MAX_POLL_QUESTION_LENGTH = 200;
const MAX_POLL_OPTION_LENGTH = 80;
const MAX_POLL_OPTIONS = 10;

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
    case 'typing':
      return handleTyping(ws, user, msg);
    case 'create_poll':
      return handleCreatePoll(ws, user, msg);
    case 'vote_poll':
      return handleVotePoll(ws, user, msg);
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
    // Rich roster — {userId, username, avatarUrl} — used for the sidebar.
    users: RoomManager.getMemberList(roomId),
    // Existing polls (and everyone's votes on them) travel with the join
    // response, so a user who left and came back sees the same state.
    polls: RoomManager.getPollsList(roomId),
  });

  send(ws, { type: 'system', text: `Welcome to "${room.roomName}", ${user.username}! 👋` });

  RoomManager.broadcast(roomId, { type: 'system', text: `${user.username} has joined the room` }, ws);
  RoomManager.broadcast(roomId, { type: 'user_list', users: RoomManager.getMemberList(roomId) });
}

/**
 * Trust nothing from the client beyond shape — the real validation
 * (size/mimetype/R2 upload/thumbnailing) already happened server-side
 * in the /api/chat/upload REST endpoint before the client ever sent
 * this WebSocket message. Here we just make sure the shape wasn't
 * tampered with.
 */
function sanitizeAttachment(att) {
  if (!att || typeof att !== 'object') return null;
  const { url, thumbUrl, lqip, kind, name, size, mimetype, width, height } = att;
  if (typeof url !== 'string' || !url) return null;
  if (!['image', 'video', 'document'].includes(kind)) return null;
  return {
    url,
    thumbUrl: typeof thumbUrl === 'string' ? thumbUrl : null,
    lqip: typeof lqip === 'string' ? lqip : null,
    kind,
    name: typeof name === 'string' ? name.slice(0, 150) : '',
    size: Number.isFinite(size) ? size : null,
    mimetype: typeof mimetype === 'string' ? mimetype : '',
    width: Number.isFinite(width) ? width : null,
    height: Number.isFinite(height) ? height : null,
  };
}

function sanitizeAttachments(list) {
  if (!Array.isArray(list)) return [];
  return list
    .slice(0, MAX_ATTACHMENTS)
    .map(sanitizeAttachment)
    .filter(Boolean);
}

function handleMessage(ws, user, msg) {
  if (!ws.roomId) return sendError(ws, 'Join a room before sending messages');

  const text = (msg.text || '').toString().trim();
  const attachments = sanitizeAttachments(msg.attachments);

  if (!text && !attachments.length) return sendError(ws, 'Message cannot be empty');
  if (text.length > MAX_MESSAGE_LENGTH) {
    return sendError(ws, `Messages must be under ${MAX_MESSAGE_LENGTH} characters`);
  }

  RoomManager.broadcast(ws.roomId, {
    type: 'message',
    from: user.username,
    fromId: user.id,
    fromAvatar: RoomManager.getMemberAvatar(ws.roomId, user.id),
    text,
    attachments,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Relays a typing/stopped-typing signal to everyone else in the room.
 * Nothing is persisted server-side — the client keeps a short-lived,
 * self-expiring view of who's currently typing.
 */
function handleTyping(ws, user, msg) {
  if (!ws.roomId) return; // silently ignore — typing pings aren't worth erroring over
  const isTyping = !!msg.isTyping;

  RoomManager.broadcast(
    ws.roomId,
    {
      type: 'typing',
      userId: user.id,
      username: user.username,
      avatarUrl: RoomManager.getMemberAvatar(ws.roomId, user.id),
      isTyping,
    },
    ws
  );
}

/**
 * Creates a poll on the current room. Options are trimmed, de-duplicated,
 * and capped. The resulting poll is broadcast to everyone in the room
 * (including the creator, since broadcast() only excludes a socket when
 * explicitly asked to).
 */
function handleCreatePoll(ws, user, msg) {
  if (!ws.roomId) return sendError(ws, 'Join a room before creating a poll');

  const question = (msg.question || '').toString().trim();
  if (!question) return sendError(ws, 'Poll question is required');
  if (question.length > MAX_POLL_QUESTION_LENGTH) {
    return sendError(ws, `Poll question must be under ${MAX_POLL_QUESTION_LENGTH} characters`);
  }

  let options = Array.isArray(msg.options) ? msg.options : [];
  options = options
    .map((o) => (o || '').toString().trim().slice(0, MAX_POLL_OPTION_LENGTH))
    .filter(Boolean);
  options = [...new Set(options)]; // de-dupe, keep order

  if (options.length < 2) return sendError(ws, 'A poll needs at least 2 options');
  if (options.length > MAX_POLL_OPTIONS) {
    return sendError(ws, `A poll can have at most ${MAX_POLL_OPTIONS} options`);
  }

  const poll = RoomManager.createPoll(ws.roomId, user, question, options);
  if (!poll) return sendError(ws, 'Could not create poll');

  RoomManager.broadcast(ws.roomId, { type: 'poll_update', poll });
}

/**
 * Sets the requesting user's single-select vote on one option in the
 * poll (RoomManager.votePoll clears any previous choice by that user
 * first; clicking the same option again un-votes it).
 */
function handleVotePoll(ws, user, msg) {
  if (!ws.roomId) return sendError(ws, 'Join a room before voting');

  const { pollId, optionId } = msg;
  if (typeof pollId !== 'string' || typeof optionId !== 'string') {
    return sendError(ws, 'Invalid vote');
  }

  const poll = RoomManager.votePoll(ws.roomId, user.id, pollId, optionId);
  if (!poll) return sendError(ws, 'This poll no longer exists');

  RoomManager.broadcast(ws.roomId, { type: 'poll_update', poll });
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