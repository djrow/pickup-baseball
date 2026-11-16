/**
 * @fileoverview BASEBALL_DB Table Definitions, Indexes & Default Volunteer Duties.
 * Compatible with Cloudflare D1 and local SQLite (via `src/d1-sqlite.js` adapter).
 *
 * @module app/schema/baseball-ddl
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
    is_moderator INTEGER DEFAULT 0,
    chat_muted INTEGER DEFAULT 0,
    chat_muted_reason TEXT DEFAULT NULL,
    chat_muted_by INTEGER DEFAULT NULL,
    chat_muted_at DATETIME DEFAULT NULL,
    machine_badge INTEGER DEFAULT 0,
    field_badge INTEGER DEFAULT 0,
    hero_credits INTEGER DEFAULT 0,
    waiver_status TEXT DEFAULT 'none',
    waiver_signed_at DATETIME DEFAULT NULL,
    clubhouse_opted_in INTEGER DEFAULT 0,
    calendar_token TEXT DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at DATETIME NOT NULL,
    is_temporary INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS auth_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL COLLATE NOCASE,
    name TEXT,
    code TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    attempts INTEGER DEFAULT 0,
    shared_device INTEGER DEFAULT 0,
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
    urgent_credit_awarded INTEGER DEFAULT 0,
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
  `CREATE TABLE IF NOT EXISTS batting_practice_signups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    attendee_id INTEGER REFERENCES attendees(id) ON DELETE SET NULL,
    slot_number INTEGER NOT NULL,
    player_name TEXT NOT NULL,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(event_id, slot_number)
  )`,
  `CREATE TABLE IF NOT EXISTS waivers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    certificate_id TEXT NOT NULL UNIQUE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    email TEXT NOT NULL COLLATE NOCASE,
    printed_name TEXT NOT NULL,
    signed_date TEXT NOT NULL,
    signature_type TEXT DEFAULT 'drawn',
    signature_data TEXT NOT NULL,
    document_version TEXT NOT NULL DEFAULT '41335\\14760738.1',
    waiver_text_sha256 TEXT NOT NULL,
    document_sha256 TEXT NOT NULL,
    provenance_seal TEXT NOT NULL,
    signer_ip TEXT,
    user_agent TEXT,
    electronic_consent INTEGER DEFAULT 1,
    gdrive_file_id TEXT DEFAULT NULL,
    signed_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  'CREATE INDEX IF NOT EXISTS idx_events_date ON events(event_date)',
  'CREATE INDEX IF NOT EXISTS idx_events_status_date ON events(status, event_date)',
  'CREATE INDEX IF NOT EXISTS idx_attendees_event ON attendees(event_id)',
  'CREATE INDEX IF NOT EXISTS idx_attendees_user ON attendees(user_id, event_id)',
  'CREATE INDEX IF NOT EXISTS idx_attendees_email ON attendees(email, event_id)',
  'CREATE INDEX IF NOT EXISTS idx_duty_assignments_attendee ON duty_assignments(attendee_id)',
  'CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)',
  'CREATE INDEX IF NOT EXISTS idx_comments_event ON comments(event_id)',
  'CREATE INDEX IF NOT EXISTS idx_posts_created_at ON posts(created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_media_date_taken ON media_items(date_taken DESC)',
  'CREATE INDEX IF NOT EXISTS idx_media_album ON media_items(album)',
  'CREATE INDEX IF NOT EXISTS idx_media_type ON media_items(media_type)',
  'CREATE INDEX IF NOT EXISTS idx_media_approved ON media_items(is_approved)',
  'CREATE INDEX IF NOT EXISTS idx_bp_signups_event ON batting_practice_signups(event_id, slot_number)',
  'CREATE INDEX IF NOT EXISTS idx_bp_signups_event_user ON batting_practice_signups(event_id, user_id)',
  'CREATE INDEX IF NOT EXISTS idx_bp_signups_event_attendee ON batting_practice_signups(event_id, attendee_id)',
  'CREATE INDEX IF NOT EXISTS idx_waivers_user ON waivers(user_id)',
  'CREATE INDEX IF NOT EXISTS idx_waivers_email ON waivers(email)',
  'CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)',
  'CREATE INDEX IF NOT EXISTS idx_auth_codes_email ON auth_codes(email, used_at, expires_at)',
  'CREATE INDEX IF NOT EXISTS idx_event_duties_event ON event_duties(event_id, sort_order)',
  'CREATE INDEX IF NOT EXISTS idx_attendees_event_status ON attendees(event_id, status)',
  'CREATE INDEX IF NOT EXISTS idx_users_clubhouse_opt ON users(clubhouse_opted_in)',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_calendar_token ON users(calendar_token) WHERE calendar_token IS NOT NULL'
];
