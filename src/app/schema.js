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
  `CREATE TABLE IF NOT EXISTS media_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT,
    caption TEXT,
    media_type TEXT NOT NULL,
    original_url TEXT,
    file_url TEXT NOT NULL,
    file_data TEXT,
    mime_type TEXT,
    file_size INTEGER DEFAULT 0,
    album TEXT DEFAULT 'General',
    date_taken TEXT NOT NULL,
    contributor_name TEXT,
    contributor_id INTEGER,
    event_id INTEGER,
    is_approved INTEGER DEFAULT 0,
    approved_by INTEGER DEFAULT NULL,
    approved_at DATETIME DEFAULT NULL,
    delete_token TEXT DEFAULT NULL,
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
  'CREATE INDEX IF NOT EXISTS idx_posts_created_at ON posts(created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_media_date_taken ON media_items(date_taken DESC)',
  'CREATE INDEX IF NOT EXISTS idx_media_album ON media_items(album)',
  'CREATE INDEX IF NOT EXISTS idx_media_type ON media_items(media_type)',
  'CREATE INDEX IF NOT EXISTS idx_media_approved ON media_items(is_approved)'
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
  'ALTER TABLE media_items ADD COLUMN is_approved INTEGER DEFAULT 0',
  'ALTER TABLE media_items ADD COLUMN approved_by INTEGER DEFAULT NULL',
  'ALTER TABLE media_items ADD COLUMN approved_at DATETIME DEFAULT NULL',
  'ALTER TABLE media_items ADD COLUMN delete_token TEXT',
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

  try {
    await db.prepare("UPDATE media_items SET is_approved = 1 WHERE is_approved IS NULL OR (is_approved = 0 AND id <= 10)").run();
  } catch (e) {}

  try {
    const mediaCountRow = await db.prepare("SELECT COUNT(*) as c FROM media_items").first();
    if (mediaCountRow && mediaCountRow.c === 0) {
      const sampleSvg1 = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 500" width="800" height="500"><rect width="800" height="500" fill="#003831"/><circle cx="400" cy="250" r="140" fill="#FD5A1E"/><text x="400" y="260" font-family="sans-serif" font-size="32" font-weight="bold" fill="#ffffff" text-anchor="middle">Bushrod Field Opening Day</text><text x="400" y="300" font-family="sans-serif" font-size="18" fill="#ffffff" text-anchor="middle">Morning Field Drag &amp; Line Marking</text></svg>';
      const sampleB64_1 = btoa(sampleSvg1);

      const sampleSvg2 = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 500" width="800" height="500"><rect width="800" height="500" fill="#1c2b27"/><rect x="100" y="80" width="600" height="340" rx="12" fill="#0c1f1a" stroke="#FD5A1E" stroke-width="4"/><text x="400" y="240" font-family="sans-serif" font-size="30" font-weight="bold" fill="#FD5A1E" text-anchor="middle">9th Inning Walk-Off Rally</text><text x="400" y="280" font-family="sans-serif" font-size="18" fill="#ffffff" text-anchor="middle">Dugout High-Fives &amp; Game Ball Presentation</text></svg>';
      const sampleB64_2 = btoa(sampleSvg2);

      const sampleSvg3 = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 500" width="800" height="500"><rect width="800" height="500" fill="#002823"/><polygon points="400,80 700,420 100,420" fill="#FD5A1E" opacity="0.85"/><text x="400" y="320" font-family="sans-serif" font-size="28" font-weight="bold" fill="#ffffff" text-anchor="middle">Summer Classic Showcase</text><text x="400" y="360" font-family="sans-serif" font-size="16" fill="#ffffff" text-anchor="middle">Mosswood Park Diamond 1</text></svg>';
      const sampleB64_3 = btoa(sampleSvg3);

      const insertMedia = db.prepare(`
        INSERT INTO media_items (title, caption, media_type, original_url, file_url, file_data, mime_type, file_size, album, date_taken, contributor_name, is_approved)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      `);

      await insertMedia.bind(
        'Bushrod Opening Infield Drag',
        'Field prep crew dragging the diamond and setting out bases at 11 AM.',
        'photo',
        null,
        '/api/media/1/file',
        sampleB64_1,
        'image/svg+xml',
        sampleSvg1.length,
        'Bushrod Field Opening',
        '2026-10-12',
        'Sarah Chen'
      ).run();

      await insertMedia.bind(
        '2026 Fall Season Walk-Off Thriller',
        'Full 9th-inning game recap and highlights from the Sunday Championship.',
        'youtube',
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        null,
        null,
        0,
        'Fall 2026 Season',
        '2026-10-26',
        'Marcus Rivera'
      ).run();

      await insertMedia.bind(
        'Dugout Rally Celebration',
        'Team celebrating the walk-off double at home plate.',
        'photo',
        null,
        '/api/media/3/file',
        sampleB64_2,
        'image/svg+xml',
        sampleSvg2.length,
        'Fall 2026 Season',
        '2026-10-26',
        'Alex Johnson'
      ).run();

      await insertMedia.bind(
        'Pitching Machine Setup & Batting Practice',
        'Morning batting practice warmup session with the pitching machine.',
        'youtube',
        'https://www.youtube.com/watch?v=L_LUpnjgPso',
        'https://www.youtube.com/watch?v=L_LUpnjgPso',
        null,
        null,
        0,
        'Bushrod Field Opening',
        '2026-10-12',
        'Coach Dave'
      ).run();

      await insertMedia.bind(
        'Summer Classic Outfield Catch',
        'Diving catch on the warning track during the August tournament.',
        'photo',
        null,
        '/api/media/5/file',
        sampleB64_3,
        'image/svg+xml',
        sampleSvg3.length,
        'Summer Classic 2026',
        '2026-08-16',
        'Marcus Rivera'
      ).run();
    }
  } catch (e) {
    // Media seeding optional
  }

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
