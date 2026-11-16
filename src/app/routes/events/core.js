/**
 * @fileoverview Core event routes: listing, detail view, CRUD, iCalendar feeds,
 * reminders, rainout/reopen controls, and database SQL backup streaming.
 * @module routes/events/core
 */

import { Hono } from 'hono';
import { CURRENT_APP_VERSION } from '../../version.js';
import {
  sanitizeHttpUrl,
  requireOrganizer,
  requireAdmin,
  resolveUserByCalendarToken,
  constantTimeEqual,
  checkRateLimit,
  getSafePublicOrigin,
  arrayBufferToBase64,
  base64ToUint8Array
} from '../../security.js';
import { getDefaultDuties, getRequireLoginSetting } from '../../schema.js';
import {
  parseAllowedEmails,
  canUserAccessEvent,
  formatUnlockDateTime,
  getTaskTier,
  getDutyType,
  getDutyTier1Cap,
  getUserRollingShifts,
  normalizeDutyFlags,
  isViewerOrganizer,
  sanitizeAttendeesForViewer,
  sanitizeCommentsForViewer,
  sanitizeBpSignupsForViewer,
  sanitizeDutyAssignedPlayers
} from '../../policy.js';
import { buildCalendarIcs } from '../../feeds.js';
import { sendRainoutEmail, sendReopenEmail } from '../../mailer.js';
import { ERROR_CODES, jsonError, logEvent } from '../../errors.js';
import { resolveConfig, PRESET_PICKUP_BASEBALL } from '../../config.js';
import {
  AVATAR_EXPR,
  ATTENDEE_DETAIL_COLUMNS,
  isDeliverableEmail,
  sendRemindersForEventD1,
  processUpcomingEventRemindersD1,
  notifyConfirmedAttendees,
  prepareAttendeeByManagementToken
} from './helpers.js';

export const eventsCoreRouter = /** @type {AppHono} */ (new Hono());

eventsCoreRouter.get('/', async (c) => {
  try {
    const filter = c.req.query('filter');
    const user = c.get('user');
    const nowIso = new Date().toISOString();

    let query = `
      SELECT e.*,
        COALESCE(att_agg.attendee_count, 0) as attendee_count,
        COALESCE(att_agg.spectator_count, 0) as spectator_count,
        COALESCE(duty_agg.duty_count, 0) as duty_count
      FROM events e
      LEFT JOIN (
        SELECT event_id,
          COALESCE(SUM(COALESCE(players_count, 1 + COALESCE(additional_guests, 0))), 0) as attendee_count,
          COALESCE(SUM(COALESCE(spectators_count, 0)), 0) as spectator_count
        FROM attendees
        WHERE status = 'attending'
        GROUP BY event_id
      ) att_agg ON att_agg.event_id = e.id
      LEFT JOIN (
        SELECT event_id, COUNT(*) as duty_count
        FROM event_duties
        GROUP BY event_id
      ) duty_agg ON duty_agg.event_id = e.id
      WHERE e.status IN ('active', 'rainout')
    `;
    const params = [];
    if (filter === 'past') {
      query += ' AND e.event_date < ?';
      params.push(nowIso);
    } else if (filter !== 'all') {
      query += " AND e.event_date >= date('now', '-1 day')";
    }
    query += filter === 'past' ? ' ORDER BY e.event_date DESC LIMIT 200' : ' ORDER BY e.event_date ASC LIMIT 200';

    const stmt = c.env.DB.prepare(query);
    const { results: events } = params.length > 0 ? await stmt.bind(...params).all() : await stmt.all();

    const isOrganizer = Boolean(user && (user.canManageEvents || user.isAdmin));
    const visibleEvents = (events || []).filter(ev => canUserAccessEvent(user, ev));

    if (user && visibleEvents.length > 0) {
      const { results: userRsvps } = await c.env.DB.prepare(
        'SELECT event_id, status, gear_bringing, players_count, spectators_count FROM attendees WHERE user_id = ?'
      ).bind(user.id).all();
      const rsvpMap = new Map((userRsvps || []).map(r => [r.event_id, r]));
      visibleEvents.forEach(ev => { ev.my_rsvp = rsvpMap.get(ev.id) || null; });
    }

    visibleEvents.forEach(ev => {
      const allowed = parseAllowedEmails(ev.allowed_emails);
      ev.is_restricted = allowed.length > 0;
      ev.allowed_emails_list = isOrganizer ? allowed : [];
      if (!isOrganizer) {
        delete ev.allowed_emails;
      }
    });

    c.header('Cache-Control', 'no-store');
    return c.json({ events: visibleEvents, user: user || null, synced_at: nowIso });
  } catch (err) {
    console.error('[Events] Error listing events:', err);
    return c.json({ error: 'Failed to fetch events.' }, 500);
  }
});

const BACKUP_PAGE_SIZE = 100;
const SECRET_APP_SETTING_KEYS = new Set(['waiver_provenance_secret', 'appscript_upload_url', 'rate_limit_hmac_secret']);
const SCRUBBED_APP_SETTING_KEYS = new Set(['schema_version', 'require_login_to_rsvp', 'disallow_zero_login_media']);

const SCRUBBED_TABLE_QUERIES = {
  events: 'SELECT * FROM "events" LIMIT ? OFFSET ?',
  event_duties: 'SELECT * FROM "event_duties" LIMIT ? OFFSET ?',
  default_duties: 'SELECT * FROM "default_duties" LIMIT ? OFFSET ?',
  posts: 'SELECT * FROM "posts" LIMIT ? OFFSET ?',
  media_items: 'SELECT * FROM "media_items" WHERE is_approved = 1 LIMIT ? OFFSET ?',
  app_settings: `SELECT * FROM "app_settings" WHERE key IN ('schema_version', 'require_login_to_rsvp', 'disallow_zero_login_media') LIMIT ? OFFSET ?`,
  channels: `SELECT * FROM "channels" WHERE channel_type NOT IN ('dm', 'group_dm') LIMIT ? OFFSET ?`,
  clubhouse_gifs: 'SELECT * FROM "clubhouse_gifs" LIMIT ? OFFSET ?'
};

const DR_TABLE_QUERIES = {
  users: 'SELECT * FROM "users" LIMIT ? OFFSET ?',
  events: 'SELECT * FROM "events" LIMIT ? OFFSET ?',
  event_duties: 'SELECT * FROM "event_duties" LIMIT ? OFFSET ?',
  attendees: 'SELECT * FROM "attendees" LIMIT ? OFFSET ?',
  duty_assignments: 'SELECT * FROM "duty_assignments" LIMIT ? OFFSET ?',
  comments: 'SELECT * FROM "comments" LIMIT ? OFFSET ?',
  default_duties: 'SELECT * FROM "default_duties" LIMIT ? OFFSET ?',
  posts: 'SELECT * FROM "posts" LIMIT ? OFFSET ?',
  media_items: 'SELECT * FROM "media_items" LIMIT ? OFFSET ?',
  banned_emails: 'SELECT * FROM "banned_emails" LIMIT ? OFFSET ?',
  app_settings: `SELECT * FROM "app_settings" WHERE key NOT IN ('waiver_provenance_secret', 'appscript_upload_url', 'rate_limit_hmac_secret') LIMIT ? OFFSET ?`,
  batting_practice_signups: 'SELECT * FROM "batting_practice_signups" LIMIT ? OFFSET ?',
  waivers: 'SELECT * FROM "waivers" LIMIT ? OFFSET ?',
  consent_records: 'SELECT * FROM "consent_records" LIMIT ? OFFSET ?',
  email_suppressions: 'SELECT * FROM "email_suppressions" LIMIT ? OFFSET ?',
  channels: 'SELECT * FROM "channels" LIMIT ? OFFSET ?',
  channel_members: 'SELECT * FROM "channel_members" LIMIT ? OFFSET ?',
  messages: 'SELECT * FROM "messages" LIMIT ? OFFSET ?',
  message_reactions: 'SELECT * FROM "message_reactions" LIMIT ? OFFSET ?',
  chat_attachments: 'SELECT * FROM "chat_attachments" LIMIT ? OFFSET ?',
  user_crypto_keys: 'SELECT * FROM "user_crypto_keys" LIMIT ? OFFSET ?',
  channel_key_shares: 'SELECT * FROM "channel_key_shares" LIMIT ? OFFSET ?',
  sync_events: 'SELECT * FROM "sync_events" LIMIT ? OFFSET ?',
  chat_reports: 'SELECT * FROM "chat_reports" LIMIT ? OFFSET ?',
  user_mutes: 'SELECT * FROM "user_mutes" LIMIT ? OFFSET ?',
  user_blocks: 'SELECT * FROM "user_blocks" LIMIT ? OFFSET ?',
  clubhouse_gifs: 'SELECT * FROM "clubhouse_gifs" LIMIT ? OFFSET ?',
  clubhouse_opted_out: 'SELECT * FROM "clubhouse_opted_out" LIMIT ? OFFSET ?'
};

function resolveBackupTargetConfig(c, dbParam, dateStr) {
  const { COMMUNITY_NAME } = resolveConfig(c.env);
  const configs = {
    baseball: {
      db: c.env && (c.env.BASEBALL_DB || c.env.DB),
      scrubbedHeader: `-- ${COMMUNITY_NAME} Database Backup (Scrubbed Operational SQL)\n-- Mode: scrubbed-operational`,
      drHeader: `-- ${COMMUNITY_NAME} Database Backup (Full Disaster Recovery)\n-- Mode: encrypted-dr`,
      scrubbedFilename: `baseball_operational_${dateStr}.sql`,
      drFilename: `baseball_dr_backup_${dateStr}.pbfenc`,
      scrubbedTables: [
        'events', 'event_duties', 'default_duties',
        'posts', 'media_items', 'app_settings'
      ],
      drTables: [
        'users', 'events', 'event_duties', 'attendees',
        'duty_assignments', 'comments', 'default_duties',
        'posts', 'media_items', 'banned_emails', 'app_settings',
        'batting_practice_signups', 'waivers', 'consent_records', 'email_suppressions'
      ]
    },
    chat: {
      db: c.env && c.env.CHAT_DB,
      scrubbedHeader: `-- ${COMMUNITY_NAME} Clubhouse (CHAT_DB) Database Backup (Scrubbed Operational SQL)\n-- Mode: scrubbed-operational`,
      drHeader: `-- ${COMMUNITY_NAME} Clubhouse (CHAT_DB) Database Backup (Full Disaster Recovery)\n-- Mode: encrypted-dr`,
      scrubbedFilename: `clubhouse_chat_operational_${dateStr}.sql`,
      drFilename: `clubhouse_chat_dr_backup_${dateStr}.pbfenc`,
      scrubbedTables: [
        'channels', 'clubhouse_gifs'
      ],
      drTables: [
        'channels', 'channel_members', 'messages', 'message_reactions',
        'chat_attachments', 'user_crypto_keys', 'channel_key_shares',
        'sync_events', 'chat_reports', 'user_mutes', 'user_blocks',
        'clubhouse_gifs', 'clubhouse_opted_out'
      ]
    }
  };
  return configs[dbParam] || null;
}

function scrubBackupRow(table, row, mode) {
  if (!row || typeof row !== 'object') return null;
  if (table === 'app_settings') {
    const settingKey = String(row.key || '');
    if (SECRET_APP_SETTING_KEYS.has(settingKey)) return null;
    if (mode === 'scrubbed' && !SCRUBBED_APP_SETTING_KEYS.has(settingKey)) return null;
  }

  const out = { ...row };
  if (table === 'users') {
    out.calendar_token = null;
  } else if (table === 'attendees') {
    out.management_token = null;
  } else if (table === 'user_crypto_keys') {
    out.encrypted_private_vault = null;
    out.vault_salt = null;
    out.vault_iv = null;
  } else if (table === 'media_items') {
    out.delete_token = null;
    out.upload_token_hash = null;
    if (mode === 'scrubbed') {
      out.file_data = null;
      out.contributor_name = null;
      out.contributor_id = null;
      if ('uploader_email' in out) out.uploader_email = null;
      if ('uploader_name' in out) out.uploader_name = null;
    }
  } else if (table === 'clubhouse_gifs') {
    out.local_data_base64 = null;
    if (mode === 'scrubbed') {
      out.added_by = 0;
      out.added_by_name = '';
    }
  } else if (table === 'chat_attachments') {
    out.resumable_session_uri = null;
  } else if (table === 'events' && mode === 'scrubbed') {
    out.allowed_emails = null;
  } else if (table === 'posts' && mode === 'scrubbed') {
    if ('author_email' in out) out.author_email = null;
  }
  return out;
}

function formatSqlInsertRow(table, row) {
  const cols = Object.keys(row).map((k) => `"${String(k).replace(/"/g, '""')}"`).join(', ');
  const vals = Object.values(row).map((v) => {
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
    if (v instanceof Uint8Array) {
      return `X'${Array.from(v, (b) => b.toString(16).padStart(2, '0')).join('')}'`;
    }
    return `'${String(v).replace(/\0/g, '').replace(/'/g, "''")}'`;
  }).join(', ');
  return `INSERT OR IGNORE INTO "${table}" (${cols}) VALUES (${vals});\n`;
}

async function writeBackupTables(db, tables, mode, onChunk) {
  const queryMap = mode === 'scrubbed' ? SCRUBBED_TABLE_QUERIES : DR_TABLE_QUERIES;
  for (const table of tables) {
    const tableQuery = queryMap[table];
    if (!tableQuery) continue;
    let offset = 0;
    let headerWritten = false;
    while (true) {
      let rows;
      try {
        const res = await db.prepare(tableQuery).bind(BACKUP_PAGE_SIZE, offset).all();
        rows = res && res.results ? res.results : [];
      } catch (err) {
        if (err && /no such table/i.test(String(err.message || err))) {
          break;
        }
        throw err;
      }
      if (!rows || rows.length === 0) break;
      let chunk = '';
      for (const rawRow of rows) {
        const scrubbed = scrubBackupRow(table, rawRow, mode);
        if (!scrubbed) continue;
        chunk += formatSqlInsertRow(table, scrubbed);
      }
      if (chunk) {
        if (!headerWritten) {
          onChunk(`-- Table: ${table}\n`);
          headerWritten = true;
        }
        onChunk(chunk);
      }
      if (rows.length < BACKUP_PAGE_SIZE) break;
      offset += rows.length;
    }
    if (headerWritten) {
      onChunk('\n');
    }
  }
}

function decodeStrictBase64Bytes(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) {
    return null;
  }
  try {
    return base64ToUint8Array(trimmed);
  } catch {
    return null;
  }
}

eventsCoreRouter.get('/admin/backup-db', requireAdmin, async (c) => {
  try {
    const user = c.get('user');
    const backupLimit = await checkRateLimit(c.env.DB, `admin_backup:${user ? user.id : 'anon'}`, 5, 3600, c.env);
    if (!backupLimit.allowed) {
      return c.json({ error: 'Too many database backup requests. Please wait before exporting again.' }, 429);
    }
    const dbParam = (c.req.query('db') || 'baseball').toLowerCase();
    const timestamp = new Date().toISOString();
    const dateStr = timestamp.slice(0, 10);

    const config = resolveBackupTargetConfig(c, dbParam, dateStr);
    if (!config) {
      return c.json({ error: 'Invalid database target. Use "baseball" or "chat".' }, 400);
    }
    if (!config.db) {
      return c.json({ error: `Database binding for "${dbParam}" is unavailable.` }, 503);
    }

    const db = config.db;
    const tables = config.scrubbedTables;
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        try {
          controller.enqueue(encoder.encode(`${config.scrubbedHeader}\n-- Exported: ${timestamp}\n\n`));
          await writeBackupTables(db, tables, 'scrubbed', (textChunk) => {
            controller.enqueue(encoder.encode(textChunk));
          });
          controller.close();
        } catch (streamErr) {
          console.error('[Backup] Stream error:', streamErr);
          controller.error(streamErr);
        }
      }
    });

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'application/sql; charset=utf-8',
        'Content-Disposition': `attachment; filename="${config.scrubbedFilename}"`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY'
      }
    });
  } catch (err) {
    console.error('[Backup] Error creating SQL dump:', err);
    return c.text('Failed to generate database backup.', 500);
  }
});

eventsCoreRouter.post('/admin/backup-db', requireAdmin, async (c) => {
  try {
    const user = c.get('user');
    const backupLimit = await checkRateLimit(c.env.DB, `admin_backup_dr:${user ? user.id : 'anon'}`, 5, 3600, c.env);
    if (!backupLimit.allowed) {
      return c.json({ error: 'Too many database backup requests. Please wait before exporting again.' }, 429);
    }
    const dbParam = (c.req.query('db') || 'baseball').toLowerCase();
    const timestamp = new Date().toISOString();
    const dateStr = timestamp.slice(0, 10);

    const config = resolveBackupTargetConfig(c, dbParam, dateStr);
    if (!config) {
      return c.json({ error: 'Invalid database target. Use "baseball" or "chat".' }, 400);
    }
    if (!config.db) {
      return c.json({ error: `Database binding for "${dbParam}" is unavailable.` }, 503);
    }

    let body = null;
    try {
      body = await c.req.json();
    } catch {
      body = null;
    }
    if (!body || typeof body !== 'object') {
      return c.json({ error: 'Invalid JSON request body for encrypted DR backup.' }, 400);
    }

    const wrappingKeyBytes = decodeStrictBase64Bytes(body.wrappingKey);
    if (!wrappingKeyBytes || wrappingKeyBytes.byteLength !== 32 || !wrappingKeyBytes.some((b) => b !== 0)) {
      return c.json({ error: 'Invalid or missing 256-bit wrappingKey (expected 32 base64-encoded random bytes).' }, 400);
    }

    const saltBytes = decodeStrictBase64Bytes(body.kdfSalt);
    if (!saltBytes || saltBytes.byteLength < 16 || saltBytes.byteLength > 64 || !saltBytes.some((b) => b !== 0)) {
      wrappingKeyBytes.fill(0);
      return c.json({ error: 'Invalid or missing kdfSalt (expected 16-64 base64-encoded random bytes).' }, 400);
    }

    const iterations = Number(body.kdfIterations);
    if (!Number.isInteger(iterations) || iterations < 100000 || iterations > 10000000) {
      wrappingKeyBytes.fill(0);
      return c.json({ error: 'Invalid or missing kdfIterations (expected integer between 100000 and 10000000).' }, 400);
    }

    const sqlParts = [`${config.drHeader}\n-- Exported: ${timestamp}\n\n`];
    await writeBackupTables(config.db, config.drTables, 'dr', (textChunk) => {
      sqlParts.push(textChunk);
    });
    const plainBytes = new TextEncoder().encode(sqlParts.join(''));

    const ivBytes = new Uint8Array(12);
    crypto.getRandomValues(ivBytes);
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      wrappingKeyBytes,
      { name: 'AES-GCM' },
      false,
      ['encrypt']
    );
    wrappingKeyBytes.fill(0);

    const cipherBuffer = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: ivBytes, tagLength: 128 },
      cryptoKey,
      plainBytes
    );

    const envelope = {
      format: 'pbf-dr-backup-v1',
      cipher: 'AES-256-GCM',
      db: dbParam,
      exportedAt: timestamp,
      iv: arrayBufferToBase64(ivBytes),
      ciphertext: arrayBufferToBase64(cipherBuffer),
      kdf: {
        algorithm: 'PBKDF2',
        hash: 'SHA-256',
        iterations,
        salt: String(body.kdfSalt).trim()
      }
    };

    return new Response(JSON.stringify(envelope), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${config.drFilename}"`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY'
      }
    });
  } catch (err) {
    console.error('[Backup] Error creating encrypted DR backup:', err);
    return c.json({ error: 'Failed to generate encrypted disaster-recovery backup.' }, 500);
  }
});

eventsCoreRouter.get('/attendee-candidates', requireOrganizer, async (c) => {
  try {
    const { results: users } = await c.env.DB.prepare('SELECT id, name, email FROM users ORDER BY name ASC LIMIT 500').all();
    return c.json({ users: users || [] });
  } catch (err) {
    console.error('[Events] Error fetching candidate attendees:', err);
    return c.json({ error: 'Failed to fetch candidate accounts.' }, 500);
  }
});

function buildCalendarSlug(cfg, baseballSlug, genericFallback) {
  if (cfg.COMMUNITY_PRESET === PRESET_PICKUP_BASEBALL) {
    return baseballSlug;
  }
  return cfg.COMMUNITY_NAME.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || genericFallback;
}

function createIcsResponse(icsContent, filename, forceDownload = false) {
  const dispositionType = forceDownload ? 'attachment' : 'inline';
  return new Response(icsContent, {
    status: 200,
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': `${dispositionType}; filename="${filename}"`,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'X-Content-Type-Options': 'nosniff',
      'X-App-Version': CURRENT_APP_VERSION
    }
  });
}

async function resolveIcsViewer(c) {
  const rawToken = c.req.query('cal_token');
  if (rawToken !== undefined && String(rawToken).trim() !== '') {
    const tokenUser = await resolveUserByCalendarToken(c.env.DB, String(rawToken).trim());
    if (!tokenUser) {
      return {
        errorResponse: c.text('Invalid or revoked calendar subscription token.', 401),
        viewerUser: null
      };
    }
    return { errorResponse: null, viewerUser: tokenUser };
  }
  return { errorResponse: null, viewerUser: c.get('user') || null };
}

eventsCoreRouter.get('/calendar.ics', async (c) => {
  try {
    const { errorResponse, viewerUser } = await resolveIcsViewer(c);
    if (errorResponse) return errorResponse;

    const { results: allEvents } = await c.env.DB.prepare(
      "SELECT * FROM events WHERE status IN ('active', 'rainout') ORDER BY event_date ASC LIMIT 500"
    ).all();
    const origin = getSafePublicOrigin(c);
    const cfg = resolveConfig(c.env);
    const ics = buildCalendarIcs(allEvents || [], origin, { viewerUser, env: c.env });
    const forceDownload = c.req.query('download') === '1';
    const fileSlug = buildCalendarSlug(cfg, 'pickup-baseball', 'community');

    return createIcsResponse(ics, `${fileSlug}-schedule.ics`, forceDownload);
  } catch (err) {
    console.error('[Events] Error generating live calendar.ics feed:', err);
    return c.text('Failed to generate calendar feed.', 500);
  }
});

eventsCoreRouter.get('/:id/calendar.ics', async (c) => {
  const eventId = parseInt(c.req.param('id'), 10);
  if (isNaN(eventId) || eventId <= 0) {
    return c.text('Invalid event ID.', 400);
  }

  try {
    const { errorResponse, viewerUser } = await resolveIcsViewer(c);
    if (errorResponse) return errorResponse;

    const ev = await c.env.DB.prepare(
      "SELECT * FROM events WHERE id = ? AND status IN ('active', 'rainout')"
    ).bind(eventId).first();
    if (!ev || !canUserAccessEvent(viewerUser, ev)) {
      return c.text('Event not found.', 404);
    }

    const origin = getSafePublicOrigin(c);
    const cfg = resolveConfig(c.env);
    const baseTitle = ev.title || cfg.COMMUNITY_NAME;
    const ics = buildCalendarIcs([ev], origin, {
      viewerUser,
      env: c.env,
      calendarName: baseTitle,
      calendarDesc: `Live updates for ${baseTitle} (${origin}/event.html?id=${ev.id})`
    });
    const forceDownload = c.req.query('download') === '1';
    const fileSlug = buildCalendarSlug(cfg, 'pickup-baseball-game', 'community-event');

    return createIcsResponse(ics, `${fileSlug}-${ev.id}.ics`, forceDownload);
  } catch (err) {
    console.error('[Events] Error generating single-game calendar.ics feed:', err);
    return c.text('Failed to generate game calendar feed.', 500);
  }
});

eventsCoreRouter.all('/reminders/check', async (c) => {
  const user = c.get('user');
  const cronSecret = (c.env && (c.env.CRON_SECRET || c.env.REMINDERS_SECRET)) || '';
  const authHeader = c.req.header('Authorization') || '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const headerSecret = c.req.header('X-Cron-Secret') || '';
  const hasValidSecret = Boolean(
    cronSecret && (
      (bearerToken && constantTimeEqual(bearerToken, cronSecret)) ||
      (headerSecret && constantTimeEqual(headerSecret, cronSecret))
    )
  );
  const isAuthorizedManager = Boolean(user && (user.canManageEvents || user.isAdmin));

  if (!hasValidSecret && !isAuthorizedManager) {
    return c.json({ error: user ? 'Organizer or administrator privileges required.' : 'Authentication required.' }, user ? 403 : 401);
  }
  if (c.req.method !== 'POST') {
    return c.json({ error: 'Method not allowed. Use POST to trigger reminder dispatch.' }, 405);
  }

  try {
    const origin = getSafePublicOrigin(c);
    const processed = await processUpcomingEventRemindersD1(c.env.DB, c.env, origin);
    return c.json({ success: true, processed, message: 'Reminder check executed.' });
  } catch (err) {
    console.error('[Reminders] Error checking reminders:', err);
    return c.json({ error: 'Failed to process reminders.' }, 500);
  }
});

eventsCoreRouter.get('/:id', async (c) => {
  try {
    const eventId = parseInt(c.req.param('id'), 10);
    if (!eventId || isNaN(eventId) || eventId <= 0) {
      return c.json({ error: 'Invalid event ID.' }, 400);
    }
    const token = c.req.query('token');
    const user = c.get('user');
    const db = c.env.DB;

    const batchStmts = [
      db.prepare('SELECT * FROM events WHERE id = ?').bind(eventId),
      db.prepare(`
        SELECT d.*,
          COALESCE((
            SELECT json_group_array(json_object(
              'attendee_id', a.id,
              'user_id', a.user_id,
              'name', a.name,
              'email', a.email,
              'roster_consent', COALESCE(a.roster_consent, 0),
              'roster_visibility', COALESCE(u.roster_visibility, 0)
            ))
            FROM duty_assignments da
            JOIN attendees a ON da.attendee_id = a.id
            LEFT JOIN users u ON a.user_id = u.id
            WHERE da.duty_id = d.id AND a.status = 'attending'
          ), '[]') as assigned_players
        FROM event_duties d
        WHERE d.event_id = ?
        ORDER BY d.sort_order ASC, d.id ASC
      `).bind(eventId),
      db.prepare(`
        SELECT a.id, a.user_id, a.name, a.email, a.status, a.gear_bringing, a.notes,
          COALESCE(a.players_count, 1 + COALESCE(a.additional_guests, 0)) as players_count,
          COALESCE(a.spectators_count, 0) as spectators_count,
          a.additional_guests, a.guest_names, a.is_guest, a.created_at,
          COALESCE(a.roster_consent, 0) as roster_consent,
          u.bio,
          COALESCE(u.waiver_status, 'none') as waiver_status,
          COALESCE(u.roster_visibility, 0) as roster_visibility,
          COALESCE(u.profile_sharing, 0) as profile_sharing,
          ${AVATAR_EXPR} as avatar_url,
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
      `).bind(eventId),
      db.prepare(`
        SELECT a.id, a.user_id, a.name, a.email, a.status, a.gear_bringing, a.notes,
          COALESCE(a.players_count, 1 + COALESCE(a.additional_guests, 0)) as players_count,
          COALESCE(a.spectators_count, 0) as spectators_count,
          a.additional_guests, a.guest_names, a.is_guest, a.created_at,
          COALESCE(a.roster_consent, 0) as roster_consent,
          u.bio,
          COALESCE(u.waiver_status, 'none') as waiver_status,
          COALESCE(u.roster_visibility, 0) as roster_visibility,
          COALESCE(u.profile_sharing, 0) as profile_sharing,
          ${AVATAR_EXPR} as avatar_url
        FROM attendees a
        LEFT JOIN users u ON a.user_id = u.id
        WHERE a.event_id = ? AND a.status = 'waitlist'
        ORDER BY a.created_at ASC, a.id ASC
      `).bind(eventId),
      db.prepare(`
        SELECT c.id, c.author_name, c.content, c.created_at, c.user_id,
          COALESCE(u.roster_visibility, 0) as roster_visibility,
          COALESCE(u.profile_sharing, 0) as profile_sharing,
          ${AVATAR_EXPR} as avatar_url,
          u.bio
        FROM comments c
        LEFT JOIN users u ON c.user_id = u.id
        WHERE c.event_id = ?
        ORDER BY c.created_at ASC
      `).bind(eventId),
      db.prepare(`
        SELECT bp.id, bp.event_id, bp.user_id, bp.attendee_id, bp.slot_number,
          bp.player_name, bp.notes, bp.created_at,
          COALESCE(a.roster_consent, 0) as roster_consent,
          COALESCE(u.roster_visibility, 0) as roster_visibility,
          COALESCE(u.profile_sharing, 0) as profile_sharing,
          ${AVATAR_EXPR} as avatar_url,
          u.role as user_role
        FROM batting_practice_signups bp
        LEFT JOIN users u ON bp.user_id = u.id
        LEFT JOIN attendees a ON bp.attendee_id = a.id
        WHERE bp.event_id = ?
        ORDER BY bp.slot_number ASC
      `).bind(eventId)
    ];

    if (user) {
      batchStmts.push(
        db.prepare(`
          SELECT a.id, a.event_id, a.user_id, a.name, a.email, a.status, a.gear_bringing,
            COALESCE(a.players_count, 1 + COALESCE(a.additional_guests, 0)) as players_count,
            COALESCE(a.spectators_count, 0) as spectators_count,
            a.additional_guests, a.guest_names,
            (SELECT json_group_array(duty_id) FROM duty_assignments WHERE attendee_id = a.id) as duty_ids
          FROM attendees a
          WHERE a.event_id = ? AND (a.user_id = ? OR a.email = ?)
        `).bind(eventId, user.id, user.email)
      );
    } else if (token) {
      const tokenStmt = await prepareAttendeeByManagementToken(db, {
        eventId,
        rawToken: token,
        columns: ATTENDEE_DETAIL_COLUMNS,
        userIdIsNull: true
      });
      if (tokenStmt) {
        batchStmts.push(tokenStmt);
      }
    }

    const batchRes = await db.batch(batchStmts);
    /** @type {Record<string, any>|null} */
    const event = (batchRes[0].results && batchRes[0].results[0]) || null;
    if (!event) {
      return c.json({ error: 'Event not found.' }, 404);
    }

    const earlyAllowedList = parseAllowedEmails(event.allowed_emails);
    if (earlyAllowedList.length > 0 && !canUserAccessEvent(user, earlyAllowedList)) {
      if (!user) {
        return c.json({
          error: 'This pickup game is restricted to an invite list. Please log in with an invited account to view game details.',
          restricted: true
        }, 401);
      }
      return c.json({
        error: 'Access denied: this pickup game is restricted to an invite list.',
        restricted: true
      }, 403);
    }

    /** @type {Array<Record<string, any>>} */
    const duties = (batchRes[1].results || []).map(/** @param {Record<string, any>} d */ d => ({
      ...d,
      assigned_players: JSON.parse(d.assigned_players || '[]')
    }));

    /** @type {Array<Record<string, any>>} */
    const attendees = batchRes[2].results || [];
    /** @type {Array<Record<string, any>>} */
    const waitlist = batchRes[3].results || [];
    /** @type {Array<Record<string, any>>} */
    const comments = batchRes[4].results || [];
    /** @type {Array<Record<string, any>>} */
    const bpSignups = batchRes[5].results || [];
    /** @type {Record<string, any>|null} */
    let myRsvp = (batchRes.length > 6 && batchRes[6] && batchRes[6].results && batchRes[6].results[0]) || null;
    if (myRsvp) {
      if (myRsvp.email && !isDeliverableEmail(myRsvp.email)) {
        myRsvp.email = '';
      }
      try {
        const parsedDutyIds = JSON.parse(myRsvp.duty_ids || '[]');
        myRsvp.duty_ids = Array.isArray(parsedDutyIds) ? parsedDutyIds.filter((n) => n != null) : [];
      } catch (e) {
        myRsvp.duty_ids = [];
      }
    }

    const cfg = resolveConfig(c.env);
    const certifiedShiftsEnabled = cfg.FEATURE_CERTIFIED_SHIFTS;
    const battingPracticeEnabled = cfg.FEATURE_BATTING_PRACTICE;

    const isOrganizer = isViewerOrganizer(user);
    const canViewRoster = Boolean(user || (myRsvp && myRsvp.id));
    const tierInfo = certifiedShiftsEnabled
      ? getTaskTier(event.event_date)
      : { tier: 'open', isUnlocked: true, unlockAt: null };
    const viewerId = user ? user.id : (myRsvp && myRsvp.user_id ? myRsvp.user_id : null);
    const [requireLogin, viewerUser, machineCap, fieldCap] = await Promise.all([
      getRequireLoginSetting(db, c.env),
      viewerId
        ? /** @type {Promise<Record<string, any>|null>} */ (db.prepare('SELECT id, machine_badge, field_badge, hero_credits FROM users WHERE id = ?').bind(viewerId).first())
        : Promise.resolve(null),
      certifiedShiftsEnabled ? getDutyTier1Cap(db, 'machine') : Promise.resolve(null),
      certifiedShiftsEnabled ? getDutyTier1Cap(db, 'field') : Promise.resolve(null)
    ]);

    const hoursUntilEvent = (new Date(event.event_date).getTime() - Date.now()) / (3600 * 1000);
    const isUrgentCoverWindow = certifiedShiftsEnabled && hoursUntilEvent > 0 && hoursUntilEvent < 48;

    if (myRsvp && viewerUser) {
      myRsvp.hero_credits = viewerUser.hero_credits || 0;
      myRsvp.machine_badge = viewerUser.machine_badge || 0;
      myRsvp.field_badge = viewerUser.field_badge || 0;
    }

    const [viewerMachineShifts, viewerFieldShifts] = (certifiedShiftsEnabled && viewerUser)
      ? await Promise.all([
          getUserRollingShifts(db, viewerUser.id, 'machine', event.event_date, event.id),
          getUserRollingShifts(db, viewerUser.id, 'field', event.event_date, event.id)
        ])
      : [0, 0];

    const sanitizedDuties = duties.map(d => {
      const dType = getDutyType(d, { certifiedShiftsEnabled });
      let userHasBadge = false;
      let isEligible = true;
      let ineligibilityReason = null;
      let canUseHeroCredit = false;
      let tier1Cap = null;
      let userCurrentShifts = 0;

      if (certifiedShiftsEnabled && !tierInfo.isUnlocked) {
        isEligible = false;
        ineligibilityReason = `Tasks locked until ${formatUnlockDateTime(tierInfo.unlockAt)}`;
      } else if (dType.isPaid) {
        tier1Cap = dType.type === 'machine' ? machineCap : fieldCap;
        if (viewerUser) {
          userHasBadge = dType.type === 'machine' ? Boolean(viewerUser.machine_badge) : Boolean(viewerUser.field_badge);
          if (!userHasBadge) {
            isEligible = false;
            ineligibilityReason = `Requires ${dType.badgeName}`;
          } else {
            userCurrentShifts = dType.type === 'machine' ? viewerMachineShifts : viewerFieldShifts;
            if (tierInfo.tier === 'tier1' && userCurrentShifts >= tier1Cap) {
              if ((viewerUser.hero_credits || 0) >= 1) {
                isEligible = true;
                canUseHeroCredit = true;
                ineligibilityReason = `Tier 1 cap reached (${tier1Cap} shifts). Redeem 1 Backup Hero Credit to select early.`;
              } else {
                isEligible = false;
                ineligibilityReason = `Tier 1 cap reached (${tier1Cap} shifts). Opens in Tier 2 (6 weeks before game) or requires 1 Backup Hero Credit.`;
              }
            }
          }
        } else {
          isEligible = false;
          ineligibilityReason = 'To select this task you must first complete training';
        }
      }

      return {
        ...d,
        assigned_players: sanitizeDutyAssignedPlayers(d.assigned_players || [], {
          user,
          isOrganizer,
          myRsvp
        }),
        duty_type: dType.type,
        is_paid: dType.isPaid,
        requires_badge: dType.requiredBadge,
        badge_name: dType.badgeName,
        user_has_badge: userHasBadge,
        is_eligible: isEligible,
        ineligibility_reason: ineligibilityReason,
        can_use_hero_credit: canUseHeroCredit,
        tier1_cap: tier1Cap,
        user_current_shifts: userCurrentShifts,
        is_urgent_cover: isUrgentCoverWindow && dType.isPaid
      };
    });

    const allowedList = parseAllowedEmails(event.allowed_emails);
    const isRestricted = allowedList.length > 0;
    let isAllowedToRsvp = true;
    if (isRestricted) {
      if (user && user.canManageEvents) isAllowedToRsvp = true;
      else if (user && user.email) isAllowedToRsvp = allowedList.includes(user.email.toLowerCase());
      else if (myRsvp && myRsvp.email) isAllowedToRsvp = allowedList.includes(myRsvp.email.toLowerCase());
      else isAllowedToRsvp = false;
    }

    const totalConfirmedPlayers = attendees.reduce((sum, a) => sum + (a.players_count != null ? a.players_count : (1 + (a.additional_guests || 0))), 0);
    const totalConfirmedSpectators = attendees.reduce((sum, a) => sum + (a.spectators_count || 0), 0);
    const totalWaitlistPlayers = waitlist.reduce((sum, w) => sum + (w.players_count != null ? w.players_count : (1 + (w.additional_guests || 0))), 0);

    const decoratedBpSignups = battingPracticeEnabled
      ? bpSignups.map(s => ({
          ...s,
          is_mine: Boolean(
            (user && s.user_id && s.user_id === user.id) ||
            (myRsvp && s.attendee_id && s.attendee_id === myRsvp.id) ||
            (myRsvp && s.player_name && myRsvp.name && s.player_name.trim().toLowerCase() === myRsvp.name.trim().toLowerCase())
          )
        }))
      : [];

    /** @type {Record<string, any>} */
    const safeEventObj = {
      ...event,
      allowed_emails_list: isOrganizer ? allowedList : [],
      is_restricted: isRestricted,
      is_allowed_to_rsvp: isAllowedToRsvp,
      task_unlock_at: tierInfo.unlockAt,
      task_tier: tierInfo.tier,
      is_tasks_unlocked: tierInfo.isUnlocked,
      hours_until_event: hoursUntilEvent
    };
    if (!isOrganizer) {
      delete safeEventObj.allowed_emails;
    }

    const canViewBpOrder = Boolean(battingPracticeEnabled && user && canUserAccessEvent(user, earlyAllowedList));
    const visibleBpSignups = canViewBpOrder
      ? sanitizeBpSignupsForViewer(decoratedBpSignups, { user, isOrganizer, myRsvp })
      : [];

    const rawVisibleAttendees = !canViewRoster
      ? []
      : (user ? attendees : attendees.filter(a => myRsvp && a.id === myRsvp.id));
    const rawVisibleWaitlist = !canViewRoster
      ? []
      : (user ? waitlist : waitlist.filter(w => myRsvp && w.id === myRsvp.id));

    const visibleAttendees = sanitizeAttendeesForViewer(rawVisibleAttendees, { user, isOrganizer, myRsvp });
    const visibleWaitlist = sanitizeAttendeesForViewer(rawVisibleWaitlist, { user, isOrganizer, myRsvp });
    const visibleComments = sanitizeCommentsForViewer(comments, { user, isOrganizer });

    return c.json({
      event: safeEventObj,
      duties: sanitizedDuties,
      attendees: visibleAttendees,
      waitlist: visibleWaitlist,
      comments: visibleComments,
      bp_signups: visibleBpSignups,
      bpCount: battingPracticeEnabled ? bpSignups.length : 0,
      canViewBpOrder,
      myRsvp,
      canViewRoster,
      totalAttendees: totalConfirmedPlayers,
      totalSpectators: totalConfirmedSpectators,
      totalHeadcount: totalConfirmedPlayers + totalConfirmedSpectators,
      totalWaitlist: totalWaitlistPlayers,
      user: user || null,
      require_login_to_rsvp: requireLogin
    });
  } catch (err) {
    console.error('[Events] Error fetching event details:', err);
    return c.json({ error: 'Failed to fetch event details.' }, 500);
  }
});

eventsCoreRouter.post('/', requireOrganizer, async (c) => {
  const user = c.get('user');
  try {
    const {
      title, description, location, location_url,
      event_date, max_players, use_default_duties,
      custom_duties, allowed_emails
    } = await c.req.json();

    if (!title || !String(title).trim() || !location || !String(location).trim() || !event_date) {
      return c.json({ error: 'Title, location, and event date/time are required.' }, 400);
    }
    if (isNaN(new Date(event_date).getTime())) {
      return c.json({ error: 'A valid event date/time is required.' }, 400);
    }

    const safeLocUrl = sanitizeHttpUrl(location_url);
    if (safeLocUrl === null) {
      return c.json({ error: 'Map link must be a valid http:// or https:// URL.' }, 400);
    }

    let dutiesToInsert = [];
    if (use_default_duties || !custom_duties || custom_duties.length === 0) {
      dutiesToInsert = await getDefaultDuties(c.env.DB, c.env);
    } else if (Array.isArray(custom_duties)) {
      if (custom_duties.length > 25) {
        return c.json({ error: 'Cannot create more than 25 volunteer tasks per event.' }, 400);
      }
      for (const d of custom_duties) {
        if (!d || !d.title || !String(d.title).trim()) {
          return c.json({ error: 'All custom duties must have a non-empty title.' }, 400);
        }
        if (normalizeDutyFlags(d).invalidBadge) {
          return c.json({ error: `Invalid required_badge on duty '${String(d.title).trim()}'. Must be 'machine', 'field', or null.` }, 400);
        }
      }
      dutiesToInsert = custom_duties;
    } else {
      dutiesToInsert = await getDefaultDuties(c.env.DB, c.env);
    }

    const allowedList = parseAllowedEmails(allowed_emails);
    const allowedEmailsJson = allowedList.length > 0 ? JSON.stringify(allowedList) : null;

    const insertEventRes = await c.env.DB.prepare(`
      INSERT INTO events (title, description, location, location_url, event_date, max_players, allowed_emails, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      String(title).trim().slice(0, 150),
      String(description || '').trim().slice(0, 2000),
      String(location).trim().slice(0, 200),
      safeLocUrl,
      event_date,
      max_players ? parseInt(max_players, 10) : null,
      allowedEmailsJson,
      user.id
    ).run();

    const eventId = insertEventRes.meta.last_row_id;

    if (dutiesToInsert.length > 0) {
      await c.env.DB.batch(dutiesToInsert.map((d, idx) => {
        const flags = normalizeDutyFlags(d);
        return c.env.DB.prepare(
          'INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order, grants_coordinator, required_badge) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).bind(
          eventId,
          String(d.title).trim().slice(0, 120),
          String(d.description || '').trim().slice(0, 300),
          Math.min(50, Math.max(1, parseInt(d.slots_needed || 1, 10) || 1)),
          d.sort_order !== undefined ? parseInt(d.sort_order, 10) : idx,
          flags.grantsCoordinator,
          flags.requiredBadge
        );
      }));
    }

    const newEvent = await c.env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(eventId).first();
    return c.json({ success: true, eventId, event: newEvent, message: 'Event created successfully.' });
  } catch (err) {
    console.error('[Events] Error creating event:', err);
    return c.json({ error: 'Failed to create event.' }, 500);
  }
});

eventsCoreRouter.put('/:id', requireOrganizer, async (c) => {
  try {
    const eventId = parseInt(c.req.param('id'), 10);
    if (!eventId || isNaN(eventId) || eventId <= 0) {
      return c.json({ error: 'Invalid event ID.' }, 400);
    }
    const { title, description, location, location_url, event_date, max_players, actual_attendance, status, allowed_emails } = await c.req.json();

    const existingEvent = await c.env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(eventId).first();
    if (!existingEvent) {
      return c.json({ error: 'Event not found.' }, 404);
    }

    if (title !== undefined && (!title || !String(title).trim())) {
      return c.json({ error: 'Event title cannot be empty.' }, 400);
    }
    if (location !== undefined && (!location || !String(location).trim())) {
      return c.json({ error: 'Event location cannot be empty.' }, 400);
    }
    if (event_date !== undefined && event_date !== null && isNaN(new Date(event_date).getTime())) {
      return c.json({ error: 'A valid event date/time is required.' }, 400);
    }
    if (status !== undefined && status !== null && !['active', 'rainout', 'cancelled', 'completed'].includes(String(status))) {
      return c.json({ error: 'Invalid event status.' }, 400);
    }

    let safeLocUrl = null;
    if (location_url !== undefined) {
      safeLocUrl = sanitizeHttpUrl(location_url);
      if (safeLocUrl === null) {
        return c.json({ error: 'Map link must be a valid http:// or https:// URL.' }, 400);
      }
    }

    const newMaxPlayers = max_players === undefined
      ? existingEvent.max_players
      : (max_players === null || max_players === '' ? null : (isNaN(parseInt(max_players, 10)) ? existingEvent.max_players : parseInt(max_players, 10)));

    const newActualAttendance = actual_attendance === undefined
      ? existingEvent.actual_attendance
      : (actual_attendance === null || actual_attendance === '' ? null : (isNaN(parseInt(actual_attendance, 10)) || parseInt(actual_attendance, 10) < 0 ? null : parseInt(actual_attendance, 10)));

    let newAllowedEmails = existingEvent.allowed_emails;
    if (allowed_emails !== undefined) {
      if (allowed_emails === null || allowed_emails === '') {
        newAllowedEmails = null;
      } else {
        const list = parseAllowedEmails(allowed_emails);
        newAllowedEmails = list.length > 0 ? JSON.stringify(list) : null;
      }
    }

    await c.env.DB.prepare(`
      UPDATE events
      SET title = COALESCE(?, title),
          description = COALESCE(?, description),
          location = COALESCE(?, location),
          location_url = COALESCE(?, location_url),
          event_date = COALESCE(?, event_date),
          max_players = ?,
          actual_attendance = ?,
          allowed_emails = ?,
          status = COALESCE(?, status)
      WHERE id = ?
    `).bind(
      title !== undefined ? String(title).trim().slice(0, 150) : null,
      description !== undefined ? String(description).trim().slice(0, 2000) : null,
      location !== undefined ? String(location).trim().slice(0, 200) : null,
      location_url !== undefined ? safeLocUrl : null,
      event_date || null,
      newMaxPlayers,
      newActualAttendance,
      newAllowedEmails,
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

eventsCoreRouter.delete('/:id', requireAdmin, async (c) => {
  try {
    const eventId = parseInt(c.req.param('id'), 10);
    if (!eventId || isNaN(eventId) || eventId <= 0) {
      return c.json({ error: 'Invalid event ID.' }, 400);
    }
    const existing = await c.env.DB.prepare('SELECT id, allowed_emails FROM events WHERE id = ?').bind(eventId).first();
    if (!existing) {
      return c.json({ error: 'Event not found.' }, 404);
    }
    const isInviteRestricted = parseAllowedEmails(existing.allowed_emails).length > 0;
    const res = await c.env.DB.prepare('DELETE FROM events WHERE id = ?').bind(eventId).run();
    if (res.meta.changes === 0) {
      return c.json({ error: 'Event not found.' }, 404);
    }
    if (isInviteRestricted) {
      // Prevent orphaned media/posts from reverting to public visibility once the invite list is gone.
      const { results: privMediaRows } = await c.env.DB.prepare('SELECT id FROM media_items WHERE event_id = ?').bind(eventId).all();
      await c.env.DB.prepare('DELETE FROM posts WHERE event_id = ?').bind(eventId).run();
      await c.env.DB.prepare('DELETE FROM media_items WHERE event_id = ?').bind(eventId).run();
      if (c.env && c.env.CHAT_DB && privMediaRows && privMediaRows.length > 0) {
        for (const m of privMediaRows) {
          try {
            await c.env.CHAT_DB.prepare('UPDATE chat_attachments SET promoted_media_id = NULL WHERE promoted_media_id = ?').bind(m.id).run();
          } catch (e) {
            logEvent('warn', 'chat_attachment_unpromote_failed', { mediaId: m.id, err: e });
          }
        }
      }
    } else {
      await c.env.DB.prepare('UPDATE posts SET event_id = NULL WHERE event_id = ?').bind(eventId).run();
      await c.env.DB.prepare('UPDATE media_items SET event_id = NULL WHERE event_id = ?').bind(eventId).run();
    }
    return c.json({ success: true, message: 'Event deleted.' });
  } catch (err) {
    console.error('[Events] Error deleting event:', err);
    return c.json({ error: 'Failed to delete event.' }, 500);
  }
});

eventsCoreRouter.post('/:id/send-reminders', requireAdmin, async (c) => {
  try {
    const eventId = parseInt(c.req.param('id'), 10);
    if (!eventId || isNaN(eventId) || eventId <= 0) {
      return c.json({ error: 'Invalid event ID.' }, 400);
    }
    const event = await c.env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(eventId).first();
    if (!event) return c.json({ error: 'Event not found.' }, 404);

    await sendRemindersForEventD1(c.env.DB, c.env, getSafePublicOrigin(c), event);
    return c.json({ success: true, message: 'Reminders have been sent to all confirmed attendees.' });
  } catch (err) {
    return jsonError(c, 500, ERROR_CODES.MAIL_ERROR, 'Failed to send reminders.');
  }
});

eventsCoreRouter.post('/:id/rainout', requireOrganizer, async (c) => {
  try {
    const eventId = parseInt(c.req.param('id'), 10);
    if (!eventId || isNaN(eventId) || eventId <= 0) {
      return c.json({ error: 'Invalid event ID.' }, 400);
    }
    const event = await c.env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(eventId).first();
    if (!event) return c.json({ error: 'Event not found.' }, 404);

    const body = await c.req.json().catch(() => ({}));
    const cleanNote = body.note ? String(body.note).trim() : null;
    const shouldEmail = Boolean(body.sendEmail);

    await c.env.DB.prepare(`
      UPDATE events
      SET status = 'rainout',
          rainout_note = ?,
          rainout_at = CURRENT_TIMESTAMP,
          rainout_email_sent = CASE WHEN ? = 1 THEN 1 ELSE rainout_email_sent END
      WHERE id = ?
    `).bind(cleanNote, shouldEmail ? 1 : 0, eventId).run();

    if (shouldEmail) {
      await notifyConfirmedAttendees(c, event, cleanNote, sendRainoutEmail);
    }
    return c.json({ success: true, message: 'Game has been marked as rained out.' });
  } catch (err) {
    console.error('[Events] Error marking rainout:', err);
    return c.json({ error: 'Failed to mark game as rained out.' }, 500);
  }
});

eventsCoreRouter.post('/:id/reopen', requireOrganizer, async (c) => {
  try {
    const eventId = parseInt(c.req.param('id'), 10);
    if (!eventId || isNaN(eventId) || eventId <= 0) {
      return c.json({ error: 'Invalid event ID.' }, 400);
    }
    const event = await c.env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(eventId).first();
    if (!event) return c.json({ error: 'Event not found.' }, 404);

    const body = await c.req.json().catch(() => ({}));
    const cleanNote = body.note ? String(body.note).trim() : null;

    await c.env.DB.prepare(
      "UPDATE events SET status = 'active', rainout_note = NULL, rainout_at = NULL, rainout_email_sent = 0 WHERE id = ?"
    ).bind(eventId).run();

    if (body.sendEmail) {
      await notifyConfirmedAttendees(c, event, cleanNote, sendReopenEmail);
    }
    return c.json({ success: true, message: 'Game has been reopened and is back on!' });
  } catch (err) {
    console.error('[Events] Error reopening event:', err);
    return c.json({ error: 'Failed to reopen game.' }, 500);
  }
});

eventsCoreRouter.post('/:id/send-rainout-email', requireOrganizer, async (c) => {
  try {
    const eventId = parseInt(c.req.param('id'), 10);
    if (!eventId || isNaN(eventId) || eventId <= 0) {
      return c.json({ error: 'Invalid event ID.' }, 400);
    }
    const event = await c.env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(eventId).first();
    if (!event) return c.json({ error: 'Event not found.' }, 404);

    const body = await c.req.json().catch(() => ({}));
    const cleanNote = body.note !== undefined ? (body.note ? String(body.note).trim() : null) : (event.rainout_note ? String(event.rainout_note) : null);

    await notifyConfirmedAttendees(c, event, cleanNote, sendRainoutEmail);
    await c.env.DB.prepare('UPDATE events SET rainout_email_sent = 1 WHERE id = ?').bind(eventId).run();

    return c.json({ success: true, message: 'Rainout email sent to confirmed attendees.' });
  } catch (err) {
    return jsonError(c, 500, ERROR_CODES.MAIL_ERROR, 'Failed to send rainout email.');
  }
});
