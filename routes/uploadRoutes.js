/**
 * chat/routes/uploadRoutes.js
 * -----------------------------------------------------------------------
 * PHASE 2 additions. Mount this alongside your existing chatRoutes:
 *
 *   const uploadRoutes = require('./routes/uploadRoutes');
 *   app.use('/api/chat', verifyToken, uploadRoutes);
 *
 * (Reuses your existing verifyToken middleware — same as the rest of
 * /api/chat/*. Nothing here duplicates the old single-shot
 * POST /api/chat/upload route; that stays as-is for small/simple
 * uploads. These new endpoints are an *additional* path the client
 * opts into for pause/resume/cancel-capable uploads.)
 * -----------------------------------------------------------------------
 */

const express = require('express');
const chunkedUploadService = require('../chat/services/chunkedUploadService');
const linkPreviewService = require('../chat/services/linkPreviewService');
const RoomManager = require('../chat/managers/RoomManager');

const router = express.Router();

// Raw binary body for chunk uploads — small limit per chunk, chunking is
// what keeps any single request cheap regardless of total file size.
const rawChunkParser = express.raw({ type: '*/*', limit: '10mb' });

/** POST /api/chat/upload/init  { fileName, fileSize, mimetype, roomId, chunkSize? } */
router.post('/upload/init', express.json(), async (req, res) => {
  try {
    const { fileName, fileSize, mimetype, roomId, chunkSize } = req.body || {};
    if (!roomId || !RoomManager.getRoom(roomId)) {
      return res.status(404).json({ success: false, message: 'Room not found' });
    }
    const result = await chunkedUploadService.initUpload({
      fileName,
      fileSize,
      mimetype,
      chunkSize,
      roomId,
      userId: req.user.id,
    });
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(err.code === 'TOO_LARGE' ? 413 : 400).json({ success: false, message: err.message });
  }
});

/** PUT /api/chat/upload/:uploadId/chunk/:index  (raw body = chunk bytes) */
router.put('/upload/:uploadId/chunk/:index', rawChunkParser, async (req, res) => {
  try {
    const index = parseInt(req.params.index, 10);
    if (!Buffer.isBuffer(req.body) || !req.body.length) {
      return res.status(400).json({ success: false, message: 'Empty chunk body' });
    }
    const status = await chunkedUploadService.writeChunk(req.params.uploadId, index, req.body);
    res.json({ success: true, data: status });
  } catch (err) {
    const status = err.code === 'NOT_FOUND' ? 404 : 400;
    res.status(status).json({ success: false, message: err.message });
  }
});

/** GET /api/chat/upload/:uploadId/status — used to resume after a pause/refresh */
router.get('/upload/:uploadId/status', (req, res) => {
  const status = chunkedUploadService.getStatus(req.params.uploadId);
  if (!status) return res.status(404).json({ success: false, message: 'Unknown upload session' });
  res.json({ success: true, data: status });
});

/** POST /api/chat/upload/:uploadId/complete — assembles chunks, runs the
 *  normal validation/thumbnail/R2 pipeline, returns the attachment
 *  object exactly like the classic single-shot upload endpoint does. */
router.post('/upload/:uploadId/complete', async (req, res) => {
  try {
    const attachment = await chunkedUploadService.completeUpload(req.params.uploadId);
    res.json({ success: true, data: attachment });
  } catch (err) {
    const status = err.code === 'NOT_FOUND' ? 404 : err.code === 'INCOMPLETE' ? 409 : 400;
    res.status(status).json({ success: false, message: err.message });
  }
});

/** DELETE /api/chat/upload/:uploadId — cancel, cleans up temp chunks */
router.delete('/upload/:uploadId', async (req, res) => {
  await chunkedUploadService.abortUpload(req.params.uploadId);
  res.json({ success: true });
});

/** GET /api/chat/link-preview?url=... — used as a fallback for the
 *  client to eagerly preview a link it's about to send (the composer
 *  can show the card before the message is even posted). The
 *  authoritative preview attached to a sent message is still generated
 *  server-side in MessageHandler/RoomManager so late joiners see it too. */
router.get('/link-preview', async (req, res) => {
  const url = (req.query.url || '').toString();
  if (!url) return res.status(400).json({ success: false, message: 'url is required' });
  const preview = await linkPreviewService.getPreviewForText(url);
  res.json({ success: true, data: preview || null });
});

module.exports = router;