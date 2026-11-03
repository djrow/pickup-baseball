/**
 * Unified Database Schema, Migrations & Default Volunteer Tasks
 * Compatible with Cloudflare D1 and local SQLite (via D1 adapter).
 */

export const DEFAULT_BASEBALL_DUTIES = [
  { title: 'Bases', description: 'Bring 3 throw-down bases.', slots_needed: 1 },
  { title: 'Pitching machine and power', description: 'Bring a pitching machine and a way to run it on the field.', slots_needed: 1 },
  { title: 'Game Baseballs', description: 'Bring game balls bucket.', slots_needed: 1 },
  { title: 'Field Dragging', description: 'Arrive 20 mins early to drag the infield with the pull rake.', slots_needed: 2 },
  { title: 'Game Facilitator', description: 'Help coordinate teams, batting order, and fair play throughout the game.', slots_needed: 1 },
  { title: 'Water / Food', description: 'Bring drinking water, ice, and dugout snacks or fruit for players.', slots_needed: 1 }
];

export const CREATE_TABLES_SQL = [
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    bio TEXT,
    avatar_url TEXT,
    role TEXT DEFAULT 'player',
    is_admin INTEGER DEFAULT 0,
    machine_badge INTEGER DEFAULT 0,
    field_badge INTEGER DEFAULT 0,
    hero_credits INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS auth_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL COLLATE NOCASE,
    name TEXT,
    code TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    attempts INTEGER DEFAULT 0,
    expires_at DATETIME NOT NULL,
    used_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    location TEXT NOT NULL,
    location_url TEXT,
    event_date DATETIME NOT NULL,
    max_players INTEGER DEFAULT NULL,
    actual_attendance INTEGER DEFAULT NULL,
    status TEXT DEFAULT 'active',
    created_by INTEGER REFERENCES users(id),
    reminder_sent INTEGER DEFAULT 0,
    rainout_note TEXT,
    rainout_at DATETIME,
    rainout_email_sent INTEGER DEFAULT 0,
    allowed_emails TEXT DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS event_duties (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT,
    slots_needed INTEGER DEFAULT 1,
    sort_order INTEGER DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS attendees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    email TEXT NOT NULL COLLATE NOCASE,
    is_guest INTEGER DEFAULT 0,
    status TEXT DEFAULT 'attending',
    gear_bringing TEXT,
    notes TEXT,
    players_count INTEGER DEFAULT 1,
    spectators_count INTEGER DEFAULT 0,
    additional_guests INTEGER DEFAULT 0,
    guest_names TEXT,
    management_token TEXT UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(event_id, email)
  )`,
  `CREATE TABLE IF NOT EXISTS duty_assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    duty_id INTEGER NOT NULL REFERENCES event_duties(id) ON DELETE CASCADE,
    attendee_id INTEGER NOT NULL REFERENCES attendees(id) ON DELETE CASCADE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(duty_id, attendee_id)
  )`,
  `CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    author_name TEXT NOT NULL,
    author_email TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS default_duties (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    slots_needed INTEGER DEFAULT 1,
    sort_order INTEGER DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    summary TEXT,
    media_url TEXT,
    media_type TEXT,
    author_id INTEGER,
    author_name TEXT NOT NULL,
    event_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS banned_emails (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    reason TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS rate_limits (
    key TEXT PRIMARY KEY,
    count INTEGER DEFAULT 0,
    window_start INTEGER NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS idx_events_date ON events(event_date)',
  'CREATE INDEX IF NOT EXISTS idx_attendees_event ON attendees(event_id)',
  'CREATE INDEX IF NOT EXISTS idx_comments_event ON comments(event_id)',
  'CREATE INDEX IF NOT EXISTS idx_posts_created_at ON posts(created_at DESC)'
];

export const ALTER_STATEMENTS = [
  'ALTER TABLE auth_codes ADD COLUMN attempts INTEGER DEFAULT 0',
  'ALTER TABLE events ADD COLUMN allowed_emails TEXT DEFAULT NULL',
  'ALTER TABLE events ADD COLUMN actual_attendance INTEGER DEFAULT NULL',
  'ALTER TABLE events ADD COLUMN rainout_note TEXT DEFAULT NULL',
  'ALTER TABLE events ADD COLUMN rainout_at DATETIME DEFAULT NULL',
  'ALTER TABLE events ADD COLUMN rainout_email_sent INTEGER DEFAULT 0',
  'ALTER TABLE attendees ADD COLUMN additional_guests INTEGER DEFAULT 0',
  'ALTER TABLE attendees ADD COLUMN guest_names TEXT',
  'ALTER TABLE attendees ADD COLUMN players_count INTEGER DEFAULT NULL',
  'ALTER TABLE attendees ADD COLUMN spectators_count INTEGER DEFAULT 0',
  'ALTER TABLE users ADD COLUMN bio TEXT',
  'ALTER TABLE users ADD COLUMN avatar_url TEXT',
  "ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'player'",
  'ALTER TABLE users ADD COLUMN machine_badge INTEGER DEFAULT 0',
  'ALTER TABLE users ADD COLUMN field_badge INTEGER DEFAULT 0',
  'ALTER TABLE users ADD COLUMN hero_credits INTEGER DEFAULT 0'
];

const migratedDbs = new WeakSet();

export async function ensureD1Schema(db, force = false) {
  if (!db || (!force && migratedDbs.has(db))) return;

  for (const sql of CREATE_TABLES_SQL) {
    try { await db.prepare(sql).run(); } catch (e) {}
  }
  for (const sql of ALTER_STATEMENTS) {
    try { await db.prepare(sql).run(); } catch (e) {}
  }
  try {
    await db.prepare(`
      UPDATE attendees
      SET players_count = CASE WHEN status = 'declined' THEN 0 ELSE 1 + COALESCE(additional_guests, 0) END
      WHERE players_count IS NULL
    `).run();
  } catch (e) {}

  try {
    await db.prepare("UPDATE users SET role = 'admin' WHERE is_admin = 1 AND (role IS NULL OR role = 'player')").run();
    await db.prepare("UPDATE users SET is_admin = 1 WHERE role = 'admin'").run();
    await db.prepare("UPDATE users SET role = 'player' WHERE role IS NULL").run();
    await db.prepare("UPDATE users SET role = 'organizer' WHERE role = 'facilitator'").run();
  } catch (e) {}

  migratedDbs.add(db);
}

export async function getDefaultDuties(db) {
  let { results } = await db.prepare(
    'SELECT title, description, slots_needed, sort_order FROM default_duties ORDER BY sort_order ASC, id ASC'
  ).all();
  if (!results || results.length === 0) {
    return DEFAULT_BASEBALL_DUTIES;
  }
  const hasFacilitator = results.some(r => r.title && r.title.toLowerCase().includes('facilitator'));
  const hasWaterFood = results.some(r => r.title && (r.title.toLowerCase().includes('water') || r.title.toLowerCase().includes('food')));
  if (!hasFacilitator || !hasWaterFood) {
    try {
      const maxSort = results.reduce((m, r) => Math.max(m, r.sort_order || 0), 0);
      if (!hasFacilitator) {
        await db.prepare('INSERT INTO default_duties (title, description, slots_needed, sort_order) VALUES (?, ?, ?, ?)').bind(
          'Game Facilitator', 'Help coordinate teams, batting order, and fair play throughout the game.', 1, maxSort + 1
        ).run();
      }
      if (!hasWaterFood) {
        await db.prepare('INSERT INTO default_duties (title, description, slots_needed, sort_order) VALUES (?, ?, ?, ?)').bind(
          'Water / Food', 'Bring drinking water, ice, and dugout snacks or fruit for players.', 1, maxSort + 2
        ).run();
      }
      const refetched = await db.prepare(
        'SELECT title, description, slots_needed, sort_order FROM default_duties ORDER BY sort_order ASC, id ASC'
      ).all();
      if (refetched && refetched.results && refetched.results.length > 0) {
        results = refetched.results;
      }
    } catch (e) {
      console.warn('[getDefaultDuties] Auto-seed error:', e);
    }
  }
  return results;
}

export async function getRequireLoginSetting(db, env) {
  const row = await db.prepare("SELECT value FROM app_settings WHERE key = 'require_login_to_rsvp'").first();
  if (row) return row.value === 'true';
  return env && env.NODE_ENV === 'test' ? false : true;
}
