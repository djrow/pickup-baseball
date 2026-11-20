/**
 * @fileoverview Opt-In, Configurable Web Push Notifications Router.
 * Manages per-member browser push subscriptions and preferences.
 * Every notification category is OFF by default (explicit opt-in).
 *
 * @module app/routes/push
 */

import { Hono } from 'hono';
import { requireAuth } from '../security.js';
import { jsonError, ERROR_CODES } from '../errors.js';

export const pushRouter = /** @type {AppHono} */ (new Hono());

const BOOL_PREFS = [
  'notify_rainouts', 'notify_reminders', 'notify_announcements',
  'notify_mentions', 'notify_everyone', 'notify_dms', 'notify_replies',
  'notify_reactions', 'notify_moderation', 'hide_previews', 'quiet_enabled'
];
const PREF_COLUMNS = BOOL_PREFS.concat(['quiet_start', 'quiet_end', 'quiet_tz']);

/** @param {any} v @param {string} fallback */
function cleanTime(v, fallback) {
  return typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : fallback;
}

/** @param {any} v */
function cleanTz(v) {
  if (typeof v !== 'string' || v.length > 64) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: v });
    return v;
  } catch (e) {
    return 'UTC';
  }
}

/** Normalize request body into ordered DB values. @param {any} body */
function parsePrefs(body) {
  const b = body && typeof body === 'object' ? body : {};
  /** @type {Record<string, any>} */
  const out = {};
  BOOL_PREFS.forEach((k) => { out[k] = b[k] === true ? 1 : 0; });
  out.quiet_start = cleanTime(b.quiet_start, '22:00');
  out.quiet_end = cleanTime(b.quiet_end, '07:00');
  out.quiet_tz = cleanTz(b.quiet_tz);
  return out;
}

/** @param {Record<string, any>|null} row */
function prefsToJson(row) {
  /** @type {Record<string, any>} */
  const out = {};
  BOOL_PREFS.forEach((k) => { out[k] = row ? Boolean(row[k]) : false; });
  out.quiet_start = row && row.quiet_start ? row.quiet_start : '22:00';
  out.quiet_end = row && row.quiet_end ? row.quiet_end : '07:00';
  out.quiet_tz = row && row.quiet_tz ? row.quiet_tz : 'UTC';
  return out;
}

pushRouter.get('/vapid-public-key', (c) => {
  const publicKey = (c.env && c.env.VAPID_PUBLIC_KEY) ? String(c.env.VAPID_PUBLIC_KEY).trim() : '';
  return c.json({
    enabled: Boolean(publicKey),
    publicKey: publicKey || null
  });
});

pushRouter.get('/preferences', requireAuth, async (c) => {
  const db = c.env && (c.env.BASEBALL_DB || c.env.DB);
  const user = c.get('user');
  if (!db || !user) return jsonError(c, 500, ERROR_CODES.INTERNAL_ERROR, 'Database unavailable.');

  const rows = await db.prepare(
    'SELECT id, endpoint, ' + PREF_COLUMNS.join(', ') + ', updated_at FROM push_subscriptions WHERE user_id = ? ORDER BY updated_at DESC'
  ).bind(user.id).all();
  const list = (rows && rows.results) ? rows.results : [];
  return c.json(Object.assign({
    subscribed: list.length > 0,
    subscriptionCount: list.length
  }, prefsToJson(list[0] || null)));
});

pushRouter.post('/subscribe', requireAuth, async (c) => {
  const db = c.env && (c.env.BASEBALL_DB || c.env.DB);
  const user = c.get('user');
  if (!db || !user) return jsonError(c, 500, ERROR_CODES.INTERNAL_ERROR, 'Database unavailable.');

  let body;
  try {
    body = await c.req.json();
  } catch (e) {
    return jsonError(c, 400, ERROR_CODES.VALIDATION_ERROR, 'Invalid JSON body.');
  }

  const endpoint = body && typeof body.endpoint === 'string' ? body.endpoint.trim() : '';
  const keys = body && body.keys && typeof body.keys === 'object' ? body.keys : {};
  const p256dh = typeof keys.p256dh === 'string' ? keys.p256dh.trim() : '';
  const auth = typeof keys.auth === 'string' ? keys.auth.trim() : '';

  if (!endpoint || !endpoint.startsWith('https://') || !p256dh || !auth) {
    return jsonError(c, 400, ERROR_CODES.VALIDATION_ERROR, 'Valid HTTPS push subscription endpoint and keys are required.');
  }

  const prefs = parsePrefs(body);
  const prefCols = PREF_COLUMNS.join(', ');
  const placeholders = PREF_COLUMNS.map(() => '?').join(', ');
  const prefUpserts = PREF_COLUMNS.map((k) => k + ' = excluded.' + k).join(', ');

  await db.prepare(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, ${prefCols}, updated_at)
     VALUES (?, ?, ?, ?, ${placeholders}, CURRENT_TIMESTAMP)
     ON CONFLICT(endpoint) DO UPDATE SET
       user_id = excluded.user_id,
       p256dh = excluded.p256dh,
       auth = excluded.auth,
       ${prefUpserts},
       updated_at = CURRENT_TIMESTAMP`
  ).bind(user.id, endpoint, p256dh, auth, ...PREF_COLUMNS.map((k) => prefs[k])).run();

  return c.json(Object.assign({ ok: true, subscribed: true }, prefsToJson(prefs)));
});

pushRouter.put('/preferences', requireAuth, async (c) => {
  const db = c.env && (c.env.BASEBALL_DB || c.env.DB);
  const user = c.get('user');
  if (!db || !user) return jsonError(c, 500, ERROR_CODES.INTERNAL_ERROR, 'Database unavailable.');

  let body;
  try {
    body = await c.req.json();
  } catch (e) {
    return jsonError(c, 400, ERROR_CODES.VALIDATION_ERROR, 'Invalid JSON body.');
  }

  const prefs = parsePrefs(body);
  const prefSets = PREF_COLUMNS.map((k) => k + ' = ?').join(', ');
  await db.prepare(
    `UPDATE push_subscriptions SET ${prefSets}, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`
  ).bind(...PREF_COLUMNS.map((k) => prefs[k]), user.id).run();

  return c.json(Object.assign({ ok: true }, prefsToJson(prefs)));
});

pushRouter.delete('/subscribe', requireAuth, async (c) => {
  const db = c.env && (c.env.BASEBALL_DB || c.env.DB);
  const user = c.get('user');
  if (!db || !user) return jsonError(c, 500, ERROR_CODES.INTERNAL_ERROR, 'Database unavailable.');

  let endpoint = '';
  try {
    const body = await c.req.json();
    if (body && typeof body.endpoint === 'string') endpoint = body.endpoint.trim();
  } catch (e) { /* optional body */ }

  if (endpoint) {
    await db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').bind(user.id, endpoint).run();
  } else {
    await db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').bind(user.id).run();
  }
  return c.json({ ok: true, subscribed: false });
});
