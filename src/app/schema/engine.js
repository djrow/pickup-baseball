/**
 * @fileoverview Schema Initialization Engine, Opportunistic Pruning & Settings Helpers.
 * Orchestrates idempotent cold-start schema checks across BASEBALL_DB and CHAT_DB.
 *
 * @module app/schema/engine
 */

import { DEFAULT_BASEBALL_DUTIES, CREATE_TABLES_SQL } from './baseball-ddl.js';
import { DEFAULT_CHAT_CHANNELS, CREATE_CHAT_TABLES_SQL } from './chat-ddl.js';
import {
  ALTER_STATEMENTS,
  CHAT_ALTER_STATEMENTS,
  OLD_HIGHLIGHTS_TOPIC,
  NEW_HIGHLIGHTS_TOPIC,
  HIGHLIGHTS_TOPIC_SYNC_SQL,
  runBaseballLegacyBackfills,
  seedSampleMediaIfEmpty,
  ensureClubhouseOptInBackfill
} from './migrations.js';

const migratedDbs = new WeakSet();
const BASEBALL_SCHEMA_VERSION = '2026-11-14.1';

async function runSchemaBatch(db, sqlList) {
  if (typeof db.batch === 'function' && sqlList.length > 1) {
    try {
      await db.batch(sqlList.map((sql) => db.prepare(sql)));
      return;
    } catch (e) {
      /* best-effort batch; fall back to statement-by-statement execution */
    }
  }
  for (const sql of sqlList) {
    try {
      await db.prepare(sql).run();
    } catch (e) {
      /* intentional idempotent DDL probe: object may already exist */
    }
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
    } catch (e) {
      /* schema_version probe: app_settings table may not exist yet on fresh DB */
    }
  }

  if (!alreadyAtVersion) {
    await runSchemaBatch(db, CREATE_TABLES_SQL);

    for (const sql of ALTER_STATEMENTS) {
      try {
        await db.prepare(sql).run();
      } catch (e) {
        /* intentional schema probe: column or index may already exist */
      }
    }

    await runBaseballLegacyBackfills(db, runSchemaBatch);

    try {
      await db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('schema_version', ?)").bind(BASEBALL_SCHEMA_VERSION).run();
    } catch (e) {
      /* best-effort schema_version stamp */
    }

    await seedSampleMediaIfEmpty(db);
  }

  migratedDbs.add(db);
}

const migratedChatDbs = new WeakSet();
const CHAT_SCHEMA_VERSION = '2026-11-14.1';

export async function ensureChatD1Schema(chatDb, force = false) {
  if (!chatDb || (!force && migratedChatDbs.has(chatDb))) return;

  if (!force && typeof chatDb.prepare === 'function') {
    try {
      const verRow = await chatDb.prepare("SELECT value FROM chat_meta WHERE key = 'schema_version'").first();
      if (verRow && verRow.value === CHAT_SCHEMA_VERSION) {
        migratedChatDbs.add(chatDb);
        return;
      }
    } catch (e) {
      /* schema_version probe: chat_meta table may not exist yet on fresh DB */
    }
  }

  if (typeof chatDb.prepare === 'function') {
    await runSchemaBatch(chatDb, CREATE_CHAT_TABLES_SQL);
  } else if (typeof chatDb.exec === 'function') {
    for (const sql of CREATE_CHAT_TABLES_SQL) {
      try {
        chatDb.exec(sql);
      } catch (e) {
        /* intentional idempotent DDL probe: object may already exist */
      }
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
    } catch (e) {
      /* pragma column probe fallback: run ALTER_STATEMENTS */
    }
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
  if (typeof chatDb.prepare === 'function' && typeof chatDb.batch === 'function') {
    try {
      await chatDb.batch([
        ...DEFAULT_CHAT_CHANNELS.map((ch) =>
          chatDb.prepare(channelSeedSql).bind(
            ch.slug, ch.name, ch.category, ch.channel_type, ch.topic,
            ch.min_role_read, ch.min_role_write, ch.is_encrypted, ch.sort_order
          )
        ),
        chatDb.prepare(HIGHLIGHTS_TOPIC_SYNC_SQL).bind(NEW_HIGHLIGHTS_TOPIC, OLD_HIGHLIGHTS_TOPIC),
        chatDb.prepare("INSERT OR REPLACE INTO chat_meta (key, value) VALUES ('schema_version', ?)").bind(CHAT_SCHEMA_VERSION)
      ]);
      migratedChatDbs.add(chatDb);
      return;
    } catch (e) {
      /* best-effort batch seed; fall back to per-channel inserts */
    }
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
      const syncStmt = chatDb.prepare(HIGHLIGHTS_TOPIC_SYNC_SQL);
      if (typeof syncStmt.bind === 'function') {
        await syncStmt.bind(NEW_HIGHLIGHTS_TOPIC, OLD_HIGHLIGHTS_TOPIC).run();
      } else if (typeof syncStmt.run === 'function') {
        syncStmt.run(NEW_HIGHLIGHTS_TOPIC, OLD_HIGHLIGHTS_TOPIC);
      }
    }
    if (typeof chatDb.prepare === 'function') {
      const metaStmt = chatDb.prepare("INSERT OR REPLACE INTO chat_meta (key, value) VALUES ('schema_version', ?)");
      if (typeof metaStmt.bind === 'function') {
        await metaStmt.bind(CHAT_SCHEMA_VERSION).run();
      }
    }
  } catch (e) {
    /* best-effort topic sync and chat schema_version stamp */
  }

  migratedChatDbs.add(chatDb);
}

const lastBaseballPruneByDb = new WeakMap();
const lastChatPruneByDb = new WeakMap();
const PRUNE_INTERVAL_MS = 10 * 60 * 1000;

/** Opportunistically prunes expired sessions, auth codes, and stale rate-limit windows at most once per 10 minutes per isolate. */
export async function pruneEphemeralBaseballRows(db) {
  if (!db || typeof db.prepare !== 'function') return;
  const nowMs = Date.now();
  const last = lastBaseballPruneByDb.get(db) || 0;
  if (nowMs - last < PRUNE_INTERVAL_MS) return;
  lastBaseballPruneByDb.set(db, nowMs);

  const nowIso = new Date(nowMs).toISOString();
  const rateCutoff = Math.floor(nowMs / 1000) - 2 * 60 * 60;
  try {
    const stmts = [
      db.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(nowIso),
      db.prepare('DELETE FROM auth_codes WHERE expires_at <= ?').bind(nowIso),
      db.prepare('DELETE FROM rate_limits WHERE window_start <= ?').bind(rateCutoff)
    ];
    if (typeof db.batch === 'function') {
      await db.batch(stmts);
    } else {
      for (const s of stmts) await s.run();
    }
  } catch (e) {
    /* best-effort opportunistic cleanup; non-fatal if DB is busy */
  }
}

/** Opportunistically prunes stale WebRTC signals, chat rate limits, and aged sync tombstones at most once per 10 minutes per isolate. */
export async function pruneEphemeralChatRows(chatDb) {
  if (!chatDb || typeof chatDb.prepare !== 'function') return;
  const nowMs = Date.now();
  const last = lastChatPruneByDb.get(chatDb) || 0;
  if (nowMs - last < PRUNE_INTERVAL_MS) return;
  lastChatPruneByDb.set(chatDb, nowMs);

  const nowSec = Math.floor(nowMs / 1000);
  try {
    const stmts = [
      chatDb.prepare('DELETE FROM rtc_signals WHERE created_at <= ?').bind(nowSec - 300),
      chatDb.prepare('DELETE FROM chat_rate_limits WHERE window_start <= ?').bind(nowSec - 7200),
      chatDb.prepare('DELETE FROM sync_events WHERE created_at <= ?').bind(nowSec - 7 * 86400)
    ];
    if (typeof chatDb.batch === 'function') {
      await chatDb.batch(stmts);
    } else {
      for (const s of stmts) await s.run();
    }
  } catch (e) {
    /* best-effort opportunistic cleanup; non-fatal if DB is busy */
  }
}

export const ensureBaseballD1Schema = ensureD1Schema;

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

export async function getDisallowZeroLoginMediaSetting(db, _env) {
  if (!db) return false;
  try {
    const row = await db.prepare("SELECT value FROM app_settings WHERE key = 'disallow_zero_login_media'").first();
    if (row) return row.value === 'true';
  } catch (e) {
    /* app_settings probe: table may not exist yet during cold start */
  }
  return false;
}
