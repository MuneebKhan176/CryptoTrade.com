/**
 * chatAuth.js
 * -----------------------------------------------------------------------
 * Auth check used only for the raw WebSocket upgrade, which never passes
 * through Express middleware. Your normal HTTP chat routes reuse your
 * existing `verifyToken` middleware directly (see chatRoutes.js) — this
 * file exists purely to re-implement that same check for the one place
 * Express middleware can't reach.
 *
 * Confirmed against your authRoutes.js:
 *   - cookie name: 'token'            (setAuthCookie)
 *   - JWT payload shape: { id, email, username }
 *   - jwtSecret is exported from db_connection.js
 * -----------------------------------------------------------------------
 */

const jwt = require('jsonwebtoken');
const { jwtSecret } = require('../db_connection');

const COOKIE_NAME = 'token';

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const val = decodeURIComponent(pair.slice(idx + 1).trim());
    out[key] = val;
  });
  return out;
}

/** Used during the raw WebSocket upgrade (before any Express middleware runs). */
function authenticateUpgrade(request) {
  const cookies = parseCookies(request.headers.cookie);
  const token = cookies[COOKIE_NAME];
  if (!token) return null;

  try {
    const payload = jwt.verify(token, jwtSecret);
    if (payload.id == null || !payload.username) return null;
    return { id: payload.id, username: payload.username };
  } catch (e) {
    return null;
  }
}

module.exports = { authenticateUpgrade };