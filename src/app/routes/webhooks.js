/**
 * Resend & Inbound Webhooks Router (Ticket #72)
 *
 * Implements Svix signature-verified webhook endpoints.
 * Mounts:
 *   POST /resend -> receives Svix-signed Resend webhook payloads (bounces, complaints)
 */

import { Hono } from 'hono';
import { verifySvixSignature } from '../security.js';
import { ERROR_CODES, jsonError, logEvent, getRequestId } from '../errors.js';

export const webhooksRouter = /** @type {AppHono} */ (new Hono());

/**
 * Handle Resend Svix-signed webhooks.
 * Bypasses session & CSRF checks; verifies svix-id, svix-timestamp (±300s window), and svix-signature.
 */
webhooksRouter.post('/resend', async (c) => {
  const secret = c.env && c.env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    return jsonError(c, 503, ERROR_CODES.INTERNAL_ERROR, 'Resend webhook secret is not configured.');
  }

  const svixId = c.req.header('svix-id');
  const svixTimestamp = c.req.header('svix-timestamp');
  const svixSignature = c.req.header('svix-signature');

  if (!svixId || !svixTimestamp || !svixSignature) {
    return jsonError(c, 401, ERROR_CODES.AUTH_REQUIRED, 'Missing Svix webhook signature headers.');
  }

  let rawBody;
  try {
    rawBody = await c.req.text();
  } catch (err) {
    return jsonError(c, 400, ERROR_CODES.VALIDATION_ERROR, 'Failed to read request payload.');
  }

  const isValid = await verifySvixSignature(secret, svixId, svixTimestamp, rawBody, svixSignature, 300);
  if (!isValid) {
    return jsonError(c, 401, ERROR_CODES.AUTH_REQUIRED, 'Invalid Svix webhook signature.');
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (err) {
    return jsonError(c, 400, ERROR_CODES.VALIDATION_ERROR, 'Invalid JSON body.');
  }

  const eventType = payload && payload.type;
  const eventData = payload && payload.data;

  if (eventType !== 'email.bounced' && eventType !== 'email.complained') {
    return c.json({ ok: true, ignored: 'unhandled_event_type', type: eventType });
  }

  const db = c.env && (c.env.BASEBALL_DB || c.env.DB);
  if (!db) {
    return jsonError(c, 500, ERROR_CODES.INTERNAL_ERROR, 'Database unavailable.');
  }

  let reason = '';
  let bounceType = null;

  if (eventType === 'email.bounced') {
    const rawBounceType = (eventData && eventData.bounce && eventData.bounce.type) ||
                          (eventData && eventData.type) ||
                          '';
    const bounceTypeNormalized = String(rawBounceType).trim().toLowerCase();

    // Only suppress permanent / hard bounces. Ignore transient / temporary bounces.
    const isPermanent = bounceTypeNormalized === 'permanent' ||
                        bounceTypeNormalized === 'hard' ||
                        bounceTypeNormalized === 'undeliverable';
    if (!isPermanent) {
      logEvent('info', 'resend_transient_bounce_ignored', {
        requestId: getRequestId(c),
        bounceType: rawBounceType,
        emailId: eventData && eventData.email_id
      });
      return c.json({ ok: true, ignored: 'transient_bounce', bounce_type: rawBounceType });
    }

    reason = 'bounce';
    bounceType = rawBounceType || 'Permanent';
  } else if (eventType === 'email.complained') {
    reason = 'complaint';
    bounceType = null;
  }

  // Extract recipient emails
  const recipients = [];
  if (eventData && Array.isArray(eventData.to)) {
    for (const addr of eventData.to) {
      if (typeof addr === 'string' && addr.trim()) {
        recipients.push(addr.trim().toLowerCase());
      }
    }
  } else if (eventData && typeof eventData.email === 'string' && eventData.email.trim()) {
    recipients.push(eventData.email.trim().toLowerCase());
  } else if (eventData && typeof eventData.recipient === 'string' && eventData.recipient.trim()) {
    recipients.push(eventData.recipient.trim().toLowerCase());
  }

  if (recipients.length === 0) {
    return c.json({ ok: true, processed: 0, message: 'No recipients found in event payload.' });
  }

  const metadataStr = eventData ? JSON.stringify(eventData) : null;
  let processedCount = 0;

  for (const email of recipients) {
    try {
      await db.prepare(
        `INSERT OR REPLACE INTO email_suppressions (email, reason, bounce_type, provider, metadata, created_at)
         VALUES (?, ?, ?, 'resend', ?, datetime('now'))`
      ).bind(email, reason, bounceType, metadataStr).run();
      processedCount++;
    } catch (dbErr) {
      logEvent('error', 'resend_suppression_insert_failed', {
        requestId: getRequestId(c),
        email,
        err: dbErr && dbErr.message ? dbErr.message : String(dbErr)
      });
    }
  }

  logEvent('info', 'resend_webhook_suppression_recorded', {
    requestId: getRequestId(c),
    eventType,
    reason,
    bounceType,
    processedCount,
    recipients
  });

  return c.json({ ok: true, processed: processedCount, reason });
});
