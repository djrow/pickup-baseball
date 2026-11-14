/**
 * @fileoverview Shared helpers for event management, waitlist promotion, email notifications,
 * and scheduled event reminders.
 * @module routes/events/helpers
 */

import {
  sendWaitlistPromotionEmail,
  sendEventReminder
} from '../../mailer.js';
import { getSafePublicOrigin } from '../../security.js';

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
 * @param {import('hono').Context} c
 * @param {Promise<unknown>} promise
 */
export function runBackground(c, promise) {
  try {
    if (c.executionCtx && typeof c.executionCtx.waitUntil === 'function') {
      c.executionCtx.waitUntil(promise);
    }
  } catch (e) {}
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
 * @param {import('hono').Context} c
 * @param {string} origin
 * @param {number} eventId
 * @returns {Promise<object|null>} First promoted attendee row, or null if none promoted.
 */
export async function promoteNextWaitlistedPlayer(c, origin, eventId) {
  const db = c.env.DB;
  const event = await db.prepare('SELECT * FROM events WHERE id = ?').bind(eventId).first();
  if (!event || event.status === 'rainout') return null;

  let firstPromoted = null;
  while (true) {
    const activeRow = await db.prepare(`
      SELECT COALESCE(SUM(COALESCE(players_count, 1 + COALESCE(additional_guests, 0))), 0) as total
      FROM attendees WHERE event_id = ? AND status = 'attending'
    `).bind(eventId).first();
    const activeCount = activeRow ? activeRow.total : 0;

    if (event.max_players && activeCount >= event.max_players) break;
    const availableSlots = event.max_players ? (event.max_players - activeCount) : 999;

    const nextWaitlisted = await db.prepare(`
      SELECT * FROM attendees
      WHERE event_id = ? AND status = 'waitlist'
      ORDER BY created_at ASC, id ASC LIMIT 1
    `).bind(eventId).first();
    if (!nextWaitlisted) break;

    const partyPlayers = nextWaitlisted.players_count != null
      ? nextWaitlisted.players_count
      : (1 + (nextWaitlisted.additional_guests || 0));
    if (event.max_players && partyPlayers > availableSlots) break;

    await db.prepare("UPDATE attendees SET status = 'attending' WHERE id = ?").bind(nextWaitlisted.id).run();
    if (!firstPromoted) firstPromoted = nextWaitlisted;

    if (isDeliverableEmail(nextWaitlisted.email)) {
      runBackground(c, sendWaitlistPromotionEmail(c.env, origin, {
        email: nextWaitlisted.email,
        name: nextWaitlisted.name,
        event,
        managementToken: nextWaitlisted.management_token
      }).catch(err => console.error('[Waitlist] Failed to dispatch promotion email:', err)));
    }
  }

  return firstPromoted;
}

/**
 * Sends pre-game reminder emails to all attending registrants for a single event and marks `reminder_sent = 1`.
 * @param {object} db - D1 database binding (`BASEBALL_DB`).
 * @param {object} env - Cloudflare environment bindings.
 * @param {string} origin - Public site origin URL.
 * @param {object} event - Event row.
 * @returns {Promise<void>}
 */
export async function sendRemindersForEventD1(db, env, origin, event) {
  const { results: attendees } = await db.prepare(`
    SELECT a.*, d.title as duty_name
    FROM attendees a
    LEFT JOIN duty_assignments da ON a.id = da.attendee_id
    LEFT JOIN event_duties d ON da.duty_id = d.id
    WHERE a.event_id = ? AND a.status = 'attending'
  `).bind(event.id).all();

  const list = attendees || [];
  await runBoundedConcurrency(list, 5, async (att) => {
    if (!isDeliverableEmail(att.email)) return;
    try {
      await sendEventReminder(env, origin, {
        email: att.email,
        name: att.name,
        event,
        dutyName: att.duty_name,
        gearBringing: att.gear_bringing,
        totalAttendees: list.length,
        managementToken: att.management_token
      });
    } catch (e) {
      console.error('[Reminders] Error sending reminder to ' + att.email + ':', e);
    }
  });
  await db.prepare('UPDATE events SET reminder_sent = 1 WHERE id = ?').bind(event.id).run();
}

/**
 * Processes all active games within the next 36 hours whose reminders have not yet been sent.
 * @param {object} db - D1 database binding.
 * @param {object} env - Cloudflare environment bindings.
 * @param {string} [origin] - Public site origin URL.
 * @returns {Promise<number>} Count of events processed.
 */
export async function processUpcomingEventRemindersD1(db, env, origin = 'https://www.pickupbaseballfoundation.org') {
  const now = new Date();
  const windowStart = now.toISOString();
  const windowEnd = new Date(now.getTime() + 36 * 60 * 60 * 1000).toISOString();

  const { results: upcomingEvents } = await db.prepare(`
    SELECT * FROM events
    WHERE status = 'active' AND reminder_sent = 0 AND event_date >= ? AND event_date <= ?
  `).bind(windowStart, windowEnd).all();

  const list = upcomingEvents || [];
  for (const ev of list) {
    await sendRemindersForEventD1(db, env, origin, ev);
  }
  return list.length;
}

/**
 * Broadcasts an event status email (rainout or reopen) to all confirmed attendees with deliverable emails.
 * @param {import('hono').Context} c
 * @param {object} event
 * @param {string|null} note
 * @param {(env: object, origin: string, payload: object) => Promise<void>} emailFn
 * @returns {Promise<void>}
 */
export async function notifyConfirmedAttendees(c, event, note, emailFn) {
  const { results: attendees } = await c.env.DB.prepare(
    "SELECT * FROM attendees WHERE event_id = ? AND status = 'attending'"
  ).bind(event.id).all();
  const origin = getSafePublicOrigin(c);
  await runBoundedConcurrency(attendees || [], 5, async (att) => {
    if (!isDeliverableEmail(att.email)) return;
    try {
      await emailFn(c.env, origin, {
        email: att.email,
        name: att.name,
        event,
        note,
        managementToken: att.management_token
      });
    } catch (e) {
      console.error('[EventNotice] Error sending email to ' + att.email + ':', e);
    }
  });
}
