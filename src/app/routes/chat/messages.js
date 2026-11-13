/**
 * Clubhouse Messages, Read Watermarks, Reactions & Message Hiding Routes
 * - GET /channels/:id/messages, POST /channels/:id/read, POST /channels/:id/messages
 * - PATCH /messages/:id, DELETE /messages/:id, POST /messages/:id/reactions
 * - POST|PATCH /messages/:id/hide, POST /messages/:id/unhide
 */

import { Hono } from 'hono';
import { requireAuth, requireModerator, rejectIfChatMuted, rejectIfClubhouseOptedOut } from '../../security.js';
import {
  abbreviateMemberNames,
  resolveChannel,
  isPrivateEncryptedBoard,
  isPublicGuestChannel,
  canUserAccessChannel,
  hydrateMessages
} from './helpers.js';

export const chatMessagesRouter = new Hono();

async function formatMessagesResponse(c, user, chatDb, rows, channel) {
  const hydrated = await hydrateMessages(chatDb, rows || []);
  if (user) {
    return c.json({ messages: hydrated, channel });
  }
  const abbr = abbreviateMemberNames(hydrated.map((m) => ({ user_id: m.author_id, name: m.author_name })));
  const sanitized = hydrated.map((m, idx) => ({
    ...m,
    author_name: abbr[idx] || m.author_name,
    reactions: (m.reactions || []).map((r) => ({ ...r, user_name: '' }))
  }));
  return c.json({ messages: sanitized, channel });
}

chatMessagesRouter.get('/channels/:id/messages', async (c) => {
  const user = c.get('user');
  const chatDb = c.env && c.env.CHAT_DB;
  if (!chatDb) return c.json({ error: 'Chat database unavailable.' }, 500);

  const channel = await resolveChannel(chatDb, c.req.param('id'));
  if (!user) {
    if (!channel || !isPublicGuestChannel(channel)) {
      return c.json({ error: 'Authentication required. Please sign in.' }, 401);
    }
  } else {
    if (!channel) {
      return c.json({ error: 'Channel not found.' }, 404);
    }
    if (!(await canUserAccessChannel(chatDb, user, channel, 'read'))) {
      return c.json({ error: 'Access denied: insufficient permissions to read this channel.' }, 403);
    }
  }

  const beforeIdParam = c.req.query('before_id');
  const parentIdParam = c.req.query('parent_message_id') || c.req.query('parent_id');
  const rawLimit = parseInt(c.req.query('limit') || '50', 10);
  const limit = isNaN(rawLimit) ? 50 : Math.min(200, Math.max(1, rawLimit));

  if (beforeIdParam !== undefined && beforeIdParam !== '') {
    const beforeId = parseInt(beforeIdParam, 10);
    if (!isNaN(beforeId) && beforeId <= 0) {
      return c.json({ messages: [], channel });
    }
    if (!isNaN(beforeId) && beforeId > 0) {
      const { results: rows } = await chatDb.prepare(`
        SELECT * FROM (
          SELECT * FROM messages
          WHERE channel_id = ? AND id < ? AND deleted_at IS NULL
            AND author_id NOT IN (SELECT user_id FROM clubhouse_opted_out)
          ORDER BY id DESC
          LIMIT ?
        ) ORDER BY id ASC
      `).bind(channel.id, beforeId, limit).all();

      return formatMessagesResponse(c, user, chatDb, rows, channel);
    }
  }

  if (parentIdParam !== undefined && parentIdParam !== '') {
    const parentId = parseInt(parentIdParam, 10);
    const { results: rows } = await chatDb.prepare(`
      SELECT * FROM messages
      WHERE channel_id = ? AND (id = ? OR parent_message_id = ?) AND deleted_at IS NULL
        AND author_id NOT IN (SELECT user_id FROM clubhouse_opted_out)
      ORDER BY id ASC
      LIMIT ?
    `).bind(channel.id, parentId, parentId, limit).all();

    return formatMessagesResponse(c, user, chatDb, rows, channel);
  }

  const { results: rows } = await chatDb.prepare(`
    SELECT * FROM (
      SELECT * FROM messages
      WHERE channel_id = ? AND deleted_at IS NULL
        AND author_id NOT IN (SELECT user_id FROM clubhouse_opted_out)
      ORDER BY id DESC
      LIMIT ?
    ) ORDER BY id ASC
  `).bind(channel.id, limit).all();

  return formatMessagesResponse(c, user, chatDb, rows, channel);
});

chatMessagesRouter.post('/channels/:id/read', requireAuth, async (c) => {
  const user = c.get('user');
  const chatDb = c.env && c.env.CHAT_DB;
  if (!chatDb) return c.json({ error: 'Chat database unavailable.' }, 500);

  const channel = await resolveChannel(chatDb, c.req.param('id'));
  if (!channel) {
    return c.json({ error: 'Channel not found.' }, 404);
  }
  if (!(await canUserAccessChannel(chatDb, user, channel, 'read'))) {
    return c.json({ error: 'Access denied: insufficient permissions to read this channel.' }, 403);
  }

  const body = await c.req.json().catch(() => ({}));
  let targetMsgId = parseInt(body.last_read_message_id || '0', 10);
  if (isNaN(targetMsgId) || targetMsgId <= 0) {
    const latestRow = await chatDb.prepare(
      'SELECT COALESCE(MAX(id), 0) as max_id FROM messages WHERE channel_id = ? AND deleted_at IS NULL'
    ).bind(channel.id).first();
    targetMsgId = Number((latestRow && latestRow.max_id) || 0);
  }

  if (targetMsgId > 0) {
    await chatDb.prepare(`
      INSERT INTO channel_members (channel_id, user_id, last_read_message_id)
      VALUES (?, ?, ?)
      ON CONFLICT(channel_id, user_id) DO UPDATE SET last_read_message_id = MAX(last_read_message_id, ?)
    `).bind(channel.id, user.id, targetMsgId, targetMsgId).run();
  }

  return c.json({
    success: true,
    channel_id: channel.id,
    last_read_message_id: targetMsgId
  });
});

chatMessagesRouter.post('/channels/:id/messages', requireAuth, async (c) => {
  const user = c.get('user');
  const optResp = rejectIfClubhouseOptedOut(c, user);
  if (optResp) return optResp;
  const mutedResp = rejectIfChatMuted(c, user);
  if (mutedResp) return mutedResp;
  const chatDb = c.env && c.env.CHAT_DB;
  if (!chatDb) return c.json({ error: 'Chat database unavailable.' }, 500);

  const channel = await resolveChannel(chatDb, c.req.param('id'));
  if (!channel) {
    return c.json({ error: 'Channel not found.' }, 404);
  }

  if (!(await canUserAccessChannel(chatDb, user, channel, 'write'))) {
    return c.json({ error: 'Access denied: insufficient permissions to post in this channel.' }, 403);
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const rateKey = `user_${user.id}_msgs`;
  const windowCutoff = nowSec - 60;

  await chatDb.prepare(`
    INSERT INTO chat_rate_limits (key, count, window_start)
    VALUES (?, 1, ?)
    ON CONFLICT(key) DO UPDATE SET
      count = CASE WHEN chat_rate_limits.window_start <= ? THEN 1 ELSE chat_rate_limits.count + 1 END,
      window_start = CASE WHEN chat_rate_limits.window_start <= ? THEN ? ELSE chat_rate_limits.window_start END
  `).bind(rateKey, nowSec, windowCutoff, windowCutoff, nowSec).run();

  const updatedRate = await chatDb.prepare(
    'SELECT count, window_start FROM chat_rate_limits WHERE key = ?'
  ).bind(rateKey).first();

  if (updatedRate && updatedRate.count > 30) {
    const retryAfter = Math.max(1, 60 - (nowSec - updatedRate.window_start));
    c.header('Retry-After', String(retryAfter));
    return c.json({
      error: 'Too many messages (rate limit exceeded: max 30 messages per 60 seconds). Please slow down.'
    }, 429);
  }

  const body = await c.req.json().catch(() => ({}));
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  if (!content && (!Array.isArray(body.attachment_ids) || body.attachment_ids.length === 0)) {
    return c.json({ error: 'Message content or attachment is required.' }, 400);
  }
  if (content.length > 16384) {
    return c.json({ error: 'Message exceeds maximum length of 16,384 characters.' }, 400);
  }

  const parentMessageId = body.parent_message_id ? parseInt(body.parent_message_id, 10) : null;
  if (parentMessageId) {
    const parentMsg = await chatDb.prepare(
      'SELECT id, channel_id FROM messages WHERE id = ? AND deleted_at IS NULL'
    ).bind(parentMessageId).first();
    if (!parentMsg || parentMsg.channel_id !== channel.id) {
      return c.json({ error: 'Parent message not found in this channel.' }, 404);
    }
  }

  const rawIv = body.iv !== undefined ? body.iv : body.encryption_iv;
  const iv = rawIv ? String(rawIv).trim() : null;
  if ((channel.channel_type === 'dm' || channel.channel_type === 'group_dm' || isPrivateEncryptedBoard(channel)) && !iv) {
    return c.json({ error: 'Direct messages and private boards must be end-to-end encrypted (missing encryption_iv).' }, 400);
  }
  const keyEpoch = body.key_epoch ? parseInt(body.key_epoch, 10) : 1;
  const messageType = body.message_type || 'text';
  const metadataJson = body.metadata_json
    ? (typeof body.metadata_json === 'string' ? body.metadata_json : JSON.stringify(body.metadata_json))
    : null;

  const authorBadges = JSON.stringify({
    machine: Boolean(user.machineBadge),
    machineBadge: Boolean(user.machineBadge),
    field: Boolean(user.fieldBadge),
    fieldBadge: Boolean(user.fieldBadge),
    playingSunday: Boolean(user.playingSunday),
    facilitator: Boolean(user.isGameFacilitator),
    isGameFacilitator: Boolean(user.isGameFacilitator),
    role: user.role || 'player'
  });

  const insRes = await chatDb.prepare(`
    INSERT INTO messages (
      channel_id, parent_message_id, author_id, author_name, author_role,
      author_badges, content, iv, key_epoch, message_type, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    channel.id,
    parentMessageId,
    user.id,
    user.name,
    user.role || 'player',
    authorBadges,
    content || '[media]',
    iv,
    keyEpoch,
    messageType,
    metadataJson
  ).run();

  const newMsgId = insRes.meta.last_row_id;

  if (parentMessageId) {
    await chatDb.prepare(
      'UPDATE messages SET reply_count = reply_count + 1 WHERE id = ?'
    ).bind(parentMessageId).run();
  }

  if (Array.isArray(body.attachment_ids) && body.attachment_ids.length > 0) {
    const attIds = body.attachment_ids.slice(0, 20).map((attId) => String(attId));
    await chatDb.batch(attIds.map((attId) =>
      chatDb.prepare(
        'UPDATE chat_attachments SET message_id = ? WHERE id = ? AND uploader_id = ?'
      ).bind(newMsgId, attId, user.id)
    ));
  }

  try {
    await chatDb.prepare(`
      INSERT INTO channel_members (channel_id, user_id, last_read_message_id)
      VALUES (?, ?, ?)
      ON CONFLICT(channel_id, user_id) DO UPDATE SET last_read_message_id = MAX(last_read_message_id, ?)
    `).bind(channel.id, user.id, newMsgId, newMsgId).run();
  } catch (e) {}

  if (channel.channel_type === 'dm' || channel.channel_type === 'group_dm') {
    try {
      const hiddenRow = await chatDb.prepare(
        'SELECT 1 FROM channel_members WHERE channel_id = ? AND COALESCE(hidden, 0) = 1 LIMIT 1'
      ).bind(channel.id).first();
      if (hiddenRow) {
        await chatDb.prepare(
          'UPDATE channel_members SET hidden = 0 WHERE channel_id = ? AND COALESCE(hidden, 0) = 1'
        ).bind(channel.id).run();
        const { results: dmMemRows } = await chatDb.prepare(
          'SELECT user_id FROM channel_members WHERE channel_id = ?'
        ).bind(channel.id).all();
        const memberIds = Array.from(new Set([
          ...(dmMemRows || []).map((r) => r.user_id),
          ...(channel.created_by ? [channel.created_by] : [])
        ]));
        await chatDb.prepare(`
          INSERT INTO sync_events (channel_id, event_type, target_id, payload_json, created_at)
          VALUES (?, 'channel_create', ?, ?, ?)
        `).bind(
          channel.id,
          channel.id,
          JSON.stringify({ ...channel, member_ids: memberIds }),
          Math.floor(Date.now() / 1000)
        ).run();
      }
    } catch (e) {}
  }

  const createdRow = await chatDb.prepare('SELECT * FROM messages WHERE id = ?').bind(newMsgId).first();
  const [hydrated] = await hydrateMessages(chatDb, [createdRow]);

  return c.json({
    ...hydrated,
    success: true,
    message: hydrated
  }, 201);
});

chatMessagesRouter.patch('/messages/:id', requireAuth, async (c) => {
  const user = c.get('user');
  const mutedResp = rejectIfChatMuted(c, user);
  if (mutedResp) return mutedResp;
  const chatDb = c.env && c.env.CHAT_DB;
  if (!chatDb) return c.json({ error: 'Chat database unavailable.' }, 500);

  const msgId = parseInt(c.req.param('id'), 10);
  if (!msgId || isNaN(msgId)) {
    return c.json({ error: 'Invalid message ID.' }, 400);
  }

  const existing = await chatDb.prepare('SELECT * FROM messages WHERE id = ?').bind(msgId).first();
  if (!existing || existing.deleted_at) {
    return c.json({ error: 'Message not found.' }, 404);
  }

  const msgChannel = await resolveChannel(chatDb, existing.channel_id);
  if (
    msgChannel &&
    (msgChannel.channel_type === 'dm' || msgChannel.channel_type === 'group_dm' || isPrivateEncryptedBoard(msgChannel)) &&
    !(await canUserAccessChannel(chatDb, user, msgChannel, 'read'))
  ) {
    return c.json({ error: 'Access denied: cannot modify an encrypted conversation you do not belong to.' }, 403);
  }

  const isDmMsg = Boolean(msgChannel && (msgChannel.channel_type === 'dm' || msgChannel.channel_type === 'group_dm'));
  const isPrivateMsg = isPrivateEncryptedBoard(msgChannel);

  if (existing.author_id !== user.id && (isDmMsg || isPrivateMsg || !user.isAdmin)) {
    return c.json({ error: 'Access denied: only the message author can edit this message.' }, 403);
  }

  const body = await c.req.json().catch(() => ({}));
  const newContent = typeof body.content === 'string' ? body.content.trim() : '';
  if (!newContent) {
    return c.json({ error: 'Updated content is required.' }, 400);
  }

  const rawEditIv = body.iv !== undefined ? body.iv : body.encryption_iv;
  if ((isDmMsg || isPrivateMsg) && !rawEditIv) {
    return c.json({ error: 'Direct message and private board edits must remain end-to-end encrypted (missing encryption_iv).' }, 400);
  }
  const newIv = rawEditIv !== undefined ? rawEditIv : existing.iv;
  const nowIso = new Date().toISOString();
  const nowSec = Math.floor(Date.now() / 1000);

  await chatDb.prepare(
    'UPDATE messages SET content = ?, iv = ?, edited_at = ? WHERE id = ?'
  ).bind(newContent, newIv, nowIso, msgId).run();

  await chatDb.prepare(`
    INSERT INTO sync_events (channel_id, event_type, target_id, payload_json, created_at)
    VALUES (?, 'message_edit', ?, ?, ?)
  `).bind(
    existing.channel_id,
    msgId,
    JSON.stringify({ id: msgId, content: newContent, iv: newIv, encryption_iv: newIv, edited_at: nowIso }),
    nowSec
  ).run();

  const updated = await chatDb.prepare('SELECT * FROM messages WHERE id = ?').bind(msgId).first();
  return c.json({
    success: true,
    id: msgId,
    content: newContent,
    edited_at: nowIso,
    message: updated
  });
});

chatMessagesRouter.delete('/messages/:id', requireAuth, async (c) => {
  const user = c.get('user');
  const chatDb = c.env && c.env.CHAT_DB;
  if (!chatDb) return c.json({ error: 'Chat database unavailable.' }, 500);

  const msgId = parseInt(c.req.param('id'), 10);
  if (!msgId || isNaN(msgId)) {
    return c.json({ error: 'Invalid message ID.' }, 400);
  }

  const existing = await chatDb.prepare('SELECT * FROM messages WHERE id = ?').bind(msgId).first();
  if (!existing || existing.deleted_at) {
    return c.json({ error: 'Message not found.' }, 404);
  }

  const msgChannel = await resolveChannel(chatDb, existing.channel_id);
  if (
    msgChannel &&
    (msgChannel.channel_type === 'dm' || msgChannel.channel_type === 'group_dm' || isPrivateEncryptedBoard(msgChannel)) &&
    !(await canUserAccessChannel(chatDb, user, msgChannel, 'read'))
  ) {
    return c.json({ error: 'Access denied: cannot moderate an encrypted conversation you do not belong to.' }, 403);
  }

  if (existing.author_id !== user.id && !user.isAdmin && !user.canManageEvents && !user.isModerator && !user.canModerateChat) {
    return c.json({ error: 'Access denied: insufficient permissions to delete this message.' }, 403);
  }

  const nowIso = new Date().toISOString();
  const nowSec = Math.floor(Date.now() / 1000);

  await chatDb.prepare(
    "UPDATE messages SET deleted_at = ?, content = '[deleted]' WHERE id = ?"
  ).bind(nowIso, msgId).run();

  if (existing.parent_message_id) {
    await chatDb.prepare(
      'UPDATE messages SET reply_count = MAX(0, reply_count - 1) WHERE id = ?'
    ).bind(existing.parent_message_id).run();
  }

  await chatDb.prepare(`
    INSERT INTO sync_events (channel_id, event_type, target_id, payload_json, created_at)
    VALUES (?, 'message_delete', ?, ?, ?)
  `).bind(
    existing.channel_id,
    msgId,
    JSON.stringify({ id: msgId, deleted_at: nowIso }),
    nowSec
  ).run();

  return c.json({
    success: true,
    id: msgId,
    deleted_at: nowIso
  });
});

chatMessagesRouter.post('/messages/:id/reactions', requireAuth, async (c) => {
  const user = c.get('user');
  const optResp = rejectIfClubhouseOptedOut(c, user);
  if (optResp) return optResp;
  const mutedResp = rejectIfChatMuted(c, user);
  if (mutedResp) return mutedResp;
  const chatDb = c.env && c.env.CHAT_DB;
  if (!chatDb) return c.json({ error: 'Chat database unavailable.' }, 500);

  const msgId = parseInt(c.req.param('id'), 10);
  if (!msgId || isNaN(msgId)) {
    return c.json({ error: 'Invalid message ID.' }, 400);
  }

  const existingMsg = await chatDb.prepare('SELECT * FROM messages WHERE id = ?').bind(msgId).first();
  if (!existingMsg || existingMsg.deleted_at) {
    return c.json({ error: 'Message not found.' }, 404);
  }

  const channel = await resolveChannel(chatDb, existingMsg.channel_id);
  if (!channel || !(await canUserAccessChannel(chatDb, user, channel, 'read'))) {
    return c.json({ error: 'Access denied.' }, 403);
  }

  const body = await c.req.json().catch(() => ({}));
  const emoji = typeof body.emoji === 'string' ? body.emoji.trim() : '';
  if (!emoji || emoji.length > 16) {
    return c.json({ error: 'Valid emoji is required.' }, 400);
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const existingRx = await chatDb.prepare(
    'SELECT id FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?'
  ).bind(msgId, user.id, emoji).first();

  if (existingRx) {
    await chatDb.prepare('DELETE FROM message_reactions WHERE id = ?').bind(existingRx.id).run();
    await chatDb.prepare(`
      INSERT INTO sync_events (channel_id, event_type, target_id, payload_json, created_at)
      VALUES (?, 'reaction_remove', ?, ?, ?)
    `).bind(
      existingMsg.channel_id,
      msgId,
      JSON.stringify({ message_id: msgId, user_id: user.id, user_name: user.name, emoji }),
      nowSec
    ).run();
  } else {
    await chatDb.prepare(`
      INSERT INTO message_reactions (message_id, channel_id, user_id, user_name, emoji)
      VALUES (?, ?, ?, ?, ?)
    `).bind(msgId, existingMsg.channel_id, user.id, user.name, emoji).run();

    await chatDb.prepare(`
      INSERT INTO sync_events (channel_id, event_type, target_id, payload_json, created_at)
      VALUES (?, 'reaction_add', ?, ?, ?)
    `).bind(
      existingMsg.channel_id,
      msgId,
      JSON.stringify({ message_id: msgId, user_id: user.id, user_name: user.name, emoji }),
      nowSec
    ).run();
  }

  const { results: updatedReactions } = await chatDb.prepare(
    'SELECT * FROM message_reactions WHERE message_id = ? AND user_id NOT IN (SELECT user_id FROM clubhouse_opted_out) ORDER BY id ASC'
  ).bind(msgId).all();

  return c.json({
    success: true,
    action: existingRx ? 'removed' : 'added',
    message_id: msgId,
    emoji,
    reactions: updatedReactions || []
  });
});

async function hideMessageHandler(c) {
  const user = c.get('user');
  const chatDb = c.env && c.env.CHAT_DB;
  if (!chatDb) return c.json({ error: 'Chat database unavailable.' }, 500);

  const msgId = parseInt(c.req.param('id'), 10);
  if (!msgId || isNaN(msgId)) {
    return c.json({ error: 'Invalid message ID.' }, 400);
  }

  const existing = await chatDb.prepare('SELECT * FROM messages WHERE id = ?').bind(msgId).first();
  if (!existing || existing.deleted_at) {
    return c.json({ error: 'Message not found.' }, 404);
  }

  const msgChannel = await resolveChannel(chatDb, existing.channel_id);
  if (
    msgChannel &&
    (msgChannel.channel_type === 'dm' || msgChannel.channel_type === 'group_dm' || isPrivateEncryptedBoard(msgChannel)) &&
    !(await canUserAccessChannel(chatDb, user, msgChannel, 'read'))
  ) {
    return c.json({ error: 'Access denied: cannot moderate an encrypted conversation you do not belong to.' }, 403);
  }

  const body = await c.req.json().catch(() => ({}));
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (reason.length < 3 || reason.length > 300) {
    return c.json({ error: 'A stated reason (3–300 characters) is required to hide a message.' }, 400);
  }

  const nowIso = new Date().toISOString();
  const nowSec = Math.floor(Date.now() / 1000);

  await chatDb.prepare(`
    UPDATE messages
    SET original_content = COALESCE(original_content, content),
        original_iv = COALESCE(original_iv, iv),
        content = '[Message hidden by moderator]',
        iv = NULL,
        hidden_at = COALESCE(hidden_at, ?),
        hidden_by = ?,
        hidden_by_name = ?,
        hidden_reason = ?
    WHERE id = ?
  `).bind(nowIso, user.id, user.name, reason, msgId).run();

  await chatDb.prepare(`
    INSERT INTO sync_events (channel_id, event_type, target_id, payload_json, created_at)
    VALUES (?, 'message_hide', ?, ?, ?)
  `).bind(
    existing.channel_id,
    msgId,
    JSON.stringify({
      id: msgId,
      hidden_at: nowIso,
      hidden_by: user.id,
      hidden_by_name: user.name,
      hidden_reason: reason
    }),
    nowSec
  ).run();

  const updated = await chatDb.prepare('SELECT * FROM messages WHERE id = ?').bind(msgId).first();
  const [hydrated] = await hydrateMessages(chatDb, [updated]);

  return c.json({
    success: true,
    id: msgId,
    hidden_reason: reason,
    hidden_at: updated.hidden_at,
    message: hydrated
  });
}

chatMessagesRouter.post('/messages/:id/hide', requireModerator, hideMessageHandler);
chatMessagesRouter.patch('/messages/:id/hide', requireModerator, hideMessageHandler);

chatMessagesRouter.post('/messages/:id/unhide', requireModerator, async (c) => {
  const user = c.get('user');
  const chatDb = c.env && c.env.CHAT_DB;
  if (!chatDb) return c.json({ error: 'Chat database unavailable.' }, 500);

  const msgId = parseInt(c.req.param('id'), 10);
  if (!msgId || isNaN(msgId)) {
    return c.json({ error: 'Invalid message ID.' }, 400);
  }

  const existing = await chatDb.prepare('SELECT * FROM messages WHERE id = ?').bind(msgId).first();
  if (!existing || existing.deleted_at) {
    return c.json({ error: 'Message not found.' }, 404);
  }

  const msgChannel = await resolveChannel(chatDb, existing.channel_id);
  if (
    msgChannel &&
    (msgChannel.channel_type === 'dm' || msgChannel.channel_type === 'group_dm' || isPrivateEncryptedBoard(msgChannel)) &&
    !(await canUserAccessChannel(chatDb, user, msgChannel, 'read'))
  ) {
    return c.json({ error: 'Access denied: cannot moderate an encrypted conversation you do not belong to.' }, 403);
  }
  if (!existing.hidden_at) {
    return c.json({ error: 'Message is not hidden.' }, 400);
  }

  const restoredContent = existing.original_content || existing.content;
  const restoredIv = existing.original_iv || null;
  const nowSec = Math.floor(Date.now() / 1000);

  await chatDb.prepare(`
    UPDATE messages
    SET content = ?,
        iv = ?,
        hidden_at = NULL,
        hidden_by = NULL,
        hidden_by_name = NULL,
        hidden_reason = NULL,
        original_content = NULL,
        original_iv = NULL
    WHERE id = ?
  `).bind(restoredContent, restoredIv, msgId).run();

  const updated = await chatDb.prepare('SELECT * FROM messages WHERE id = ?').bind(msgId).first();
  const [hydrated] = await hydrateMessages(chatDb, [updated]);

  await chatDb.prepare(`
    INSERT INTO sync_events (channel_id, event_type, target_id, payload_json, created_at)
    VALUES (?, 'message_unhide', ?, ?, ?)
  `).bind(
    existing.channel_id,
    msgId,
    JSON.stringify({ id: msgId, message: hydrated }),
    nowSec
  ).run();

  return c.json({ success: true, id: msgId, message: hydrated });
});
