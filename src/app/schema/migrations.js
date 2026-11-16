/**
 * @fileoverview Versioned Schema Migrations & Legacy Data Backfills.
 * Defines ordered integer-versioned migration steps for BASEBALL_DB and CHAT_DB,
 * plus legacy compatibility arrays and one-time Clubhouse opt-in backfill.
 *
 * @module app/schema/migrations
 */

import { CREATE_TABLES_SQL } from './baseball-ddl.js';
import { DEFAULT_CHAT_CHANNELS, CREATE_CHAT_TABLES_SQL } from './chat-ddl.js';
import { hashSessionId, hashManagementToken, MANAGEMENT_TOKEN_PREFIX } from '../security.js';

/**
 * @typedef {Object} MigrationColumnDef
 * @property {string} table
 * @property {string} column
 * @property {string} sql
 */

/**
 * @typedef {Object} MigrationStep
 * @property {number} version
 * @property {string} name
 * @property {string[]} [ensureTables]
 * @property {MigrationColumnDef[]} [columns]
 * @property {string[]} [indexes]
 * @property {string[]} [sqlStatements]
 * @property {(db: D1Database) => Promise<void>} [run]
 */

const isCreateIndexSql = (sql) => /^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\b/i.test(sql);

function extractCreatedTableName(sql) {
  const m = String(sql).match(/^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/i);
  return m ? m[1] : null;
}

function extractCreatedIndexName(sql) {
  const m = String(sql).match(/^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/i);
  return m ? m[1] : null;
}

/** @type {MigrationColumnDef[]} */
const BASEBALL_V1_COLUMNS = [
  { table: 'auth_codes', column: 'attempts', sql: 'ALTER TABLE auth_codes ADD COLUMN attempts INTEGER DEFAULT 0' },
  { table: 'events', column: 'allowed_emails', sql: 'ALTER TABLE events ADD COLUMN allowed_emails TEXT DEFAULT NULL' },
  { table: 'events', column: 'actual_attendance', sql: 'ALTER TABLE events ADD COLUMN actual_attendance INTEGER DEFAULT NULL' },
  { table: 'events', column: 'rainout_note', sql: 'ALTER TABLE events ADD COLUMN rainout_note TEXT DEFAULT NULL' },
  { table: 'events', column: 'rainout_at', sql: 'ALTER TABLE events ADD COLUMN rainout_at DATETIME DEFAULT NULL' },
  { table: 'events', column: 'rainout_email_sent', sql: 'ALTER TABLE events ADD COLUMN rainout_email_sent INTEGER DEFAULT 0' },
  { table: 'attendees', column: 'additional_guests', sql: 'ALTER TABLE attendees ADD COLUMN additional_guests INTEGER DEFAULT 0' },
  { table: 'attendees', column: 'guest_names', sql: 'ALTER TABLE attendees ADD COLUMN guest_names TEXT' },
  { table: 'attendees', column: 'players_count', sql: 'ALTER TABLE attendees ADD COLUMN players_count INTEGER DEFAULT NULL' },
  { table: 'attendees', column: 'spectators_count', sql: 'ALTER TABLE attendees ADD COLUMN spectators_count INTEGER DEFAULT 0' },
  { table: 'attendees', column: 'urgent_credit_awarded', sql: 'ALTER TABLE attendees ADD COLUMN urgent_credit_awarded INTEGER DEFAULT 0' },
  { table: 'users', column: 'bio', sql: 'ALTER TABLE users ADD COLUMN bio TEXT' },
  { table: 'users', column: 'avatar_url', sql: 'ALTER TABLE users ADD COLUMN avatar_url TEXT' },
  { table: 'media_items', column: 'is_approved', sql: 'ALTER TABLE media_items ADD COLUMN is_approved INTEGER DEFAULT 0' },
  { table: 'media_items', column: 'approved_by', sql: 'ALTER TABLE media_items ADD COLUMN approved_by INTEGER DEFAULT NULL' },
  { table: 'media_items', column: 'approved_at', sql: 'ALTER TABLE media_items ADD COLUMN approved_at DATETIME DEFAULT NULL' },
  { table: 'media_items', column: 'delete_token', sql: 'ALTER TABLE media_items ADD COLUMN delete_token TEXT' },
  { table: 'users', column: 'role', sql: "ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'player'" },
  { table: 'users', column: 'machine_badge', sql: 'ALTER TABLE users ADD COLUMN machine_badge INTEGER DEFAULT 0' },
  { table: 'users', column: 'field_badge', sql: 'ALTER TABLE users ADD COLUMN field_badge INTEGER DEFAULT 0' },
  { table: 'users', column: 'hero_credits', sql: 'ALTER TABLE users ADD COLUMN hero_credits INTEGER DEFAULT 0' },
  { table: 'users', column: 'waiver_status', sql: "ALTER TABLE users ADD COLUMN waiver_status TEXT DEFAULT 'none'" },
  { table: 'users', column: 'waiver_signed_at', sql: 'ALTER TABLE users ADD COLUMN waiver_signed_at DATETIME DEFAULT NULL' },
  { table: 'users', column: 'is_moderator', sql: 'ALTER TABLE users ADD COLUMN is_moderator INTEGER DEFAULT 0' },
  { table: 'users', column: 'chat_muted', sql: 'ALTER TABLE users ADD COLUMN chat_muted INTEGER DEFAULT 0' },
  { table: 'users', column: 'chat_muted_reason', sql: 'ALTER TABLE users ADD COLUMN chat_muted_reason TEXT DEFAULT NULL' },
  { table: 'users', column: 'chat_muted_by', sql: 'ALTER TABLE users ADD COLUMN chat_muted_by INTEGER DEFAULT NULL' },
  { table: 'users', column: 'chat_muted_at', sql: 'ALTER TABLE users ADD COLUMN chat_muted_at DATETIME DEFAULT NULL' },
  { table: 'users', column: 'clubhouse_opted_in', sql: 'ALTER TABLE users ADD COLUMN clubhouse_opted_in INTEGER DEFAULT 0' },
  { table: 'users', column: 'calendar_token', sql: 'ALTER TABLE users ADD COLUMN calendar_token TEXT DEFAULT NULL' },
  { table: 'sessions', column: 'is_temporary', sql: 'ALTER TABLE sessions ADD COLUMN is_temporary INTEGER DEFAULT 0' },
  { table: 'auth_codes', column: 'shared_device', sql: 'ALTER TABLE auth_codes ADD COLUMN shared_device INTEGER DEFAULT 0' }
];

const BASEBALL_V1_INDEXES = [
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_calendar_token ON users(calendar_token) WHERE calendar_token IS NOT NULL'
];

export const ALTER_STATEMENTS = [
  ...BASEBALL_V1_COLUMNS.map((c) => c.sql),
  ...BASEBALL_V1_INDEXES
];

/** @type {MigrationColumnDef[]} */
const CHAT_V1_COLUMNS = [
  { table: 'messages', column: 'hidden_at', sql: 'ALTER TABLE messages ADD COLUMN hidden_at DATETIME DEFAULT NULL' },
  { table: 'messages', column: 'hidden_by', sql: 'ALTER TABLE messages ADD COLUMN hidden_by INTEGER DEFAULT NULL' },
  { table: 'messages', column: 'hidden_by_name', sql: 'ALTER TABLE messages ADD COLUMN hidden_by_name TEXT DEFAULT NULL' },
  { table: 'messages', column: 'hidden_reason', sql: 'ALTER TABLE messages ADD COLUMN hidden_reason TEXT DEFAULT NULL' },
  { table: 'messages', column: 'original_content', sql: 'ALTER TABLE messages ADD COLUMN original_content TEXT DEFAULT NULL' },
  { table: 'messages', column: 'original_iv', sql: 'ALTER TABLE messages ADD COLUMN original_iv TEXT DEFAULT NULL' },
  { table: 'channels', column: 'is_private', sql: 'ALTER TABLE channels ADD COLUMN is_private INTEGER NOT NULL DEFAULT 0' },
  { table: 'channel_members', column: 'hidden', sql: 'ALTER TABLE channel_members ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0' }
];

export const CHAT_ALTER_STATEMENTS = CHAT_V1_COLUMNS.map((c) => c.sql);

export const ATTENDEES_PLAYERS_COUNT_BACKFILL_SQL = `
        UPDATE attendees
        SET players_count = CASE WHEN status = 'declined' THEN 0 ELSE 1 + COALESCE(additional_guests, 0) END
        WHERE players_count IS NULL
      `;

export const LEGACY_BASEBALL_NORMALIZATION_SQL = [
  "UPDATE users SET role = 'admin' WHERE is_admin = 1 AND (role IS NULL OR role = 'player')",
  "UPDATE users SET is_admin = 1 WHERE role = 'admin'",
  "UPDATE users SET role = 'player' WHERE role IS NULL",
  "UPDATE users SET role = 'organizer' WHERE role = 'facilitator'",
  "UPDATE events SET location = 'Bushrod Park Field 1' WHERE location = 'Bushrod Part Field 1'",
  "UPDATE media_items SET is_approved = 1 WHERE is_approved IS NULL OR (is_approved = 0 AND id <= 10)"
];

export const OLD_HIGHLIGHTS_TOPIC = 'Drop HD game photos & slow-mo videos (stored in 5 TB Google Drive); Admins can 1-click promote to the public Gallery.';
export const NEW_HIGHLIGHTS_TOPIC = 'Drop HD game photos & slow-mo videos (stored in PBF Shared Drive); Admins can 1-click promote to the public Gallery.';
export const HIGHLIGHTS_TOPIC_SYNC_SQL = `
    UPDATE channels SET topic = ?
    WHERE slug = 'highlights-and-media' AND topic = ?
  `;

const CHANNEL_SEED_SQL = `
  INSERT INTO channels (slug, name, category, channel_type, topic, min_role_read, min_role_write, is_encrypted, sort_order)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(slug) DO NOTHING
`;

/**
 * Builds prepared statements to idempotently seed the default Clubhouse channels.
 * @param {D1Database} chatDb
 * @returns {D1PreparedStatement[]}
 */
export function buildDefaultChatChannelStatements(chatDb) {
  return DEFAULT_CHAT_CHANNELS.map((ch) =>
    chatDb.prepare(CHANNEL_SEED_SQL).bind(
      ch.slug, ch.name, ch.category, ch.channel_type, ch.topic,
      ch.min_role_read, ch.min_role_write, ch.is_encrypted, ch.sort_order
    )
  );
}

/**
 * Seeds default Clubhouse channels and syncs the highlights topic on existing CHAT_DB upgrades.
 * @param {D1Database} chatDb
 */
export async function seedDefaultChatChannels(chatDb) {
  const stmts = [
    ...buildDefaultChatChannelStatements(chatDb),
    chatDb.prepare(HIGHLIGHTS_TOPIC_SYNC_SQL).bind(NEW_HIGHLIGHTS_TOPIC, OLD_HIGHLIGHTS_TOPIC)
  ];
  if (typeof chatDb.batch === 'function') {
    await chatDb.batch(stmts);
    return;
  }
  for (const st of stmts) {
    await st.run();
  }
}

const SESSION_BACKFILL_BATCH_SIZE = 50;

/**
 * Purges expired sessions and hashes legacy unprefixed active session IDs
 * in bounded 50-row chunks using WebCrypto SHA-256 (`sha256:<hex>`).
 * @param {D1Database} db
 * @returns {Promise<void>}
 */
export async function backfillHashedSessionIds(db) {
  await db.prepare("DELETE FROM sessions WHERE datetime(expires_at) <= datetime('now')").run();

  let hasMore = true;
  while (hasMore) {
    const { results } = await db.prepare(
      "SELECT id FROM sessions WHERE id NOT LIKE 'sha256:%' LIMIT ?"
    ).bind(SESSION_BACKFILL_BATCH_SIZE).all();

    const rows = /** @type {Array<{ id: string }>} */ (results || []);
    if (rows.length === 0) break;

    const hashes = await Promise.all(rows.map((row) => hashSessionId(row.id)));
    const updateStmts = rows.map((row, idx) =>
      db.prepare('UPDATE sessions SET id = ? WHERE id = ?').bind(hashes[idx], row.id)
    );

    if (typeof db.batch === 'function') {
      await db.batch(updateStmts);
    } else {
      for (const stmt of updateStmts) {
        await stmt.run();
      }
    }

    hasMore = rows.length === SESSION_BACKFILL_BATCH_SIZE;
  }
}

/** @type {MigrationColumnDef[]} */
const BASEBALL_V2_COLUMNS = [
  { table: 'event_duties', column: 'grants_coordinator', sql: 'ALTER TABLE event_duties ADD COLUMN grants_coordinator INTEGER NOT NULL DEFAULT 0' },
  { table: 'event_duties', column: 'required_badge', sql: 'ALTER TABLE event_duties ADD COLUMN required_badge TEXT DEFAULT NULL' },
  { table: 'default_duties', column: 'grants_coordinator', sql: 'ALTER TABLE default_duties ADD COLUMN grants_coordinator INTEGER NOT NULL DEFAULT 0' },
  { table: 'default_duties', column: 'required_badge', sql: 'ALTER TABLE default_duties ADD COLUMN required_badge TEXT DEFAULT NULL' },
  { table: 'events', column: 'invite_enabled', sql: 'ALTER TABLE events ADD COLUMN invite_enabled INTEGER NOT NULL DEFAULT 0' },
  { table: 'events', column: 'invite_version', sql: 'ALTER TABLE events ADD COLUMN invite_version INTEGER NOT NULL DEFAULT 1' },
  { table: 'events', column: 'auto_reminders', sql: 'ALTER TABLE events ADD COLUMN auto_reminders INTEGER NOT NULL DEFAULT 1' },
  { table: 'users', column: 'roster_visibility', sql: 'ALTER TABLE users ADD COLUMN roster_visibility INTEGER NOT NULL DEFAULT 0' },
  { table: 'users', column: 'profile_sharing', sql: 'ALTER TABLE users ADD COLUMN profile_sharing INTEGER NOT NULL DEFAULT 0' },
  { table: 'users', column: 'notify_rsvp_confirm', sql: 'ALTER TABLE users ADD COLUMN notify_rsvp_confirm INTEGER NOT NULL DEFAULT 1' },
  { table: 'users', column: 'notify_rainouts', sql: 'ALTER TABLE users ADD COLUMN notify_rainouts INTEGER NOT NULL DEFAULT 1' },
  { table: 'users', column: 'notify_event_reminders', sql: 'ALTER TABLE users ADD COLUMN notify_event_reminders INTEGER NOT NULL DEFAULT 1' },
  { table: 'users', column: 'notify_community_updates', sql: 'ALTER TABLE users ADD COLUMN notify_community_updates INTEGER NOT NULL DEFAULT 0' },
  { table: 'attendees', column: 'reminder_sent_at', sql: 'ALTER TABLE attendees ADD COLUMN reminder_sent_at DATETIME DEFAULT NULL' },
  { table: 'attendees', column: 'last_notice_key', sql: 'ALTER TABLE attendees ADD COLUMN last_notice_key TEXT DEFAULT NULL' },
  { table: 'attendees', column: 'last_notice_sent_at', sql: 'ALTER TABLE attendees ADD COLUMN last_notice_sent_at DATETIME DEFAULT NULL' },
  { table: 'attendees', column: 'notify_emails', sql: 'ALTER TABLE attendees ADD COLUMN notify_emails INTEGER NOT NULL DEFAULT 0' },
  { table: 'attendees', column: 'roster_consent', sql: 'ALTER TABLE attendees ADD COLUMN roster_consent INTEGER NOT NULL DEFAULT 0' },
  { table: 'attendees', column: 'paper_waiver_at', sql: 'ALTER TABLE attendees ADD COLUMN paper_waiver_at DATETIME DEFAULT NULL' },
  { table: 'attendees', column: 'paper_waiver_by', sql: 'ALTER TABLE attendees ADD COLUMN paper_waiver_by INTEGER DEFAULT NULL' },
  { table: 'waivers', column: 'waiver_locale', sql: "ALTER TABLE waivers ADD COLUMN waiver_locale TEXT NOT NULL DEFAULT 'en'" },
  { table: 'waivers', column: 'status', sql: "ALTER TABLE waivers ADD COLUMN status TEXT NOT NULL DEFAULT 'active'" },
  { table: 'waivers', column: 'erasure_requested_at', sql: 'ALTER TABLE waivers ADD COLUMN erasure_requested_at DATETIME DEFAULT NULL' },
  { table: 'waivers', column: 'retention_until', sql: 'ALTER TABLE waivers ADD COLUMN retention_until DATETIME DEFAULT NULL' },
  { table: 'waivers', column: 'signer_ip_scrubbed_at', sql: 'ALTER TABLE waivers ADD COLUMN signer_ip_scrubbed_at DATETIME DEFAULT NULL' },
  { table: 'media_items', column: 'storage_provider', sql: "ALTER TABLE media_items ADD COLUMN storage_provider TEXT NOT NULL DEFAULT 'local'" },
  { table: 'media_items', column: 'r2_key', sql: 'ALTER TABLE media_items ADD COLUMN r2_key TEXT DEFAULT NULL' },
  { table: 'media_items', column: 'upload_status', sql: "ALTER TABLE media_items ADD COLUMN upload_status TEXT NOT NULL DEFAULT 'ready'" },
  { table: 'media_items', column: 'upload_token_hash', sql: 'ALTER TABLE media_items ADD COLUMN upload_token_hash TEXT DEFAULT NULL' },
  { table: 'rate_limits', column: 'expires_at', sql: 'ALTER TABLE rate_limits ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0' }
];

const BASEBALL_V2_NEW_TABLES = new Set(['consent_records', 'email_suppressions']);
const BASEBALL_V2_NEW_INDEXES = new Set([
  'idx_attendees_reminder_cursor',
  'idx_waivers_status_retention',
  'idx_media_upload_status',
  'idx_consent_user_type',
  'idx_consent_email_type',
  'idx_rate_limits_expires'
]);

const BASEBALL_V2_BACKFILL_SQL = [
  "UPDATE event_duties SET grants_coordinator = 1 WHERE LOWER(title) LIKE '%facilitator%'",
  "UPDATE event_duties SET required_badge = 'machine' WHERE LOWER(title) LIKE '%machine%'",
  "UPDATE event_duties SET required_badge = 'field' WHERE LOWER(title) LIKE '%drag%'",
  "UPDATE default_duties SET grants_coordinator = 1 WHERE LOWER(title) LIKE '%facilitator%'",
  "UPDATE default_duties SET required_badge = 'machine' WHERE LOWER(title) LIKE '%machine%'",
  "UPDATE default_duties SET required_badge = 'field' WHERE LOWER(title) LIKE '%drag%'",
  "UPDATE waivers SET signer_ip = NULL, user_agent = NULL, signer_ip_scrubbed_at = CURRENT_TIMESTAMP WHERE signed_at <= datetime('now', '-30 days') AND (signer_ip IS NOT NULL OR user_agent IS NOT NULL OR signer_ip_scrubbed_at IS NULL)",
  `UPDATE media_items
   SET
     upload_status = 'ready',
     storage_provider = CASE
       WHEN file_data IS NOT NULL AND file_data != '' THEN 'local'
       WHEN (
         LOWER(COALESCE(file_url, '')) LIKE '%drive.google.com%'
         OR LOWER(COALESCE(original_url, '')) LIKE '%drive.google.com%'
         OR LOWER(COALESCE(file_url, '')) LIKE '%docs.google.com%'
         OR LOWER(COALESCE(original_url, '')) LIKE '%docs.google.com%'
         OR LOWER(COALESCE(file_url, '')) LIKE '%photos.google.com%'
         OR LOWER(COALESCE(original_url, '')) LIKE '%photos.google.com%'
         OR LOWER(COALESCE(file_url, '')) LIKE '%photos.app.goo.gl%'
         OR LOWER(COALESCE(original_url, '')) LIKE '%photos.app.goo.gl%'
         OR LOWER(COALESCE(file_url, '')) LIKE '%googleusercontent.com%'
         OR LOWER(COALESCE(original_url, '')) LIKE '%googleusercontent.com%'
       ) THEN 'gdrive'
       ELSE 'external'
     END
   WHERE r2_key IS NULL AND (upload_status IS NULL OR upload_status = 'ready')`,
  'DELETE FROM rate_limits'
];

/** @type {MigrationColumnDef[]} */
const CHAT_V2_COLUMNS = [
  { table: 'user_crypto_keys', column: 'key_version', sql: 'ALTER TABLE user_crypto_keys ADD COLUMN key_version INTEGER NOT NULL DEFAULT 1' },
  { table: 'user_crypto_keys', column: 'key_rotated_at', sql: 'ALTER TABLE user_crypto_keys ADD COLUMN key_rotated_at DATETIME DEFAULT NULL' },
  { table: 'chat_attachments', column: 'r2_key', sql: 'ALTER TABLE chat_attachments ADD COLUMN r2_key TEXT DEFAULT NULL' },
  { table: 'clubhouse_gifs', column: 'r2_key', sql: 'ALTER TABLE clubhouse_gifs ADD COLUMN r2_key TEXT DEFAULT NULL' },
  { table: 'chat_rate_limits', column: 'expires_at', sql: 'ALTER TABLE chat_rate_limits ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0' }
];

const CHAT_V2_NEW_TABLES = new Set(['user_blocks']);
const CHAT_V2_NEW_INDEXES = new Set([
  'idx_user_blocks_blocked',
  'idx_chat_attachments_upload_status',
  'idx_chat_rate_limits_expires'
]);

const CHAT_V2_BACKFILL_SQL = [
  'DELETE FROM chat_rate_limits'
];

/** @type {MigrationStep[]} */
export const BASEBALL_MIGRATIONS = [
  {
    version: 1,
    name: 'baseline-consolidated-schema',
    ensureTables: CREATE_TABLES_SQL.filter(
      (sql) => !isCreateIndexSql(sql) && !BASEBALL_V2_NEW_TABLES.has(extractCreatedTableName(sql))
    ),
    columns: BASEBALL_V1_COLUMNS,
    indexes: CREATE_TABLES_SQL.filter(
      (sql) => isCreateIndexSql(sql) && !BASEBALL_V2_NEW_INDEXES.has(extractCreatedIndexName(sql))
    ),
    sqlStatements: [
      ATTENDEES_PLAYERS_COUNT_BACKFILL_SQL,
      ...LEGACY_BASEBALL_NORMALIZATION_SQL
    ]
  },
  {
    version: 2,
    name: 'hash-session-ids-at-rest',
    async run(db) {
      await backfillHashedSessionIds(db);
    }
  },
  {
    version: 3,
    name: 'adr-0001-to-0008-additive-schema',
    ensureTables: CREATE_TABLES_SQL.filter(
      (sql) => !isCreateIndexSql(sql) && BASEBALL_V2_NEW_TABLES.has(extractCreatedTableName(sql))
    ),
    columns: BASEBALL_V2_COLUMNS,
    indexes: CREATE_TABLES_SQL.filter(
      (sql) => isCreateIndexSql(sql) && BASEBALL_V2_NEW_INDEXES.has(extractCreatedIndexName(sql))
    ),
    sqlStatements: BASEBALL_V2_BACKFILL_SQL
  },
  {
    version: 4,
    name: 'backfill-hashed-rsvp-management-tokens',
    async run(db) {
      const CHUNK_SIZE = 50;
      const likePrefix = `${MANAGEMENT_TOKEN_PREFIX}%`;
      while (true) {
        const { results: rows } = await db.prepare(
          'SELECT id, management_token FROM attendees WHERE management_token IS NOT NULL AND management_token NOT LIKE ? ORDER BY id ASC LIMIT ?'
        ).bind(likePrefix, CHUNK_SIZE).all();

        const batchRows = rows || [];
        if (batchRows.length === 0) break;

        const stmts = [];
        for (const row of batchRows) {
          const raw = row && row.management_token != null ? String(row.management_token).trim() : '';
          if (!raw) {
            stmts.push(db.prepare('UPDATE attendees SET management_token = NULL WHERE id = ?').bind(row.id));
            continue;
          }
          const hashed = await hashManagementToken(raw);
          stmts.push(
            db.prepare(
              'UPDATE attendees SET management_token = ? WHERE id = ? AND management_token IS NOT NULL AND management_token NOT LIKE ?'
            ).bind(hashed, row.id, likePrefix)
          );
        }

        if (stmts.length > 0) {
          if (typeof db.batch === 'function') {
            await db.batch(stmts);
          } else {
            for (const st of stmts) {
              await st.run();
            }
          }
        }

        if (batchRows.length < CHUNK_SIZE) break;
      }
    }
  }
];

/** @type {MigrationStep[]} */
export const CHAT_MIGRATIONS = [
  {
    version: 1,
    name: 'baseline-consolidated-chat-schema',
    ensureTables: CREATE_CHAT_TABLES_SQL.filter(
      (sql) => !isCreateIndexSql(sql) && !CHAT_V2_NEW_TABLES.has(extractCreatedTableName(sql))
    ),
    columns: CHAT_V1_COLUMNS,
    indexes: CREATE_CHAT_TABLES_SQL.filter(
      (sql) => isCreateIndexSql(sql) && !CHAT_V2_NEW_INDEXES.has(extractCreatedIndexName(sql))
    ),
    async run(chatDb) {
      await seedDefaultChatChannels(chatDb);
    }
  },
  {
    version: 2,
    name: 'adr-0001-to-0008-additive-chat-schema',
    ensureTables: CREATE_CHAT_TABLES_SQL.filter(
      (sql) => !isCreateIndexSql(sql) && CHAT_V2_NEW_TABLES.has(extractCreatedTableName(sql))
    ),
    columns: CHAT_V2_COLUMNS,
    indexes: CREATE_CHAT_TABLES_SQL.filter(
      (sql) => isCreateIndexSql(sql) && CHAT_V2_NEW_INDEXES.has(extractCreatedIndexName(sql))
    ),
    sqlStatements: CHAT_V2_BACKFILL_SQL
  }
];

const backfilledOptInDbs = new WeakSet();
const inFlightOptInBackfills = new WeakMap();

export async function ensureClubhouseOptInBackfill(baseballDb, chatDb, force = false) {
  if (!baseballDb || !chatDb || (!force && backfilledOptInDbs.has(baseballDb))) return;

  const existing = inFlightOptInBackfills.get(baseballDb);
  if (existing) {
    if (!force) return existing;
    try {
      await existing;
    } catch (_err) {
      /* previous backfill failed; forced call will retry */
    }
  }

  const runPromise = (async () => {
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
      } catch (e) {
        /* best-effort backfill probe: messages table may not be initialized yet */
      }
      try {
        const { results: keyUsers } = await chatDb.prepare('SELECT DISTINCT user_id as uid FROM user_crypto_keys WHERE user_id IS NOT NULL').all();
        for (const r of (keyUsers || [])) {
          if (r && r.uid) activeIds.add(Number(r.uid));
        }
      } catch (e) {
        /* best-effort backfill probe: user_crypto_keys table may not be initialized yet */
      }

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
    } finally {
      if (inFlightOptInBackfills.get(baseballDb) === runPromise) {
        inFlightOptInBackfills.delete(baseballDb);
      }
    }
  })();

  inFlightOptInBackfills.set(baseballDb, runPromise);
  return runPromise;
}
