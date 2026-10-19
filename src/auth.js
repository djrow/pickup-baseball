const crypto = require('crypto');
const { db } = require('./db');

const SESSION_COOKIE_NAME = 'baseball_session';
const SESSION_DURATION_DAYS = 90;

/**
 * Generate a random 6-digit numeric string
 */
function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

/**
 * Generate a secure URL-safe token
 */
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Create a session for a user and return the session ID
 */
function createSession(userId) {
  const sessionId = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_DURATION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  
  db.prepare(`
    INSERT INTO sessions (id, user_id, expires_at)
    VALUES (?, ?, ?)
  `).run(sessionId, userId, expiresAt);

  return { sessionId, expiresAt };
}

/**
 * Delete a session
 */
function deleteSession(sessionId) {
  if (!sessionId) return;
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

/**
 * Middleware: Optional user auth (populates req.user if valid session cookie present)
 */
function optionalUser(req, res, next) {
  const sessionId = req.cookies[SESSION_COOKIE_NAME];
  if (!sessionId) {
    req.user = null;
    return next();
  }

  const session = db.prepare(`
    SELECT s.id as session_id, s.expires_at, u.id, u.name, u.email, u.is_admin
    FROM sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.id = ? AND s.expires_at > CURRENT_TIMESTAMP
  `).get(sessionId);

  if (session) {
    req.user = {
      id: session.id,
      name: session.name,
      email: session.email,
      isAdmin: Boolean(session.is_admin)
    };
  } else {
    req.user = null;
  }

  next();
}

/**
 * Middleware: Require authenticated user
 */
function requireUser(req, res, next) {
  optionalUser(req, res, () => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required. Please sign in.' });
    }
    next();
  });
}

/**
 * Middleware: Require admin user
 */
function requireAdmin(req, res, next) {
  requireUser(req, res, () => {
    if (!req.user.isAdmin) {
      return res.status(403).json({ error: 'Access denied: Admin privileges required.' });
    }
    next();
  });
}

module.exports = {
  SESSION_COOKIE_NAME,
  SESSION_DURATION_DAYS,
  generateCode,
  generateToken,
  createSession,
  deleteSession,
  optionalUser,
  requireUser,
  requireAdmin
};
