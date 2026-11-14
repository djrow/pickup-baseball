/**
 * Clubhouse Moderation, Member Reports & Personal Mute Routes
 * - POST /reports
 * - GET /moderation/reports, PATCH /moderation/reports/:id
 * - GET /moderation/users, PUT /moderation/users/:id/mute
 * - GET /mutes, POST /mutes, DELETE /mutes/:userId
 */

import { Hono } from 'hono';
import { requireAuth, requireModerator, rejectIfChatMuted, rejectIfClubhouseOptedOut } from '../../security.js';
import { resolveChannel, canUserAccessChannel, chunkArray, abbreviateMemberNames } from './helpers.js';

export const chatModerationRouter = new Hono();

chatModerationRouter.post('/reports', requireAuth, async (c) => {
  const user = c.get('user');
  const optResp = rejectIfClubhouseOptedOut(c, user);
  if (optResp) return optResp;
  const chatDb = c.env && c.env.CHAT_DB;
  const baseballDb = c.env && (c.env.BASEBALL_DB || c.env.DB);
  if (!chatDb) return c.json({ error: 'Chat database unavailable.' }, 500);

  const body = await c.req.json().catch(() => ({}));
  const targetType = String(body.target_type || '').trim().toLowerCase();
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';

  if (targetType !== 'message' && targetType !== 'user') {
    return c.json({ error: "target_type must be 'message' or 'user'." }, 400);
  }
  if (reason.length < 3 || reason.length > 500) {
    return c.json({ error: 'A stated reason (3–500 characters) is required.' }, 400);
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const reportRateKey = `user_${user.id}_reports`;
  const reportCutoff = nowSec - 600;
  try {
    await chatDb.prepare(`
      INSERT INTO chat_rate_limits (key, count, window_start)
      VALUES (?, 1, ?)
      ON CONFLICT(key) DO UPDATE SET
        count = CASE WHEN chat_rate_limits.window_start <= ? THEN 1 ELSE chat_rate_limits.count + 1 END,
        window_start = CASE WHEN chat_rate_limits.window_start <= ? THEN ? ELSE chat_rate_limits.window_start END
    `).bind(reportRateKey, nowSec, reportCutoff, reportCutoff, nowSec).run();
    const updatedRate = await chatDb.prepare('SELECT count FROM chat_rate_limits WHERE key = ?').bind(reportRateKey).first();
    if (updatedRate && updatedRate.count > 10) {
      return c.json({ error: 'Too many reports submitted recently. Please wait before submitting more.' }, 429);
    }
  } catch (e) {}

  let targetMessageId = null;
  let targetUserId = null;
  let targetUserName = '';
  let channelId = null;

  if (targetType === 'message') {
    targetMessageId = parseInt(body.target_message_id !== undefined ? body.target_message_id : body.message_id, 10);
    if (!targetMessageId || isNaN(targetMessageId)) {
      return c.json({ error: 'Valid target_message_id is required.' }, 400);
    }
    const msg = await chatDb.prepare('SELECT * FROM messages WHERE id = ? AND deleted_at IS NULL').bind(targetMessageId).first();
    if (!msg) {
      return c.json({ error: 'Target message not found.' }, 404);
    }
    const msgChannel = await resolveChannel(chatDb, msg.channel_id);
    if (msgChannel && !(await canUserAccessChannel(chatDb, user, msgChannel, 'read'))) {
      return c.json({ error: 'Target message not found.' }, 404);
    }
    if (Number(msg.author_id) === Number(user.id)) {
      return c.json({ error: 'You cannot report your own message.' }, 400);
    }
    targetUserId = msg.author_id;
    targetUserName = msg.author_name || '';
    channelId = msg.channel_id;
  } else {
    targetUserId = parseInt(body.target_user_id !== undefined ? body.target_user_id : body.reported_user_id, 10);
    if (!targetUserId || isNaN(targetUserId)) {
      return c.json({ error: 'Valid target_user_id is required.' }, 400);
    }
    if (Number(targetUserId) === Number(user.id)) {
      return c.json({ error: 'You cannot report yourself.' }, 400);
    }
    if (baseballDb) {
      const targetUser = await baseballDb.prepare('SELECT id, name FROM users WHERE id = ?').bind(targetUserId).first();
      if (!targetUser) {
        return c.json({ error: 'Target user not found.' }, 404);
      }
      targetUserName = targetUser.name || '';
    }
  }

  const dup = await chatDb.prepare(
    targetType === 'message'
      ? "SELECT id FROM chat_reports WHERE reporter_id = ? AND target_type = 'message' AND target_message_id = ? AND status = 'open'"
      : "SELECT id FROM chat_reports WHERE reporter_id = ? AND target_type = 'user' AND target_user_id = ? AND status = 'open'"
  ).bind(user.id, targetType === 'message' ? targetMessageId : targetUserId).first();

  if (dup) {
    return c.json({ error: 'You already have an open report pending review for this target.' }, 409);
  }

  const insRes = await chatDb.prepare(`
    INSERT INTO chat_reports (reporter_id, reporter_name, target_type, target_user_id, target_user_name, target_message_id, channel_id, reason, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open')
  `).bind(user.id, user.name, targetType, targetUserId, targetUserName, targetMessageId, channelId, reason).run();

  const report = await chatDb.prepare('SELECT * FROM chat_reports WHERE id = ?').bind(insRes.meta.last_row_id).first();
  if (report && report.target_user_name) {
    report.target_user_name = abbreviateMemberNames([{ user_id: report.target_user_id, name: report.target_user_name }])[0];
  }
  return c.json({ success: true, report }, 201);
});

chatModerationRouter.get('/moderation/reports', requireModerator, async (c) => {
  const user = c.get('user');
  const mutedResp = rejectIfChatMuted(c, user);
  if (mutedResp) return mutedResp;
  const chatDb = c.env && c.env.CHAT_DB;
  const baseballDb = c.env && (c.env.BASEBALL_DB || c.env.DB);
  if (!chatDb) return c.json({ error: 'Chat database unavailable.' }, 500);

  const statusFilter = (c.req.query('status') || 'all').toLowerCase();
  const sql = statusFilter === 'open'
    ? "SELECT * FROM chat_reports WHERE status = 'open' ORDER BY id DESC LIMIT 100"
    : 'SELECT * FROM chat_reports ORDER BY CASE WHEN status = \'open\' THEN 0 ELSE 1 END, id DESC LIMIT 100';

  const { results: reports } = await chatDb.prepare(sql).all();
  const list = reports || [];

  const msgIds = Array.from(new Set(list.map((r) => r.target_message_id).filter(Boolean)));
  const userIds = Array.from(new Set(list.map((r) => r.target_user_id).filter(Boolean)));

  const msgMap = new Map();
  for (const chunk of chunkArray(msgIds, 80)) {
    const ph = chunk.map(() => '?').join(',');
    const { results: msgRows } = await chatDb.prepare(
      `SELECT id, channel_id, content, hidden_at, hidden_reason, deleted_at FROM messages WHERE id IN (${ph})`
    ).bind(...chunk).all();
    for (const m of (msgRows || [])) msgMap.set(m.id, m);
  }

  const channelAccessMap = new Map();
  const channelIds = Array.from(new Set(list.map((r) => {
    const m = r.target_message_id ? msgMap.get(r.target_message_id) : null;
    return (m && m.channel_id) || r.channel_id || null;
  }).filter(Boolean)));
  for (const chunk of chunkArray(channelIds, 80)) {
    const ph = chunk.map(() => '?').join(',');
    const { results: chRows } = await chatDb.prepare(
      `SELECT * FROM channels WHERE id IN (${ph})`
    ).bind(...chunk).all();
    for (const ch of (chRows || [])) {
      const allowed = await canUserAccessChannel(chatDb, user, ch, 'read');
      channelAccessMap.set(ch.id, allowed);
    }
  }

  const userMuteMap = new Map();
  if (baseballDb) {
    for (const chunk of chunkArray(userIds, 80)) {
      const ph = chunk.map(() => '?').join(',');
      const { results: uRows } = await baseballDb.prepare(
        `SELECT id, COALESCE(chat_muted, 0) as chat_muted, chat_muted_reason FROM users WHERE id IN (${ph})`
      ).bind(...chunk).all();
      for (const u of (uRows || [])) userMuteMap.set(u.id, u);
    }
  }

  const enriched = list.map((r) => {
    const m = r.target_message_id ? msgMap.get(r.target_message_id) : null;
    const u = r.target_user_id ? userMuteMap.get(r.target_user_id) : null;
    const chId = (m && m.channel_id) || r.channel_id || null;
    const canViewChannel = chId
      ? (channelAccessMap.has(chId) ? channelAccessMap.get(chId) : Boolean(user.isAdmin))
      : true;
    return {
      ...r,
      reporter_id: canViewChannel ? r.reporter_id : null,
      reporter_name: canViewChannel ? r.reporter_name : 'Redacted',
      target_user_id: canViewChannel ? r.target_user_id : null,
      target_user_name: canViewChannel ? r.target_user_name : 'Redacted',
      target_message_id: canViewChannel ? r.target_message_id : null,
      reason: canViewChannel ? r.reason : '[Private board report]',
      channel_id: canViewChannel ? r.channel_id : null,
      reviewed_by: canViewChannel ? r.reviewed_by : null,
      reviewed_by_name: canViewChannel ? r.reviewed_by_name : null,
      resolution_note: canViewChannel ? r.resolution_note : null,
      reviewed_at: canViewChannel ? r.reviewed_at : null,
      message_preview: m ? (!canViewChannel ? '[Private channel message]' : (m.deleted_at ? '[deleted]' : m.content)) : null,
      message_hidden: canViewChannel ? Boolean(m && m.hidden_at) : false,
      message_hidden_reason: canViewChannel && m ? m.hidden_reason : null,
      target_chat_muted: canViewChannel ? Boolean(u && u.chat_muted) : false,
      target_chat_muted_reason: canViewChannel && u ? u.chat_muted_reason : null
    };
  });

  return c.json({ reports: enriched });
});

chatModerationRouter.patch('/moderation/reports/:id', requireModerator, async (c) => {
  const user = c.get('user');
  const mutedResp = rejectIfChatMuted(c, user);
  if (mutedResp) return mutedResp;
  const chatDb = c.env && c.env.CHAT_DB;
  if (!chatDb) return c.json({ error: 'Chat database unavailable.' }, 500);

  const reportId = parseInt(c.req.param('id'), 10);
  const existing = await chatDb.prepare('SELECT * FROM chat_reports WHERE id = ?').bind(reportId).first();
  if (!existing) {
    return c.json({ error: 'Report not found.' }, 404);
  }
  if (!user.isAdmin && Number(existing.target_user_id) === Number(user.id)) {
    return c.json({ error: 'You cannot resolve or dismiss a report targeting your own account.' }, 403);
  }
  if (!user.isAdmin && existing.channel_id) {
    const ch = await resolveChannel(chatDb, existing.channel_id);
    if (!ch || !(await canUserAccessChannel(chatDb, user, ch, 'read'))) {
      return c.json({ error: 'Access denied: you do not have permission to resolve reports for this board.' }, 403);
    }
  }

  const body = await c.req.json().catch(() => ({}));
  const nextStatus = String(body.status || 'resolved').trim().toLowerCase();
  if (!['open', 'resolved', 'dismissed'].includes(nextStatus)) {
    return c.json({ error: "Invalid report status. Must be 'open', 'resolved', or 'dismissed'." }, 400);
  }
  const note = typeof body.resolution_note === 'string' ? body.resolution_note.trim().slice(0, 300) : null;
  const nowIso = nextStatus === 'open' ? null : new Date().toISOString();

  await chatDb.prepare(`
    UPDATE chat_reports
    SET status = ?, reviewed_by = ?, reviewed_by_name = ?, resolution_note = ?, reviewed_at = ?
    WHERE id = ?
  `).bind(nextStatus, nextStatus === 'open' ? null : user.id, nextStatus === 'open' ? null : user.name, note, nowIso, reportId).run();

  const updated = await chatDb.prepare('SELECT * FROM chat_reports WHERE id = ?').bind(reportId).first();
  return c.json({ success: true, report: updated });
});

chatModerationRouter.get('/moderation/users', requireModerator, async (c) => {
  const user = c.get('user');
  const mutedResp = rejectIfChatMuted(c, user);
  if (mutedResp) return mutedResp;
  const baseballDb = c.env && (c.env.BASEBALL_DB || c.env.DB);
  if (!baseballDb) return c.json({ error: 'Database unavailable.' }, 500);

  const { results } = await baseballDb.prepare(`
    SELECT id, name,
           COALESCE(role, CASE WHEN is_admin = 1 THEN 'admin' ELSE 'player' END) as role,
           is_admin,
           COALESCE(is_moderator, 0) as is_moderator,
           COALESCE(chat_muted, 0) as chat_muted,
           chat_muted_reason,
           chat_muted_at
    FROM users
    WHERE NOT EXISTS (SELECT 1 FROM banned_emails b WHERE LOWER(b.email) = LOWER(users.email))
    ORDER BY CASE WHEN is_admin = 1 OR role = 'admin' THEN 1 WHEN is_moderator = 1 THEN 2 ELSE 3 END, name COLLATE NOCASE ASC
    LIMIT 200
  `).all();

  return c.json({ users: results || [] });
});

chatModerationRouter.put('/moderation/users/:id/mute', requireModerator, async (c) => {
  const actor = c.get('user');
  const mutedResp = rejectIfChatMuted(c, actor);
  if (mutedResp) return mutedResp;
  const baseballDb = c.env && (c.env.BASEBALL_DB || c.env.DB);
  const chatDb = c.env && c.env.CHAT_DB;
  if (!baseballDb) return c.json({ error: 'Database unavailable.' }, 500);

  const targetId = parseInt(c.req.param('id'), 10);
  if (!targetId || isNaN(targetId)) {
    return c.json({ error: 'Invalid user ID.' }, 400);
  }
  if (Number(targetId) === Number(actor.id)) {
    return c.json({ error: 'You cannot blanket-mute yourself.' }, 400);
  }

  const targetUser = await baseballDb.prepare(
    'SELECT id, name, role, is_admin, COALESCE(is_moderator, 0) as is_moderator FROM users WHERE id = ?'
  ).bind(targetId).first();
  if (!targetUser) {
    return c.json({ error: 'User not found.' }, 404);
  }

  const targetIsAdmin = Boolean(targetUser.is_admin || targetUser.role === 'admin');
  const targetIsMod = Boolean(targetUser.is_moderator);
  const targetIsOrganizer = targetUser.role === 'organizer';
  if (targetIsAdmin) {
    return c.json({ error: 'Administrators cannot be blanket-muted.' }, 403);
  }
  if (targetIsMod && !actor.isAdmin) {
    return c.json({ error: 'Only an Administrator can mute a delegated Moderator.' }, 403);
  }
  if (targetIsOrganizer && !actor.isAdmin) {
    return c.json({ error: 'Only an Administrator can blanket-mute an Event Organizer.' }, 403);
  }

  const body = await c.req.json().catch(() => ({}));
  const shouldMute = body.muted !== undefined ? Boolean(body.muted) : true;
  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 300) : '';

  if (shouldMute && reason.length < 3) {
    return c.json({ error: 'A stated reason (3–300 characters) is required to blanket-mute a user.' }, 400);
  }

  const nowIso = new Date().toISOString();
  if (shouldMute) {
    await baseballDb.prepare(`
      UPDATE users
      SET chat_muted = 1, chat_muted_reason = ?, chat_muted_by = ?, chat_muted_at = ?
      WHERE id = ?
    `).bind(reason, actor.id, nowIso, targetId).run();
  } else {
    await baseballDb.prepare(`
      UPDATE users
      SET chat_muted = 0, chat_muted_reason = NULL, chat_muted_by = NULL, chat_muted_at = NULL
      WHERE id = ?
    `).bind(targetId).run();
  }

  if (chatDb) {
    try {
      if (shouldMute) {
        await chatDb.prepare('DELETE FROM voice_participants WHERE user_id = ?').bind(targetId).run();
      }
      await chatDb.prepare(`
        INSERT INTO sync_events (channel_id, event_type, target_id, payload_json, created_at)
        VALUES (0, 'user_mute_update', ?, ?, ?)
      `).bind(
        targetId,
        JSON.stringify({
          user_id: targetId,
          chat_muted: shouldMute ? 1 : 0
        }),
        Math.floor(Date.now() / 1000)
      ).run();
    } catch (e) {}
  }

  return c.json({
    success: true,
    user: {
      id: targetId,
      name: targetUser.name,
      chat_muted: shouldMute ? 1 : 0,
      chatMuted: shouldMute,
      chat_muted_reason: shouldMute ? reason : null
    }
  });
});

chatModerationRouter.get('/mutes', requireAuth, async (c) => {
  const user = c.get('user');
  const chatDb = c.env && c.env.CHAT_DB;
  if (!chatDb) return c.json({ error: 'Chat database unavailable.' }, 500);

  const { results } = await chatDb.prepare(
    'SELECT muted_user_id, reason, created_at FROM user_mutes WHERE muter_user_id = ? ORDER BY created_at DESC'
  ).bind(user.id).all();
  const rows = results || [];
  return c.json({
    muted_users: rows,
    muted_user_ids: rows.map((r) => r.muted_user_id)
  });
});

chatModerationRouter.post('/mutes', requireAuth, async (c) => {
  const user = c.get('user');
  const chatDb = c.env && c.env.CHAT_DB;
  const baseballDb = c.env && (c.env.BASEBALL_DB || c.env.DB);
  if (!chatDb) return c.json({ error: 'Chat database unavailable.' }, 500);

  const body = await c.req.json().catch(() => ({}));
  const targetUserId = parseInt(body.muted_user_id !== undefined ? body.muted_user_id : body.user_id, 10);
  if (!targetUserId || isNaN(targetUserId)) {
    return c.json({ error: 'Valid muted_user_id is required.' }, 400);
  }
  if (Number(targetUserId) === Number(user.id)) {
    return c.json({ error: 'You cannot mute yourself.' }, 400);
  }
  if (baseballDb) {
    const targetExists = await baseballDb.prepare('SELECT id FROM users WHERE id = ?').bind(targetUserId).first();
    if (!targetExists) {
      return c.json({ error: 'Target user not found.' }, 404);
    }
  }

  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 200) : '';
  await chatDb.prepare(`
    INSERT INTO user_mutes (muter_user_id, muted_user_id, reason)
    VALUES (?, ?, ?)
    ON CONFLICT(muter_user_id, muted_user_id) DO UPDATE SET reason = excluded.reason
  `).bind(user.id, targetUserId, reason).run();

  const { results } = await chatDb.prepare(
    'SELECT muted_user_id FROM user_mutes WHERE muter_user_id = ?'
  ).bind(user.id).all();

  return c.json({
    success: true,
    muted_user_id: targetUserId,
    muted_user_ids: (results || []).map((r) => r.muted_user_id)
  }, 201);
});

chatModerationRouter.delete('/mutes/:userId', requireAuth, async (c) => {
  const user = c.get('user');
  const chatDb = c.env && c.env.CHAT_DB;
  if (!chatDb) return c.json({ error: 'Chat database unavailable.' }, 500);

  const targetUserId = parseInt(c.req.param('userId'), 10);
  await chatDb.prepare(
    'DELETE FROM user_mutes WHERE muter_user_id = ? AND muted_user_id = ?'
  ).bind(user.id, targetUserId).run();

  const { results } = await chatDb.prepare(
    'SELECT muted_user_id FROM user_mutes WHERE muter_user_id = ?'
  ).bind(user.id).all();

  return c.json({
    success: true,
    unmuted_user_id: targetUserId,
    muted_user_ids: (results || []).map((r) => r.muted_user_id)
  });
});
