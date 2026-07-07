
const { conn } = require('../../db_connection');
const pool = conn.promise();

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
  clearAllRooms,
  insertRoom,
  getAllRooms,
  getRoomById,
  updateUserCount,
  deleteRoomById,
};