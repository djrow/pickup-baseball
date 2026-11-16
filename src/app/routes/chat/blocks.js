/**
 * Clubhouse Peer Block Routes (Member-to-Member Safety Boundary, ADR-0002)
 * - GET /blocks — list users blocked by the signed-in Member
 * - POST /blocks — block a target Member (idempotent, no self-blocking)
 * - DELETE /blocks/:userId — unblock a target Member
 */

import { Hono } from 'hono';
import { requireAuth, rejectIfClubhouseOptedOut, checkRateLimit } from '../../security.js';
import { getBlockedUserIds } from './helpers.js';

export const chatBlocksRouter = /** @type {AppHono} */ (new Hono());

chatBlocksRouter.get('/blocks', requireAuth, async (c) => {
  const user = c.get('user');
  const optResp = rejectIfClubhouseOptedOut(c, user);
  if (optResp) return optResp;
  const chatDb = c.env && c.env.CHAT_DB;
  if (!chatDb) return c.json({ error: 'Chat database unavailable.' }, 500);

  const { results } = await chatDb.prepare(
    'SELECT blocked_id, created_at FROM user_blocks WHERE blocker_id = ? ORDER BY created_at DESC'
  ).bind(user.id).all();
  const rows = (results || []).map((r) => ({
    blocked_id: Number(r.blocked_id),
    user_id: Number(r.blocked_id),
    created_at: r.created_at
  }));

  return c.json({
    blocked_users: rows,
    blocked_user_ids: rows.map((r) => r.blocked_id)
  });
});

chatBlocksRouter.post('/blocks', requireAuth, async (c) => {
  const user = c.get('user');
  const optResp = rejectIfClubhouseOptedOut(c, user);
  if (optResp) return optResp;
  const chatDb = c.env && c.env.CHAT_DB;
  const baseballDb = c.env && (c.env.BASEBALL_DB || c.env.DB);
  if (!chatDb) return c.json({ error: 'Chat database unavailable.' }, 500);

  const body = await c.req.json().catch(() => ({}));
  const rawTarget = body.blocked_user_id !== undefined
    ? body.blocked_user_id
    : (body.blocked_id !== undefined ? body.blocked_id : body.user_id);
  const targetUserId = parseInt(String(rawTarget || ''), 10);
  if (!targetUserId || isNaN(targetUserId) || targetUserId <= 0) {
    return c.json({ error: 'Valid blocked_user_id is required.' }, 400);
  }
  if (Number(targetUserId) === Number(user.id)) {
    return c.json({ error: 'You cannot block yourself.' }, 400);
  }

  const blockRate = await checkRateLimit(chatDb, `chat_blocks:${user.id}`, 60, 60, c.env, {
    table: 'chat_rate_limits',
    failClosed: false,
    enforceInTest: true
  });
  if (!blockRate.allowed) {
    return c.json({ error: 'Too many peer block updates. Please wait a minute.' }, 429);
  }

  if (baseballDb) {
    const targetExists = await baseballDb.prepare('SELECT id FROM users WHERE id = ?').bind(targetUserId).first();
    if (!targetExists) {
      return c.json({ error: 'Target user not found.' }, 404);
    }
  }

  await chatDb.prepare(`
    INSERT INTO user_blocks (blocker_id, blocked_id)
    VALUES (?, ?)
    ON CONFLICT(blocker_id, blocked_id) DO NOTHING
  `).bind(user.id, targetUserId).run();

  const blocked_user_ids = await getBlockedUserIds(chatDb, user.id);
  return c.json({
    success: true,
    blocked_id: targetUserId,
    blocked_user_id: targetUserId,
    blocked_user_ids
  }, 201);
});

chatBlocksRouter.delete('/blocks/:userId', requireAuth, async (c) => {
  const user = c.get('user');
  const optResp = rejectIfClubhouseOptedOut(c, user);
  if (optResp) return optResp;
  const chatDb = c.env && c.env.CHAT_DB;
  if (!chatDb) return c.json({ error: 'Chat database unavailable.' }, 500);

  const targetUserId = parseInt(c.req.param('userId'), 10);
  if (!targetUserId || isNaN(targetUserId) || targetUserId <= 0) {
    return c.json({ error: 'Invalid user ID.' }, 400);
  }

  await chatDb.prepare(
    'DELETE FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?'
  ).bind(user.id, targetUserId).run();

  const blocked_user_ids = await getBlockedUserIds(chatDb, user.id);
  return c.json({
    success: true,
    unblocked_id: targetUserId,
    unblocked_user_id: targetUserId,
    blocked_user_ids
  });
});
