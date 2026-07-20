/**
 * chunkedUploadService.js
 * -----------------------------------------------------------------------
 * PHASE 2 — Improved Upload Experience
 *
 * The old upload flow was a single multipart POST with no way to pause,
 * resume, or cancel mid-flight (browsers can abort() an XHR, but you
 * lose everything sent so far — restarting means re-uploading from
 * byte 0). This module lets the client break a file into fixed-size
 * chunks and upload them one at a time, so:
 *   - Pause = just stop sending the next chunk. Nothing is lost.
 *   - Resume = ask the server which chunks it already has, continue
 *     from there (survives a page refresh too, since state lives here,
 *     not in browser memory).
 *   - Cancel = tell the server to delete the partial upload.
 *   - Speed / ETA = the client already knows bytes-sent-per-chunk and
 *     can compute this purely client-side; this module doesn't need to
 *     know about it.
 *
 * Chunks are buffered to a per-upload temp directory on local disk
 * (survives across requests, unlike an in-memory Buffer[], and doesn't
 * hold megabytes of every in-progress upload in server RAM). Once every
 * expected chunk has arrived, complete() concatenates them, hands the
 * result to the existing uploadService.uploadOne() pipeline (same
 * validation, thumbnailing, R2 upload as the non-chunked path), then
 * deletes the temp directory.
 *
 * Stale uploads (abandoned mid-flight — tab closed, network died for
 * good) are swept on an interval so temp disk usage doesn't grow
 * unbounded.
 * -----------------------------------------------------------------------
 */

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { uploadOne } = require('./uploadService');

const TMP_ROOT = path.join(os.tmpdir(), 'chat-chunked-uploads');
const MAX_UPLOAD_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours — abandoned uploads get swept
const MAX_TOTAL_SIZE = 200 * 1024 * 1024; // matches uploadService's largest per-kind limit (video)
const MAX_CHUNK_SIZE = 8 * 1024 * 1024; // 8MB per chunk — generous ceiling, client typically sends ~1MB

/** uploadId -> { dir, meta, receivedChunks: Set<number>, createdAt, roomId, userId } */
const sessions = new Map();

fsp.mkdir(TMP_ROOT, { recursive: true }).catch(() => {});

function newUploadId() {
  return crypto.randomUUID();
}

function chunkPath(dir, index) {
  return path.join(dir, `chunk_${String(index).padStart(6, '0')}`);
}

/** Starts a new resumable upload session. Returns the uploadId the client
 *  will attach chunks to, plus how many chunks the server expects (so
 *  the client and server agree on chunking even after a resume). */
async function initUpload({ fileName, fileSize, mimetype, chunkSize, roomId, userId }) {
  if (!fileName || !Number.isFinite(fileSize) || fileSize <= 0) {
    const err = new Error('Invalid file metadata');
    err.code = 'BAD_REQUEST';
    throw err;
  }
  if (fileSize > MAX_TOTAL_SIZE) {
    const err = new Error(`File exceeds the ${(MAX_TOTAL_SIZE / (1024 * 1024)).toFixed(0)}MB limit`);
    err.code = 'TOO_LARGE';
    throw err;
  }
  const size = Math.min(Math.max(parseInt(chunkSize, 10) || 1024 * 1024, 64 * 1024), MAX_CHUNK_SIZE);
  const totalChunks = Math.ceil(fileSize / size);

  const uploadId = newUploadId();
  const dir = path.join(TMP_ROOT, uploadId);
  await fsp.mkdir(dir, { recursive: true });

  sessions.set(uploadId, {
    dir,
    fileName,
    fileSize,
    mimetype,
    chunkSize: size,
    totalChunks,
    receivedChunks: new Set(),
    createdAt: Date.now(),
    roomId,
    userId,
  });

  return { uploadId, chunkSize: size, totalChunks };
}

/** Writes one chunk to disk. Idempotent — re-sending an already-received
 *  chunk index (e.g. after a flaky network retry) just overwrites it. */
async function writeChunk(uploadId, index, buffer) {
  const session = sessions.get(uploadId);
  if (!session) {
    const err = new Error('Unknown or expired upload session');
    err.code = 'NOT_FOUND';
    throw err;
  }
  if (index < 0 || index >= session.totalChunks) {
    const err = new Error('Chunk index out of range');
    err.code = 'BAD_REQUEST';
    throw err;
  }
  await fsp.writeFile(chunkPath(session.dir, index), buffer);
  session.receivedChunks.add(index);
  return { received: session.receivedChunks.size, totalChunks: session.totalChunks };
}

/** Tells the client which chunk indices the server already has, so a
 *  resumed upload (new page load, or "resume" after a pause) only sends
 *  what's missing instead of starting over. */
function getStatus(uploadId) {
  const session = sessions.get(uploadId);
  if (!session) return null;
  return {
    uploadId,
    receivedChunks: Array.from(session.receivedChunks).sort((a, b) => a - b),
    totalChunks: session.totalChunks,
    chunkSize: session.chunkSize,
    fileSize: session.fileSize,
  };
}

/** Concatenates every chunk (must all be present) into one buffer, runs
 *  it through the same validation/thumbnailing/R2-upload path as a
 *  normal upload, then cleans up the temp directory. */
async function completeUpload(uploadId) {
  const session = sessions.get(uploadId);
  if (!session) {
    const err = new Error('Unknown or expired upload session');
    err.code = 'NOT_FOUND';
    throw err;
  }
  if (session.receivedChunks.size !== session.totalChunks) {
    const err = new Error(
      `Upload incomplete: received ${session.receivedChunks.size} of ${session.totalChunks} chunks`
    );
    err.code = 'INCOMPLETE';
    throw err;
  }

  const buffers = [];
  for (let i = 0; i < session.totalChunks; i++) {
    buffers.push(await fsp.readFile(chunkPath(session.dir, i)));
  }
  const fullBuffer = Buffer.concat(buffers);

  let result;
  try {
    result = await uploadOne({
      buffer: fullBuffer,
      mimetype: session.mimetype,
      originalName: session.fileName,
      roomId: session.roomId,
    });
  } finally {
    await cleanupSession(uploadId);
  }
  return result;
}

async function abortUpload(uploadId) {
  await cleanupSession(uploadId);
  return { ok: true };
}

async function cleanupSession(uploadId) {
  const session = sessions.get(uploadId);
  if (!session) return;
  sessions.delete(uploadId);
  await fsp.rm(session.dir, { recursive: true, force: true }).catch(() => {});
}

/** Periodic sweep of abandoned sessions (tab closed mid-upload, etc). */
function sweepStale() {
  const now = Date.now();
  for (const [uploadId, session] of sessions.entries()) {
    if (now - session.createdAt > MAX_UPLOAD_AGE_MS) {
      cleanupSession(uploadId).catch(() => {});
    }
  }
}
setInterval(sweepStale, 15 * 60 * 1000).unref();

module.exports = { initUpload, writeChunk, getStatus, completeUpload, abortUpload };