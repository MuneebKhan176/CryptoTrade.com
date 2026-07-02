/**
 * chatDb.js
 * -----------------------------------------------------------------------
 * MySQL persistence for chat rooms. RoomManager is the actual runtime
 * authority (in-memory Map of live rooms + connected sockets); this file
 * just keeps the `chat_rooms` table mirroring that state so it survives
 * for inspection/reporting even though live membership only ever lives
 * in server memory.
 *
 * Your db_connection.js exports `{ conn, jwtSecret }`, where `conn` is a
 * plain callback-style mysql2 Connection. mysql2 connections expose a
 * `.promise()` wrapper that gives the same connection async/await query
 * methods without changing anything in db_connection.js itself.
 * -----------------------------------------------------------------------
 */

const { conn } = require('../../db_connection');
const pool = conn.promise();

async function initChatTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_rooms (
      room_id VARCHAR(36) PRIMARY KEY,
      room_name VARCHAR(100) NOT NULL,
      description VARCHAR(255) DEFAULT NULL,
      owner_id INT NOT NULL,
      owner_username VARCHAR(100) NOT NULL,
      visibility ENUM('public','private') NOT NULL DEFAULT 'public',
      password_hash VARCHAR(255) DEFAULT NULL,
      max_users INT NOT NULL DEFAULT 100,
      current_users INT NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_visibility (visibility),
      INDEX idx_owner (owner_id)
    )
  `);
}

/**
 * Live rooms only ever exist in server memory (they need an active
 * process holding the sockets), so on every boot we start the table
 * clean rather than showing stale rooms nobody is actually connected to.
 */
async function clearAllRooms() {
  await pool.query('DELETE FROM chat_rooms');
}

async function insertRoom(room) {
  await pool.query(
    `INSERT INTO chat_rooms
     (room_id, room_name, description, owner_id, owner_username, visibility, password_hash, max_users, current_users, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NOW())`,
    [
      room.room_id,
      room.room_name,
      room.description || null,
      room.owner_id,
      room.owner_username,
      room.visibility,
      room.password_hash || null,
      room.max_users,
    ]
  );
}

async function getAllRooms() {
  const [rows] = await pool.query('SELECT * FROM chat_rooms');
  return rows;
}

async function getRoomById(roomId) {
  const [rows] = await pool.query('SELECT * FROM chat_rooms WHERE room_id = ?', [roomId]);
  return rows[0] || null;
}

async function updateUserCount(roomId, count) {
  await pool.query('UPDATE chat_rooms SET current_users = ? WHERE room_id = ?', [count, roomId]);
}

async function deleteRoomById(roomId) {
  await pool.query('DELETE FROM chat_rooms WHERE room_id = ?', [roomId]);
}

module.exports = {
  initChatTable,
  clearAllRooms,
  insertRoom,
  getAllRooms,
  getRoomById,
  updateUserCount,
  deleteRoomById,
};