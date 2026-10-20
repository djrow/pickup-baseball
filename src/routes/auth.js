const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { db } = require('../db');
const {
  SESSION_COOKIE_NAME,
  SESSION_DURATION_DAYS,
  generateCode,
  generateToken,
  createSession,
  deleteSession,
  optionalUser,
  requireUser,
  requireAdmin
} = require('../auth');
const { sendAuthCode } = require('../mailer');

// Set up avatar upload destination in persistent data directory
const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const avatarsDir = path.join(dataDir, 'avatars');
if (!fs.existsSync(avatarsDir)) {
  fs.mkdirSync(avatarsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, avatarsDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    const safeExt = ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext) ? ext : '.jpg';
    cb(null, `avatar-${req.user.id}-${Date.now()}${safeExt}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB max
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/jpg'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only JPEG, PNG, WebP, and GIF images are allowed.'));
    }
  }
});

/**
 * Request a 6-digit login code and magic link
 * Body: { email, name }
 */
router.post('/send-code', async (req, res) => {
  try {
    let { email, name } = req.body;
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'A valid email address is required.' });
    }

    email = email.trim().toLowerCase();
    name = (name || '').trim();

    // Look up if user already exists
    const existingUser = db.prepare('SELECT id, name FROM users WHERE email = ?').get(email);
    if (existingUser && !name) {
      name = existingUser.name;
    }

    const code = generateCode();
    const token = generateToken();
    const expiresAt = new Date(Date.now() + 20 * 60 * 1000).toISOString(); // 20 mins

    db.prepare(`
      INSERT INTO auth_codes (email, name, code, token, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(email, name, code, token, expiresAt);

    // Send email (or console log if dev)
    await sendAuthCode({
      email,
      name: name || 'Player',
      code,
      token
    });

    res.json({
      success: true,
      message: `A 6-digit code has been sent to ${email}. Please check your inbox.`
    });
  } catch (err) {
    console.error('[Auth] Error sending auth code:', err);
    res.status(500).json({ error: 'Failed to dispatch verification code.' });
  }
});

/**
 * Verify 6-digit code
 * Body: { email, code }
 */
router.post('/verify-code', (req, res) => {
  try {
    let { email, code } = req.body;
    if (!email || !code) {
      return res.status(400).json({ error: 'Email and 6-digit code are required.' });
    }

    email = email.trim().toLowerCase();
    code = code.trim();

    const authRecord = db.prepare(`
      SELECT * FROM auth_codes
      WHERE email = ? AND code = ? AND used_at IS NULL AND expires_at > CURRENT_TIMESTAMP
      ORDER BY id DESC LIMIT 1
    `).get(email, code);

    if (!authRecord) {
      return res.status(400).json({ error: 'Invalid or expired code. Please request a new one.' });
    }

    // Mark code as used
    db.prepare('UPDATE auth_codes SET used_at = CURRENT_TIMESTAMP WHERE id = ?').run(authRecord.id);

    // Upsert user
    let user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user) {
      const displayName = authRecord.name || email.split('@')[0];
      const adminCount = db.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'admin' OR is_admin = 1").get().c;
      const shouldBeAdmin = (adminCount === 0 || email === 'pickupbaseballfoundation@gmail.com');
      const role = shouldBeAdmin ? 'admin' : 'player';
      const isAdminFlag = shouldBeAdmin ? 1 : 0;

      const result = db.prepare(`
        INSERT INTO users (name, email, role, is_admin) VALUES (?, ?, ?, ?)
      `).run(displayName, email, role, isAdminFlag);
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
    }

    // Create session
    const { sessionId } = createSession(user.id);

    // Set cookie
    res.cookie(SESSION_COOKIE_NAME, sessionId, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: SESSION_DURATION_DAYS * 24 * 60 * 60 * 1000
    });

    res.json({
      success: true,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        isAdmin: Boolean(user.is_admin)
      }
    });
  } catch (err) {
    console.error('[Auth] Error verifying code:', err);
    res.status(500).json({ error: 'Failed to verify code.' });
  }
});

/**
 * Verify one-click magic link
 * Query: ?token=xyz
 */
router.get('/verify-magic', (req, res) => {
  try {
    const { token, redirect } = req.query;
    if (!token) {
      return res.status(400).send('Invalid or missing magic link token.');
    }

    const authRecord = db.prepare(`
      SELECT * FROM auth_codes
      WHERE token = ? AND used_at IS NULL AND expires_at > CURRENT_TIMESTAMP
    `).get(token);

    if (!authRecord) {
      return res.status(400).send('This sign-in link is invalid or has expired. Please request a new one on the login page.');
    }

    // Mark as used
    db.prepare('UPDATE auth_codes SET used_at = CURRENT_TIMESTAMP WHERE id = ?').run(authRecord.id);

    // Upsert user
    let user = db.prepare('SELECT * FROM users WHERE email = ?').get(authRecord.email);
    if (!user) {
      const displayName = authRecord.name || authRecord.email.split('@')[0];
      const adminCount = db.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'admin' OR is_admin = 1").get().c;
      const shouldBeAdmin = (adminCount === 0 || authRecord.email === 'pickupbaseballfoundation@gmail.com');
      const role = shouldBeAdmin ? 'admin' : 'player';
      const isAdminFlag = shouldBeAdmin ? 1 : 0;

      const result = db.prepare(`
        INSERT INTO users (name, email, role, is_admin) VALUES (?, ?, ?, ?)
      `).run(displayName, authRecord.email, role, isAdminFlag);
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
    }

    const { sessionId } = createSession(user.id);

    res.cookie(SESSION_COOKIE_NAME, sessionId, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: SESSION_DURATION_DAYS * 24 * 60 * 60 * 1000
    });

    res.redirect(redirect || '/index.html?logged_in=1');
  } catch (err) {
    console.error('[Auth] Error handling magic link:', err);
    res.status(500).send('Internal server error verifying magic link.');
  }
});

/**
 * Check current logged in user status
 */
router.get('/me', optionalUser, (req, res) => {
  res.json({ user: req.user });
});

/**
 * Update user profile (Name and Short Bio)
 */
router.put('/profile', requireUser, (req, res) => {
  try {
    const { name, bio } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Name cannot be empty.' });
    }

    db.prepare(`
      UPDATE users
      SET name = ?, bio = ?
      WHERE id = ?
    `).run(name.trim(), (bio || '').trim(), req.user.id);

    req.user.name = name.trim();
    req.user.bio = (bio || '').trim();

    res.json({
      success: true,
      message: 'Profile updated successfully.',
      user: {
        id: req.user.id,
        name: req.user.name,
        email: req.user.email,
        bio: req.user.bio,
        avatarUrl: req.user.avatarUrl,
        isAdmin: req.user.isAdmin
      }
    });
  } catch (err) {
    console.error('[Auth] Error updating profile:', err);
    res.status(500).json({ error: 'Failed to update profile.' });
  }
});

/**
 * Upload profile picture
 */
router.post('/avatar', requireUser, upload.single('avatar'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image file uploaded.' });
    }

    // Delete previous avatar file if exists
    const prevUser = db.prepare('SELECT avatar_url FROM users WHERE id = ?').get(req.user.id);
    if (prevUser && prevUser.avatar_url && prevUser.avatar_url.startsWith('/uploads/avatars/')) {
      const prevFile = path.join(avatarsDir, path.basename(prevUser.avatar_url));
      if (fs.existsSync(prevFile)) {
        try { fs.unlinkSync(prevFile); } catch (e) {}
      }
    }

    const avatarUrl = `/uploads/avatars/${req.file.filename}`;
    db.prepare('UPDATE users SET avatar_url = ? WHERE id = ?').run(avatarUrl, req.user.id);
    req.user.avatarUrl = avatarUrl;

    res.json({
      success: true,
      avatarUrl,
      message: 'Profile picture updated successfully!'
    });
  } catch (err) {
    console.error('[Auth] Error uploading avatar:', err);
    res.status(500).json({ error: 'Failed to upload profile picture.' });
  }
});

/**
 * Remove profile picture
 */
router.delete('/avatar', requireUser, (req, res) => {
  try {
    const prevUser = db.prepare('SELECT avatar_url FROM users WHERE id = ?').get(req.user.id);
    if (prevUser && prevUser.avatar_url && prevUser.avatar_url.startsWith('/uploads/avatars/')) {
      const prevFile = path.join(avatarsDir, path.basename(prevUser.avatar_url));
      if (fs.existsSync(prevFile)) {
        try { fs.unlinkSync(prevFile); } catch (e) {}
      }
    }

    db.prepare('UPDATE users SET avatar_url = NULL WHERE id = ?').run(req.user.id);
    req.user.avatarUrl = null;

    res.json({ success: true, message: 'Profile picture removed.' });
  } catch (err) {
    console.error('[Auth] Error removing avatar:', err);
    res.status(500).json({ error: 'Failed to remove profile picture.' });
  }
});

/**
 * List all users with their roles (Admin only)
 */
router.get('/users', requireAdmin, (req, res) => {
  try {
    const users = db.prepare(`
      SELECT 
        u.id, 
        u.name, 
        u.email, 
        u.bio, 
        u.avatar_url as avatarUrl, 
        COALESCE(u.role, CASE WHEN u.is_admin = 1 THEN 'admin' ELSE 'player' END) as role,
        u.is_admin as isAdmin,
        u.created_at as createdAt,
        (SELECT COUNT(*) FROM attendees WHERE user_id = u.id AND status = 'attending') as eventsAttended
      FROM users u
      ORDER BY 
        CASE WHEN u.role = 'admin' OR u.is_admin = 1 THEN 1 
             WHEN u.role = 'organizer' THEN 2 
             ELSE 3 END,
        u.name COLLATE NOCASE ASC
    `).all();

    res.json({ users });
  } catch (err) {
    console.error('[Auth] Error fetching users list:', err);
    res.status(500).json({ error: 'Failed to fetch users list.' });
  }
});

/**
 * Update a user's role (Admin only)
 * Body: { role: 'admin' | 'organizer' | 'player' }
 */
router.put('/users/:id/role', requireAdmin, (req, res) => {
  try {
    const targetId = parseInt(req.params.id, 10);
    const { role } = req.body;
    const validRoles = ['admin', 'organizer', 'player'];

    if (!validRoles.includes(role)) {
      return res.status(400).json({ error: `Invalid role. Must be one of: ${validRoles.join(', ')}` });
    }

    const targetUser = db.prepare('SELECT id, email, role, is_admin FROM users WHERE id = ?').get(targetId);
    if (!targetUser) {
      return res.status(404).json({ error: 'User not found.' });
    }

    // Prevent demoting the only remaining admin
    if ((targetUser.role === 'admin' || targetUser.is_admin === 1) && role !== 'admin') {
      const adminCount = db.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'admin' OR is_admin = 1").get().c;
      if (adminCount <= 1) {
        return res.status(400).json({ error: 'Cannot demote the last remaining administrator.' });
      }
    }

    const isAdminFlag = (role === 'admin') ? 1 : 0;
    db.prepare('UPDATE users SET role = ?, is_admin = ? WHERE id = ?').run(role, isAdminFlag, targetId);

    // If target user is updating their own role, update req.user as well
    if (req.user && req.user.id === targetId) {
      req.user.role = role;
      req.user.isAdmin = Boolean(isAdminFlag);
      req.user.canManageEvents = role === 'admin' || role === 'organizer' || Boolean(isAdminFlag);
    }

    res.json({
      success: true,
      message: `Role for ${targetUser.email} updated to ${role}.`,
      user: { id: targetId, role, isAdmin: Boolean(isAdminFlag) }
    });
  } catch (err) {
    console.error('[Auth] Error updating user role:', err);
    res.status(500).json({ error: 'Failed to update user role.' });
  }
});

/**
 * Log out
 */
router.post('/logout', (req, res) => {
  const sessionId = req.cookies[SESSION_COOKIE_NAME];
  if (sessionId) {
    deleteSession(sessionId);
  }
  res.clearCookie(SESSION_COOKIE_NAME);
  res.json({ success: true });
});

module.exports = router;
