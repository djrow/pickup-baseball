/**
 * @fileoverview Opt-In, Configurable Web Push Notifications Router.
 * Manages per-member browser push subscriptions and topic preferences
 * (`notify_rainouts`, `notify_reminders`, `notify_announcements`).
 *
 * @module app/routes/push
 */

import { Hono } from 'hono';
import { requireAuth } from '../security.js';
import { jsonError, ERROR_CODES } from '../errors.js';

export const pushRouter = /** @type {AppHono} */ (new Hono());

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
    'SELECT id, endpoint, notify_rainouts, notify_reminders, notify_announcements, updated_at FROM push_subscriptions WHERE user_id = ? ORDER BY updated_at DESC'
  ).bind(user.id).all();
  const list = (rows && rows.results) ? rows.results : [];
  const first = list[0] || null;
  return c.json({
    subscribed: list.length > 0,
    subscriptionCount: list.length,
    notify_rainouts: first ? Boolean(first.notify_rainouts) : true,
    notify_reminders: first ? Boolean(first.notify_reminders) : true,
    notify_announcements: first ? Boolean(first.notify_announcements) : false
  });
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

  const notifyRainouts = body.notify_rainouts === false ? 0 : 1;
  const notifyReminders = body.notify_reminders === false ? 0 : 1;
  const notifyAnnouncements = body.notify_announcements === true ? 1 : 0;

  await db.prepare(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, notify_rainouts, notify_reminders, notify_announcements, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(endpoint) DO UPDATE SET
       user_id = excluded.user_id,
       p256dh = excluded.p256dh,
       auth = excluded.auth,
       notify_rainouts = excluded.notify_rainouts,
       notify_reminders = excluded.notify_reminders,
       notify_announcements = excluded.notify_announcements,
       updated_at = CURRENT_TIMESTAMP`
  ).bind(user.id, endpoint, p256dh, auth, notifyRainouts, notifyReminders, notifyAnnouncements).run();

  return c.json({
    ok: true,
    subscribed: true,
    notify_rainouts: Boolean(notifyRainouts),
    notify_reminders: Boolean(notifyReminders),
    notify_announcements: Boolean(notifyAnnouncements)
  });
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

  const notifyRainouts = body.notify_rainouts === false ? 0 : 1;
  const notifyReminders = body.notify_reminders === false ? 0 : 1;
  const notifyAnnouncements = body.notify_announcements === true ? 1 : 0;

  await db.prepare(
    `UPDATE push_subscriptions
     SET notify_rainouts = ?, notify_reminders = ?, notify_announcements = ?, updated_at = CURRENT_TIMESTAMP
     WHERE user_id = ?`
  ).bind(notifyRainouts, notifyReminders, notifyAnnouncements, user.id).run();

  return c.json({
    ok: true,
    notify_rainouts: Boolean(notifyRainouts),
    notify_reminders: Boolean(notifyReminders),
    notify_announcements: Boolean(notifyAnnouncements)
  });
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
