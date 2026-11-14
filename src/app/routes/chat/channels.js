/**
 * Clubhouse Channel, Message Board & Direct Message Visibility Routes
 * - GET /public/channels, GET /channels, POST /channels
 * - PATCH /channels/:id, DELETE /channels/:id
 * - POST /channels/:id/hide & /unhide
 */

import { Hono } from 'hono';
import { requireAuth, requireModerator, rejectIfChatMuted, rejectIfClubhouseOptedOut } from '../../security.js';
import {
  resolveChannel,
  isPrivateEncryptedBoard,
  canUserAccessChannel,
  getAccessibleChannels,
  chunkArray
} from './helpers.js';

export const chatChannelsRouter = new Hono();

chatChannelsRouter.get('/public/channels', async (c) => {
  const chatDb = c.env && c.env.CHAT_DB;
  if (!chatDb) return c.json({ error: 'Chat database unavailable.' }, 500);

  const { results } = await chatDb.prepare(
    "SELECT * FROM channels WHERE (slug = 'announcements' OR min_role_read = 'public') AND channel_type NOT IN ('dm', 'group_dm') AND COALESCE(is_private, 0) = 0 ORDER BY sort_order ASC, id ASC LIMIT 1"
  ).all();

  return c.json({ channels: results || [] });
});

chatChannelsRouter.get('/channels', requireAuth, async (c) => {
  const user = c.get('user');
  const optResp = rejectIfClubhouseOptedOut(c, user);
  if (optResp) return optResp;
  const chatDb = c.env && c.env.CHAT_DB;
  if (!chatDb) return c.json({ error: 'Chat database unavailable.' }, 500);

  const channels = await getAccessibleChannels(chatDb, user);
  return c.json({ channels });
});

chatChannelsRouter.post('/channels', requireAuth, async (c) => {
  const user = c.get('user');
  const optResp = rejectIfClubhouseOptedOut(c, user);
  if (optResp) return optResp;
  const chatDb = c.env && c.env.CHAT_DB;
  if (!chatDb) return c.json({ error: 'Chat database unavailable.' }, 500);

  const body = await c.req.json().catch(() => ({}));
  const channelType = body.channel_type || 'text';
  const isDm = channelType === 'dm' || channelType === 'group_dm';

  if (isDm) {
    const mutedResp = rejectIfChatMuted(c, user);
    if (mutedResp) return mutedResp;
  }

  if (!isDm && !user.isAdmin && !user.isModerator && !user.canModerateChat) {
    return c.json({ error: 'Access denied: Moderator or Administrator privileges required to create boards.' }, 403);
  }

  const allowedCreateTypes = isDm ? ['dm', 'group_dm'] : ['text', 'announcement', 'voice'];
  if (!allowedCreateTypes.includes(channelType)) {
    return c.json({ error: 'Invalid channel_type.' }, 400);
  }

  let name = String(body.name || '').trim().slice(0, 80);
  let slug = String(body.slug || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  if (!slug && name) {
    slug = name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  }

  const rawMemberIds = Array.isArray(body.member_ids)
    ? body.member_ids
    : (body.dm_user_id ? [body.dm_user_id] : []);
  const dmMemberIds = rawMemberIds.map((id) => parseInt(id, 10)).filter((n) => !isNaN(n) && n > 0).slice(0, 90);
  if (isDm) {
    const allParticipants = Array.from(new Set([user.id, ...dmMemberIds])).sort((a, b) => a - b);
    if (allParticipants.length < 2) {
      return c.json({ error: 'At least one other member is required to start a DM.' }, 400);
    }
    if (allParticipants.length > 20) {
      return c.json({ error: 'Group DMs are limited to 20 participants.' }, 400);
    }
    slug = `dm-${allParticipants.join('-')}`;
    if (!name) name = body.name || `DM (${allParticipants.length})`;
  } else if (slug.startsWith('dm-')) {
    return c.json({ error: "Only direct messages may use the 'dm-' slug prefix." }, 400);
  }

  if (!slug || !name) {
    return c.json({ error: 'Channel name and slug are required.' }, 400);
  }
  const isPrivateBoard = !isDm && channelType !== 'voice' && Boolean(body.is_private);

  const nowSecCreate = Math.floor(Date.now() / 1000);
  const chRateKey = `user_${user.id}_channel_create`;
  const chCutoff = nowSecCreate - 60;
  try {
    await chatDb.prepare(`
      INSERT INTO chat_rate_limits (key, count, window_start)
      VALUES (?, 1, ?)
      ON CONFLICT(key) DO UPDATE SET
        count = CASE WHEN chat_rate_limits.window_start <= ? THEN 1 ELSE chat_rate_limits.count + 1 END,
        window_start = CASE WHEN chat_rate_limits.window_start <= ? THEN ? ELSE chat_rate_limits.window_start END
    `).bind(chRateKey, nowSecCreate, chCutoff, chCutoff, nowSecCreate).run();
    const chRateRow = await chatDb.prepare('SELECT count FROM chat_rate_limits WHERE key = ?').bind(chRateKey).first();
    if (chRateRow && chRateRow.count > 20) {
      return c.json({ error: 'Too many channel creation requests. Please wait a minute.' }, 429);
    }
  } catch (e) {}

  if (isDm || isPrivateBoard) {
    const otherIds = dmMemberIds.filter((uid) => Number(uid) !== Number(user.id));
    const baseballDb = c.env && (c.env.BASEBALL_DB || c.env.DB);
    if (baseballDb && otherIds.length > 0) {
      const validSet = new Set();
      for (const idChunk of chunkArray(otherIds, 80)) {
        const ph = idChunk.map(() => '?').join(',');
        const { results: targetUsers } = await baseballDb.prepare(`
          SELECT u.id, COALESCE(u.clubhouse_opted_in, 0) as clubhouse_opted_in,
                 EXISTS(SELECT 1 FROM banned_emails b WHERE LOWER(b.email) = LOWER(u.email)) as is_banned
          FROM users u WHERE u.id IN (${ph})
        `).bind(...idChunk).all();
        for (const u of (targetUsers || [])) {
          if (!u.is_banned && Number(u.clubhouse_opted_in) === 1) {
            validSet.add(Number(u.id));
          }
        }
      }
      if (otherIds.some((uid) => !validSet.has(Number(uid)))) {
        return c.json({ error: 'One or more target members do not exist, are banned, or have opted out of Clubhouse.' }, 403);
      }
    }
  }

  const existing = await chatDb.prepare('SELECT * FROM channels WHERE slug = ?').bind(slug).first();
  if (existing) {
    if (isDm) {
      if (existing.channel_type !== 'dm' && existing.channel_type !== 'group_dm') {
        return c.json({ error: 'A non-DM channel already uses that slug.' }, 409);
      }
      const allowed = await canUserAccessChannel(chatDb, user, existing, 'read');
      if (!allowed) {
        return c.json({ error: 'Access denied to existing conversation.' }, 403);
      }
      try {
        await chatDb.prepare(
          'INSERT INTO channel_members (channel_id, user_id, role, hidden) VALUES (?, ?, ?, 0) ON CONFLICT(channel_id, user_id) DO UPDATE SET hidden = 0'
        ).bind(existing.id, user.id, existing.created_by === user.id ? 'owner' : 'member').run();
      } catch (e) {}
      const { results: dmMemRows } = await chatDb.prepare(
        'SELECT user_id FROM channel_members WHERE channel_id = ?'
      ).bind(existing.id).all();
      const mIds = Array.from(new Set([...(dmMemRows || []).map((r) => r.user_id), ...(existing.created_by ? [existing.created_by] : [])]));
      return c.json({ success: true, channel: { ...existing, member_ids: mIds } }, 200);
    }
    return c.json({ error: 'A channel with that slug already exists.' }, 409);
  }

  const category = String(body.category || (isDm ? 'Direct Messages' : (channelType === 'voice' ? 'Voice Lounges' : 'Text Channels'))).trim().slice(0, 60);
  const topic = String(body.topic || '').trim().slice(0, 300);
  const validReadRoleList = ['guest', 'public', 'player', 'facilitator', 'organizer', 'admin', 'invite'];
  const validWriteRoleList = ['player', 'facilitator', 'organizer', 'admin'];
  const requestedRead = body.min_role_read;
  const requestedWrite = body.min_role_write;
  if (requestedRead !== undefined && !validReadRoleList.includes(requestedRead)) {
    return c.json({ error: 'Invalid min_role_read.' }, 400);
  }
  if (requestedWrite !== undefined && !validWriteRoleList.includes(requestedWrite)) {
    return c.json({ error: 'Invalid min_role_write.' }, 400);
  }
  if (!user.isAdmin && (requestedRead === 'admin' || requestedWrite === 'admin' || requestedRead === 'guest' || requestedRead === 'public')) {
    return c.json({ error: 'Access denied: only admins can configure admin or public guest channel roles.' }, 403);
  }
  const minRoleRead = isPrivateBoard ? 'invite' : (requestedRead || 'player');
  const minRoleWrite = requestedWrite || (channelType === 'announcement' ? 'organizer' : 'player');
  const isEncrypted = isPrivateBoard ? 1 : (body.is_encrypted !== undefined ? (body.is_encrypted ? 1 : 0) : 1);
  const canLinkEvent = Boolean(!isDm && (user.canManageEvents || user.isAdmin));
  const linkedEventId = canLinkEvent && body.linked_event_id ? parseInt(body.linked_event_id, 10) : null;
  const sortOrder = body.sort_order !== undefined ? parseInt(body.sort_order, 10) : 10;

  const insRes = await chatDb.prepare(`
    INSERT INTO channels (slug, name, category, channel_type, topic, min_role_read, min_role_write, is_encrypted, is_private, linked_event_id, sort_order, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    slug,
    name,
    category,
    channelType,
    topic,
    minRoleRead,
    minRoleWrite,
    isEncrypted,
    isPrivateBoard ? 1 : 0,
    linkedEventId,
    sortOrder,
    user.id
  ).run();

  const newChannelId = insRes.meta.last_row_id;

  const membersToInsert = Array.from(new Set([user.id, ...dmMemberIds]));
  if (membersToInsert.length > 0) {
    let mutedBySet = new Set();
    if (isDm && membersToInsert.length > 1) {
      try {
        const { results: muteRows } = await chatDb.prepare(
          'SELECT muter_user_id FROM user_mutes WHERE muted_user_id = ?'
        ).bind(user.id).all();
        mutedBySet = new Set((muteRows || []).map((r) => Number(r.muter_user_id)));
      } catch (e) {}
    }
    try {
      await chatDb.batch(membersToInsert.map((uid) =>
        chatDb.prepare(
          'INSERT INTO channel_members (channel_id, user_id, role, hidden) VALUES (?, ?, ?, ?) ON CONFLICT(channel_id, user_id) DO NOTHING'
        ).bind(newChannelId, uid, uid === user.id ? 'owner' : 'member', (isDm && Number(uid) !== Number(user.id) && mutedBySet.has(Number(uid))) ? 1 : 0)
      ));
    } catch (e) {}
  }

  const created = await chatDb.prepare('SELECT * FROM channels WHERE id = ?').bind(newChannelId).first();
  if ((isDm || isPrivateBoard) && created) {
    created.member_ids = membersToInsert;
  }
  if (!isDm && created) {
    try {
      const isRoleRestricted = isPrivateBoard || !['player', 'guest', 'public'].includes(minRoleRead);
      await chatDb.prepare(`
        INSERT INTO sync_events (channel_id, event_type, target_id, payload_json, created_at)
        VALUES (?, 'channel_create', ?, ?, ?)
      `).bind(isRoleRestricted ? newChannelId : 0, newChannelId, JSON.stringify(created), Math.floor(Date.now() / 1000)).run();
    } catch (e) {}
  }
  return c.json({ success: true, channel: created, id: newChannelId }, 201);
});

chatChannelsRouter.patch('/channels/:id', requireAuth, async (c) => {
  const user = c.get('user');
  const chatDb = c.env && c.env.CHAT_DB;
  if (!chatDb) return c.json({ error: 'Chat database unavailable.' }, 500);

  if (!user.isAdmin && !user.isModerator && !user.canModerateChat) {
    return c.json({ error: 'Access denied: Moderator or Administrator privileges required to edit boards.' }, 403);
  }
  const mutedResp = rejectIfChatMuted(c, user);
  if (mutedResp) return mutedResp;

  const channel = await resolveChannel(chatDb, c.req.param('id'));
  if (!channel) {
    return c.json({ error: 'Message board not found.' }, 404);
  }
  if (channel.channel_type === 'dm' || channel.channel_type === 'group_dm') {
    return c.json({ error: 'Direct message conversations cannot be edited as boards.' }, 400);
  }
  if (!(await canUserAccessChannel(chatDb, user, channel, 'write')) && !user.isAdmin && channel.created_by !== user.id) {
    return c.json({ error: 'Access denied: insufficient permissions to manage this board.' }, 403);
  }
  const isProtectedCoreBoard = channel.slug === 'general' || channel.slug === 'announcements';
  const existingNeedsAdmin = Boolean(
    isProtectedCoreBoard ||
    channel.min_role_read === 'admin' ||
    channel.min_role_write === 'admin' ||
    channel.min_role_read === 'guest' ||
    channel.min_role_read === 'public'
  );
  if (!user.isAdmin && existingNeedsAdmin) {
    return c.json({ error: 'Access denied: only administrators can modify core or admin-configured boards.' }, 403);
  }

  const body = await c.req.json().catch(() => ({}));
  const name = body.name !== undefined ? String(body.name).trim().slice(0, 80) : channel.name;
  if (!name) {
    return c.json({ error: 'Board name cannot be empty.' }, 400);
  }

  const category = body.category !== undefined ? (String(body.category).trim().slice(0, 60) || channel.category) : channel.category;
  const topic = body.topic !== undefined ? String(body.topic).trim().slice(0, 300) : (channel.topic || '');
  const allowedTypes = ['text', 'announcement', 'voice'];
  const channelType = body.channel_type !== undefined
    ? (allowedTypes.includes(body.channel_type) ? body.channel_type : channel.channel_type)
    : channel.channel_type;
  const wasPrivateBoard = isPrivateEncryptedBoard(channel);
  const isPrivateBoard = body.is_private !== undefined
    ? (channelType !== 'voice' && Boolean(body.is_private))
    : wasPrivateBoard;
  if (wasPrivateBoard && !user.isAdmin && (!isPrivateBoard || channelType === 'voice')) {
    return c.json({ error: 'Access denied: only administrators may downgrade a private invite-only board to public.' }, 403);
  }
  if (isProtectedCoreBoard && isPrivateBoard) {
    return c.json({ error: 'Core community boards (#general, #announcements) cannot be converted into private boards.' }, 400);
  }
  const allowedReadRoles = ['guest', 'public', 'player', 'facilitator', 'organizer', 'admin', 'invite'];
  const allowedWriteRoles = ['player', 'facilitator', 'organizer', 'admin'];
  if (!user.isAdmin && (body.min_role_read === 'admin' || body.min_role_write === 'admin' || body.min_role_read === 'guest' || body.min_role_read === 'public')) {
    return c.json({ error: 'Access denied: only admins can configure admin or public guest channel roles.' }, 403);
  }
  if (!user.isAdmin && channel.min_role_read === 'invite' && body.min_role_read && body.min_role_read !== 'invite') {
    return c.json({ error: 'Access denied: only administrators may remove invite-only restriction.' }, 403);
  }
  const minRoleRead = isPrivateBoard
    ? 'invite'
    : (allowedReadRoles.includes(body.min_role_read) ? body.min_role_read : ((channel.min_role_read === 'invite' ? 'player' : channel.min_role_read) || 'player'));
  const minRoleWrite = allowedWriteRoles.includes(body.min_role_write) ? body.min_role_write : (channel.min_role_write || 'player');
  const isEncrypted = isPrivateBoard ? 1 : (channel.is_encrypted !== undefined ? channel.is_encrypted : 1);
  const sortOrder = body.sort_order !== undefined && !isNaN(parseInt(body.sort_order, 10))
    ? parseInt(body.sort_order, 10)
    : (channel.sort_order || 0);

  await chatDb.prepare(`
    UPDATE channels
    SET name = ?, category = ?, topic = ?, channel_type = ?, min_role_read = ?, min_role_write = ?, is_encrypted = ?, is_private = ?, sort_order = ?
    WHERE id = ?
  `).bind(name, category, topic, channelType, minRoleRead, minRoleWrite, isEncrypted, isPrivateBoard ? 1 : 0, sortOrder, channel.id).run();

  let updatedMembers = null;
  if (isPrivateBoard && Array.isArray(body.member_ids)) {
    if (!user.isAdmin && channel.created_by !== user.id) {
      return c.json({ error: 'Access denied: only the board creator or an administrator can manage private board members.' }, 403);
    }
    const cleanIds = body.member_ids.map((id) => parseInt(id, 10)).filter((n) => !isNaN(n) && n > 0).slice(0, 90);
    const baseballDb = c.env && (c.env.BASEBALL_DB || c.env.DB);
    if (baseballDb && cleanIds.length > 0) {
      const validSet = new Set();
      for (const idChunk of chunkArray(cleanIds, 80)) {
        const ph = idChunk.map(() => '?').join(',');
        const { results: targetUsers } = await baseballDb.prepare(`
          SELECT u.id, COALESCE(u.clubhouse_opted_in, 0) as clubhouse_opted_in,
                 EXISTS(SELECT 1 FROM banned_emails b WHERE LOWER(b.email) = LOWER(u.email)) as is_banned
          FROM users u WHERE u.id IN (${ph})
        `).bind(...idChunk).all();
        for (const u of (targetUsers || [])) {
          if (!u.is_banned && Number(u.clubhouse_opted_in) === 1) {
            validSet.add(Number(u.id));
          }
        }
      }
      if (cleanIds.some((uid) => !validSet.has(Number(uid)))) {
        return c.json({ error: 'One or more target members do not exist, are banned, or have opted out of Clubhouse.' }, 403);
      }
    }
    const ownerId = channel.created_by || user.id;
    updatedMembers = Array.from(new Set([ownerId, user.id, ...cleanIds]));
    const ph = updatedMembers.map(() => '?').join(',');
    const batchMemberOps = [
      chatDb.prepare(`DELETE FROM channel_members WHERE channel_id = ? AND user_id NOT IN (${ph})`).bind(channel.id, ...updatedMembers)
    ];
    for (const uid of updatedMembers) {
      batchMemberOps.push(
        chatDb.prepare(
          'INSERT INTO channel_members (channel_id, user_id, role) VALUES (?, ?, ?) ON CONFLICT(channel_id, user_id) DO NOTHING'
        ).bind(channel.id, uid, uid === ownerId ? 'owner' : 'member')
      );
    }
    await chatDb.batch(batchMemberOps);
  } else if (isPrivateBoard && !wasPrivateBoard) {
    // Converting public -> private without member_ids must purge stale read-watermark rows
    const ownerId = channel.created_by || user.id;
    updatedMembers = Array.from(new Set([ownerId, user.id]));
    const ph = updatedMembers.map(() => '?').join(',');
    const batchReset = [
      chatDb.prepare(`DELETE FROM channel_members WHERE channel_id = ? AND user_id NOT IN (${ph})`).bind(channel.id, ...updatedMembers)
    ];
    for (const uid of updatedMembers) {
      batchReset.push(
        chatDb.prepare(
          'INSERT INTO channel_members (channel_id, user_id, role) VALUES (?, ?, ?) ON CONFLICT(channel_id, user_id) DO NOTHING'
        ).bind(channel.id, uid, uid === ownerId ? 'owner' : 'member')
      );
    }
    await chatDb.batch(batchReset);
  } else if (isPrivateBoard) {
    const { results: mRows } = await chatDb.prepare(
      'SELECT user_id FROM channel_members WHERE channel_id = ?'
    ).bind(channel.id).all();
    updatedMembers = Array.from(new Set([...(mRows || []).map((r) => r.user_id), ...(channel.created_by ? [channel.created_by] : [user.id])]));
  }

  const updated = await chatDb.prepare('SELECT * FROM channels WHERE id = ?').bind(channel.id).first();
  if (updated && updatedMembers) {
    updated.member_ids = updatedMembers;
  }
  try {
    const isRoleRestricted = isPrivateBoard || !['player', 'guest', 'public'].includes(minRoleRead);
    await chatDb.prepare(`
      INSERT INTO sync_events (channel_id, event_type, target_id, payload_json, created_at)
      VALUES (?, 'channel_update', ?, ?, ?)
    `).bind(isRoleRestricted ? channel.id : 0, channel.id, JSON.stringify(updated), Math.floor(Date.now() / 1000)).run();
  } catch (e) {}

  return c.json({ success: true, channel: updated });
});

chatChannelsRouter.delete('/channels/:id', requireModerator, async (c) => {
  const user = c.get('user');
  const mutedResp = rejectIfChatMuted(c, user);
  if (mutedResp) return mutedResp;
  const chatDb = c.env && c.env.CHAT_DB;
  if (!chatDb) return c.json({ error: 'Chat database unavailable.' }, 500);

  const channel = await resolveChannel(chatDb, c.req.param('id'));
  if (!channel) {
    return c.json({ error: 'Message board not found.' }, 404);
  }
  if (channel.slug === 'general' || channel.slug === 'announcements') {
    return c.json({ error: 'Core system boards (#general, #announcements) cannot be deleted.' }, 400);
  }
  if (channel.channel_type === 'dm' || channel.channel_type === 'group_dm') {
    return c.json({ error: 'Direct message conversations cannot be deleted via board management.' }, 400);
  }
  if (!(await canUserAccessChannel(chatDb, user, channel, 'write')) && !user.isAdmin && channel.created_by !== user.id) {
    return c.json({ error: 'Access denied: insufficient permissions to delete this board.' }, 403);
  }
  if (!user.isAdmin && (channel.min_role_read === 'admin' || channel.min_role_write === 'admin')) {
    return c.json({ error: 'Access denied: only administrators can delete admin-restricted boards.' }, 403);
  }

  await chatDb.prepare('DELETE FROM channels WHERE id = ?').bind(channel.id).run();
  try {
    const isRoleRestricted = isPrivateEncryptedBoard(channel) || !['player', 'guest', 'public'].includes(channel.min_role_read || 'player');
    await chatDb.prepare(`
      INSERT INTO sync_events (channel_id, event_type, target_id, payload_json, created_at)
      VALUES (?, 'channel_delete', ?, ?, ?)
    `).bind(isRoleRestricted ? channel.id : 0, channel.id, JSON.stringify({ id: channel.id, slug: channel.slug }), Math.floor(Date.now() / 1000)).run();
  } catch (e) {}

  return c.json({ success: true, id: channel.id, slug: channel.slug });
});

async function setDmChannelHiddenState(c, hidden) {
  const user = c.get('user');
  const chatDb = c.env && c.env.CHAT_DB;
  if (!chatDb) return c.json({ error: 'Chat database unavailable.' }, 500);

  const channel = await resolveChannel(chatDb, c.req.param('id'));
  if (!channel) {
    return c.json({ error: 'Conversation not found.' }, 404);
  }
  if (channel.channel_type !== 'dm' && channel.channel_type !== 'group_dm') {
    return c.json({ error: 'Only direct message conversations can be hidden from your channel list.' }, 400);
  }
  if (!(await canUserAccessChannel(chatDb, user, channel, 'read'))) {
    return c.json({ error: 'Access denied: you are not a participant in this conversation.' }, 403);
  }

  const hiddenFlag = hidden ? 1 : 0;
  await chatDb.prepare(
    'INSERT INTO channel_members (channel_id, user_id, role, hidden) VALUES (?, ?, ?, ?) ON CONFLICT(channel_id, user_id) DO UPDATE SET hidden = ?'
  ).bind(channel.id, user.id, channel.created_by === user.id ? 'owner' : 'member', hiddenFlag, hiddenFlag).run();

  if (hidden) {
    return c.json({ success: true, id: channel.id, hidden: true });
  }
  const { results: dmMemRows } = await chatDb.prepare(
    'SELECT user_id FROM channel_members WHERE channel_id = ?'
  ).bind(channel.id).all();
  const memberIds = Array.from(new Set([...(dmMemRows || []).map((r) => r.user_id), ...(channel.created_by ? [channel.created_by] : [])]));
  return c.json({ success: true, channel: { ...channel, member_ids: memberIds }, hidden: false });
}

chatChannelsRouter.post('/channels/:id/hide', requireAuth, (c) => setDmChannelHiddenState(c, true));
chatChannelsRouter.post('/channels/:id/unhide', requireAuth, (c) => setDmChannelHiddenState(c, false));
