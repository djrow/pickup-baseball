const fs = require('fs');
const path = require('path');

const targetPath = path.join(__dirname, '..', 'functions', 'api', '[[route]].js');
fs.mkdirSync(path.dirname(targetPath), { recursive: true });

const code = `import { Hono } from 'hono';
import { handle } from 'hono/cloudflare-pages';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';

const app = new Hono().basePath('/api');

const SESSION_COOKIE_NAME = 'baseball_session';
const SESSION_DURATION_SECONDS = 90 * 24 * 60 * 60; // 90 days

// -----------------------------------------------------------------------------
// Utilities
// -----------------------------------------------------------------------------

function generateToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function generateCode() {
  const array = new Uint32Array(1);
  crypto.getRandomValues(array);
  return (100000 + (array[0] % 900000)).toString();
}

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// -----------------------------------------------------------------------------
// Mailer (Resend REST API)
// -----------------------------------------------------------------------------

async function dispatchEmail(env, { to, subject, text, html }) {
  const appName = env.APP_NAME || 'Sunday Pickup Baseball';
  const from = env.FROM_EMAIL || \`"\${appName}" <games@pickupbaseballfoundation.org>\`;
  const replyTo = env.REPLY_TO_EMAIL || 'pickupbaseballfoundation@gmail.com';
  const apiKey = env.RESEND_API_KEY;

  if (apiKey) {
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': \`Bearer \${apiKey.trim()}\`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from,
          to: Array.isArray(to) ? to : [to],
          reply_to: replyTo,
          subject,
          text,
          html
        })
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.message || \`Resend API error (\${response.status})\`);
      }
      return { messageId: data.id };
    } catch (err) {
      console.error('[Mailer:Resend] Delivery failed to ' + to + ':', err.message);
      throw err;
    }
  }

  console.log('\\n[Email Dispatch (No Key)] To: ' + to + ' | Subject: ' + subject);
  return { messageId: 'mock-' + Date.now() };
}

async function sendAuthCode(env, origin, { email, name, code, token }) {
  const appName = env.APP_NAME || 'Sunday Pickup Baseball';
  const magicLink = \`\${origin}/api/auth/verify-magic?token=\${encodeURIComponent(token)}\`;
  const subject = \`Your Sign-In Code for \${appName}: \${code}\`;

  const text = \`Hi \${name || 'there'},

Welcome to \${appName}!

Your 6-digit sign-in code is: \${code}

Or click the link below to sign in automatically:
\${magicLink}

This code and link will expire in 20 minutes.

Play ball!
- \${appName} Team\`;

  const html = \`
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 580px; margin: 0 auto; padding: 26px; border: 1px solid #dbe4e0; border-top: 5px solid #003831; border-radius: 8px; background: #ffffff;">
      <h2 style="color: #003831; margin-top: 0; font-size: 22px;">⚾ \${appName}</h2>
      <p style="color: #0c1f1a; font-size: 16px;">Hi <strong>\${name || 'there'}</strong>,</p>
      <p style="color: #546e66; font-size: 15px;">Use the code below to sign in to your account:</p>
      <div style="background: #f5f8f7; border: 1px solid #dbe4e0; padding: 18px; border-radius: 8px; text-align: center; margin: 24px 0;">
        <span style="font-size: 34px; font-weight: 800; letter-spacing: 6px; color: #003831;">\${code}</span>
      </div>
      <p style="text-align: center; margin: 26px 0;">
        <a href="\${magicLink}" style="background: #FD5A1E; color: #ffffff; padding: 13px 26px; border-radius: 6px; text-decoration: none; font-weight: 700; font-size: 15px; display: inline-block;">
          Or Click to Sign In Instantly →
        </a>
      </p>
      <p style="color: #546e66; font-size: 13px; margin-top: 32px; border-top: 1px solid #dbe4e0; padding-top: 14px;">This code expires in 20 minutes. If you did not request this, you can safely ignore this email.</p>
    </div>
  \`;

  return dispatchEmail(env, { to: email, subject, text, html });
}

async function sendRsvpConfirmation(env, origin, { email, name, event, dutyName, gearBringing, managementToken }) {
  const appName = env.APP_NAME || 'Sunday Pickup Baseball';
  const manageLink = \`\${origin}/event.html?id=\${event.id}&token=\${encodeURIComponent(managementToken || '')}\`;
  const eventDateFormatted = new Date(event.event_date).toLocaleString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/Los_Angeles',
    timeZoneName: 'short'
  });

  const subject = \`Confirmed: You're playing in \${event.title} (\${eventDateFormatted})\`;
  const text = \`Hi \${name},

You're confirmed for pickup baseball!

Event: \${event.title}
Date & Time: \${eventDateFormatted}
Location: \${event.location}
\${dutyName ? \`Duty Signed Up For: \${dutyName}\\n\` : ''}\${gearBringing ? \`Gear You're Bringing: \${gearBringing}\\n\` : ''}
Need to coordinate gear, check who else is coming, or change your RSVP?
Visit the event page here:
\${manageLink}

See you on the field!
- \${appName}\`;

  const html = \`
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 580px; margin: 0 auto; padding: 26px; border: 1px solid #dbe4e0; border-top: 5px solid #FD5A1E; border-radius: 8px; background: #ffffff;">
      <h2 style="color: #003831; margin-top: 0; font-size: 22px;">⚾ RSVP Confirmed!</h2>
      <p style="color: #0c1f1a; font-size: 16px;">Hi <strong>\${name}</strong>,</p>
      <p style="color: #546e66; font-size: 15px;">You are confirmed on the roster for <strong>\${event.title}</strong>.</p>
      
      <div style="background: #f5f8f7; border-left: 4px solid #003831; border: 1px solid #dbe4e0; padding: 18px; margin: 20px 0; border-radius: 6px;">
        <p style="margin: 4px 0; color: #0c1f1a;"><strong>📅 When:</strong> \${eventDateFormatted}</p>
        <p style="margin: 4px 0; color: #0c1f1a;"><strong>📍 Where:</strong> \${event.location}</p>
        \${event.location_url ? \`<p style="margin: 4px 0;"><a href="\${event.location_url}" target="_blank" style="color: #FD5A1E; font-weight: 700;">View Map / Directions ↗</a></p>\` : ''}
        \${dutyName ? \`<p style="margin: 6px 0 4px 0; color: #003831;"><strong>🛡️ Your Duty:</strong> <span style="background: #e6f0ed; padding: 2px 8px; border-radius: 4px; font-weight: 700;">\${dutyName}</span></p>\` : ''}
        \${gearBringing ? \`<p style="margin: 4px 0; color: #0c1f1a;"><strong>🎒 Gear You're Bringing:</strong> <em>\${gearBringing}</em></p>\` : ''}
      </div>

      <p style="text-align: center; margin: 28px 0;">
        <a href="\${manageLink}" style="background: #FD5A1E; color: #ffffff; padding: 13px 26px; border-radius: 6px; text-decoration: none; font-weight: 700; font-size: 15px; display: inline-block;">
          View Live Roster & Coordinate Gear →
        </a>
      </p>

      <p style="color: #546e66; font-size: 13px; border-top: 1px solid #dbe4e0; padding-top: 14px;">
        Plans changed? Use the button above to update your gear or cancel your attendance so another player can take your spot.
      </p>
    </div>
  \`;

  return dispatchEmail(env, { to: email, subject, text, html });
}

async function sendEventReminder(env, origin, { email, name, event, dutyName, gearBringing, totalAttendees, managementToken }) {
  const appName = env.APP_NAME || 'Sunday Pickup Baseball';
  const manageLink = \`\${origin}/event.html?id=\${event.id}&token=\${encodeURIComponent(managementToken || '')}\`;
  const eventDateFormatted = new Date(event.event_date).toLocaleString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/Los_Angeles',
    timeZoneName: 'short'
  });

  const subject = \`Game Reminder: \${event.title} is coming up! (\${eventDateFormatted})\`;
  const text = \`Hi \${name},

This is a reminder that you're signed up for pickup baseball:

Event: \${event.title}
Date & Time: \${eventDateFormatted}
Location: \${event.location}
\${dutyName ? \`Your Assigned Duty: \${dutyName}\\n\` : ''}\${gearBringing ? \`Gear You're Bringing: \${gearBringing}\\n\` : ''}Total Players Confirmed: \${totalAttendees}

View details & live roster:
\${manageLink}

See you on the diamond!
- \${appName}\`;

  const html = \`
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 580px; margin: 0 auto; padding: 26px; border: 1px solid #dbe4e0; border-top: 5px solid #003831; border-radius: 8px; background: #ffffff;">
      <h2 style="color: #003831; margin-top: 0; font-size: 22px;">⚾ Game Day Reminder</h2>
      <p style="color: #0c1f1a; font-size: 16px;">Hi <strong>\${name}</strong>,</p>
      <p style="color: #546e66; font-size: 15px;">Get ready! <strong>\${event.title}</strong> is coming up soon.</p>
      
      <div style="background: #f5f8f7; border-left: 4px solid #003831; border: 1px solid #dbe4e0; padding: 18px; margin: 20px 0; border-radius: 6px;">
        <p style="margin: 4px 0; color: #0c1f1a;"><strong>📅 When:</strong> \${eventDateFormatted}</p>
        <p style="margin: 4px 0; color: #0c1f1a;"><strong>📍 Where:</strong> \${event.location}</p>
        <p style="margin: 4px 0; color: #0c1f1a;"><strong>👥 Confirmed Players:</strong> \${totalAttendees}</p>
        \${event.location_url ? \`<p style="margin: 4px 0;"><a href="\${event.location_url}" target="_blank" style="color: #FD5A1E; font-weight: 700;">View Map / Directions ↗</a></p>\` : ''}
        \${dutyName ? \`<p style="margin: 6px 0 4px 0; color: #003831;"><strong>🛡️ Your Duty:</strong> <span style="background: #e6f0ed; padding: 2px 8px; border-radius: 4px; font-weight: 700;">\${dutyName}</span></p>\` : ''}
        \${gearBringing ? \`<p style="margin: 4px 0; color: #0c1f1a;"><strong>🎒 Gear You're Bringing:</strong> <em>\${gearBringing}</em></p>\` : ''}
      </div>

      <p style="text-align: center; margin: 28px 0;">
        <a href="\${manageLink}" style="background: #003831; color: #ffffff; padding: 13px 26px; border-radius: 6px; text-decoration: none; font-weight: 700; font-size: 15px; display: inline-block;">
          Check Game Discussion & Roster →
        </a>
      </p>
    </div>
  \`;

  return dispatchEmail(env, { to: email, subject, text, html });
}

// -----------------------------------------------------------------------------
// Auth & RBAC Middleware
// -----------------------------------------------------------------------------

async function getUserFromSession(db, sessionId) {
  if (!sessionId) return null;

  const session = await db.prepare(\`
    SELECT 
      s.id as session_id, 
      s.expires_at, 
      u.id, 
      u.name, 
      u.email, 
      u.bio, 
      u.avatar_url, 
      u.is_admin,
      COALESCE(u.role, CASE WHEN u.is_admin = 1 THEN 'admin' ELSE 'player' END) as role
    FROM sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.id = ? AND datetime(s.expires_at) > datetime('now')
  \`).bind(sessionId).first();

  if (!session) return null;

  const role = session.role || (session.is_admin === 1 ? 'admin' : 'player');
  const isAdmin = role === 'admin' || Boolean(session.is_admin);
  const canManageEvents = role === 'admin' || role === 'organizer' || isAdmin;

  return {
    id: session.id,
    name: session.name,
    email: session.email,
    bio: session.bio || '',
    avatarUrl: session.avatar_url || '',
    role: role,
    isAdmin: isAdmin,
    canManageEvents: canManageEvents
  };
}

app.use('*', async (c, next) => {
  const sessionId = getCookie(c, SESSION_COOKIE_NAME);
  if (sessionId && c.env.DB) {
    try {
      c.set('user', await getUserFromSession(c.env.DB, sessionId));
    } catch (e) {
      console.error('[Auth Middleware] Session error:', e);
      c.set('user', null);
    }
  } else {
    c.set('user', null);
  }
  await next();
});

const DEFAULT_BASEBALL_DUTIES = [
  { title: "Bases", description: "Bring 3 throw-down bases.", slots_needed: 1 },
  { title: "Pitching machine and power", description: "Bring a pitching machine and a way to run it on the field.", slots_needed: 1 },
  { title: "Game Baseballs", description: "Bring game balls bucket.", slots_needed: 1 },
  { title: "Field Dragging", description: "Arrive 20 mins early to drag the infield with the pull rake.", slots_needed: 2 }
];

async function getDefaultDuties(db) {
  const { results } = await db.prepare(
    'SELECT title, description, slots_needed, sort_order FROM default_duties ORDER BY sort_order ASC, id ASC'
  ).all();
  return results && results.length > 0 ? results : DEFAULT_BASEBALL_DUTIES;
}

// -----------------------------------------------------------------------------
// Health Check
// -----------------------------------------------------------------------------

app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    environment: 'cloudflare-pages',
    timestamp: new Date().toISOString()
  });
});

// -----------------------------------------------------------------------------
// Auth Routes
// -----------------------------------------------------------------------------

app.post('/auth/send-code', async (c) => {
  try {
    const body = await c.req.json();
    let { email, name } = body;
    if (!email || !email.includes('@')) {
      return c.json({ error: 'A valid email address is required.' }, 400);
    }

    email = email.trim().toLowerCase();
    name = (name || '').trim();

    const banRecord = await c.env.DB.prepare('SELECT id, reason FROM banned_emails WHERE email = ?').bind(email).first();
    if (banRecord) {
      return c.json({ error: 'This email address has been restricted from accessing this service.' }, 403);
    }

    const existingUser = await c.env.DB.prepare('SELECT id, name FROM users WHERE email = ?').bind(email).first();
    if (existingUser && !name) {
      name = existingUser.name;
    }

    const code = generateCode();
    const token = generateToken();
    const expiresAt = new Date(Date.now() + 20 * 60 * 1000).toISOString();

    await c.env.DB.prepare(\`
      INSERT INTO auth_codes (email, name, code, token, expires_at)
      VALUES (?, ?, ?, ?, ?)
    \`).bind(email, name, code, token, expiresAt).run();

    const origin = new URL(c.req.url).origin;
    await sendAuthCode(c.env, origin, {
      email,
      name: name || 'Player',
      code,
      token
    });

    return c.json({
      success: true,
      message: \`A 6-digit code has been sent to \${email}. Please check your inbox.\`
    });
  } catch (err) {
    console.error('[Auth] Error sending code:', err);
    return c.json({ error: 'Failed to dispatch verification code.' }, 500);
  }
});

app.post('/auth/verify-code', async (c) => {
  try {
    const { email, code } = await c.req.json();
    if (!email || !code) {
      return c.json({ error: 'Email and 6-digit verification code are required.' }, 400);
    }

    const cleanEmail = email.trim().toLowerCase();
    const cleanCode = code.toString().trim();

    const authRecord = await c.env.DB.prepare(\`
      SELECT * FROM auth_codes
      WHERE email = ? AND code = ? AND used_at IS NULL AND datetime(expires_at) > datetime('now')
      ORDER BY id DESC LIMIT 1
    \`).bind(cleanEmail, cleanCode).first();

    if (!authRecord) {
      return c.json({ error: 'Invalid or expired code. Please request a new code.' }, 400);
    }

    await c.env.DB.prepare('UPDATE auth_codes SET used_at = CURRENT_TIMESTAMP WHERE id = ?').bind(authRecord.id).run();

    let user = await c.env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(cleanEmail).first();
    if (!user) {
      const displayName = authRecord.name || cleanEmail.split('@')[0];
      const adminCountRow = await c.env.DB.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'admin' OR is_admin = 1").first();
      const adminCount = adminCountRow ? adminCountRow.c : 0;
      const shouldBeAdmin = (adminCount === 0 || cleanEmail === (c.env.ADMIN_EMAIL || 'pickupbaseballfoundation@gmail.com').toLowerCase());
      const role = shouldBeAdmin ? 'admin' : 'player';
      const isAdminFlag = shouldBeAdmin ? 1 : 0;

      const insertRes = await c.env.DB.prepare(\`
        INSERT INTO users (name, email, role, is_admin) VALUES (?, ?, ?, ?)
      \`).bind(displayName, cleanEmail, role, isAdminFlag).run();

      const lastId = insertRes.meta.last_row_id;
      user = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(lastId).first();
    }

    const sessionId = generateToken();
    const expiresAt = new Date(Date.now() + SESSION_DURATION_SECONDS * 1000).toISOString();

    await c.env.DB.prepare(\`
      INSERT INTO sessions (id, user_id, expires_at)
      VALUES (?, ?, ?)
    \`).bind(sessionId, user.id, expiresAt).run();

    setCookie(c, SESSION_COOKIE_NAME, sessionId, {
      httpOnly: true,
      sameSite: 'Lax',
      secure: true,
      path: '/',
      maxAge: SESSION_DURATION_SECONDS
    });

    return c.json({
      success: true,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        isAdmin: Boolean(user.is_admin || user.role === 'admin')
      }
    });
  } catch (err) {
    console.error('[Auth] Error verifying code:', err);
    return c.json({ error: 'Failed to verify code.' }, 500);
  }
});

app.get('/auth/verify-magic', async (c) => {
  try {
    const token = c.req.query('token');
    const redirect = c.req.query('redirect');

    if (!token) {
      return c.text('Invalid or missing magic link token.', 400);
    }

    const authRecord = await c.env.DB.prepare(\`
      SELECT * FROM auth_codes
      WHERE token = ? AND used_at IS NULL AND datetime(expires_at) > datetime('now')
    \`).bind(token).first();

    if (!authRecord) {
      return c.text('This sign-in link is invalid or has expired. Please request a new one on the login page.', 400);
    }

    await c.env.DB.prepare('UPDATE auth_codes SET used_at = CURRENT_TIMESTAMP WHERE id = ?').bind(authRecord.id).run();

    let user = await c.env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(authRecord.email).first();
    if (!user) {
      const displayName = authRecord.name || authRecord.email.split('@')[0];
      const adminCountRow = await c.env.DB.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'admin' OR is_admin = 1").first();
      const adminCount = adminCountRow ? adminCountRow.c : 0;
      const shouldBeAdmin = (adminCount === 0 || authRecord.email === (c.env.ADMIN_EMAIL || 'pickupbaseballfoundation@gmail.com').toLowerCase());
      const role = shouldBeAdmin ? 'admin' : 'player';
      const isAdminFlag = shouldBeAdmin ? 1 : 0;

      const insertRes = await c.env.DB.prepare(\`
        INSERT INTO users (name, email, role, is_admin) VALUES (?, ?, ?, ?)
      \`).bind(displayName, authRecord.email, role, isAdminFlag).run();

      const lastId = insertRes.meta.last_row_id;
      user = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(lastId).first();
    }

    const sessionId = generateToken();
    const expiresAt = new Date(Date.now() + SESSION_DURATION_SECONDS * 1000).toISOString();

    await c.env.DB.prepare(\`
      INSERT INTO sessions (id, user_id, expires_at)
      VALUES (?, ?, ?)
    \`).bind(sessionId, user.id, expiresAt).run();

    setCookie(c, SESSION_COOKIE_NAME, sessionId, {
      httpOnly: true,
      sameSite: 'Lax',
      secure: true,
      path: '/',
      maxAge: SESSION_DURATION_SECONDS
    });

    return c.redirect(redirect || '/index.html?logged_in=1');
  } catch (err) {
    console.error('[Auth] Error handling magic link:', err);
    return c.text('Internal error verifying magic link.', 500);
  }
});

app.get('/auth/me', (c) => {
  const user = c.get('user');
  return c.json({ user });
});

app.put('/auth/profile', async (c) => {
  const user = c.get('user');
  if (!user) {
    return c.json({ error: 'Authentication required.' }, 401);
  }

  try {
    const { name, bio } = await c.req.json();
    if (!name || !name.trim()) {
      return c.json({ error: 'Name cannot be empty.' }, 400);
    }

    await c.env.DB.prepare(\`
      UPDATE users SET name = ?, bio = ? WHERE id = ?
    \`).bind(name.trim(), (bio || '').trim(), user.id).run();

    user.name = name.trim();
    user.bio = (bio || '').trim();

    return c.json({
      success: true,
      message: 'Profile updated successfully.',
      user
    });
  } catch (err) {
    console.error('[Auth] Error updating profile:', err);
    return c.json({ error: 'Failed to update profile.' }, 500);
  }
});

app.post('/auth/avatar', async (c) => {
  const user = c.get('user');
  if (!user) {
    return c.json({ error: 'Authentication required.' }, 401);
  }

  try {
    const body = await c.req.parseBody();
    const file = body['avatar'];
    if (!file || typeof file === 'string') {
      return c.json({ error: 'No image file uploaded.' }, 400);
    }

    const mime = file.type || 'image/jpeg';
    if (!mime.startsWith('image/')) {
      return c.json({ error: 'Only image files are allowed.' }, 400);
    }

    const buffer = await file.arrayBuffer();
    if (buffer.byteLength > 5 * 1024 * 1024) {
      return c.json({ error: 'Image size exceeds 5MB limit.' }, 400);
    }

    const base64 = arrayBufferToBase64(buffer);
    const dataUrl = \`data:\${mime};base64,\${base64}\`;

    await c.env.DB.prepare('UPDATE users SET avatar_url = ? WHERE id = ?').bind(dataUrl, user.id).run();
    user.avatarUrl = dataUrl;

    return c.json({
      success: true,
      avatarUrl: dataUrl,
      message: 'Profile picture updated successfully!'
    });
  } catch (err) {
    console.error('[Auth] Error updating avatar:', err);
    return c.json({ error: 'Failed to upload profile picture.' }, 500);
  }
});

app.delete('/auth/avatar', async (c) => {
  const user = c.get('user');
  if (!user) {
    return c.json({ error: 'Authentication required.' }, 401);
  }

  try {
    await c.env.DB.prepare('UPDATE users SET avatar_url = NULL WHERE id = ?').bind(user.id).run();
    user.avatarUrl = null;
    return c.json({ success: true, message: 'Profile picture removed.' });
  } catch (err) {
    console.error('[Auth] Error removing avatar:', err);
    return c.json({ error: 'Failed to remove profile picture.' }, 500);
  }
});

app.get('/auth/users', async (c) => {
  const user = c.get('user');
  if (!user || !user.isAdmin) {
    return c.json({ error: 'Administrator access required.' }, 403);
  }

  try {
    const { results } = await c.env.DB.prepare(\`
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
    \`).all();

    return c.json({ users: results || [] });
  } catch (err) {
    console.error('[Auth] Error fetching users:', err);
    return c.json({ error: 'Failed to fetch users list.' }, 500);
  }
});

app.put('/auth/users/:id/role', async (c) => {
  const currentUser = c.get('user');
  if (!currentUser || !currentUser.isAdmin) {
    return c.json({ error: 'Administrator access required.' }, 403);
  }

  const targetId = parseInt(c.req.param('id'), 10);
  const { role } = await c.req.json();

  if (!['admin', 'organizer', 'player'].includes(role)) {
    return c.json({ error: 'Invalid role. Must be admin, organizer, or player.' }, 400);
  }

  const targetUser = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(targetId).first();
  if (!targetUser) {
    return c.json({ error: 'User not found.' }, 404);
  }

  if (targetId === currentUser.id && role !== 'admin') {
    const adminCountRow = await c.env.DB.prepare("SELECT COUNT(*) as c FROM users WHERE (role = 'admin' OR is_admin = 1) AND id != ?").bind(targetId).first();
    if (!adminCountRow || adminCountRow.c === 0) {
      return c.json({ error: 'Cannot remove the last administrator.' }, 400);
    }
  }

  const isAdminFlag = role === 'admin' ? 1 : 0;
  await c.env.DB.prepare('UPDATE users SET role = ?, is_admin = ? WHERE id = ?').bind(role, isAdminFlag, targetId).run();

  return c.json({
    success: true,
    message: \`Role updated to \${role}.\`,
    user: { id: targetId, role, isAdmin: Boolean(isAdminFlag) }
  });
});

app.delete('/auth/users/:id', async (c) => {
  const currentUser = c.get('user');
  if (!currentUser || !currentUser.isAdmin) {
    return c.json({ error: 'Administrator access required.' }, 403);
  }

  const targetId = parseInt(c.req.param('id'), 10);
  if (targetId === currentUser.id) {
    return c.json({ error: 'You cannot delete your own administrator account.' }, 400);
  }

  const targetUser = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(targetId).first();
  if (!targetUser) {
    return c.json({ error: 'User not found.' }, 404);
  }

  const ban = c.req.query('ban') === 'true';
  const reason = c.req.query('reason') || 'Banned by administrator';

  if (ban) {
    await c.env.DB.prepare(
      'INSERT OR REPLACE INTO banned_emails (email, reason) VALUES (?, ?)'
    ).bind(targetUser.email, reason).run();
  }

  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(targetId),
    c.env.DB.prepare('DELETE FROM auth_codes WHERE email = ?').bind(targetUser.email),
    c.env.DB.prepare('UPDATE attendees SET user_id = NULL WHERE user_id = ?').bind(targetId),
    c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(targetId)
  ]);

  return c.json({
    success: true,
    message: ban ? \`User \${targetUser.email} has been removed and banned from re-registering.\` : \`User \${targetUser.email} has been removed.\`
  });
});

app.get('/auth/banned-emails', async (c) => {
  const currentUser = c.get('user');
  if (!currentUser || !currentUser.isAdmin) {
    return c.json({ error: 'Administrator access required.' }, 403);
  }
  const { results } = await c.env.DB.prepare('SELECT * FROM banned_emails ORDER BY id DESC').all();
  return c.json({ bannedEmails: results || [] });
});

app.post('/auth/banned-emails', async (c) => {
  const currentUser = c.get('user');
  if (!currentUser || !currentUser.isAdmin) {
    return c.json({ error: 'Administrator access required.' }, 403);
  }
  const { email, reason } = await c.req.json();
  if (!email || !email.includes('@')) {
    return c.json({ error: 'A valid email is required.' }, 400);
  }
  await c.env.DB.prepare(
    'INSERT OR REPLACE INTO banned_emails (email, reason) VALUES (?, ?)'
  ).bind(email.trim().toLowerCase(), (reason || 'Banned by admin').trim()).run();
  return c.json({ success: true, message: \`Email \${email} added to ban list.\` });
});

app.delete('/auth/banned-emails/:id', async (c) => {
  const currentUser = c.get('user');
  if (!currentUser || !currentUser.isAdmin) {
    return c.json({ error: 'Administrator access required.' }, 403);
  }
  const id = parseInt(c.req.param('id'), 10);
  await c.env.DB.prepare('DELETE FROM banned_emails WHERE id = ?').bind(id).run();
  return c.json({ success: true, message: 'Ban removed.' });
});

app.get('/settings', async (c) => {
  const row = await c.env.DB.prepare("SELECT value FROM app_settings WHERE key = 'require_login_to_rsvp'").first();
  const requireLogin = row ? row.value === 'true' : true;
  return c.json({ require_login_to_rsvp: requireLogin });
});

app.put('/settings', async (c) => {
  const currentUser = c.get('user');
  if (!currentUser || !currentUser.isAdmin) {
    return c.json({ error: 'Administrator access required.' }, 403);
  }
  const { require_login_to_rsvp } = await c.req.json();
  const val = require_login_to_rsvp ? 'true' : 'false';
  await c.env.DB.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('require_login_to_rsvp', ?)").bind(val).run();
  return c.json({ success: true, require_login_to_rsvp: val === 'true', message: 'Settings saved.' });
});

app.post('/auth/logout', async (c) => {
  const sessionId = getCookie(c, SESSION_COOKIE_NAME);
  if (sessionId && c.env.DB) {
    try {
      await c.env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sessionId).run();
    } catch (e) {}
  }

  deleteCookie(c, SESSION_COOKIE_NAME, { path: '/' });
  return c.json({ success: true, message: 'Logged out successfully.' });
});

// -----------------------------------------------------------------------------
// Events Routes
// -----------------------------------------------------------------------------

app.get('/events', async (c) => {
  try {
    const filter = c.req.query('filter');
    const user = c.get('user');
    const nowIso = new Date().toISOString();

    let query = \`
      SELECT e.*,
        (SELECT COUNT(*) FROM attendees a WHERE a.event_id = e.id AND a.status = 'attending') as attendee_count,
        (SELECT COUNT(*) FROM event_duties d WHERE d.event_id = e.id) as duty_count
      FROM events e
      WHERE e.status = 'active'
    \`;

    if (filter === 'past') {
      query += \` AND e.event_date < '\${nowIso}'\`;
    } else if (filter === 'all') {
      // no restriction
    } else {
      query += \` AND e.event_date >= date('now', '-1 day')\`;
    }

    query += ' ORDER BY e.event_date ASC';

    const { results: events } = await c.env.DB.prepare(query).all();

    if (user && events && events.length > 0) {
      const { results: userRsvps } = await c.env.DB.prepare(\`
        SELECT event_id, status, gear_bringing
        FROM attendees
        WHERE user_id = ?
      \`).bind(user.id).all();

      const rsvpMap = new Map((userRsvps || []).map(r => [r.event_id, r]));
      events.forEach(ev => {
        ev.my_rsvp = rsvpMap.get(ev.id) || null;
      });
    }

    return c.json({ events: events || [] });
  } catch (err) {
    console.error('[Events] Error listing events:', err);
    return c.json({ error: 'Failed to fetch events.' }, 500);
  }
});

app.get('/events/default-duties', async (c) => {
  const duties = await getDefaultDuties(c.env.DB);
  return c.json({ duties });
});

app.put('/events/default-duties', async (c) => {
  const user = c.get('user');
  if (!user || !user.isAdmin) {
    return c.json({ error: 'Administrator access required.' }, 403);
  }

  try {
    const { duties } = await c.req.json();
    if (!Array.isArray(duties)) {
      return c.json({ error: 'duties array is required.' }, 400);
    }

    const batch = [c.env.DB.prepare('DELETE FROM default_duties')];
    duties.filter(d => d && d.title && d.title.trim()).forEach((d, idx) => {
      batch.push(
        c.env.DB.prepare(\`
          INSERT INTO default_duties (title, description, slots_needed, sort_order)
          VALUES (?, ?, ?, ?)
        \`).bind(d.title.trim(), (d.description || '').trim(), parseInt(d.slots_needed || 1, 10), idx)
      );
    });

    await c.env.DB.batch(batch);
    const updated = await getDefaultDuties(c.env.DB);
    return c.json({ success: true, duties: updated, message: 'Default task template updated successfully!' });
  } catch (err) {
    console.error('[Events] Error saving default duties:', err);
    return c.json({ error: 'Failed to update default duties template.' }, 500);
  }
});

app.get('/events/admin/backup-db', async (c) => {
  const user = c.get('user');
  if (!user || !user.isAdmin) {
    return c.text('Administrator access required. Please sign in as an admin.', 403);
  }

  try {
    const tables = [
      'users',
      'events',
      'event_duties',
      'attendees',
      'duty_assignments',
      'comments',
      'default_duties'
    ];

    const timestamp = new Date().toISOString();
    const dateStr = timestamp.slice(0, 10);
    let sqlDump = \`-- Sunday Pickup Baseball Database Backup\\n-- Exported: \${timestamp}\\n-- Platform: Cloudflare D1 SQL\\n\\n\`;

    for (const table of tables) {
      const { results: rows } = await c.env.DB.prepare(\`SELECT * FROM "\${table}"\`).all();
      if (rows && rows.length > 0) {
        sqlDump += \`-- Table: \${table} (\${rows.length} rows)\\n\`;
        for (const row of rows) {
          const cols = Object.keys(row).map(k => \`"\${k}"\`).join(', ');
          const vals = Object.values(row).map(v => {
            if (v === null || v === undefined) return 'NULL';
            if (typeof v === 'number') return v;
            return \`'\${String(v).replace(/'/g, "''")}'\`;
          }).join(', ');
          sqlDump += \`INSERT OR IGNORE INTO "\${table}" (\${cols}) VALUES (\${vals});\\n\`;
        }
        sqlDump += '\\n';
      }
    }

    return new Response(sqlDump, {
      status: 200,
      headers: {
        'Content-Type': 'application/sql; charset=utf-8',
        'Content-Disposition': \`attachment; filename="baseball_backup_\${dateStr}.sql"\`,
        'Cache-Control': 'no-store'
      }
    });
  } catch (err) {
    console.error('[Backup] Error creating SQL dump:', err);
    return c.text('Failed to generate database backup: ' + err.message, 500);
  }
});

app.get('/events/:id', async (c) => {
  try {
    const eventId = parseInt(c.req.param('id'), 10);
    const token = c.req.query('token');
    const user = c.get('user');

    const event = await c.env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(eventId).first();
    if (!event) {
      return c.json({ error: 'Event not found.' }, 404);
    }

    const { results: rawDuties } = await c.env.DB.prepare(\`
      SELECT d.*,
        COALESCE((
          SELECT json_group_array(json_object('attendee_id', a.id, 'name', a.name, 'avatar_url', u.avatar_url))
          FROM duty_assignments da
          JOIN attendees a ON da.attendee_id = a.id
          LEFT JOIN users u ON a.user_id = u.id
          WHERE da.duty_id = d.id AND a.status = 'attending'
        ), '[]') as assigned_players
      FROM event_duties d
      WHERE d.event_id = ?
      ORDER BY d.sort_order ASC, d.id ASC
    \`).bind(eventId).all();

    const duties = (rawDuties || []).map(d => ({
      ...d,
      assigned_players: JSON.parse(d.assigned_players || '[]')
    }));

    const { results: attendees } = await c.env.DB.prepare(\`
      SELECT a.id, a.name, a.status, a.gear_bringing, a.is_guest, a.created_at,
        u.bio, u.avatar_url,
        (
          SELECT group_concat(d.title, ', ')
          FROM duty_assignments da
          JOIN event_duties d ON da.duty_id = d.id
          WHERE da.attendee_id = a.id
        ) as duties_assigned
      FROM attendees a
      LEFT JOIN users u ON a.user_id = u.id
      WHERE a.event_id = ? AND a.status = 'attending'
      ORDER BY a.created_at ASC
    \`).bind(eventId).all();

    const { results: comments } = await c.env.DB.prepare(\`
      SELECT c.id, c.author_name, c.content, c.created_at, c.user_id,
        u.avatar_url, u.bio
      FROM comments c
      LEFT JOIN users u ON c.user_id = u.id
      WHERE c.event_id = ?
      ORDER BY c.created_at ASC
    \`).bind(eventId).all();

    let myRsvp = null;
    if (user) {
      myRsvp = await c.env.DB.prepare(\`
        SELECT a.*,
          (SELECT json_group_array(duty_id) FROM duty_assignments WHERE attendee_id = a.id) as duty_ids
        FROM attendees a
        WHERE a.event_id = ? AND (a.user_id = ? OR a.email = ?)
      \`).bind(eventId, user.id, user.email).first();
    } else if (token) {
      myRsvp = await c.env.DB.prepare(\`
        SELECT a.*,
          (SELECT json_group_array(duty_id) FROM duty_assignments WHERE attendee_id = a.id) as duty_ids
        FROM attendees a
        WHERE a.event_id = ? AND a.management_token = ?
      \`).bind(eventId, token).first();
    }

    if (myRsvp) {
      myRsvp.duty_ids = JSON.parse(myRsvp.duty_ids || '[]');
    }

    return c.json({
      event,
      duties: duties || [],
      attendees: attendees || [],
      comments: comments || [],
      myRsvp,
      totalAttendees: (attendees || []).length
    });
  } catch (err) {
    console.error('[Events] Error fetching event details:', err);
    return c.json({ error: 'Failed to fetch event details.' }, 500);
  }
});

app.post('/events', async (c) => {
  const user = c.get('user');
  if (!user || !user.canManageEvents) {
    return c.json({ error: 'Organizer or Admin permissions required to create events.' }, 403);
  }

  try {
    const {
      title,
      description,
      location,
      location_url,
      event_date,
      max_players,
      use_default_duties,
      custom_duties
    } = await c.req.json();

    if (!title || !title.trim() || !location || !location.trim() || !event_date) {
      return c.json({ error: 'Title, location, and event date/time are required.' }, 400);
    }

    if (isNaN(new Date(event_date).getTime())) {
      return c.json({ error: 'A valid event date/time is required.' }, 400);
    }

    let dutiesToInsert = [];
    if (use_default_duties || (!custom_duties || custom_duties.length === 0)) {
      dutiesToInsert = await getDefaultDuties(c.env.DB);
    } else if (Array.isArray(custom_duties)) {
      for (const d of custom_duties) {
        if (!d || !d.title || !d.title.trim()) {
          return c.json({ error: 'All custom duties must have a non-empty title.' }, 400);
        }
      }
      dutiesToInsert = custom_duties;
    } else {
      dutiesToInsert = await getDefaultDuties(c.env.DB);
    }

    const insertEventRes = await c.env.DB.prepare(\`
      INSERT INTO events (title, description, location, location_url, event_date, max_players, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    \`).bind(
      title.trim(),
      (description || '').trim(),
      location.trim(),
      (location_url || '').trim(),
      event_date,
      max_players ? parseInt(max_players, 10) : null,
      user.id
    ).run();

    const eventId = insertEventRes.meta.last_row_id;

    if (dutiesToInsert.length > 0) {
      const dutyBatch = dutiesToInsert.map((d, idx) => (
        c.env.DB.prepare(\`
          INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
          VALUES (?, ?, ?, ?, ?)
        \`).bind(
          eventId,
          d.title.trim(),
          (d.description || '').trim(),
          parseInt(d.slots_needed || 1, 10),
          d.sort_order !== undefined ? parseInt(d.sort_order, 10) : idx
        )
      ));
      await c.env.DB.batch(dutyBatch);
    }

    const newEvent = await c.env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(eventId).first();

    return c.json({
      success: true,
      eventId,
      event: newEvent,
      message: 'Event created successfully.'
    });
  } catch (err) {
    console.error('[Events] Error creating event:', err);
    return c.json({ error: 'Failed to create event.' }, 500);
  }
});

app.put('/events/:id', async (c) => {
  const user = c.get('user');
  if (!user || !user.canManageEvents) {
    return c.json({ error: 'Organizer or Admin permissions required.' }, 403);
  }

  try {
    const eventId = parseInt(c.req.param('id'), 10);
    const { title, description, location, location_url, event_date, max_players, status } = await c.req.json();

    const existingEvent = await c.env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(eventId).first();
    if (!existingEvent) {
      return c.json({ error: 'Event not found.' }, 404);
    }

    if (title !== undefined && (!title || !title.trim())) {
      return c.json({ error: 'Event title cannot be empty.' }, 400);
    }
    if (location !== undefined && (!location || !location.trim())) {
      return c.json({ error: 'Event location cannot be empty.' }, 400);
    }
    if (event_date !== undefined && event_date !== null) {
      if (isNaN(new Date(event_date).getTime())) {
        return c.json({ error: 'A valid event date/time is required.' }, 400);
      }
    }

    let newMaxPlayers;
    if (max_players === undefined) {
      newMaxPlayers = existingEvent.max_players;
    } else if (max_players === null || max_players === '') {
      newMaxPlayers = null;
    } else {
      const parsed = parseInt(max_players, 10);
      newMaxPlayers = isNaN(parsed) ? existingEvent.max_players : parsed;
    }

    await c.env.DB.prepare(\`
      UPDATE events
      SET title = COALESCE(?, title),
          description = COALESCE(?, description),
          location = COALESCE(?, location),
          location_url = COALESCE(?, location_url),
          event_date = COALESCE(?, event_date),
          max_players = ?,
          status = COALESCE(?, status)
      WHERE id = ?
    \`).bind(
      title !== undefined ? title.trim() : null,
      description !== undefined ? description.trim() : null,
      location !== undefined ? location.trim() : null,
      location_url !== undefined ? location_url.trim() : null,
      event_date || null,
      newMaxPlayers,
      status || null,
      eventId
    ).run();

    const updated = await c.env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(eventId).first();
    return c.json({ success: true, event: updated, message: 'Event updated.' });
  } catch (err) {
    console.error('[Events] Error updating event:', err);
    return c.json({ error: 'Failed to update event.' }, 500);
  }
});

app.delete('/events/:id', async (c) => {
  const user = c.get('user');
  if (!user || !user.isAdmin) {
    return c.json({ error: 'Administrator access required.' }, 403);
  }

  try {
    const eventId = parseInt(c.req.param('id'), 10);
    const res = await c.env.DB.prepare('DELETE FROM events WHERE id = ?').bind(eventId).run();
    if (res.meta.changes === 0) {
      return c.json({ error: 'Event not found.' }, 404);
    }
    return c.json({ success: true, message: 'Event deleted.' });
  } catch (err) {
    console.error('[Events] Error deleting event:', err);
    return c.json({ error: 'Failed to delete event.' }, 500);
  }
});

app.post('/events/:id/rsvp', async (c) => {
  try {
    const eventId = parseInt(c.req.param('id'), 10);
    const user = c.get('user');

    const event = await c.env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(eventId).first();
    if (!event) {
      return c.json({ error: 'Event not found.' }, 404);
    }

    let { name, email, gear_bringing, duty_ids, management_token, status } = await c.req.json();
    status = status === 'declined' ? 'declined' : 'attending';

    const settingRow = await c.env.DB.prepare("SELECT value FROM app_settings WHERE key = 'require_login_to_rsvp'").first();
    const requireLogin = settingRow ? settingRow.value === 'true' : true;
    if (requireLogin && !user) {
      return c.json({ error: 'Sign-in required to RSVP. Please sign in or register before joining the roster.' }, 401);
    }

    let userId = user ? user.id : null;
    let isGuest = user ? 0 : 1;

    if (user) {
      name = name || user.name;
      email = user.email;
    } else {
      if (!name || !name.trim()) {
        return c.json({ error: 'Your name is required to RSVP.' }, 400);
      }
      if (!email || !email.includes('@')) {
        return c.json({ error: 'A valid email address is required.' }, 400);
      }
      name = name.trim();
      email = email.trim().toLowerCase();

      const existingUser = await c.env.DB.prepare('SELECT id, name FROM users WHERE email = ?').bind(email).first();
      if (existingUser) {
        userId = existingUser.id;
        isGuest = 0;
      }
    }

    if (email) {
      const banRecord = await c.env.DB.prepare('SELECT id FROM banned_emails WHERE email = ?').bind(email).first();
      if (banRecord) {
        return c.json({ error: 'This email address has been restricted from registering.' }, 403);
      }
    }

    const mgmtToken = management_token || generateToken();

    const existingAttendee = await c.env.DB.prepare(
      'SELECT * FROM attendees WHERE event_id = ? AND email = ?'
    ).bind(eventId, email).first();

    let attendeeId;
    if (existingAttendee) {
      attendeeId = existingAttendee.id;
      await c.env.DB.prepare(\`
        UPDATE attendees
        SET name = ?, status = ?, gear_bringing = ?, user_id = COALESCE(?, user_id), is_guest = ?
        WHERE id = ?
      \`).bind(name, status, (gear_bringing || '').trim(), userId, isGuest, attendeeId).run();
    } else {
      const insertAttendeeRes = await c.env.DB.prepare(\`
        INSERT INTO attendees (event_id, user_id, name, email, is_guest, status, gear_bringing, management_token)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      \`).bind(eventId, userId, name, email, isGuest, status, (gear_bringing || '').trim(), mgmtToken).run();
      attendeeId = insertAttendeeRes.meta.last_row_id;
    }

    const assignedDutyNames = [];
    if (status === 'attending' && Array.isArray(duty_ids)) {
      await c.env.DB.prepare('DELETE FROM duty_assignments WHERE attendee_id = ?').bind(attendeeId).run();

      for (const dId of duty_ids) {
        const duty = await c.env.DB.prepare(
          'SELECT * FROM event_duties WHERE id = ? AND event_id = ?'
        ).bind(dId, eventId).first();

        if (duty) {
          const countRow = await c.env.DB.prepare(\`
            SELECT COUNT(*) as count FROM duty_assignments da
            JOIN attendees a ON da.attendee_id = a.id
            WHERE da.duty_id = ? AND a.status = 'attending' AND a.id != ?
          \`).bind(dId, attendeeId).first();

          const currentCount = countRow ? countRow.count : 0;
          if (currentCount < duty.slots_needed) {
            await c.env.DB.prepare(\`
              INSERT OR IGNORE INTO duty_assignments (duty_id, attendee_id)
              VALUES (?, ?)
            \`).bind(dId, attendeeId).run();
            assignedDutyNames.push(duty.title);
          }
        }
      }
    } else if (status === 'declined') {
      await c.env.DB.prepare('DELETE FROM duty_assignments WHERE attendee_id = ?').bind(attendeeId).run();
    }

    if (status === 'attending') {
      const origin = new URL(c.req.url).origin;
      const sendPromise = sendRsvpConfirmation(c.env, origin, {
        email,
        name,
        event,
        dutyName: assignedDutyNames.join(', '),
        gearBringing: (gear_bringing || '').trim(),
        managementToken: mgmtToken
      }).catch(e => console.error('[RSVP Email Error]:', e));

      if (c.executionCtx && c.executionCtx.waitUntil) {
        c.executionCtx.waitUntil(sendPromise);
      }
    }

    return c.json({
      success: true,
      status,
      managementToken: mgmtToken,
      message: status === 'attending'
        ? \`You're on the roster! A confirmation email has been sent to \${email}.\`
        : 'Your RSVP has been cancelled.'
    });
  } catch (err) {
    console.error('[RSVP] Error updating RSVP:', err);
    return c.json({ error: 'Failed to record RSVP.' }, 500);
  }
});

app.post('/events/:id/comments', async (c) => {
  try {
    const eventId = parseInt(c.req.param('id'), 10);
    const user = c.get('user');

    const event = await c.env.DB.prepare('SELECT id FROM events WHERE id = ?').bind(eventId).first();
    if (!event) {
      return c.json({ error: 'Event not found.' }, 404);
    }

    const { content, author_name, author_email } = await c.req.json();
    if (!content || !content.trim()) {
      return c.json({ error: 'Comment message cannot be empty.' }, 400);
    }

    const settingRow = await c.env.DB.prepare("SELECT value FROM app_settings WHERE key = 'require_login_to_rsvp'").first();
    const requireLogin = settingRow ? settingRow.value === 'true' : true;
    if (requireLogin && !user) {
      return c.json({ error: 'Sign-in required to post comments.' }, 401);
    }

    let name = '';
    let email = '';
    let userId = null;

    if (user) {
      name = user.name;
      email = user.email;
      userId = user.id;
    } else {
      name = (author_name || '').trim();
      email = (author_email || '').trim().toLowerCase();
      if (!name) {
        return c.json({ error: 'Please enter your name to post a comment.' }, 400);
      }
    }

    if (email) {
      const banRecord = await c.env.DB.prepare('SELECT id FROM banned_emails WHERE email = ?').bind(email).first();
      if (banRecord) {
        return c.json({ error: 'This email address has been restricted.' }, 403);
      }
    }

    const insertCommentRes = await c.env.DB.prepare(\`
      INSERT INTO comments (event_id, user_id, author_name, author_email, content)
      VALUES (?, ?, ?, ?, ?)
    \`).bind(eventId, userId, name, email || 'guest', content.trim()).run();

    const commentId = insertCommentRes.meta.last_row_id;
    const newComment = await c.env.DB.prepare('SELECT * FROM comments WHERE id = ?').bind(commentId).first();

    return c.json({ success: true, comment: newComment });
  } catch (err) {
    console.error('[Comments] Error posting comment:', err);
    return c.json({ error: 'Failed to post comment.' }, 500);
  }
});

app.post('/events/:id/duties', async (c) => {
  const user = c.get('user');
  if (!user || !user.canManageEvents) {
    return c.json({ error: 'Organizer or Admin permissions required.' }, 403);
  }

  try {
    const eventId = parseInt(c.req.param('id'), 10);
    const { title, description, slots_needed } = await c.req.json();

    if (!title || !title.trim()) {
      return c.json({ error: 'Duty title is required.' }, 400);
    }

    const maxSortRow = await c.env.DB.prepare('SELECT MAX(sort_order) as max_sort FROM event_duties WHERE event_id = ?').bind(eventId).first();
    const nextSort = (maxSortRow && maxSortRow.max_sort !== null) ? maxSortRow.max_sort + 1 : 0;

    const res = await c.env.DB.prepare(\`
      INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
      VALUES (?, ?, ?, ?, ?)
    \`).bind(eventId, title.trim(), (description || '').trim(), parseInt(slots_needed || 1, 10), nextSort).run();

    const duty = await c.env.DB.prepare('SELECT * FROM event_duties WHERE id = ?').bind(res.meta.last_row_id).first();
    return c.json({ success: true, duty });
  } catch (err) {
    console.error('[Events] Error adding duty:', err);
    return c.json({ error: 'Failed to add duty.' }, 500);
  }
});

app.put('/events/:id/duties/:dutyId', async (c) => {
  const user = c.get('user');
  if (!user || !user.canManageEvents) {
    return c.json({ error: 'Organizer or Admin permissions required.' }, 403);
  }

  try {
    const eventId = parseInt(c.req.param('id'), 10);
    const dutyId = parseInt(c.req.param('dutyId'), 10);
    const { title, description, slots_needed } = await c.req.json();

    if (title !== undefined && (!title || !title.trim())) {
      return c.json({ error: 'Duty title cannot be empty.' }, 400);
    }

    const res = await c.env.DB.prepare(\`
      UPDATE event_duties
      SET title = COALESCE(?, title),
          description = COALESCE(?, description),
          slots_needed = COALESCE(?, slots_needed)
      WHERE id = ? AND event_id = ?
    \`).bind(
      title ? title.trim() : null,
      description !== undefined ? description.trim() : null,
      slots_needed ? parseInt(slots_needed, 10) : null,
      dutyId,
      eventId
    ).run();

    if (res.meta.changes === 0) {
      return c.json({ error: 'Duty not found.' }, 404);
    }

    const updated = await c.env.DB.prepare('SELECT * FROM event_duties WHERE id = ?').bind(dutyId).first();
    return c.json({ success: true, duty: updated });
  } catch (err) {
    console.error('[Events] Error updating duty:', err);
    return c.json({ error: 'Failed to update duty.' }, 500);
  }
});

app.delete('/events/:id/duties/:dutyId', async (c) => {
  const user = c.get('user');
  if (!user || !user.canManageEvents) {
    return c.json({ error: 'Organizer or Admin permissions required.' }, 403);
  }

  try {
    const eventId = parseInt(c.req.param('id'), 10);
    const dutyId = parseInt(c.req.param('dutyId'), 10);

    const res = await c.env.DB.prepare('DELETE FROM event_duties WHERE id = ? AND event_id = ?').bind(dutyId, eventId).run();
    if (res.meta.changes === 0) {
      return c.json({ error: 'Duty not found.' }, 404);
    }

    return c.json({ success: true, message: 'Duty removed.' });
  } catch (err) {
    console.error('[Events] Error deleting duty:', err);
    return c.json({ error: 'Failed to delete duty.' }, 500);
  }
});

app.post('/events/:id/send-reminders', async (c) => {
  const user = c.get('user');
  if (!user || !user.isAdmin) {
    return c.json({ error: 'Administrator access required.' }, 403);
  }

  try {
    const eventId = parseInt(c.req.param('id'), 10);
    const event = await c.env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(eventId).first();
    if (!event) {
      return c.json({ error: 'Event not found.' }, 404);
    }

    const { results: attendees } = await c.env.DB.prepare(\`
      SELECT a.*, d.title as duty_name
      FROM attendees a
      LEFT JOIN duty_assignments da ON a.id = da.attendee_id
      LEFT JOIN event_duties d ON da.duty_id = d.id
      WHERE a.event_id = ? AND a.status = 'attending'
    \`).bind(eventId).all();

    const origin = new URL(c.req.url).origin;
    const totalCount = attendees ? attendees.length : 0;

    for (const att of (attendees || [])) {
      try {
        await sendEventReminder(c.env, origin, {
          email: att.email,
          name: att.name,
          event,
          dutyName: att.duty_name,
          gearBringing: att.gear_bringing,
          totalAttendees: totalCount,
          managementToken: att.management_token
        });
      } catch (e) {
        console.error('[Reminders] Error sending reminder to ' + att.email + ':', e);
      }
    }

    await c.env.DB.prepare('UPDATE events SET reminder_sent = 1 WHERE id = ?').bind(eventId).run();

    return c.json({ success: true, message: 'Reminders have been sent to all confirmed attendees.' });
  } catch (err) {
    console.error('[Events] Error sending reminders manually:', err);
    return c.json({ error: 'Failed to send reminders.' }, 500);
  }
});

export const onRequest = handle(app);
`;

fs.writeFileSync(targetPath, code, 'utf8');
console.log('Successfully written functions/api/[[route]].js');
