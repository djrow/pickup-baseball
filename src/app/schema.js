/**
 * @fileoverview Unified Database Schema, Idempotent Migrations & Default Volunteer Tasks.
 * Compatible with Cloudflare D1 and local SQLite (via `src/d1-sqlite.js` adapter).
 *
 * TABLE OF CONTENTS:
 * 1. BASEBALL_DB (`DEFAULT_BASEBALL_DUTIES`, `CREATE_TABLES_SQL`, `ALTER_STATEMENTS`, `ensureD1Schema`)
 * 2. CHAT_DB     (`DEFAULT_CHAT_CHANNELS`, `CREATE_CHAT_TABLES_SQL`, `CHAT_ALTER_STATEMENTS`, `ensureChatD1Schema`)
 * 3. Orchestration & Helpers (`ensureClubhouseOptInBackfill`, `ensureDualD1Schema`, `getDefaultDuties`, `getRequireLoginSetting`)
 *
 * @module app/schema
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
  'ALTER TABLE attendees ADD COLUMN urgent_credit_awarded INTEGER DEFAULT 0',
  'ALTER TABLE users ADD COLUMN bio TEXT',
  'ALTER TABLE users ADD COLUMN avatar_url TEXT',
  'ALTER TABLE media_items ADD COLUMN is_approved INTEGER DEFAULT 0',
  'ALTER TABLE media_items ADD COLUMN approved_by INTEGER DEFAULT NULL',
  'ALTER TABLE media_items ADD COLUMN approved_at DATETIME DEFAULT NULL',
  'ALTER TABLE media_items ADD COLUMN delete_token TEXT',
  "ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'player'",
  'ALTER TABLE users ADD COLUMN machine_badge INTEGER DEFAULT 0',
  'ALTER TABLE users ADD COLUMN field_badge INTEGER DEFAULT 0',
  'ALTER TABLE users ADD COLUMN hero_credits INTEGER DEFAULT 0',
  "ALTER TABLE users ADD COLUMN waiver_status TEXT DEFAULT 'none'",
  'ALTER TABLE users ADD COLUMN waiver_signed_at DATETIME DEFAULT NULL',
  'ALTER TABLE users ADD COLUMN is_moderator INTEGER DEFAULT 0',
  'ALTER TABLE users ADD COLUMN chat_muted INTEGER DEFAULT 0',
  'ALTER TABLE users ADD COLUMN chat_muted_reason TEXT DEFAULT NULL',
  'ALTER TABLE users ADD COLUMN chat_muted_by INTEGER DEFAULT NULL',
  'ALTER TABLE users ADD COLUMN chat_muted_at DATETIME DEFAULT NULL',
  'ALTER TABLE users ADD COLUMN clubhouse_opted_in INTEGER DEFAULT 0',
  'ALTER TABLE users ADD COLUMN calendar_token TEXT DEFAULT NULL',
  'ALTER TABLE sessions ADD COLUMN is_temporary INTEGER DEFAULT 0',
  'ALTER TABLE auth_codes ADD COLUMN shared_device INTEGER DEFAULT 0',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_calendar_token ON users(calendar_token) WHERE calendar_token IS NOT NULL'
];

const migratedDbs = new WeakSet();
const BASEBALL_SCHEMA_VERSION = '2026-11-14.1';

async function runSchemaBatch(db, sqlList) {
  if (typeof db.batch === 'function' && sqlList.length > 1) {
    try {
      await db.batch(sqlList.map((sql) => db.prepare(sql)));
      return;
    } catch (e) {}
  }
  for (const sql of sqlList) {
    try { await db.prepare(sql).run(); } catch (e) {}
  }
}

export async function ensureD1Schema(db, force = false) {
  if (!db || (!force && migratedDbs.has(db))) return;

  let alreadyAtVersion = false;
  if (!force) {
    try {
      const verRow = await db.prepare("SELECT value FROM app_settings WHERE key = 'schema_version'").first();
      if (verRow && verRow.value === BASEBALL_SCHEMA_VERSION) {
        alreadyAtVersion = true;
      }
    } catch (e) {}
  }

  if (!alreadyAtVersion) {
    await runSchemaBatch(db, CREATE_TABLES_SQL);

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
      await runSchemaBatch(db, [
        "UPDATE users SET role = 'admin' WHERE is_admin = 1 AND (role IS NULL OR role = 'player')",
        "UPDATE users SET is_admin = 1 WHERE role = 'admin'",
        "UPDATE users SET role = 'player' WHERE role IS NULL",
        "UPDATE users SET role = 'organizer' WHERE role = 'facilitator'",
        "UPDATE events SET location = 'Bushrod Park Field 1' WHERE location = 'Bushrod Part Field 1'",
        "UPDATE media_items SET is_approved = 1 WHERE is_approved IS NULL OR (is_approved = 0 AND id <= 10)"
      ]);
    } catch (e) {}

    try {
      await db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('schema_version', ?)").bind(BASEBALL_SCHEMA_VERSION).run();
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

        const insertMediaSql = `
          INSERT INTO media_items (title, caption, media_type, original_url, file_url, file_data, mime_type, file_size, album, date_taken, contributor_name, is_approved)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        `;
        const seedStatements = [
          db.prepare(insertMediaSql).bind(
            'Bushrod Opening Infield Drag',
            'Field prep crew dragging the diamond and setting out bases at 11 AM.',
            'photo', null, '/api/media/1/file', sampleB64_1, 'image/svg+xml', sampleSvg1.length,
            'Bushrod Field Opening', '2026-10-12', 'Sarah Chen'
          ),
          db.prepare(insertMediaSql).bind(
            '2026 Fall Season Walk-Off Thriller',
            'Full 9th-inning game recap and highlights from the Sunday Championship.',
            'youtube', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
            null, null, 0, 'Fall 2026 Season', '2026-10-26', 'Marcus Rivera'
          ),
          db.prepare(insertMediaSql).bind(
            'Dugout Rally Celebration',
            'Team celebrating the walk-off double at home plate.',
            'photo', null, '/api/media/3/file', sampleB64_2, 'image/svg+xml', sampleSvg2.length,
            'Fall 2026 Season', '2026-10-26', 'Alex Johnson'
          ),
          db.prepare(insertMediaSql).bind(
            'Pitching Machine Setup & Batting Practice',
            'Morning batting practice warmup session with the pitching machine.',
            'youtube', 'https://www.youtube.com/watch?v=L_LUpnjgPso', 'https://www.youtube.com/watch?v=L_LUpnjgPso',
            null, null, 0, 'Bushrod Field Opening', '2026-10-12', 'Coach Dave'
          ),
          db.prepare(insertMediaSql).bind(
            'Summer Classic Outfield Catch',
            'Diving catch on the warning track during the August tournament.',
            'photo', null, '/api/media/5/file', sampleB64_3, 'image/svg+xml', sampleSvg3.length,
            'Summer Classic 2026', '2026-08-16', 'Marcus Rivera'
          )
        ];
        if (typeof db.batch === 'function') {
          await db.batch(seedStatements);
        } else {
          for (const st of seedStatements) await st.run();
        }
      }
    } catch (e) {
      // Media seeding optional
    }
  }

  migratedDbs.add(db);
}

export const DEFAULT_CHAT_CHANNELS = [
  {
    slug: 'announcements',
    name: '#announcements',
    category: 'Clubhouse Info',
    channel_type: 'announcement',
    topic: 'Official game schedules, rainout alerts, and foundation updates.',
    min_role_read: 'player',
    min_role_write: 'organizer',
    is_encrypted: 0,
    sort_order: 1
  },
  {
    slug: 'general',
    name: '#general',
    category: 'Text Channels',
    channel_type: 'text',
    topic: 'Main community hangout for all players.',
    min_role_read: 'player',
    min_role_write: 'player',
    is_encrypted: 1,
    sort_order: 2
  },
  {
    slug: 'sunday-game-day',
    name: '#sunday-game-day',
    category: 'Text Channels',
    channel_type: 'text',
    topic: 'Carpools, gear requests, batting practice chat, and post-game highlights.',
    min_role_read: 'player',
    min_role_write: 'player',
    is_encrypted: 1,
    sort_order: 3
  },
  {
    slug: 'highlights-and-media',
    name: '#highlights-and-media',
    category: 'Text Channels',
    channel_type: 'text',
    topic: 'Drop HD game photos & slow-mo videos (stored in PBF Shared Drive); Admins can 1-click promote to the public Gallery.',
    min_role_read: 'player',
    min_role_write: 'player',
    is_encrypted: 1,
    sort_order: 4
  },
  {
    slug: 'facilitators-lounge',
    name: '#facilitators-lounge',
    category: 'Staff & Operations',
    channel_type: 'text',
    topic: 'Private coordination channel for Admins, Organizers, and whoever is signed up for the Game Facilitator volunteer task.',
    min_role_read: 'facilitator',
    min_role_write: 'facilitator',
    is_encrypted: 1,
    sort_order: 5
  },
  {
    slug: 'dugout-voice-huddle',
    name: '🔊 Dugout Voice Huddle',
    category: 'Voice Lounges',
    channel_type: 'voice',
    topic: 'Drop-in P2P voice, video, and screen sharing (up to 8 peers per room).',
    min_role_read: 'player',
    min_role_write: 'player',
    is_encrypted: 0,
    sort_order: 6
  },
  {
    slug: 'organizers-war-room',
    name: '🔊 Organizers War Room',
    category: 'Voice Lounges',
    channel_type: 'voice',
    topic: 'Quick game-day weather and logistics call room.',
    min_role_read: 'facilitator',
    min_role_write: 'facilitator',
    is_encrypted: 0,
    sort_order: 7
  }
];

export const CREATE_CHAT_TABLES_SQL = [
  // 1. Channel Categories & Channels
  `CREATE TABLE IF NOT EXISTS channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'Text Channels',
    channel_type TEXT NOT NULL DEFAULT 'text',
    topic TEXT DEFAULT '',
    min_role_read TEXT NOT NULL DEFAULT 'player',
    min_role_write TEXT NOT NULL DEFAULT 'player',
    is_encrypted INTEGER NOT NULL DEFAULT 1,
    is_private INTEGER NOT NULL DEFAULT 0,
    linked_event_id INTEGER DEFAULT NULL,
    retention_days INTEGER DEFAULT 365,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,

  // 2. DM & Private Channel Membership
  `CREATE TABLE IF NOT EXISTS channel_members (
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL,
    role TEXT DEFAULT 'member',
    last_read_message_id INTEGER DEFAULT 0,
    muted INTEGER DEFAULT 0,
    hidden INTEGER NOT NULL DEFAULT 0,
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (channel_id, user_id)
  )`,

  // 3. Messages & Threads
  `CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    parent_message_id INTEGER DEFAULT NULL REFERENCES messages(id) ON DELETE CASCADE,
    author_id INTEGER NOT NULL,
    author_name TEXT NOT NULL,
    author_role TEXT DEFAULT 'player',
    author_badges TEXT DEFAULT '{}',
    content TEXT NOT NULL,
    iv TEXT DEFAULT NULL,
    key_epoch INTEGER DEFAULT 1,
    message_type TEXT NOT NULL DEFAULT 'text',
    metadata_json TEXT DEFAULT NULL,
    reply_count INTEGER NOT NULL DEFAULT 0,
    edited_at DATETIME DEFAULT NULL,
    deleted_at DATETIME DEFAULT NULL,
    hidden_at DATETIME DEFAULT NULL,
    hidden_by INTEGER DEFAULT NULL,
    hidden_by_name TEXT DEFAULT NULL,
    hidden_reason TEXT DEFAULT NULL,
    original_content TEXT DEFAULT NULL,
    original_iv TEXT DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,

  // 4. Emoji Reactions
  `CREATE TABLE IF NOT EXISTS message_reactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL,
    user_name TEXT NOT NULL,
    emoji TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(message_id, user_id, emoji)
  )`,

  // 5. Media & Large File Attachments
  `CREATE TABLE IF NOT EXISTS chat_attachments (
    id TEXT PRIMARY KEY,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    message_id INTEGER DEFAULT NULL REFERENCES messages(id) ON DELETE SET NULL,
    uploader_id INTEGER NOT NULL,
    file_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    storage_provider TEXT NOT NULL DEFAULT 'gdrive',
    drive_file_id TEXT DEFAULT NULL,
    resumable_session_uri TEXT DEFAULT NULL,
    upload_status TEXT NOT NULL DEFAULT 'pending',
    is_encrypted INTEGER NOT NULL DEFAULT 0,
    iv TEXT DEFAULT NULL,
    thumbnail_base64 TEXT DEFAULT NULL,
    local_data_base64 TEXT DEFAULT NULL,
    promoted_media_id INTEGER DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,

  // 6. User Crypto Identities & Zero-Knowledge Backup Vault
  `CREATE TABLE IF NOT EXISTS user_crypto_keys (
    user_id INTEGER PRIMARY KEY,
    ecdh_public_key_jwk TEXT NOT NULL,
    ecdsa_public_key_jwk TEXT NOT NULL,
    encrypted_private_vault TEXT DEFAULT NULL,
    vault_salt TEXT DEFAULT NULL,
    vault_iv TEXT DEFAULT NULL,
    privacy_relay_mode INTEGER NOT NULL DEFAULT 0,
    status_text TEXT DEFAULT '',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,

  // 7. Channel Epoch Key Shares
  `CREATE TABLE IF NOT EXISTS channel_key_shares (
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    key_epoch INTEGER NOT NULL DEFAULT 1,
    recipient_user_id INTEGER NOT NULL,
    sender_user_id INTEGER NOT NULL,
    wrapped_key_base64 TEXT NOT NULL,
    wrap_iv TEXT NOT NULL,
    sender_ephemeral_pub_jwk TEXT DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (channel_id, key_epoch, recipient_user_id)
  )`,

  // 8. Voice Room Presence
  `CREATE TABLE IF NOT EXISTS voice_participants (
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL,
    user_name TEXT NOT NULL,
    muted INTEGER NOT NULL DEFAULT 0,
    deafened INTEGER NOT NULL DEFAULT 0,
    screen_sharing INTEGER NOT NULL DEFAULT 0,
    heartbeat_at INTEGER NOT NULL,
    PRIMARY KEY (channel_id, user_id)
  )`,

  // 9. Scoped WebRTC Signaling Queue
  `CREATE TABLE IF NOT EXISTS rtc_signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    sender_user_id INTEGER NOT NULL,
    recipient_user_id INTEGER NOT NULL,
    signal_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,

  // 10. Delta Sync Deletion Tombstones
  `CREATE TABLE IF NOT EXISTS sync_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    target_id INTEGER NOT NULL,
    payload_json TEXT DEFAULT NULL,
    created_at INTEGER NOT NULL
  )`,

  // 11. Rate Limits
  `CREATE TABLE IF NOT EXISTS chat_rate_limits (
    key TEXT PRIMARY KEY,
    count INTEGER DEFAULT 0,
    window_start INTEGER NOT NULL
  )`,

  // 12. Moderation Reports (Messages & Users)
  `CREATE TABLE IF NOT EXISTS chat_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reporter_id INTEGER NOT NULL,
    reporter_name TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_user_id INTEGER DEFAULT NULL,
    target_user_name TEXT DEFAULT '',
    target_message_id INTEGER DEFAULT NULL,
    channel_id INTEGER DEFAULT NULL,
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    reviewed_by INTEGER DEFAULT NULL,
    reviewed_by_name TEXT DEFAULT NULL,
    resolution_note TEXT DEFAULT NULL,
    reviewed_at DATETIME DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,

  // 13. Personal User Mutes (Hides chat/audio only; never affects baseball RSVPs)
  `CREATE TABLE IF NOT EXISTS user_mutes (
    muter_user_id INTEGER NOT NULL,
    muted_user_id INTEGER NOT NULL,
    reason TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (muter_user_id, muted_user_id)
  )`,

  // 14. Clubhouse Community GIF Library (Metadata only in D1; binary hosted in PBF Shared Drive)
  `CREATE TABLE IF NOT EXISTS clubhouse_gifs (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    tags TEXT DEFAULT '',
    mime_type TEXT NOT NULL DEFAULT 'image/gif',
    file_size INTEGER NOT NULL DEFAULT 0,
    source_url TEXT DEFAULT NULL,
    sha256 TEXT DEFAULT NULL,
    storage_provider TEXT NOT NULL DEFAULT 'gdrive',
    drive_file_id TEXT DEFAULT NULL,
    local_data_base64 TEXT DEFAULT NULL,
    added_by INTEGER NOT NULL,
    added_by_name TEXT DEFAULT '',
    is_public INTEGER NOT NULL DEFAULT 1,
    use_count INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,

  // 15. Clubhouse Opt-Out Registry (non-destructive hiding of opted-out users' messages/reactions)
  `CREATE TABLE IF NOT EXISTS clubhouse_opted_out (
    user_id INTEGER PRIMARY KEY,
    opted_out_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,

  // Indexes
  'CREATE INDEX IF NOT EXISTS idx_messages_channel_id ON messages(channel_id, id ASC)',
  'CREATE INDEX IF NOT EXISTS idx_messages_ch_del_id ON messages(channel_id, deleted_at, id ASC)',
  'CREATE INDEX IF NOT EXISTS idx_messages_parent_id ON messages(parent_message_id, id ASC)',
  'CREATE INDEX IF NOT EXISTS idx_messages_author ON messages(author_id)',
  'CREATE INDEX IF NOT EXISTS idx_channel_members_user ON channel_members(user_id)',
  'CREATE INDEX IF NOT EXISTS idx_channels_linked_event ON channels(linked_event_id)',
  'CREATE INDEX IF NOT EXISTS idx_voice_participants_hb ON voice_participants(heartbeat_at)',
  'CREATE INDEX IF NOT EXISTS idx_reactions_msg ON message_reactions(message_id)',
  'CREATE INDEX IF NOT EXISTS idx_attachments_msg ON chat_attachments(message_id)',
  'CREATE INDEX IF NOT EXISTS idx_rtc_signals_recipient ON rtc_signals(recipient_user_id, id ASC)',
  'CREATE INDEX IF NOT EXISTS idx_rtc_signals_created ON rtc_signals(created_at)',
  'CREATE INDEX IF NOT EXISTS idx_rtc_signals_recipient_created ON rtc_signals(recipient_user_id, created_at)',
  'CREATE INDEX IF NOT EXISTS idx_sync_events_id ON sync_events(id ASC)',
  'CREATE INDEX IF NOT EXISTS idx_chat_reports_status ON chat_reports(status, id DESC)',
  'CREATE INDEX IF NOT EXISTS idx_chat_reports_lookup ON chat_reports(reporter_id, target_type, status)',
  'CREATE INDEX IF NOT EXISTS idx_user_mutes_muter ON user_mutes(muter_user_id)',
  'CREATE INDEX IF NOT EXISTS idx_clubhouse_gifs_public ON clubhouse_gifs(is_public, use_count DESC, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_clubhouse_gifs_source ON clubhouse_gifs(source_url)',
  'CREATE INDEX IF NOT EXISTS idx_clubhouse_gifs_sha256 ON clubhouse_gifs(sha256)'
];

export const CHAT_ALTER_STATEMENTS = [
  'ALTER TABLE messages ADD COLUMN hidden_at DATETIME DEFAULT NULL',
  'ALTER TABLE messages ADD COLUMN hidden_by INTEGER DEFAULT NULL',
  'ALTER TABLE messages ADD COLUMN hidden_by_name TEXT DEFAULT NULL',
  'ALTER TABLE messages ADD COLUMN hidden_reason TEXT DEFAULT NULL',
  'ALTER TABLE messages ADD COLUMN original_content TEXT DEFAULT NULL',
  'ALTER TABLE messages ADD COLUMN original_iv TEXT DEFAULT NULL',
  'ALTER TABLE channels ADD COLUMN is_private INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE channel_members ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0'
];

const migratedChatDbs = new WeakSet();

export async function ensureChatD1Schema(chatDb, force = false) {
  if (!chatDb || (!force && migratedChatDbs.has(chatDb))) return;

  if (typeof chatDb.prepare === 'function') {
    await runSchemaBatch(chatDb, CREATE_CHAT_TABLES_SQL);
  } else if (typeof chatDb.exec === 'function') {
    for (const sql of CREATE_CHAT_TABLES_SQL) {
      try { chatDb.exec(sql); } catch (e) {}
    }
  }

  let needsColumnAlter = true;
  if (!force && typeof chatDb.prepare === 'function') {
    try {
      const [msgColsRes, chColsRes, cmColsRes] = typeof chatDb.batch === 'function'
        ? await chatDb.batch([
            chatDb.prepare('PRAGMA table_info(messages)'),
            chatDb.prepare('PRAGMA table_info(channels)'),
            chatDb.prepare('PRAGMA table_info(channel_members)')
          ])
        : [
            await chatDb.prepare('PRAGMA table_info(messages)').all(),
            await chatDb.prepare('PRAGMA table_info(channels)').all(),
            await chatDb.prepare('PRAGMA table_info(channel_members)').all()
          ];
      const msgCols = new Set(((msgColsRes && msgColsRes.results) || []).map((c) => c.name));
      const chCols = new Set(((chColsRes && chColsRes.results) || []).map((c) => c.name));
      const cmCols = new Set(((cmColsRes && cmColsRes.results) || []).map((c) => c.name));
      if (msgCols.has('hidden_at') && msgCols.has('original_iv') && chCols.has('is_private') && cmCols.has('hidden')) {
        needsColumnAlter = false;
      }
    } catch (e) {}
  }

  if (needsColumnAlter) {
    for (const sql of CHAT_ALTER_STATEMENTS) {
      try {
        if (typeof chatDb.prepare === 'function') {
          await chatDb.prepare(sql).run();
        } else if (typeof chatDb.exec === 'function') {
          chatDb.exec(sql);
        }
      } catch (e) {
        // Ignore if column exists
      }
    }
  }

  const channelSeedSql = `
    INSERT INTO channels (slug, name, category, channel_type, topic, min_role_read, min_role_write, is_encrypted, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(slug) DO NOTHING
  `;
  const oldHighlightsTopic = 'Drop HD game photos & slow-mo videos (stored in 5 TB Google Drive); Admins can 1-click promote to the public Gallery.';
  const newHighlightsTopic = 'Drop HD game photos & slow-mo videos (stored in PBF Shared Drive); Admins can 1-click promote to the public Gallery.';
  const topicSyncSql = `
    UPDATE channels SET topic = ?
    WHERE slug = 'highlights-and-media' AND topic = ?
  `;
  if (typeof chatDb.prepare === 'function' && typeof chatDb.batch === 'function') {
    try {
      await chatDb.batch([
        ...DEFAULT_CHAT_CHANNELS.map((ch) =>
          chatDb.prepare(channelSeedSql).bind(
            ch.slug, ch.name, ch.category, ch.channel_type, ch.topic,
            ch.min_role_read, ch.min_role_write, ch.is_encrypted, ch.sort_order
          )
        ),
        chatDb.prepare(topicSyncSql).bind(newHighlightsTopic, oldHighlightsTopic)
      ]);
      migratedChatDbs.add(chatDb);
      return;
    } catch (e) {}
  }

  for (const ch of DEFAULT_CHAT_CHANNELS) {
    try {
      if (typeof chatDb.prepare === 'function') {
        const stmt = chatDb.prepare(channelSeedSql);
        if (typeof stmt.bind === 'function') {
          await stmt.bind(
            ch.slug, ch.name, ch.category, ch.channel_type, ch.topic,
            ch.min_role_read, ch.min_role_write, ch.is_encrypted, ch.sort_order
          ).run();
        } else if (typeof stmt.run === 'function') {
          stmt.run(
            ch.slug, ch.name, ch.category, ch.channel_type, ch.topic,
            ch.min_role_read, ch.min_role_write, ch.is_encrypted, ch.sort_order
          );
        }
      }
    } catch (e) {
      console.warn(`[ensureChatD1Schema] Error seeding channel ${ch.slug}:`, e);
    }
  }

  try {
    if (typeof chatDb.prepare === 'function') {
      const syncStmt = chatDb.prepare(topicSyncSql);
      if (typeof syncStmt.bind === 'function') {
        await syncStmt.bind(newHighlightsTopic, oldHighlightsTopic).run();
      } else if (typeof syncStmt.run === 'function') {
        syncStmt.run(newHighlightsTopic, oldHighlightsTopic);
      }
    }
  } catch (e) {}

  migratedChatDbs.add(chatDb);
}

export const ensureBaseballD1Schema = ensureD1Schema;

const backfilledOptInDbs = new WeakSet();

export async function ensureClubhouseOptInBackfill(baseballDb, chatDb, force = false) {
  if (!baseballDb || !chatDb || (!force && backfilledOptInDbs.has(baseballDb))) return;
  try {
    if (!force) {
      const flag = await baseballDb.prepare("SELECT value FROM app_settings WHERE key = 'clubhouse_optin_backfilled'").first();
      if (flag && flag.value === '1') {
        backfilledOptInDbs.add(baseballDb);
        return;
      }
    }

    const activeIds = new Set();
    try {
      const { results: msgAuthors } = await chatDb.prepare('SELECT DISTINCT author_id as uid FROM messages WHERE author_id IS NOT NULL').all();
      for (const r of (msgAuthors || [])) {
        if (r && r.uid) activeIds.add(Number(r.uid));
      }
    } catch (e) {}
    try {
      const { results: keyUsers } = await chatDb.prepare('SELECT DISTINCT user_id as uid FROM user_crypto_keys WHERE user_id IS NOT NULL').all();
      for (const r of (keyUsers || [])) {
        if (r && r.uid) activeIds.add(Number(r.uid));
      }
    } catch (e) {}

    if (activeIds.size > 0) {
      const idsArr = Array.from(activeIds);
      const CHUNK = 80;
      for (let i = 0; i < idsArr.length; i += CHUNK) {
        const slice = idsArr.slice(i, i + CHUNK);
        const ph = slice.map(() => '?').join(',');
        await baseballDb.prepare(`UPDATE users SET clubhouse_opted_in = 1 WHERE id IN (${ph})`).bind(...slice).run();
      }
    }

    await baseballDb.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('clubhouse_optin_backfilled', '1')").run();
    backfilledOptInDbs.add(baseballDb);
  } catch (e) {
    console.warn('[ensureClubhouseOptInBackfill] Warning:', e.message);
  }
}

export async function ensureDualD1Schema(dbs, force = false) {
  const baseball = dbs?.BASEBALL_DB || dbs?.DB || dbs?.baseballDb || dbs?.db;
  const chat = dbs?.CHAT_DB || dbs?.chatDb;
  if (baseball) await ensureBaseballD1Schema(baseball, force);
  if (chat) await ensureChatD1Schema(chat, force);
  if (baseball && chat) await ensureClubhouseOptInBackfill(baseball, chat, force);
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
