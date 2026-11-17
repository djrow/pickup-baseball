/**
 * Admin Suppressions Handlers (Ticket #72)
 *
 * Implements admin inspection and removal controls for email suppressions.
 * Mounts:
 *   GET /api/admin/suppressions (requireAdmin)
 *   DELETE /api/admin/suppressions/:email (requireAdmin)
 */

import { ERROR_CODES, jsonError, logEvent, getRequestId } from '../errors.js';

/**
 * GET /api/admin/suppressions
 * Lists email suppressions ordered by created_at DESC.
 */
export async function getAdminSuppressionsHandler(c) {
  const db = c.env && (c.env.BASEBALL_DB || c.env.DB);
  if (!db) {
    return jsonError(c, 500, ERROR_CODES.INTERNAL_ERROR, 'Database unavailable.');
  }

  try {
    const { results } = await db.prepare(
      'SELECT email, reason, bounce_type, provider, metadata, created_at FROM email_suppressions ORDER BY created_at DESC LIMIT 500'
    ).all();

    return c.json({ suppressions: results || [] });
  } catch (err) {
    logEvent('error', 'admin_get_suppressions_failed', {
      requestId: getRequestId(c),
      err: err && err.message ? err.message : String(err)
    });
    return jsonError(c, 500, ERROR_CODES.INTERNAL_ERROR, 'Failed to fetch email suppressions.');
  }
}

/**
 * DELETE /api/admin/suppressions/:email
 * Clears an email suppression entry so future emails can be dispatched.
 */
export async function deleteAdminSuppressionHandler(c) {
  const db = c.env && (c.env.BASEBALL_DB || c.env.DB);
  if (!db) {
    return jsonError(c, 500, ERROR_CODES.INTERNAL_ERROR, 'Database unavailable.');
  }

  const rawEmail = c.req.param('email');
  if (!rawEmail) {
    return jsonError(c, 400, ERROR_CODES.VALIDATION_ERROR, 'Email parameter is required.');
  }

  let email;
  try {
    email = decodeURIComponent(rawEmail).trim().toLowerCase();
  } catch (e) {
    email = rawEmail.trim().toLowerCase();
  }

  if (!email || !email.includes('@')) {
    return jsonError(c, 400, ERROR_CODES.VALIDATION_ERROR, 'A valid email parameter is required.');
  }

  try {
    const result = await db.prepare(
      'DELETE FROM email_suppressions WHERE LOWER(email) = LOWER(?)'
    ).bind(email).run();

    const changes = (result && result.meta && typeof result.meta.changes === 'number')
      ? result.meta.changes
      : ((result && typeof result.changes === 'number') ? result.changes : 1);

    logEvent('info', 'admin_suppression_cleared', {
      requestId: getRequestId(c),
      email,
      adminEmail: c.get('user') ? c.get('user').email : null
    });

    return c.json({
      success: true,
      message: `Suppression cleared for ${email}.`,
      cleared: changes
    });
  } catch (err) {
    logEvent('error', 'admin_delete_suppression_failed', {
      requestId: getRequestId(c),
      email,
      err: err && err.message ? err.message : String(err)
    });
    return jsonError(c, 500, ERROR_CODES.INTERNAL_ERROR, 'Failed to clear email suppression.');
  }
}
