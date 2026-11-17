/**
 * @fileoverview Versioned Schema Initialization Engine, Opportunistic Pruning & Settings Helpers.
 * Orchestrates idempotent cold-start schema checks across BASEBALL_DB and CHAT_DB
 * with fresh-DB single-batch fast-path, PRAGMA table_info incremental upgrades,
 * fail-loud error semantics, and WeakMap concurrency locks.
 *
 * @module app/schema/engine
 */

import { DEFAULT_BASEBALL_DUTIES, DEFAULT_GENERIC_DUTIES, CREATE_TABLES_SQL } from './baseball-ddl.js';
import { CREATE_CHAT_TABLES_SQL } from './chat-ddl.js';
import { resolveConfig, PRESET_PICKUP_BASEBALL } from '../config.js';
import { purgeExpiredQuarantinedWaivers, scrubExpiredWaiverTelemetry } from '../erasure.js';
import {
  BASEBALL_MIGRATIONS,
  CHAT_MIGRATIONS,
  buildDefaultChatChannelStatements,
  ensureClubhouseOptInBackfill
} from './migrations.js';

const migratedDbs = new WeakSet();
const inFlightBaseballMigrations = new WeakMap();
export const BASEBALL_SCHEMA_VERSION = BASEBALL_MIGRATIONS[BASEBALL_MIGRATIONS.length - 1].version;

const migratedChatDbs = new WeakSet();
const inFlightChatMigrations = new WeakMap();
export const CHAT_SCHEMA_VERSION = CHAT_MIGRATIONS[CHAT_MIGRATIONS.length - 1].version;

/**
 * Parses a stored schema_version string into a non-negative integer.
 * Non-integer legacy strings (e.g. '2026-11-14.1') normalize to 0 so
 * baseline incremental verification and integer stamping execute once.
 * @param {unknown} raw
 * @returns {number}
 */
export function parseSchemaVersion(raw) {
  if (raw === null || raw === undefined) return 0;
  const str = String(raw).trim();
  if (!/^\d+$/.test(str)) return 0;
  const parsed = Number(str);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function validateIdentifier(name) {
  if (typeof name !== 'string' || !/^[a-z_][a-z0-9_]*$/i.test(name)) {
    throw new Error(`Invalid SQLite identifier: ${String(name)}`);
  }
  return name;
}

function isNoSuchTableError(err) {
  return Boolean(err && typeof err.message === 'string' && /no such table/i.test(err.message));
}

async function executePreparedList(db, stmts) {
  if (!stmts || stmts.length === 0) return;
  if (typeof db.batch === 'function' && stmts.length > 1) {
    await db.batch(stmts);
    return;
  }
  for (const stmt of stmts) {
    await stmt.run();
  }
}

async function executeSqlList(db, sqlList) {
  if (!sqlList || sqlList.length === 0) return;
  await executePreparedList(db, sqlList.map((sql) => db.prepare(sql)));
}

/**
 * Fetches existing column names for each requested table in a single D1 batch.
 * @param {D1Database} db
 * @param {string[]} tableNames
 * @returns {Promise<Map<string, Set<string>>>}
 */
async function fetchExistingColumnsByTable(db, tableNames) {
  const uniqueTables = [];
  const seen = new Set();
  for (const name of tableNames) {
    const table = validateIdentifier(name);
    if (!seen.has(table)) {
      seen.add(table);
      uniqueTables.push(table);
    }
  }

  /** @type {Map<string, Set<string>>} */
  const colsByTable = new Map();
  if (uniqueTables.length === 0) return colsByTable;

  const pragmaStmts = uniqueTables.map((table) => db.prepare(`PRAGMA table_info(${table})`));
  const results = (typeof db.batch === 'function' && pragmaStmts.length > 1)
    ? await db.batch(pragmaStmts)
    : await Promise.all(pragmaStmts.map((stmt) => stmt.all()));

  for (let i = 0; i < uniqueTables.length; i++) {
    const rows = /** @type {Array<{ name: string }>} */ ((results[i] && results[i].results) || []);
    colsByTable.set(uniqueTables[i], new Set(rows.map((r) => r.name)));
  }
  return colsByTable;
}

/**
 * Checks column existence via batched PRAGMA table_info and alters only missing columns.
 * Fails loud if any PRAGMA or ALTER statement errors.
 * @param {D1Database} db
 * @param {import('./migrations.js').MigrationColumnDef[]} columnDefs
 */
async function applyMissingColumns(db, columnDefs) {
  if (!columnDefs || columnDefs.length === 0) return;
  const colsByTable = await fetchExistingColumnsByTable(db, columnDefs.map((c) => c.table));
  const missingAlterSql = [];

  for (const colDef of columnDefs) {
    const table = validateIdentifier(colDef.table);
    let existing = colsByTable.get(table);
    if (!existing) {
      existing = new Set();
      colsByTable.set(table, existing);
    }
    if (!existing.has(colDef.column)) {
      missingAlterSql.push(colDef.sql);
      existing.add(colDef.column);
    }
  }

  await executeSqlList(db, missingAlterSql);
}

/**
 * Probes whether a database is completely empty (fresh fast-path) or an existing
 * database with an integer schema_version (or 0 if unversioned/legacy).
 * @param {D1Database} db
 * @param {string} metaTable
 * @returns {Promise<{ isFresh: boolean, currentVersion: number }>}
 */
async function probeSchemaState(db, metaTable) {
  const table = validateIdentifier(metaTable);
  try {
    const verRow = await db.prepare(`SELECT value FROM ${table} WHERE key = 'schema_version'`).first();
    return {
      isFresh: false,
      currentVersion: parseSchemaVersion(verRow && verRow.value)
    };
  } catch (err) {
    if (!isNoSuchTableError(err)) {
      throw err;
    }
  }

  const existingTable = await db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1"
  ).first();

  return {
    isFresh: !existingTable,
    currentVersion: 0
  };
}

/**
 * Runs a single versioned migration step and stamps its integer version on completion.
 * @param {D1Database} db
 * @param {import('./migrations.js').MigrationStep} step
 * @param {string} metaTable
 */
async function runMigrationStep(db, step, metaTable) {
  if (step.ensureTables && step.ensureTables.length > 0) {
    await executeSqlList(db, step.ensureTables);
  }
  if (step.columns && step.columns.length > 0) {
    await applyMissingColumns(db, step.columns);
  }
  if (step.indexes && step.indexes.length > 0) {
    await executeSqlList(db, step.indexes);
  }
  if (step.sqlStatements && step.sqlStatements.length > 0) {
    await executeSqlList(db, step.sqlStatements);
  }
  if (typeof step.run === 'function') {
    await step.run(db);
  }

  const table = validateIdentifier(metaTable);
  await db.prepare(`INSERT OR REPLACE INTO ${table} (key, value) VALUES ('schema_version', ?)`)
    .bind(String(step.version))
    .run();
}

/**
 * Executes fresh-DB single-batch fast-path or pending ordered versioned migrations.
 * Throws loudly on any failure without advancing `schema_version`.
 *
 * @param {D1Database} db
 * @param {{
 *   metaTable: string,
 *   migrations: import('./migrations.js').MigrationStep[],
 *   force?: boolean,
 *   buildFreshStatements?: (targetVersion: number) => D1PreparedStatement[]
 * }} options
 * @returns {Promise<{ mode: 'fresh' | 'upgraded' | 'noop', previousVersion: number, currentVersion: number }>}
 */
export async function runVersionedMigrations(db, options) {
  const { metaTable, migrations, force = false, buildFreshStatements } = options;
  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  const targetVersion = sorted.length > 0 ? sorted[sorted.length - 1].version : 0;

  const state = await probeSchemaState(db, metaTable);
  if (!force && state.isFresh && typeof buildFreshStatements === 'function') {
    const freshStmts = buildFreshStatements(targetVersion);
    await executePreparedList(db, freshStmts);
    return {
      mode: 'fresh',
      previousVersion: 0,
      currentVersion: targetVersion
    };
  }

  const effectiveVersion = force ? 0 : state.currentVersion;
  const pending = sorted.filter((step) => step.version > effectiveVersion);
  for (const step of pending) {
    await runMigrationStep(db, step, metaTable);
  }

  return {
    mode: pending.length > 0 ? 'upgraded' : 'noop',
    previousVersion: state.currentVersion,
    currentVersion: pending.length > 0 ? pending[pending.length - 1].version : state.currentVersion
  };
}

/**
 * Deduplicates concurrent cold-start initialization per DB instance via WeakMap
 * and memoizes successful completion in the provided WeakSet.
 * @param {D1Database} db
 * @param {boolean} force
 * @param {WeakSet<object>} doneSet
 * @param {WeakMap<object, Promise<void>>} inFlightMap
 * @param {() => Promise<void>} workerFn
 */
async function runWithDbLock(db, force, doneSet, inFlightMap, workerFn) {
  if (!db) return;
  if (!force && doneSet.has(db)) return;

  const existing = inFlightMap.get(db);
  if (existing) {
    if (!force) {
      return existing;
    }
    try {
      await existing;
    } catch (_err) {
      /* previous attempt failed; forced call executes a fresh run */
    }
  }

  const promise = (async () => {
    try {
      await workerFn();
      doneSet.add(db);
    } finally {
      if (inFlightMap.get(db) === promise) {
        inFlightMap.delete(db);
      }
    }
  })();

  inFlightMap.set(db, promise);
  return promise;
}

/**
 * Returns preset-appropriate default volunteer tasks (`pickup-baseball` vs `generic-community`).
 * @param {Record<string, any> | ResolvedBootConfig | null | undefined} [envOrConfig]
 */
export function getPresetDefaultDuties(envOrConfig) {
  const cfg = resolveConfig(envOrConfig);
  return cfg.COMMUNITY_PRESET === PRESET_PICKUP_BASEBALL
    ? DEFAULT_BASEBALL_DUTIES
    : DEFAULT_GENERIC_DUTIES;
}

/**
 * Builds prepared statements to seed preset default duties on fresh DB initialization.
 * @param {D1Database} db
 * @param {Record<string, any> | ResolvedBootConfig | null | undefined} [envOrConfig]
 * @returns {D1PreparedStatement[]}
 */
export function buildDefaultDutyStatements(db, envOrConfig) {
  const duties = getPresetDefaultDuties(envOrConfig);
  const sql = 'INSERT INTO default_duties (title, description, slots_needed, sort_order, grants_coordinator, required_badge) VALUES (?, ?, ?, ?, ?, ?)';
  return duties.map((d, idx) =>
    db.prepare(sql).bind(
      d.title,
      d.description || '',
      d.slots_needed || 1,
      idx,
      d.grants_coordinator ? 1 : 0,
      d.required_badge || null
    )
  );
}

export async function ensureD1Schema(db, force = false, env = null) {
  return runWithDbLock(db, force, migratedDbs, inFlightBaseballMigrations, async () => {
    await runVersionedMigrations(db, {
      metaTable: 'app_settings',
      migrations: BASEBALL_MIGRATIONS,
      force,
      buildFreshStatements: (targetVersion) => [
        ...CREATE_TABLES_SQL.map((sql) => db.prepare(sql)),
        ...buildDefaultDutyStatements(db, env),
        db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('schema_version', ?)").bind(String(targetVersion))
      ]
    });
  });
}

export async function ensureChatD1Schema(chatDb, force = false) {
  return runWithDbLock(chatDb, force, migratedChatDbs, inFlightChatMigrations, async () => {
    await runVersionedMigrations(chatDb, {
      metaTable: 'chat_meta',
      migrations: CHAT_MIGRATIONS,
      force,
      buildFreshStatements: (targetVersion) => [
        ...CREATE_CHAT_TABLES_SQL.map((sql) => chatDb.prepare(sql)),
        ...buildDefaultChatChannelStatements(chatDb),
        chatDb.prepare("INSERT OR REPLACE INTO chat_meta (key, value) VALUES ('schema_version', ?)").bind(String(targetVersion))
      ]
    });
  });
}

const lastBaseballPruneByDb = new WeakMap();
const lastChatPruneByDb = new WeakMap();
const PRUNE_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Opportunistically prunes expired sessions, auth codes, and rate-limit rows at most once per 10 minutes per isolate.
 * @param {D1Database|null|undefined} db
 * @param {number} [nowMsOverride]
 * @param {{ force?: boolean }} [options]
 */
export async function pruneEphemeralBaseballRows(db, nowMsOverride = Date.now(), options = {}) {
  if (!db || typeof db.prepare !== 'function') return;
  const nowMs = typeof nowMsOverride === 'number' && Number.isFinite(nowMsOverride) ? nowMsOverride : Date.now();
  const force = Boolean(options && options.force);
  const last = lastBaseballPruneByDb.get(db) || 0;
  if (!force && nowMs - last < PRUNE_INTERVAL_MS) return;
  lastBaseballPruneByDb.set(db, nowMs);

  const nowIso = new Date(nowMs).toISOString();
  const nowSec = Math.floor(nowMs / 1000);
  const legacyRateCutoff = nowSec - 2 * 60 * 60;
  const pendingUploadCutoff = new Date(nowMs - 24 * 60 * 60 * 1000).toISOString();
  try {
    const stmts = [
      db.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(nowIso),
      db.prepare('DELETE FROM auth_codes WHERE expires_at <= ?').bind(nowIso),
      db.prepare(
        'DELETE FROM rate_limits WHERE (expires_at > 0 AND expires_at <= ?) OR (expires_at <= 0 AND window_start <= ?)'
      ).bind(nowSec, legacyRateCutoff),
      db.prepare(
        "DELETE FROM media_items WHERE upload_status = 'pending' AND created_at <= ?"
      ).bind(pendingUploadCutoff)
    ];
    if (typeof db.batch === 'function') {
      await db.batch(stmts);
    } else {
      for (const s of stmts) await s.run();
    }
    await purgeExpiredQuarantinedWaivers(db);
    await scrubExpiredWaiverTelemetry(db);
  } catch (e) {
    /* best-effort opportunistic cleanup; non-fatal if DB is busy */
  }
}

/**
 * Opportunistically prunes stale WebRTC signals, expired chat rate limits, and aged sync tombstones at most once per 10 minutes per isolate.
 * @param {D1Database|null|undefined} chatDb
 * @param {number} [nowMsOverride]
 * @param {{ force?: boolean }} [options]
 */
export async function pruneEphemeralChatRows(chatDb, nowMsOverride = Date.now(), options = {}) {
  if (!chatDb || typeof chatDb.prepare !== 'function') return;
  const nowMs = typeof nowMsOverride === 'number' && Number.isFinite(nowMsOverride) ? nowMsOverride : Date.now();
  const force = Boolean(options && options.force);
  const last = lastChatPruneByDb.get(chatDb) || 0;
  if (!force && nowMs - last < PRUNE_INTERVAL_MS) return;
  lastChatPruneByDb.set(chatDb, nowMs);

  const nowSec = Math.floor(nowMs / 1000);
  const legacyRateCutoff = nowSec - 7200;
  const pendingUploadCutoff = new Date(nowMs - 24 * 60 * 60 * 1000).toISOString();
  try {
    const stmts = [
      chatDb.prepare('DELETE FROM rtc_signals WHERE created_at <= ?').bind(nowSec - 300),
      chatDb.prepare(
        'DELETE FROM chat_rate_limits WHERE (expires_at > 0 AND expires_at <= ?) OR (expires_at <= 0 AND window_start <= ?)'
      ).bind(nowSec, legacyRateCutoff),
      chatDb.prepare('DELETE FROM sync_events WHERE created_at <= ?').bind(nowSec - 7 * 86400),
      chatDb.prepare(
        "DELETE FROM chat_attachments WHERE upload_status = 'pending' AND created_at <= ?"
      ).bind(pendingUploadCutoff)
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

export async function ensureDualD1Schema(dbs, force = false, env = null) {
  const baseball = dbs?.BASEBALL_DB || dbs?.DB || dbs?.baseballDb || dbs?.db;
  const chat = dbs?.CHAT_DB || dbs?.chatDb;
  if (baseball) await ensureBaseballD1Schema(baseball, force, env);
  if (chat) await ensureChatD1Schema(chat, force);
  if (baseball && chat) await ensureClubhouseOptInBackfill(baseball, chat, force);
}

export async function getDefaultDuties(db, env = null) {
  const { results } = await db.prepare(
    'SELECT title, description, slots_needed, sort_order, COALESCE(grants_coordinator, 0) as grants_coordinator, required_badge FROM default_duties ORDER BY sort_order ASC, id ASC'
  ).all();
  if (!results || results.length === 0) {
    return getPresetDefaultDuties(env);
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
