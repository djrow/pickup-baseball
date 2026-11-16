const crypto = require('node:crypto');
const { db } = require('./db');
const {
  SESSION_COOKIE_NAME,
  SESSION_HASH_PREFIX,
  SESSION_DURATION_SECONDS,
  generateCode,
  generateToken
} = require('./app/security.js');

const SESSION_DURATION_DAYS = Math.round(SESSION_DURATION_SECONDS / (24 * 60 * 60));

function hashSessionIdSync(rawId) {
  return `${SESSION_HASH_PREFIX}${crypto.createHash('sha256').update(String(rawId)).digest('hex')}`;
}

function createSession(userId) {
  const sessionId = generateToken();
  const storedSessionId = hashSessionIdSync(sessionId);
  const expiresAt = new Date(Date.now() + SESSION_DURATION_SECONDS * 1000).toISOString();
  db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(storedSessionId, userId, expiresAt);
  return { sessionId, expiresAt };
}

function deleteSession(sessionId) {
  if (!sessionId) return;
  const hashedId = hashSessionIdSync(sessionId);
  db.prepare("DELETE FROM sessions WHERE id = ? OR (id = ? AND id NOT LIKE 'sha256:%')").run(hashedId, sessionId);
}

module.exports = {
  SESSION_COOKIE_NAME,
  SESSION_DURATION_DAYS,
  generateCode,
  generateToken,
  createSession,
  deleteSession
};
