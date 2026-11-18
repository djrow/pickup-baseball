/**
 * Public one-click unsubscribe (RFC 8058). No sign-in required; HMAC-token authorized.
 */
import { Hono } from 'hono';
import { verifyUnsubscribeToken, applyUnsubscribe } from '../mailer/preferences.js';

export const notificationsRouter = /** @type {AppHono} */ (new Hono());

async function handle(c) {
  let token = c.req.query('token') || '';
  if (!token && c.req.method === 'POST') {
    try {
      const form = await c.req.parseBody();
      token = (form && form.token) ? String(form.token) : '';
    } catch (_e) { /* ignore */ }
  }
  const subject = await verifyUnsubscribeToken(c.env, token);
  if (!subject) return c.json({ error: 'Invalid or tampered unsubscribe token.' }, 400);
  await applyUnsubscribe(c.env.DB, c.env, subject);
  return c.json({ success: true, preference: subject.pref, message: 'You have been unsubscribed.' });
}

notificationsRouter.get('/unsubscribe', handle);
notificationsRouter.post('/unsubscribe', handle);
