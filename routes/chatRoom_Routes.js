const express = require('express');
const path = require('path');
const multer = require('multer');
const router = express.Router();

const verifyToken = require('../middle/middleware');
const RoomManager = require('../chat/managers/RoomManager');
const { uploadAttachments } = require('../chat/services/uploadService');

const ROOM_NAME_MAX = 30;
const ROOM_DESC_MAX = 100;

/* ────────────────────────────────────────────────────────────
   PAGES
   ──────────────────────────────────────────────────────────── */
router.get('/chat', verifyToken, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'Frontend', '/ChatRoom_UI/chat-lobby.html'));
});

router.get('/chat/create', verifyToken, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'Frontend', '/ChatRoom_UI/chat-create.html'));
});

router.get('/chat/room/:roomId', verifyToken, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'Frontend', '/ChatRoom_UI/chat-room.html'));
});

/* ────────────────────────────────────────────────────────────
   API
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
    if (roomName.trim().length > ROOM_NAME_MAX) {
      return res.status(400).json({ success: false, message: `Room name must be ${ROOM_NAME_MAX} characters or fewer` });
    }
    if (description && description.toString().trim().length > ROOM_DESC_MAX) {
      return res.status(400).json({ success: false, message: `Description must be ${ROOM_DESC_MAX} characters or fewer` });
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
      description: (description || '').toString().trim().slice(0, ROOM_DESC_MAX),
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

/* ────────────────────────────────────────────────────────────
   ATTACHMENTS (images / videos / documents)
   Accepts MULTIPLE files per message (WhatsApp-style album
   sends). Memory storage only — never touches disk — then each
   file is validated + pushed to R2 by uploadService, which also
   produces a display version, a bubble thumbnail, and an inline
   blurred LQIP placeholder for instant, non-janky rendering.

   Hard ceiling raised to 200MB to accommodate the new video
   limit; uploadService still enforces the precise per-type caps
   (images 5MB, video 200MB, documents 50MB).
   ──────────────────────────────────────────────────────────── */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024, files: 10 }, // hard ceiling; per-type limits enforced in uploadService
});

function uploadMiddleware(req, res, next) {
  upload.array('files', 10)(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ success: false, message: 'A file exceeds the maximum allowed size' });
      }
      if (err.code === 'LIMIT_FILE_COUNT') {
        return res.status(400).json({ success: false, message: 'You can attach up to 10 files at once' });
      }
      return res.status(400).json({ success: false, message: 'Upload failed' });
    }
    next();
  });
}

router.post('/api/chat/upload', verifyToken, uploadMiddleware, async (req, res) => {
  try {
    if (!req.files || !req.files.length) {
      return res.status(400).json({ success: false, message: 'No file provided' });
    }

    const roomId = req.body.roomId;
    if (!roomId) return res.status(400).json({ success: false, message: 'roomId is required' });

    const room = RoomManager.getRoom(roomId);
    if (!room) return res.status(404).json({ success: false, message: 'Room not found' });

    const isMember = Array.from(room.members.values()).some((m) => m.userId === req.user.id);
    if (!isMember) return res.status(403).json({ success: false, message: 'You are not in this room' });

    const attachments = await uploadAttachments(req.files, { roomId });

    res.json({ success: true, data: attachments });
  } catch (e) {
    if (e.code === 'UNSUPPORTED_TYPE' || e.code === 'TOO_LARGE') {
      return res.status(400).json({ success: false, message: e.message });
    }
    console.error('[chat] upload error:', e);
    res.status(500).json({ success: false, message: 'Upload failed' });
  }
});

module.exports = router;