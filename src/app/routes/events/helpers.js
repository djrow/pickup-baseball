/**
 * @fileoverview Shared helpers for event management, waitlist promotion, email notifications,
 * and scheduled event reminders.
 * @module routes/events/helpers
 */

import {
  sendWaitlistPromotionEmail,
  sendBatch,
  buildEventReminderEmail,
  buildRainoutEmail,
  buildReopenEmail
} from '../../mailer.js';
import { getSafePublicOrigin, getManagementTokenCandidates } from '../../security.js';
import { ERROR_CODES, logEvent } from '../../errors.js';
import { resolveConfig } from '../../config.js';

/** SQL projection normalizing inline data-URI avatars to cached endpoint URLs. */
export const AVATAR_EXPR = `CASE WHEN u.avatar_url LIKE 'data:%' THEN '/api/users/' || u.id || '/avatar?v=' || length(u.avatar_url) ELSE COALESCE(u.avatar_url, '') END`;

/** Synthetic domain used when storing guest RSVPs submitted without an email address. */
export const GUEST_NO_EMAIL_SUFFIX = '@noemail.invalid';

/**
 * Returns true if an email address is deliverable (non-empty, contains `@`, not a synthetic guest placeholder).
 * @param {string|null|undefined} email
 * @returns {boolean}
 */
export function isDeliverableEmail(email) {
  if (!email || typeof email !== 'string') return false;
  const trimmed = email.trim().toLowerCase();
  return Boolean(trimmed.includes('@') && !trimmed.endsWith(GUEST_NO_EMAIL_SUFFIX));
}

/**
 * Schedules a non-blocking promise via Cloudflare Pages `waitUntil` when available.
 * @param {AppContext} c
 * @param {Promise<unknown>} promise
 */
export function runBackground(c, promise) {
  try {
    if (c.executionCtx && typeof c.executionCtx.waitUntil === 'function') {
      c.executionCtx.waitUntil(promise);
    }
  } catch (e) {
    /* executionCtx.waitUntil unavailable outside Cloudflare Workers runtime */
  }
}

/**
 * Runs an async worker across `items` with bounded concurrency.
 * @template T
 * @param {T[]} items
 * @param {number} concurrency
 * @param {(item: T) => Promise<void>} worker
 * @returns {Promise<void>}
 */
export async function runBoundedConcurrency(items, concurrency, worker) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return;
  let index = 0;
  const workerCount = Math.min(concurrency, list.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (index < list.length) {
      const current = list[index++];
      await worker(current);
    }
  }));
}

/**
 * Promotes eligible waitlisted parties into attending slots in FIFO order when spots open.
 * Dispatches waitlist promotion emails in the background.
 * @param {AppContext} c
 * @param {string} origin
 * @param {number} eventId
 * @returns {Promise<Record<string, any>|null>} First promoted attendee row, or null if none promoted.
 */
export async function promoteNextWaitlistedPlayer(c, origin, eventId) {
  const db = c.env.DB;
  /** @type {Record<string, any>|null} */
  const event = await db.prepare('SELECT * FROM events WHERE id = ?').bind(eventId).first();
  if (!event || event.status === 'rainout') return null;

  let firstPromoted = null;
  while (true) {
    const activeRow = await db.prepare(`
      SELECT COALESCE(SUM(COALESCE(players_count, 1 + COALESCE(additional_guests, 0))), 0) as total
      FROM attendees WHERE event_id = ? AND status = 'attending'
    `).bind(eventId).first();
    const activeCount = Number((activeRow && activeRow.total) || 0);

    const maxPlayers = Number(event.max_players || 0);
    if (maxPlayers && activeCount >= maxPlayers) break;
    const availableSlots = maxPlayers ? (maxPlayers - activeCount) : 999;

    /** @type {Record<string, any>|null} */
    const nextWaitlisted = await db.prepare(`
      SELECT * FROM attendees
      WHERE event_id = ? AND status = 'waitlist'
      ORDER BY created_at ASC, id ASC LIMIT 1
    `).bind(eventId).first();
    if (!nextWaitlisted) break;

    const partyPlayers = nextWaitlisted.players_count != null
      ? Number(nextWaitlisted.players_count)
      : (1 + Number(nextWaitlisted.additional_guests || 0));
    if (maxPlayers && partyPlayers > availableSlots) break;

    const promoRes = await db.prepare(
      "UPDATE attendees SET status = 'attending' WHERE id = ? AND status = 'waitlist'"
    ).bind(nextWaitlisted.id).run();
    if (!promoRes.meta || promoRes.meta.changes !== 1) continue;
    if (!firstPromoted) firstPromoted = nextWaitlisted;

    if (isDeliverableEmail(nextWaitlisted.email)) {
      runBackground(c, sendWaitlistPromotionEmail(c.env, origin, {
        email: nextWaitlisted.email,
        name: nextWaitlisted.name,
        event
      }).catch(err => logEvent('error', 'waitlist_promotion_email_failed', {
        code: ERROR_CODES.MAIL_ERROR,
        email: nextWaitlisted.email,
        msg: err && err.message ? err.message : 'Waitlist promotion email failed'
      })));
    }
  }

  return firstPromoted;
}

/**
 * Sends pre-game reminder emails to attending registrants for a single event.
 * Tracks `attendees.reminder_sent_at`, caps per-run batches (default 100),
 * stamps `reminder_sent_at` per sent batch via `db.batch()`, and sets `events.reminder_sent = 1`
 * only when `remaining === 0`.
 *
 * @param {D1Database} db - D1 database binding (`BASEBALL_DB`).
 * @param {AppBindings} env - Cloudflare environment bindings.
 * @param {string} origin - Public site origin URL.
 * @param {Record<string, any>} event - Event row.
 * @param {{ limit?: number }} [options]
 * @returns {Promise<{ sent: number, remaining: number, quotaPaused: boolean }>}
 */
export async function sendRemindersForEventD1(db, env, origin, event, options = {}) {
  const limit = options.limit !== undefined ? options.limit : 100;

  // 1. Fetch attending registrants whose reminder has not yet been sent
  const { results: unsentRows } = await db.prepare(`
    SELECT a.*, d.title as duty_name
    FROM attendees a
    LEFT JOIN duty_assignments da ON a.id = da.attendee_id
    LEFT JOIN event_duties d ON da.duty_id = d.id
    WHERE a.event_id = ? AND a.status = 'attending' AND a.reminder_sent_at IS NULL
    ORDER BY a.created_at ASC, a.id ASC
    LIMIT ?
  `).bind(event.id, limit).all();

  /** @type {Array<Record<string, any>>} */
  const candidates = (unsentRows || []).filter((att) => isDeliverableEmail(String(att.email || '')));

  if (candidates.length === 0) {
    // Check if any deliverable attendees remain unsent
    const countRow = await db.prepare(`
      SELECT COUNT(*) as count
      FROM attendees
      WHERE event_id = ? AND status = 'attending' AND reminder_sent_at IS NULL
        AND email NOT LIKE '%@noemail.invalid' AND email NOT LIKE '%.invalid'
    `).bind(event.id).first();
    const remaining = Number((countRow && countRow.count) || 0);

    if (remaining === 0) {
      await db.prepare('UPDATE events SET reminder_sent = 1 WHERE id = ?').bind(event.id).run();
    }
    return { sent: 0, remaining, quotaPaused: false };
  }

  // Count total attending to display in email
  const totalAttRow = await db.prepare(`
    SELECT COUNT(*) as total FROM attendees WHERE event_id = ? AND status = 'attending'
  `).bind(event.id).first();
  const totalAttendees = Number((totalAttRow && totalAttRow.total) || candidates.length);

  // Build batch messages
  const messages = candidates.map((att) => buildEventReminderEmail(env, origin, {
    email: att.email,
    name: att.name,
    event,
    dutyName: att.duty_name,
    gearBringing: att.gear_bringing,
    totalAttendees
  }));

  const batchRes = await sendBatch(env, db, messages, { priority: 'reminder' });

  // Atomically stamp reminder_sent_at for sent candidates
  if (batchRes.sent && batchRes.sent.length > 0) {
    const sentIndices = new Set(batchRes.sent.map((s) => s.index));
    const sentAttendees = candidates.filter((_, idx) => sentIndices.has(idx));

    if (sentAttendees.length > 0) {
      const nowIso = new Date().toISOString();
      const stmts = sentAttendees.map((att) =>
        db.prepare('UPDATE attendees SET reminder_sent_at = ? WHERE id = ?').bind(nowIso, att.id)
      );
      await db.batch(stmts);
    }
  }

  // Check remaining count
  const remainingRow = await db.prepare(`
    SELECT COUNT(*) as count
    FROM attendees
    WHERE event_id = ? AND status = 'attending' AND reminder_sent_at IS NULL
      AND email NOT LIKE '%@noemail.invalid' AND email NOT LIKE '%.invalid'
  `).bind(event.id).first();
  const remaining = Number((remainingRow && remainingRow.count) || 0);

  if (remaining === 0 && !batchRes.quotaPaused) {
    await db.prepare('UPDATE events SET reminder_sent = 1 WHERE id = ?').bind(event.id).run();
  }

  return {
    sent: (batchRes.sent && batchRes.sent.length) || 0,
    remaining,
    quotaPaused: Boolean(batchRes.quotaPaused)
  };
}

/**
 * Processes all active games within the next 36 hours whose reminders have not yet been completed.
 * @param {D1Database} db - D1 database binding.
 * @param {AppBindings} env - Cloudflare environment bindings.
 * @param {string} [origin] - Public site origin URL.
 * @returns {Promise<{ processed: number, sent: number, remaining: number, quotaPaused: boolean }>}
 */
export async function processUpcomingEventRemindersD1(db, env, origin = '') {
  const safeOrigin = origin || resolveConfig(env).PUBLIC_ORIGIN || '';
  const now = new Date();
  const windowStart = now.toISOString();
  const windowEnd = new Date(now.getTime() + 36 * 60 * 60 * 1000).toISOString();

  const { results: upcomingEvents } = await db.prepare(`
    SELECT * FROM events
    WHERE status = 'active' AND reminder_sent = 0 AND event_date >= ? AND event_date <= ?
  `).bind(windowStart, windowEnd).all();

  const list = upcomingEvents || [];
  let totalSent = 0;
  let totalRemaining = 0;
  let anyQuotaPaused = false;

  for (const ev of list) {
    const res = await sendRemindersForEventD1(db, env, safeOrigin, ev);
    totalSent += res.sent;
    totalRemaining += res.remaining;
    if (res.quotaPaused) {
      anyQuotaPaused = true;
      break;
    }
  }

  return {
    processed: list.length,
    sent: totalSent,
    remaining: totalRemaining,
    quotaPaused: anyQuotaPaused
  };
}

/**
 * Broadcasts an event status email (rainout or reopen) to confirmed attendees with deliverable emails.
 * Stamps deterministic `notice_key` (`rainout:<event_version>` / `reopen:<event_version>`)
 * into `attendees.last_notice_key` and `last_notice_sent_at` via `db.batch()`.
 * Returns `{ sent, remaining, quotaPaused }` and supports duplicate-free continuation.
 *
 * @param {AppContext} c
 * @param {Record<string, any>} event
 * @param {string|null} note
 * @param {Function} [emailBuilderOrFn] - Email builder or sender function
 * @param {{ noticeKey?: string, limit?: number, actionType?: 'rainout' | 'reopen' }} [options]
 * @returns {Promise<{ sent: number, remaining: number, quotaPaused: boolean }>}
 */
export async function notifyConfirmedAttendees(c, event, note, emailBuilderOrFn, options = {}) {
  const db = c.env.DB;
  const origin = getSafePublicOrigin(c);
  const limit = options.limit !== undefined ? options.limit : 100;

  // Determine notice_key: rainout:<version> or reopen:<version>
  const version = event.invite_version !== undefined ? event.invite_version : 1;
  const actionType = options.actionType || (event.status === 'rainout' ? 'rainout' : 'reopen');
  const noticeKey = options.noticeKey || `${actionType}:${version}`;

  // Query confirmed attendees who have not yet received this notice_key
  const { results: unsentRows } = await db.prepare(`
    SELECT * FROM attendees
    WHERE event_id = ? AND status = 'attending'
      AND (last_notice_key IS NULL OR last_notice_key != ?)
    ORDER BY created_at ASC, id ASC
    LIMIT ?
  `).bind(event.id, noticeKey, limit).all();

  const candidates = (unsentRows || []).filter((att) => isDeliverableEmail(String(att.email || '')));

  if (candidates.length === 0) {
    const countRow = await db.prepare(`
      SELECT COUNT(*) as count
      FROM attendees
      WHERE event_id = ? AND status = 'attending'
        AND (last_notice_key IS NULL OR last_notice_key != ?)
        AND email NOT LIKE '%@noemail.invalid' AND email NOT LIKE '%.invalid'
    `).bind(event.id, noticeKey).first();
    const remaining = Number((countRow && countRow.count) || 0);
    return { sent: 0, remaining, quotaPaused: false };
  }

  // Construct batch messages
  const isRainout = actionType === 'rainout';
  const messages = candidates.map((att) => {
    if (isRainout) {
      return buildRainoutEmail(c.env, origin, {
        email: att.email,
        name: att.name,
        event,
        note
      });
    }
    return buildReopenEmail(c.env, origin, {
      email: att.email,
      name: att.name,
      event,
      note
    });
  });

  const batchRes = await sendBatch(c.env, db, messages, { priority: 'rainout_reopen' });

  // Atomically stamp last_notice_key and last_notice_sent_at for sent candidates
  if (batchRes.sent && batchRes.sent.length > 0) {
    const sentIndices = new Set(batchRes.sent.map((s) => s.index));
    const sentAttendees = candidates.filter((_, idx) => sentIndices.has(idx));

    if (sentAttendees.length > 0) {
      const nowIso = new Date().toISOString();
      const stmts = sentAttendees.map((att) =>
        db.prepare('UPDATE attendees SET last_notice_key = ?, last_notice_sent_at = ? WHERE id = ?')
          .bind(noticeKey, nowIso, att.id)
      );
      await db.batch(stmts);
    }
  }

  // Remaining count for this notice_key
  const remainingRow = await db.prepare(`
    SELECT COUNT(*) as count
    FROM attendees
    WHERE event_id = ? AND status = 'attending'
      AND (last_notice_key IS NULL OR last_notice_key != ?)
      AND email NOT LIKE '%@noemail.invalid' AND email NOT LIKE '%.invalid'
  `).bind(event.id, noticeKey).first();
  const remaining = Number((remainingRow && remainingRow.count) || 0);

  return {
    sent: (batchRes.sent && batchRes.sent.length) || 0,
    remaining,
    quotaPaused: Boolean(batchRes.quotaPaused)
  };
}

/** Detail projection for `GET /api/events/:id` attendee self-lookup. */
export const ATTENDEE_DETAIL_COLUMNS = `a.id, a.event_id, a.user_id, a.name, a.email, a.status, a.gear_bringing,
  COALESCE(a.players_count, 1 + COALESCE(a.additional_guests, 0)) as players_count,
  COALESCE(a.spectators_count, 0) as spectators_count,
  a.additional_guests, a.guest_names,
  COALESCE(a.notify_emails, 0) as notify_emails,
  COALESCE(a.roster_consent, 0) as roster_consent,
  (SELECT json_group_array(duty_id) FROM duty_assignments WHERE attendee_id = a.id) as duty_ids`;

const ALLOWED_ATTENDEE_COLUMNS = new Set([
  '*',
  'a.*',
  'id',
  'a.id',
  'id, name',
  'a.id, a.name',
  ATTENDEE_DETAIL_COLUMNS
]);

/**
 * Prepares a parameterized D1 statement looking up an attendee by hashed `sha256:` management token.
 * Returns `null` if `rawToken` is empty/invalid or neither `eventId` nor `attendeeId` is supplied.
 * @param {D1Database} db
 * @param {{ eventId?: number|null, attendeeId?: number|null, rawToken: unknown, columns?: string, userIdIsNull?: boolean }} opts
 * @returns {Promise<ReturnType<D1Database['prepare']>|null>}
 */
export async function prepareAttendeeByManagementToken(db, {
  eventId = null,
  attendeeId = null,
  rawToken,
  columns = '*',
  userIdIsNull = false
}) {
  const candidates = await getManagementTokenCandidates(rawToken);
  if (!candidates) return null;

  const selectClause = ALLOWED_ATTENDEE_COLUMNS.has(columns) ? columns : '*';
  const scopeCol = attendeeId != null ? 'a.id' : 'a.event_id';
  const scopeVal = attendeeId != null ? attendeeId : eventId;
  if (scopeVal == null) return null;

  const userNullSql = userIdIsNull ? ' AND a.user_id IS NULL' : '';
  const sql = `SELECT ${selectClause} FROM attendees a WHERE ${scopeCol} = ? AND a.management_token = ?${userNullSql}`;
  return db.prepare(sql).bind(scopeVal, candidates.hashed);
}

/**
 * Looks up a single attendee row by hashed `sha256:` management token.
 * @param {D1Database} db
 * @param {{ eventId?: number|null, attendeeId?: number|null, rawToken: unknown, columns?: string, userIdIsNull?: boolean }} opts
 * @returns {Promise<Record<string, any>|null>}
 */
export async function findAttendeeByManagementToken(db, opts) {
  const stmt = await prepareAttendeeByManagementToken(db, opts);
  if (!stmt) return null;
  return stmt.first();
}
