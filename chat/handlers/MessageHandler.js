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
 *
 * ── PHASE 1 ──────────────────────────────────────────────────────────
 * `message` no longer just broadcasts-and-forgets: it's stored via
 * RoomManager.postMessage, broadcast to everyone else, and the sender
 * gets a `message_ack` back (not a `message` echo) carrying the
 * server-canonical message (real id, timestamp) plus a best-effort
 * delivery status. This is what lets the client show
 * sending -> sent/delivered -> read without re-rendering anything —
 * it just reconciles its optimistic bubble against the ack.
 *
 * New message types: `edit_message`, `delete_message`, `react_message`,
 * `mark_read`, `pin_message`, `unpin_message`, `request_history`. Each
 * mirrors the corresponding RoomManager method and broadcasts the
 * resulting state (never the raw client input) so every client — not
 * just the sender — converges on the same view.
 *
 * ── PHASE 2 ──────────────────────────────────────────────────────────
 * Link previews: after a text message is stored and acked, we kick off
 * an async, fire-and-forget lookup (linkPreviewService) for the first
 * URL in the message text. This never blocks or delays sending — the
 * message is already rendered by the time the preview (if any) resolves
 * a moment later. Once it does, RoomManager.setLinkPreview attaches it
 * to the stored message and we broadcast `link_preview_update` so every
 * client — including the sender — renders the card in place.
 * -----------------------------------------------------------------------
 */

const RoomManager = require('../managers/RoomManager');
const linkPreviewService = require('../services/linkPreviewService');

const MAX_MESSAGE_LENGTH = 2000;
const MAX_ATTACHMENTS = 10;
const MAX_POLL_QUESTION_LENGTH = 200;
const MAX_POLL_OPTION_LENGTH = 80;
const MAX_POLL_OPTIONS = 10;
const MAX_REACTION_LENGTH = 8; // enough for any single emoji, incl. multi-codepoint ones

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
    case 'edit_message':
      return handleEditMessage(ws, user, msg);
    case 'delete_message':
      return handleDeleteMessage(ws, user, msg);
    case 'react_message':
      return handleReactMessage(ws, user, msg);
    case 'mark_read':
      return handleMarkRead(ws, user, msg);
    case 'pin_message':
      return handlePinMessage(ws, user, msg);
    case 'unpin_message':
      return handleUnpinMessage(ws, user);
    case 'request_history':
      return handleRequestHistory(ws, user, msg);
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

  // Most recent page of history, oldest -> newest, plus whether older
  // messages exist (drives the client's initial infinite-scroll state).
  const history = RoomManager.getHistory(roomId, null, 30);

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
    // Most recent messages + pagination flag for infinite scroll.
    // Each message already carries its resolved linkPreview (if any),
    // since that's stored on the message itself (see RoomManager).
    messages: history.messages,
    hasMoreHistory: history.hasMore,
    // Currently pinned message (if any), so the banner can render immediately.
    pinned: RoomManager.getPinnedMessage(roomId),
  });

  send(ws, { type: 'system', text: `Welcome to "${room.roomName}", ${user.username}! 👋` });

  RoomManager.broadcast(roomId, { type: 'system', text: `${user.username} has joined the room` }, ws);
  RoomManager.broadcast(roomId, { type: 'user_list', users: RoomManager.getMemberList(roomId) });
}

/**
 * Trust nothing from the client beyond shape — the real validation
 * (size/mimetype/R2 upload/thumbnailing) already happened server-side
 * in the /api/chat/upload REST endpoint (or the Phase 2 chunked-upload
 * endpoints) before the client ever sent this WebSocket message. Here
 * we just make sure the shape wasn't tampered with.
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

/**
 * Stores the message, broadcasts it to everyone else in the room, and
 * acks the sender directly with the canonical (server-assigned) message
 * plus a best-effort delivery status:
 *   - 'delivered' if the broadcast actually reached at least one other
 *     open socket in the room right now
 *   - 'sent' otherwise (message stored, but nobody else was there to
 *     receive it live — they'll get it via history on next join)
 * This is deliberately not a true per-recipient delivery receipt (that
 * would need an ack-per-socket round trip); it's the same approximation
 * most chat apps make for "delivered" vs. true read receipts, which are
 * tracked precisely via `mark_read` below.
 *
 * PHASE 2: once the ack goes out, kicks off an async link-preview
 * resolution for the message text (see resolveLinkPreview below). This
 * never blocks the send path.
 */
function handleMessage(ws, user, msg) {
  if (!ws.roomId) return sendError(ws, 'Join a room before sending messages');

  const text = (msg.text || '').toString().trim();
  const attachments = sanitizeAttachments(msg.attachments);
  const replyToId = typeof msg.replyToId === 'string' ? msg.replyToId : null;
  const clientId = typeof msg.clientId === 'string' ? msg.clientId.slice(0, 100) : null;

  if (!text && !attachments.length) return sendError(ws, 'Message cannot be empty');
  if (text.length > MAX_MESSAGE_LENGTH) {
    return sendError(ws, `Messages must be under ${MAX_MESSAGE_LENGTH} characters`);
  }

  const message = RoomManager.postMessage(ws.roomId, user, { text, attachments, replyToId, clientId });
  if (!message) return sendError(ws, 'Could not send message');

  const deliveredCount = RoomManager.broadcast(ws.roomId, { type: 'message', message }, ws);

  send(ws, {
    type: 'message_ack',
    clientId,
    message,
    status: deliveredCount > 0 ? 'delivered' : 'sent',
  });

  // Fire-and-forget: fetching a page's OG tags is a real network round
  // trip (up to a few seconds), so we don't make the sender wait on it
  // — the message already rendered. Once it resolves (or comes back
  // null, meaning "nothing worth showing"), broadcast the update so
  // every client — including the sender — attaches the card in place.
  if (text) {
    resolveLinkPreview(ws.roomId, message.id, text);
  }
}

/** PHASE 2: resolves and attaches a link preview for a just-sent message,
 *  entirely decoupled from the main send path — a slow or failing fetch
 *  here can never delay or break sending a message. */
function resolveLinkPreview(roomId, messageId, text) {
  linkPreviewService
    .getPreviewForText(text)
    .then((preview) => {
      if (!preview) return; // no URL found, or nothing worth showing
      const updated = RoomManager.setLinkPreview(roomId, messageId, preview);
      if (!updated) return; // message was deleted before the fetch finished
      RoomManager.broadcast(roomId, { type: 'link_preview_update', messageId, linkPreview: preview });
    })
    .catch((err) => {
      console.error('[chat] link preview fetch failed:', err.message);
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

/** Author-only, text-only edit. Broadcasts the updated message to the
 *  whole room (including the editor, for consistency). Note: editing
 *  text does NOT re-resolve the link preview — matching WhatsApp/Telegram
 *  behavior, the preview stays pinned to whatever was true when first sent. */
function handleEditMessage(ws, user, msg) {
  if (!ws.roomId) return sendError(ws, 'Join a room before editing messages');

  const messageId = typeof msg.messageId === 'string' ? msg.messageId : null;
  const text = (msg.text || '').toString().trim();
  if (!messageId) return sendError(ws, 'Invalid message');
  if (!text) return sendError(ws, 'Message cannot be empty');
  if (text.length > MAX_MESSAGE_LENGTH) {
    return sendError(ws, `Messages must be under ${MAX_MESSAGE_LENGTH} characters`);
  }

  const message = RoomManager.editMessage(ws.roomId, user.id, messageId, text);
  if (!message) return sendError(ws, 'You can only edit your own messages');

  RoomManager.broadcast(ws.roomId, { type: 'message_edited', message });
}

/** scope 'everyone' is broadcast to the whole room (tombstones the
 *  message for everyone, including future joiners). scope 'me' is
 *  purely local to the requester — the client hides it and remembers
 *  that locally, so we just echo confirmation back to that one socket. */
function handleDeleteMessage(ws, user, msg) {
  if (!ws.roomId) return sendError(ws, 'Join a room before deleting messages');

  const messageId = typeof msg.messageId === 'string' ? msg.messageId : null;
  const scope = msg.scope === 'everyone' ? 'everyone' : 'me';
  if (!messageId) return sendError(ws, 'Invalid message');

  const room = RoomManager.getRoom(ws.roomId);
  const isOwner = !!room && room.ownerId === user.id;
  const result = RoomManager.deleteMessage(ws.roomId, user.id, messageId, scope, isOwner);
  if (!result.ok) return sendError(ws, result.reason);

  if (scope === 'everyone') {
    RoomManager.broadcast(ws.roomId, { type: 'message_deleted', messageId, scope: 'everyone' });
  } else {
    send(ws, { type: 'message_deleted', messageId, scope: 'me' });
  }
}

/** Toggle reaction; broadcasts the message's full reaction map so every
 *  client stays in sync rather than trying to diff one emoji at a time. */
function handleReactMessage(ws, user, msg) {
  if (!ws.roomId) return sendError(ws, 'Join a room before reacting');

  const messageId = typeof msg.messageId === 'string' ? msg.messageId : null;
  const emoji = typeof msg.emoji === 'string' ? msg.emoji.slice(0, MAX_REACTION_LENGTH) : null;
  if (!messageId || !emoji) return sendError(ws, 'Invalid reaction');

  const message = RoomManager.toggleReaction(ws.roomId, user.id, messageId, emoji);
  if (!message) return sendError(ws, 'Could not react to this message');

  RoomManager.broadcast(ws.roomId, { type: 'reaction_update', messageId, reactions: message.reactions });
}

/** No-op (and no broadcast) if the user had already read this message —
 *  read receipts only ever move forward. */
function handleMarkRead(ws, user, msg) {
  if (!ws.roomId) return;
  const messageId = typeof msg.messageId === 'string' ? msg.messageId : null;
  if (!messageId) return;

  const message = RoomManager.markRead(ws.roomId, user.id, messageId);
  if (!message) return;

  RoomManager.broadcast(ws.roomId, { type: 'read_update', messageId, readBy: message.readBy });
}

function handlePinMessage(ws, user, msg) {
  if (!ws.roomId) return sendError(ws, 'Join a room before pinning messages');
  const messageId = typeof msg.messageId === 'string' ? msg.messageId : null;
  if (!messageId) return sendError(ws, 'Invalid message');

  const result = RoomManager.pinMessage(ws.roomId, user.id, messageId);
  if (!result.ok) return sendError(ws, result.reason);

  RoomManager.broadcast(ws.roomId, { type: 'pin_update', message: result.message });
}

function handleUnpinMessage(ws, user) {
  if (!ws.roomId) return sendError(ws, 'Join a room before unpinning messages');

  const result = RoomManager.unpinMessage(ws.roomId, user.id);
  if (!result.ok) return sendError(ws, result.reason);

  RoomManager.broadcast(ws.roomId, { type: 'pin_update', message: null });
}

/** Powers infinite scroll: the client sends the id of the oldest message
 *  it currently has loaded, and gets the next page further back in time. */
function handleRequestHistory(ws, user, msg) {
  if (!ws.roomId) return sendError(ws, 'Join a room before loading history');

  const beforeId = typeof msg.beforeId === 'string' ? msg.beforeId : null;
  const { messages, hasMore } = RoomManager.getHistory(ws.roomId, beforeId, msg.limit);

  send(ws, { type: 'history', messages, hasMore, beforeId });
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