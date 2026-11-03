const { db } = require('./db');
const {
  SESSION_COOKIE_NAME,
  SESSION_DURATION_SECONDS,
  generateCode,
  generateToken
} = require('./app/security.js');

const SESSION_DURATION_DAYS = Math.round(SESSION_DURATION_SECONDS / (24 * 60 * 60));

function createSession(userId) {
  const sessionId = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_DURATION_SECONDS * 1000).toISOString();
  db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(sessionId, userId, expiresAt);
  return { sessionId, expiresAt };
}

function deleteSession(sessionId) {
  if (!sessionId) return;
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

module.exports = {
  SESSION_COOKIE_NAME,
  SESSION_DURATION_DAYS,
  generateCode,
  generateToken,
  createSession,
  deleteSession
};
