const express = require('express');
const path = require('path');
const router = express.Router();

const verifyToken = require('../middle/middleware');
const RoomManager = require('../chat/managers/RoomManager');

/* ────────────────────────────────────────────────────────────
   PAGES
   Your HTML files live in Frontend/, matching how /dashboard,
   /login, /register, etc. are served in authRoutes.js — these
   three new pages sit alongside them there.
   ──────────────────────────────────────────────────────────── */
router.get('/chat', verifyToken, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'Frontend', 'chat-lobby.html'));
});

router.get('/chat/create', verifyToken, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'Frontend', 'chat-create.html'));
});

router.get('/chat/room/:roomId', verifyToken, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'Frontend', 'chat-room.html'));
});

/* ────────────────────────────────────────────────────────────
   API
   All protected by your existing verifyToken middleware, so
   req.user is the same decoded JWT payload ({ id, email, username })
   used everywhere else in authRoutes.js.
   ──────────────────────────────────────────────────────────── */

router.get('/api/chat/me', verifyToken, (req, res) => {
  res.json({ success: true, data: { id: req.user.id, username: req.user.username } });
});

router.get('/api/chat/rooms', verifyToken, (req, res) => {
  try {
    res.json({ success: true, data: RoomManager.getRoomListing() });
  } catch (e) {
    console.error('[chat] list rooms error:', e);
    res.status(500).json({ success: false, message: 'Failed to load rooms' });
  }
});

router.post('/api/chat/rooms', verifyToken, async (req, res) => {
  try {
    const { roomName, description, visibility, password, maxUsers } = req.body || {};

    if (!roomName || typeof roomName !== 'string' || !roomName.trim()) {
      return res.status(400).json({ success: false, message: 'Room name is required' });
    }
    if (roomName.trim().length > 60) {
      return res.status(400).json({ success: false, message: 'Room name must be 60 characters or fewer' });
    }
    if (!['public', 'private'].includes(visibility)) {
      return res.status(400).json({ success: false, message: 'Visibility must be public or private' });
    }
    if (visibility === 'private' && (!password || String(password).length < 4)) {
      return res.status(400).json({ success: false, message: 'Private rooms require a password of at least 4 characters' });
    }

    const room = await RoomManager.createRoom({
      ownerId: req.user.id,
      ownerUsername: req.user.username,
      roomName: roomName.trim(),
      description: (description || '').toString().trim().slice(0, 200),
      visibility,
      password,
      maxUsers,
    });

    res.json({ success: true, data: room });
  } catch (e) {
    if (e.code === 'DUPLICATE_NAME') {
      return res.status(409).json({ success: false, message: 'A room with that name already exists' });
    }
    console.error('[chat] create room error:', e);
    res.status(500).json({ success: false, message: 'Failed to create room' });
  }
});

// Pre-check used by the lobby before opening a WebSocket (lets us show
// "wrong password" inline instead of failing after the socket connects).
router.post('/api/chat/rooms/:roomId/join', verifyToken, (req, res) => {
  try {
    const result = RoomManager.validateJoin(req.params.roomId, req.body?.password, req.user.id);
    if (!result.ok) {
      return res.status(result.status || 400).json({ success: false, message: result.reason });
    }
    res.json({ success: true });
  } catch (e) {
    console.error('[chat] join validation error:', e);
    res.status(500).json({ success: false, message: 'Failed to validate room access' });
  }
});

router.delete('/api/chat/rooms/:roomId', verifyToken, async (req, res) => {
  try {
    const result = await RoomManager.deleteRoom(req.params.roomId, req.user.id);
    if (!result.ok) {
      return res.status(result.status || 400).json({ success: false, message: result.reason });
    }
    res.json({ success: true });
  } catch (e) {
    console.error('[chat] delete room error:', e);
    res.status(500).json({ success: false, message: 'Failed to delete room' });
  }
});

module.exports = router;