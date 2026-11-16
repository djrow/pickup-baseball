/**
 * @fileoverview Versioned Schema Migrations & Legacy Data Backfills.
 * Defines ordered integer-versioned migration steps for BASEBALL_DB and CHAT_DB,
 * plus legacy compatibility arrays and one-time Clubhouse opt-in backfill.
 *
 * @module app/schema/migrations
 */

import { CREATE_TABLES_SQL } from './baseball-ddl.js';
import { DEFAULT_CHAT_CHANNELS, CREATE_CHAT_TABLES_SQL } from './chat-ddl.js';

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

/** @type {MigrationStep[]} */
export const BASEBALL_MIGRATIONS = [
  {
    version: 1,
    name: 'baseline-consolidated-schema',
    ensureTables: CREATE_TABLES_SQL.filter((sql) => !isCreateIndexSql(sql)),
    columns: BASEBALL_V1_COLUMNS,
    indexes: CREATE_TABLES_SQL.filter((sql) => isCreateIndexSql(sql)),
    sqlStatements: [
      ATTENDEES_PLAYERS_COUNT_BACKFILL_SQL,
      ...LEGACY_BASEBALL_NORMALIZATION_SQL
    ]
  }
];

/** @type {MigrationStep[]} */
export const CHAT_MIGRATIONS = [
  {
    version: 1,
    name: 'baseline-consolidated-chat-schema',
    ensureTables: CREATE_CHAT_TABLES_SQL.filter((sql) => !isCreateIndexSql(sql)),
    columns: CHAT_V1_COLUMNS,
    indexes: CREATE_CHAT_TABLES_SQL.filter((sql) => isCreateIndexSql(sql)),
    async run(chatDb) {
      await seedDefaultChatChannels(chatDb);
    }
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
