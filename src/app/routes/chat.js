/**
 * Clubhouse Chat Engine, Delta Sync, Channels, Messages, Threads & Emoji Reactions
 * Backed by CHAT_DB (Cloudflare D1 / SQLite) with zero-webhook access to BASEBALL_DB.
 */

import { Hono } from 'hono';
import { requireAuth, requireModerator, canAccessChannel, rejectIfChatMuted } from '../security.js';

export const chatRouter = new Hono();

/**
 * Abbreviate last names in a member directory ("First L.", or "First La."
 * when multiple distinct users share the same first name and last initial).
 */
export function abbreviateMemberNames(records) {
  const list = Array.isArray(records) ? records : [];
  const seenIds = new Set();
  const keyCounts = Object.create(null);

  const parsed = list.map((rec, idx) => {
    const raw = rec && rec.name ? String(rec.name).trim() : '';
    const parts = raw ? raw.split(/\s+/) : [];
    const first = parts.length > 1 ? parts.slice(0, -1).join(' ') : (parts[0] || '');
    const last = parts.length > 1 ? parts[parts.length - 1].replace(/\.+$/, '') : '';
    const key = (first && last) ? (first.toLowerCase() + '|' + last.charAt(0).toLowerCase()) : '';
    const uid = rec && (rec.user_id || rec.id);
    const personId = uid ? ('u:' + String(uid)) : ('i:' + idx);
    if (key && !seenIds.has(personId)) {
      seenIds.add(personId);
      keyCounts[key] = (keyCounts[key] || 0) + 1;
    }
    return { raw, first, last, key };
  });

  return parsed.map((p) => {
    if (!p.raw) return 'Player';
    if (!p.last) return p.raw;
    const len = keyCounts[p.key] > 1 ? 2 : 1;
    return p.first + ' ' + p.last.slice(0, len) + '.';
  });
}

/**
 * Resolve a channel by numeric ID or slug
 */
export async function resolveChannel(chatDb, channelParam) {
  if (!chatDb || channelParam === undefined || channelParam === null) return null;
  const raw = String(channelParam).trim();
  if (!raw) return null;

  if (/^\d+$/.test(raw)) {
    const byId = await chatDb.prepare('SELECT * FROM channels WHERE id = ?').bind(parseInt(raw, 10)).first();
    if (byId) return byId;
  }
  const bySlug = await chatDb.prepare('SELECT * FROM channels WHERE slug = ?').bind(raw).first();
  if (bySlug) return bySlug;

  // Support shorthand voice slug aliases used by clients/tests
  const SLUG_ALIASES = {
    'dugout-voice': 'dugout-voice-huddle',
    'war-room': 'organizers-war-room'
  };
  if (SLUG_ALIASES[raw]) {
    return await chatDb.prepare('SELECT * FROM channels WHERE slug = ?').bind(SLUG_ALIASES[raw]).first();
  }
  return null;
}

/**
 * Returns true for invite-only / private message boards that enforce ECDH E2EE.
 */
export function isPrivateEncryptedBoard(channel) {
  return Boolean(
    channel &&
    (channel.is_private === 1 || channel.min_role_read === 'invite') &&
    channel.channel_type !== 'dm' &&
    channel.channel_type !== 'group_dm'
  );
}

/**
 * Check if a user can read or write a channel (including DM & private board membership checks)
 */
export async function canUserAccessChannel(chatDb, user, channel, mode = 'read') {
  if (!user || !channel) return false;

  if (channel.channel_type === 'dm' || channel.channel_type === 'group_dm' || isPrivateEncryptedBoard(channel)) {
    if (channel.created_by === user.id) return true;
    const member = await chatDb.prepare(
      'SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?'
    ).bind(channel.id, user.id).first();
    if (!member) return false;
    if (isPrivateEncryptedBoard(channel) && mode === 'write') {
      return canAccessChannel(user, channel, 'write');
    }
    return true;
  }

  if (user.isAdmin || user.role === 'admin' || user.is_admin === 1) return true;
  return canAccessChannel(user, channel, mode);
}

let lastSyncPruneSec = 0;

/**
 * Get all channels accessible to the user (batched DM & private board membership lookup to avoid N+1 D1 queries)
 */
async function getAccessibleChannels(chatDb, user) {
  const { results: allChannels } = await chatDb.prepare(
    'SELECT * FROM channels ORDER BY sort_order ASC, id ASC'
  ).all();

  if (!user) return [];
  const isAdminUser = Boolean(user.isAdmin || user.role === 'admin' || user.is_admin === 1);

  let memberChannelIds = new Set();
  try {
    const { results: memberRows } = await chatDb.prepare(
      'SELECT channel_id FROM channel_members WHERE user_id = ?'
    ).bind(user.id).all();
    memberChannelIds = new Set((memberRows || []).map((r) => r.channel_id));
  } catch (e) {}

  const accessible = [];
  const keySharedChannelIds = [];
  for (const ch of (allChannels || [])) {
    if (ch.channel_type === 'dm' || ch.channel_type === 'group_dm' || isPrivateEncryptedBoard(ch)) {
      if (ch.created_by === user.id || memberChannelIds.has(ch.id)) {
        accessible.push({ ...ch, member_ids: [] });
        keySharedChannelIds.push(ch.id);
      }
    } else if (isAdminUser || canAccessChannel(user, ch, 'read')) {
      accessible.push(ch);
    }
  }

  if (keySharedChannelIds.length > 0) {
    try {
      const ph = keySharedChannelIds.map(() => '?').join(',');
      const { results: memberListRows } = await chatDb.prepare(
        `SELECT channel_id, user_id FROM channel_members WHERE channel_id IN (${ph})`
      ).bind(...keySharedChannelIds).all();
      const memberMap = new Map();
      for (const row of (memberListRows || [])) {
        if (!memberMap.has(row.channel_id)) memberMap.set(row.channel_id, []);
        memberMap.get(row.channel_id).push(row.user_id);
      }
      for (const ch of accessible) {
        if (ch.channel_type === 'dm' || ch.channel_type === 'group_dm' || isPrivateEncryptedBoard(ch)) {
          const list = memberMap.get(ch.id) ? [...memberMap.get(ch.id)] : [];
          if (ch.created_by && !list.includes(ch.created_by)) list.push(ch.created_by);
          ch.member_ids = list;
        }
      }
    } catch (e) {}
  }

  return accessible;
}

/**
 * Format message row with parsed badges, reactions, and attachments
 */
function normalizeMessageRow(msg, reactionsByMsg = new Map(), attachmentsByMsg = new Map()) {
  if (!msg) return msg;
  let parsedBadges = {};
  if (typeof msg.author_badges === 'string') {
    try {
      parsedBadges = JSON.parse(msg.author_badges);
    } catch (e) {
      parsedBadges = {};
    }
  } else if (msg.author_badges && typeof msg.author_badges === 'object') {
    parsedBadges = msg.author_badges;
  }

  let parsedMetadata = null;
  if (typeof msg.metadata_json === 'string' && msg.metadata_json.trim()) {
    try {
      parsedMetadata = JSON.parse(msg.metadata_json);
    } catch (e) {
      parsedMetadata = null;
    }
  }

  const sanitized = { ...msg };
  delete sanitized.original_content;
  delete sanitized.original_iv;

  if (sanitized.hidden_at) {
    return {
      ...sanitized,
      is_hidden: true,
      content: '[Message hidden by moderator]',
      iv: null,
      encryption_iv: null,
      author_badges_obj: parsedBadges,
      metadata: null,
      reactions: [],
      attachments: []
    };
  }

  return {
    ...sanitized,
    is_hidden: false,
    encryption_iv: sanitized.iv || null,
    author_badges_obj: parsedBadges,
    metadata: parsedMetadata,
    reactions: reactionsByMsg.get(sanitized.id) || [],
    attachments: attachmentsByMsg.get(sanitized.id) || []
  };
}

/**
 * Hydrate reactions and attachments for a batch of messages
 */
async function hydrateMessages(chatDb, messages) {
  if (!messages || messages.length === 0) return [];
  const msgIds = messages.map((m) => m.id);
  const placeholders = msgIds.map(() => '?').join(',');

  const reactionsByMsg = new Map();
  const attachmentsByMsg = new Map();

  try {
    const { results: reactions } = await chatDb.prepare(
      `SELECT * FROM message_reactions WHERE message_id IN (${placeholders}) ORDER BY id ASC`
    ).bind(...msgIds).all();
    for (const r of (reactions || [])) {
      if (!reactionsByMsg.has(r.message_id)) reactionsByMsg.set(r.message_id, []);
      reactionsByMsg.get(r.message_id).push(r);
    }
  } catch (e) {}

  try {
    const { results: attachments } = await chatDb.prepare(
      `SELECT id, channel_id, message_id, uploader_id, file_name, mime_type, file_size, storage_provider, upload_status, is_encrypted, iv, thumbnail_base64, promoted_media_id, created_at
       FROM chat_attachments WHERE message_id IN (${placeholders}) ORDER BY created_at ASC`
    ).bind(...msgIds).all();
    for (const a of (attachments || [])) {
      if (!attachmentsByMsg.has(a.message_id)) attachmentsByMsg.set(a.message_id, []);
      attachmentsByMsg.get(a.message_id).push({
        ...a,
        stream_url: `/api/attachments/${a.id}/stream`
      });
    }
  } catch (e) {}

  return messages.map((m) => normalizeMessageRow(m, reactionsByMsg, attachmentsByMsg));
}

// ---------------------------------------------------------------------------
// GET /api/bootstrap - Initial UI Hydration
// ---------------------------------------------------------------------------
chatRouter.get('/bootstrap', requireAuth, async (c) => {
  const user = c.get('user');
  const chatDb = c.env && c.env.CHAT_DB;
  const baseballDb = c.env && (c.env.BASEBALL_DB || c.env.DB);

  if (!chatDb) {
    return c.json({ error: 'Chat database unavailable.' }, 500);
  }

  const nowSec = Math.floor(Date.now() / 1000);

  // Prune stale voice participants only when stale rows actually exist (avoids idle D1 writes)
  try {
    const staleVoice = await chatDb.prepare(
      'SELECT 1 FROM voice_participants WHERE heartbeat_at <= ? LIMIT 1'
    ).bind(nowSec - 25).first();
    if (staleVoice) {
      await chatDb.prepare('DELETE FROM voice_participants WHERE heartbeat_at <= ?').bind(nowSec - 25).run();
    }
  } catch (e) {}

  const channels = await getAccessibleChannels(chatDb, user);
  const accessibleIds = new Set(channels.map((ch) => ch.id));

  // Active voice participants (<25s heartbeat)
  const { results: rawVoice } = await chatDb.prepare(
    'SELECT * FROM voice_participants WHERE heartbeat_at > ? ORDER BY heartbeat_at DESC'
  ).bind(nowSec - 25).all();
  const voice_participants = (rawVoice || []).filter((vp) => accessibleIds.has(vp.channel_id));

  // Unread counts per channel (single aggregated query instead of N+1 loop)
  const unread_counts = {};
  try {
    const { results: unreadRows } = await chatDb.prepare(`
      SELECT m.channel_id, COUNT(*) as c
      FROM messages m
      LEFT JOIN channel_members cm ON cm.channel_id = m.channel_id AND cm.user_id = ?
      WHERE m.deleted_at IS NULL AND m.id > COALESCE(cm.last_read_message_id, 0)
      GROUP BY m.channel_id
    `).bind(user.id).all();
    const countMap = new Map((unreadRows || []).map((r) => [r.channel_id, r.c || 0]));

    for (const ch of channels) {
      const cnt = countMap.get(ch.id) || 0;
      unread_counts[ch.id] = cnt;
      unread_counts[ch.slug] = cnt;
    }
  } catch (e) {}

  // Community member directory from BASEBALL_DB
  let members = [];
  if (baseballDb) {
    try {
      const { results: usersList } = await baseballDb.prepare(`
        SELECT id, name, role, is_admin, COALESCE(is_moderator, 0) as is_moderator,
               COALESCE(chat_muted, 0) as chat_muted, chat_muted_reason,
               machine_badge, field_badge, hero_credits,
               CASE
                 WHEN avatar_url LIKE 'data:%' THEN '/api/users/' || id || '/avatar?v=' || length(avatar_url)
                 ELSE COALESCE(avatar_url, '')
               END as avatar_url
        FROM users
        WHERE NOT EXISTS (SELECT 1 FROM banned_emails b WHERE LOWER(b.email) = LOWER(users.email))
        ORDER BY CASE WHEN role = 'admin' OR is_admin = 1 THEN 1 WHEN is_moderator = 1 THEN 2 WHEN role = 'organizer' THEN 3 ELSE 4 END, name ASC
        LIMIT 200
      `).all();

      const { results: cryptoRows } = await chatDb.prepare(
        'SELECT user_id, ecdh_public_key_jwk, ecdsa_public_key_jwk, status_text FROM user_crypto_keys'
      ).all();
      const cryptoMap = new Map((cryptoRows || []).map((r) => [r.user_id, r]));

      const abbreviatedNames = abbreviateMemberNames(usersList || []);
      members = (usersList || []).map((u, idx) => {
        const ck = cryptoMap.get(u.id);
        return {
          id: u.id,
          name: abbreviatedNames[idx] || u.name,
          role: u.role || (u.is_admin ? 'admin' : 'player'),
          isAdmin: Boolean(u.is_admin || u.role === 'admin'),
          isModerator: Boolean(u.is_moderator || u.is_admin || u.role === 'admin'),
          is_moderator: Boolean(u.is_moderator),
          chatMuted: Boolean(u.chat_muted),
          chat_muted: Boolean(u.chat_muted),
          chatMutedReason: u.chat_muted_reason || null,
          machineBadge: Boolean(u.machine_badge),
          fieldBadge: Boolean(u.field_badge),
          heroCredits: u.hero_credits || 0,
          avatarUrl: u.avatar_url || '',
          hasKeys: Boolean(ck),
          statusText: (ck && ck.status_text) || ''
        };
      });
    } catch (e) {}
  }

  let muted_user_ids = [];
  try {
    const { results: muteRows } = await chatDb.prepare(
      'SELECT muted_user_id FROM user_mutes WHERE muter_user_id = ?'
    ).bind(user.id).all();
    muted_user_ids = (muteRows || []).map((r) => r.muted_user_id);
  } catch (e) {}

  // Upcoming Sunday game summary from BASEBALL_DB
  let upcoming_game = null;
  if (baseballDb) {
    try {
      upcoming_game = await baseballDb.prepare(`
        SELECT * FROM events
        WHERE (status IS NULL OR status NOT IN ('cancelled'))
          AND datetime(event_date) >= datetime('now', '-1 day')
        ORDER BY
          CASE WHEN strftime('%w', event_date) = '0' OR title LIKE '%Sunday%' THEN 0 ELSE 1 END,
          event_date ASC
        LIMIT 1
      `).first();
    } catch (e) {}
  }

  let last_message_id = 0;
  let last_event_id = 0;
  try {
    const maxMsgRow = await chatDb.prepare('SELECT MAX(id) as m FROM messages').first();
    const maxEvtRow = await chatDb.prepare('SELECT MAX(id) as m FROM sync_events').first();
    if (maxMsgRow && maxMsgRow.m) last_message_id = maxMsgRow.m;
    if (maxEvtRow && maxEvtRow.m) last_event_id = maxEvtRow.m;
  } catch (e) {}

  return c.json({
    user,
    channels,
    voice_participants,
    unread_counts,
    members,
    muted_user_ids,
    upcoming_game,
    last_message_id,
    last_event_id
  });
});

// ---------------------------------------------------------------------------
// GET /api/sync - High-Efficiency Delta Sync Endpoint
// ---------------------------------------------------------------------------
chatRouter.get('/sync', requireAuth, async (c) => {
  const user = c.get('user');
  const chatDb = c.env && c.env.CHAT_DB;
  if (!chatDb) {
    return c.json({ error: 'Chat database unavailable.' }, 500);
  }

  const rawSinceMsg = parseInt(c.req.query('since_msg_id') || '0', 10);
  const sinceMsgId = isNaN(rawSinceMsg) || rawSinceMsg < 0 ? 0 : rawSinceMsg;

  const rawSinceEvent = parseInt(c.req.query('since_event_id') || '0', 10);
  const sinceEventId = isNaN(rawSinceEvent) || rawSinceEvent < 0 ? 0 : rawSinceEvent;

  const channelFilterParam = c.req.query('channel_id');
  const nowSec = Math.floor(Date.now() / 1000);

  // Fast-path watermark check: 1 compact scalar query skips 6+ table queries on idle polls
  if (!channelFilterParam) {
    const watermark = await chatDb.prepare(`
      SELECT
        (SELECT COALESCE(MAX(id), 0) FROM messages) as max_msg_id,
        (SELECT COALESCE(MAX(id), 0) FROM sync_events) as max_event_id,
        EXISTS(SELECT 1 FROM rtc_signals WHERE recipient_user_id = ? AND created_at > ?) as has_signals,
        EXISTS(SELECT 1 FROM voice_participants WHERE heartbeat_at > ?) as has_voice
    `).bind(user.id, nowSec - 60, nowSec - 25).first();

    if (
      watermark &&
      Number(watermark.max_msg_id || 0) <= sinceMsgId &&
      Number(watermark.max_event_id || 0) <= sinceEventId &&
      !watermark.has_signals &&
      !watermark.has_voice
    ) {
      return c.json({
        messages: [],
        events: [],
        rtc_signals: [],
        voice_participants: [],
        latest_msg_id: sinceMsgId,
        latest_event_id: sinceEventId
      });
    }
  }

  const accessibleChannels = await getAccessibleChannels(chatDb, user);
  let targetChannelIds = accessibleChannels.map((ch) => ch.id);

  if (channelFilterParam) {
    const resolved = await resolveChannel(chatDb, channelFilterParam);
    if (resolved && targetChannelIds.includes(resolved.id)) {
      targetChannelIds = [resolved.id];
    } else {
      targetChannelIds = [];
    }
  }

  let messages = [];
  let events = [];

  if (targetChannelIds.length > 0) {
    const placeholders = targetChannelIds.map(() => '?').join(',');

    // 1. Delta messages
    const { results: rawMsgs } = await chatDb.prepare(
      `SELECT * FROM messages
       WHERE id > ? AND channel_id IN (${placeholders}) AND deleted_at IS NULL
       ORDER BY id ASC
       LIMIT 200`
    ).bind(sinceMsgId, ...targetChannelIds).all();

    messages = await hydrateMessages(chatDb, rawMsgs || []);

    // 2. Delta sync_events (include global channel_id = 0 for board & moderation updates)
    const { results: rawEvents } = await chatDb.prepare(
      `SELECT * FROM sync_events
       WHERE id > ? AND (channel_id = 0 OR channel_id IN (${placeholders}))
       ORDER BY id ASC
       LIMIT 200`
    ).bind(sinceEventId, ...targetChannelIds).all();

    events = rawEvents || [];
  }

  // 3. Throttle background TTL pruning writes to at most once every 60s and only when expired rows exist
  if (nowSec - lastSyncPruneSec >= 60) {
    lastSyncPruneSec = nowSec;
    try {
      const staleSig = await chatDb.prepare('SELECT 1 FROM rtc_signals WHERE created_at <= ? LIMIT 1').bind(nowSec - 60).first();
      if (staleSig) {
        await chatDb.prepare('DELETE FROM rtc_signals WHERE created_at <= ?').bind(nowSec - 60).run();
      }
      const staleVp = await chatDb.prepare('SELECT 1 FROM voice_participants WHERE heartbeat_at <= ? LIMIT 1').bind(nowSec - 25).first();
      if (staleVp) {
        await chatDb.prepare('DELETE FROM voice_participants WHERE heartbeat_at <= ?').bind(nowSec - 25).run();
      }
    } catch (e) {}
  }

  const { results: rawSignals } = await chatDb.prepare(
    `SELECT * FROM rtc_signals
     WHERE recipient_user_id = ? AND created_at > ?
     ORDER BY id ASC
     LIMIT 100`
  ).bind(user.id, nowSec - 60).all();

  const rtc_signals = rawSignals || [];

  // 4. Active voice participants (<25s heartbeat)
  const { results: rawVoice } = await chatDb.prepare(
    'SELECT * FROM voice_participants WHERE heartbeat_at > ? ORDER BY heartbeat_at DESC'
  ).bind(nowSec - 25).all();

  const accessibleSet = new Set(accessibleChannels.map((ch) => ch.id));
  const voice_participants = (rawVoice || []).filter((vp) => accessibleSet.has(vp.channel_id));

  const latest_msg_id = messages.length > 0 ? messages[messages.length - 1].id : sinceMsgId;
  const latest_event_id = events.length > 0 ? events[events.length - 1].id : sinceEventId;

  return c.json({
    messages,
    events,
    rtc_signals,
    voice_participants,
    latest_msg_id,
    latest_event_id
  });
});

// ---------------------------------------------------------------------------
// GET /api/channels - List Accessible Channels
// ---------------------------------------------------------------------------
chatRouter.get('/channels', requireAuth, async (c) => {
  const user = c.get('user');
  const chatDb = c.env && c.env.CHAT_DB;
  if (!chatDb) return c.json({ error: 'Chat database unavailable.' }, 500);

  const channels = await getAccessibleChannels(chatDb, user);
  return c.json({ channels });
});

// ---------------------------------------------------------------------------
// POST /api/channels - Create Text/Voice Channel or Direct Message
// ---------------------------------------------------------------------------
chatRouter.post('/channels', requireAuth, async (c) => {
  const user = c.get('user');
  const chatDb = c.env && c.env.CHAT_DB;
  if (!chatDb) return c.json({ error: 'Chat database unavailable.' }, 500);

  const body = await c.req.json().catch(() => ({}));
  const channelType = body.channel_type || 'text';
  const isDm = channelType === 'dm' || channelType === 'group_dm';

  if (isDm) {
    const mutedResp = rejectIfChatMuted(c, user);
    if (mutedResp) return mutedResp;
  }

  if (!isDm && !user.canManageEvents && !user.isAdmin && !user.isModerator && !user.canModerateChat) {
    return c.json({ error: 'Access denied: Moderator, Event Organizer, or Administrator privileges required to create boards.' }, 403);
  }

  let name = String(body.name || '').trim();
  let slug = String(body.slug || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug && name) {
    slug = name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  }

  const rawMemberIds = Array.isArray(body.member_ids)
    ? body.member_ids
    : (body.dm_user_id ? [body.dm_user_id] : []);
  const dmMemberIds = rawMemberIds.map((id) => parseInt(id, 10)).filter(Boolean);
  if (isDm) {
    const allParticipants = Array.from(new Set([user.id, ...dmMemberIds])).sort((a, b) => a - b);
    if (allParticipants.length < 2) {
      return c.json({ error: 'At least one other member is required to start a DM.' }, 400);
    }
    slug = `dm-${allParticipants.join('-')}`;
    if (!name) name = body.name || `DM (${allParticipants.length})`;
  }

  if (!slug || !name) {
    return c.json({ error: 'Channel name and slug are required.' }, 400);
  }

  const existing = await chatDb.prepare('SELECT * FROM channels WHERE slug = ?').bind(slug).first();
  if (existing) {
    if (isDm) {
      const allowed = await canUserAccessChannel(chatDb, user, existing, 'read');
      if (!allowed) {
        return c.json({ error: 'Access denied to existing conversation.' }, 403);
      }
      const { results: dmMemRows } = await chatDb.prepare(
        'SELECT user_id FROM channel_members WHERE channel_id = ?'
      ).bind(existing.id).all();
      const mIds = Array.from(new Set([...(dmMemRows || []).map((r) => r.user_id), ...(existing.created_by ? [existing.created_by] : [])]));
      return c.json({ success: true, channel: { ...existing, member_ids: mIds } }, 200);
    }
    return c.json({ error: 'A channel with that slug already exists.' }, 409);
  }

  const category = String(body.category || (isDm ? 'Direct Messages' : (channelType === 'voice' ? 'Voice Lounges' : 'Text Channels'))).trim();
  const topic = String(body.topic || '').trim();
  const isPrivateBoard = !isDm && channelType !== 'voice' && Boolean(body.is_private);
  const minRoleRead = isPrivateBoard ? 'invite' : (body.min_role_read || 'player');
  const minRoleWrite = body.min_role_write || (channelType === 'announcement' ? 'organizer' : 'player');
  const isEncrypted = isPrivateBoard ? 1 : (body.is_encrypted !== undefined ? (body.is_encrypted ? 1 : 0) : 1);
  const linkedEventId = body.linked_event_id ? parseInt(body.linked_event_id, 10) : null;
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

  // Register members if DM or member_ids supplied
  const membersToInsert = Array.from(new Set([user.id, ...dmMemberIds]));
  for (const uid of membersToInsert) {
    try {
      await chatDb.prepare(
        'INSERT INTO channel_members (channel_id, user_id, role) VALUES (?, ?, ?) ON CONFLICT(channel_id, user_id) DO NOTHING'
      ).bind(newChannelId, uid, uid === user.id ? 'owner' : 'member').run();
    } catch (e) {}
  }

  const created = await chatDb.prepare('SELECT * FROM channels WHERE id = ?').bind(newChannelId).first();
  if ((isDm || isPrivateBoard) && created) {
    created.member_ids = membersToInsert;
  }
  if (!isDm && created) {
    try {
      await chatDb.prepare(`
        INSERT INTO sync_events (channel_id, event_type, target_id, payload_json, created_at)
        VALUES (?, 'channel_create', ?, ?, ?)
      `).bind(isPrivateBoard ? newChannelId : 0, newChannelId, JSON.stringify(created), Math.floor(Date.now() / 1000)).run();
    } catch (e) {}
  }
  return c.json({ success: true, channel: created, id: newChannelId }, 201);
});

// ---------------------------------------------------------------------------
// PATCH /api/channels/:id - Edit Message Board Metadata & Private Invite List
// ---------------------------------------------------------------------------
chatRouter.patch('/channels/:id', requireAuth, async (c) => {
  const user = c.get('user');
  const chatDb = c.env && c.env.CHAT_DB;
  if (!chatDb) return c.json({ error: 'Chat database unavailable.' }, 500);

  if (!user.isAdmin && !user.isModerator && !user.canModerateChat && !user.canManageEvents) {
    return c.json({ error: 'Access denied: Moderator, Event Organizer, or Administrator privileges required to edit boards.' }, 403);
  }

  const channel = await resolveChannel(chatDb, c.req.param('id'));
  if (!channel) {
    return c.json({ error: 'Message board not found.' }, 404);
  }
  if (channel.channel_type === 'dm' || channel.channel_type === 'group_dm') {
    return c.json({ error: 'Direct message conversations cannot be edited as boards.' }, 400);
  }
  if (isPrivateEncryptedBoard(channel) && !(await canUserAccessChannel(chatDb, user, channel, 'read'))) {
    return c.json({ error: 'Access denied: only invited members of this private board can manage it.' }, 403);
  }

  const body = await c.req.json().catch(() => ({}));
  const name = body.name !== undefined ? String(body.name).trim() : channel.name;
  if (!name) {
    return c.json({ error: 'Board name cannot be empty.' }, 400);
  }

  const category = body.category !== undefined ? String(body.category).trim() || channel.category : channel.category;
  const topic = body.topic !== undefined ? String(body.topic).trim() : (channel.topic || '');
  const allowedTypes = ['text', 'announcement', 'voice'];
  const channelType = body.channel_type !== undefined
    ? (allowedTypes.includes(body.channel_type) ? body.channel_type : channel.channel_type)
    : channel.channel_type;
  const isPrivateBoard = body.is_private !== undefined
    ? (channelType !== 'voice' && Boolean(body.is_private))
    : isPrivateEncryptedBoard(channel);
  const minRoleRead = isPrivateBoard
    ? 'invite'
    : (body.min_role_read || (channel.min_role_read === 'invite' ? 'player' : channel.min_role_read) || 'player');
  const minRoleWrite = body.min_role_write || channel.min_role_write || 'player';
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
    const cleanIds = body.member_ids.map((id) => parseInt(id, 10)).filter(Boolean);
    const ownerId = channel.created_by || user.id;
    updatedMembers = Array.from(new Set([ownerId, user.id, ...cleanIds]));
    await chatDb.prepare('DELETE FROM channel_members WHERE channel_id = ?').bind(channel.id).run();
    for (const uid of updatedMembers) {
      await chatDb.prepare(
        'INSERT INTO channel_members (channel_id, user_id, role) VALUES (?, ?, ?) ON CONFLICT(channel_id, user_id) DO NOTHING'
      ).bind(channel.id, uid, uid === ownerId ? 'owner' : 'member').run();
    }
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
    await chatDb.prepare(`
      INSERT INTO sync_events (channel_id, event_type, target_id, payload_json, created_at)
      VALUES (?, 'channel_update', ?, ?, ?)
    `).bind(isPrivateBoard ? channel.id : 0, channel.id, JSON.stringify(updated), Math.floor(Date.now() / 1000)).run();
  } catch (e) {}

  return c.json({ success: true, channel: updated });
});

// ---------------------------------------------------------------------------
// DELETE /api/channels/:id - Delete Message Board
// ---------------------------------------------------------------------------
chatRouter.delete('/channels/:id', requireModerator, async (c) => {
  const user = c.get('user');
  const chatDb = c.env && c.env.CHAT_DB;
  if (!chatDb) return c.json({ error: 'Chat database unavailable.' }, 500);

  const channel = await resolveChannel(chatDb, c.req.param('id'));
  if (!channel) {
    return c.json({ error: 'Message board not found.' }, 404);
  }
  if (channel.slug === 'general') {
    return c.json({ error: 'The primary #general board cannot be deleted.' }, 400);
  }
  if (channel.channel_type === 'dm' || channel.channel_type === 'group_dm') {
    return c.json({ error: 'Direct message conversations cannot be deleted via board management.' }, 400);
  }
  if (isPrivateEncryptedBoard(channel) && !(await canUserAccessChannel(chatDb, user, channel, 'read'))) {
    return c.json({ error: 'Access denied: only invited members of this private board can delete it.' }, 403);
  }

  await chatDb.prepare('DELETE FROM channels WHERE id = ?').bind(channel.id).run();
  try {
    await chatDb.prepare(`
      INSERT INTO sync_events (channel_id, event_type, target_id, payload_json, created_at)
      VALUES (0, 'channel_delete', ?, ?, ?)
    `).bind(channel.id, JSON.stringify({ id: channel.id, slug: channel.slug }), Math.floor(Date.now() / 1000)).run();
  } catch (e) {}

  return c.json({ success: true, id: channel.id, slug: channel.slug });
});

// ---------------------------------------------------------------------------
// GET /api/channels/:id/messages - Paginated Channel / Thread History
// ---------------------------------------------------------------------------
chatRouter.get('/channels/:id/messages', requireAuth, async (c) => {
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
          ORDER BY id DESC
          LIMIT ?
        ) ORDER BY id ASC
      `).bind(channel.id, beforeId, limit).all();

      const hydrated = await hydrateMessages(chatDb, rows || []);
      return c.json({ messages: hydrated, channel });
    }
  }

  if (parentIdParam !== undefined && parentIdParam !== '') {
    const parentId = parseInt(parentIdParam, 10);
    const { results: rows } = await chatDb.prepare(`
      SELECT * FROM messages
      WHERE channel_id = ? AND (id = ? OR parent_message_id = ?) AND deleted_at IS NULL
      ORDER BY id ASC
      LIMIT ?
    `).bind(channel.id, parentId, parentId, limit).all();

    const hydrated = await hydrateMessages(chatDb, rows || []);
    return c.json({ messages: hydrated, channel });
  }

  const { results: rows } = await chatDb.prepare(`
    SELECT * FROM (
      SELECT * FROM messages
      WHERE channel_id = ? AND deleted_at IS NULL
      ORDER BY id DESC
      LIMIT ?
    ) ORDER BY id ASC
  `).bind(channel.id, limit).all();

  const hydrated = await hydrateMessages(chatDb, rows || []);
  return c.json({ messages: hydrated, channel });
});

// ---------------------------------------------------------------------------
// POST /api/channels/:id/messages - Post Message or Thread Reply (Rate Limited)
// ---------------------------------------------------------------------------
chatRouter.post('/channels/:id/messages', requireAuth, async (c) => {
  const user = c.get('user');
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

  // Enforce 30 messages / 60s sliding-window burst rate limit via CHAT_DB.chat_rate_limits
  const nowSec = Math.floor(Date.now() / 1000);
  const rateKey = `user_${user.id}_msgs`;
  const windowCutoff = nowSec - 60;

  const existingRate = await chatDb.prepare(
    'SELECT count, window_start FROM chat_rate_limits WHERE key = ?'
  ).bind(rateKey).first();

  if (!existingRate || existingRate.window_start <= windowCutoff) {
    await chatDb.prepare(`
      INSERT INTO chat_rate_limits (key, count, window_start)
      VALUES (?, 1, ?)
      ON CONFLICT(key) DO UPDATE SET count = 1, window_start = ?
    `).bind(rateKey, nowSec, nowSec).run();
  } else if (existingRate.count >= 30) {
    const retryAfter = Math.max(1, 60 - (nowSec - existingRate.window_start));
    c.header('Retry-After', String(retryAfter));
    return c.json({
      error: 'Too many messages (rate limit exceeded: max 30 messages per 60 seconds). Please slow down.'
    }, 429);
  } else {
    await chatDb.prepare(
      'UPDATE chat_rate_limits SET count = count + 1 WHERE key = ?'
    ).bind(rateKey).run();
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

  // Increment parent reply_count if this is a thread reply
  if (parentMessageId) {
    await chatDb.prepare(
      'UPDATE messages SET reply_count = reply_count + 1 WHERE id = ?'
    ).bind(parentMessageId).run();
  }

  // Link any uploaded attachments to this message
  if (Array.isArray(body.attachment_ids) && body.attachment_ids.length > 0) {
    for (const attId of body.attachment_ids) {
      await chatDb.prepare(
        'UPDATE chat_attachments SET message_id = ? WHERE id = ? AND uploader_id = ?'
      ).bind(newMsgId, String(attId), user.id).run();
    }
  }

  // Update sender's last_read_message_id
  try {
    await chatDb.prepare(`
      INSERT INTO channel_members (channel_id, user_id, last_read_message_id)
      VALUES (?, ?, ?)
      ON CONFLICT(channel_id, user_id) DO UPDATE SET last_read_message_id = MAX(last_read_message_id, ?)
    `).bind(channel.id, user.id, newMsgId, newMsgId).run();
  } catch (e) {}

  const createdRow = await chatDb.prepare('SELECT * FROM messages WHERE id = ?').bind(newMsgId).first();
  const [hydrated] = await hydrateMessages(chatDb, [createdRow]);

  return c.json({
    ...hydrated,
    success: true,
    message: hydrated
  }, 201);
});

// ---------------------------------------------------------------------------
// PATCH /api/messages/:id - Edit Message & Emit Sync Tombstone
// ---------------------------------------------------------------------------
chatRouter.patch('/messages/:id', requireAuth, async (c) => {
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

// ---------------------------------------------------------------------------
// DELETE /api/messages/:id - Soft-Delete Message & Emit Sync Tombstone
// ---------------------------------------------------------------------------
chatRouter.delete('/messages/:id', requireAuth, async (c) => {
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

// ---------------------------------------------------------------------------
// POST /api/messages/:id/reactions - Toggle Emoji Reaction & Emit Sync Event
// ---------------------------------------------------------------------------
chatRouter.post('/messages/:id/reactions', requireAuth, async (c) => {
  const user = c.get('user');
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

    const { results: updatedReactions } = await chatDb.prepare(
      'SELECT * FROM message_reactions WHERE message_id = ? ORDER BY id ASC'
    ).bind(msgId).all();

    return c.json({
      success: true,
      action: 'removed',
      message_id: msgId,
      emoji,
      reactions: updatedReactions || []
    });
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

    const { results: updatedReactions } = await chatDb.prepare(
      'SELECT * FROM message_reactions WHERE message_id = ? ORDER BY id ASC'
    ).bind(msgId).all();

    return c.json({
      success: true,
      action: 'added',
      message_id: msgId,
      emoji,
      reactions: updatedReactions || []
    });
  }
});

// ---------------------------------------------------------------------------
// POST|PATCH /api/messages/:id/hide - Hide Message for a Stated Reason (Mod/Admin)
// ---------------------------------------------------------------------------
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

chatRouter.post('/messages/:id/hide', requireModerator, hideMessageHandler);
chatRouter.patch('/messages/:id/hide', requireModerator, hideMessageHandler);

// ---------------------------------------------------------------------------
// POST /api/messages/:id/unhide - Restore Previously Hidden Message (Mod/Admin)
// ---------------------------------------------------------------------------
chatRouter.post('/messages/:id/unhide', requireModerator, async (c) => {
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

// ---------------------------------------------------------------------------
// POST /api/reports - Any Member Can Report a Message or User for a Reason
// ---------------------------------------------------------------------------
chatRouter.post('/reports', requireAuth, async (c) => {
  const user = c.get('user');
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

  // Burst rate limit for reports (max 10 reports per 10 mins per user)
  const nowSec = Math.floor(Date.now() / 1000);
  const reportRateKey = `user_${user.id}_reports`;
  try {
    const existingRate = await chatDb.prepare('SELECT count, window_start FROM chat_rate_limits WHERE key = ?').bind(reportRateKey).first();
    if (!existingRate || existingRate.window_start <= nowSec - 600) {
      await chatDb.prepare(`
        INSERT INTO chat_rate_limits (key, count, window_start)
        VALUES (?, 1, ?)
        ON CONFLICT(key) DO UPDATE SET count = 1, window_start = ?
      `).bind(reportRateKey, nowSec, nowSec).run();
    } else if (existingRate.count >= 10) {
      return c.json({ error: 'Too many reports submitted recently. Please wait before submitting more.' }, 429);
    } else {
      await chatDb.prepare('UPDATE chat_rate_limits SET count = count + 1 WHERE key = ?').bind(reportRateKey).run();
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
  return c.json({ success: true, report }, 201);
});

// ---------------------------------------------------------------------------
// GET /api/moderation/reports - List Submitted Reports (Mod/Admin)
// ---------------------------------------------------------------------------
chatRouter.get('/moderation/reports', requireModerator, async (c) => {
  const chatDb = c.env && c.env.CHAT_DB;
  const baseballDb = c.env && (c.env.BASEBALL_DB || c.env.DB);
  if (!chatDb) return c.json({ error: 'Chat database unavailable.' }, 500);

  const statusFilter = (c.req.query('status') || 'all').toLowerCase();
  const sql = statusFilter === 'open'
    ? "SELECT * FROM chat_reports WHERE status = 'open' ORDER BY id DESC LIMIT 100"
    : 'SELECT * FROM chat_reports ORDER BY CASE WHEN status = \'open\' THEN 0 ELSE 1 END, id DESC LIMIT 100';

  const { results: reports } = await chatDb.prepare(sql).all();
  const list = reports || [];

  // Batch enrich message excerpts and muted status without N+1 queries
  const msgIds = Array.from(new Set(list.map((r) => r.target_message_id).filter(Boolean)));
  const userIds = Array.from(new Set(list.map((r) => r.target_user_id).filter(Boolean)));

  const msgMap = new Map();
  if (msgIds.length > 0) {
    const ph = msgIds.map(() => '?').join(',');
    const { results: msgRows } = await chatDb.prepare(
      `SELECT id, channel_id, content, hidden_at, hidden_reason, deleted_at FROM messages WHERE id IN (${ph})`
    ).bind(...msgIds).all();
    for (const m of (msgRows || [])) msgMap.set(m.id, m);
  }

  const userMuteMap = new Map();
  if (baseballDb && userIds.length > 0) {
    const ph = userIds.map(() => '?').join(',');
    const { results: uRows } = await baseballDb.prepare(
      `SELECT id, COALESCE(chat_muted, 0) as chat_muted, chat_muted_reason FROM users WHERE id IN (${ph})`
    ).bind(...userIds).all();
    for (const u of (uRows || [])) userMuteMap.set(u.id, u);
  }

  const enriched = list.map((r) => {
    const m = r.target_message_id ? msgMap.get(r.target_message_id) : null;
    const u = r.target_user_id ? userMuteMap.get(r.target_user_id) : null;
    return {
      ...r,
      message_preview: m ? (m.deleted_at ? '[deleted]' : m.content) : null,
      message_hidden: Boolean(m && m.hidden_at),
      message_hidden_reason: m ? m.hidden_reason : null,
      target_chat_muted: Boolean(u && u.chat_muted),
      target_chat_muted_reason: u ? u.chat_muted_reason : null
    };
  });

  return c.json({ reports: enriched });
});

// ---------------------------------------------------------------------------
// PATCH /api/moderation/reports/:id - Resolve / Dismiss Report (Mod/Admin)
// ---------------------------------------------------------------------------
chatRouter.patch('/moderation/reports/:id', requireModerator, async (c) => {
  const user = c.get('user');
  const chatDb = c.env && c.env.CHAT_DB;
  if (!chatDb) return c.json({ error: 'Chat database unavailable.' }, 500);

  const reportId = parseInt(c.req.param('id'), 10);
  const existing = await chatDb.prepare('SELECT * FROM chat_reports WHERE id = ?').bind(reportId).first();
  if (!existing) {
    return c.json({ error: 'Report not found.' }, 404);
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

// ---------------------------------------------------------------------------
// GET /api/moderation/users - Moderation Roster (Non-PII for Delegated Mods)
// ---------------------------------------------------------------------------
chatRouter.get('/moderation/users', requireModerator, async (c) => {
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

// ---------------------------------------------------------------------------
// PUT /api/moderation/users/:id/mute - Blanket Mute / Unmute User in Clubhouse
// ---------------------------------------------------------------------------
chatRouter.put('/moderation/users/:id/mute', requireModerator, async (c) => {
  const actor = c.get('user');
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
  if (targetIsAdmin) {
    return c.json({ error: 'Administrators cannot be blanket-muted.' }, 403);
  }
  if (targetIsMod && !actor.isAdmin) {
    return c.json({ error: 'Only an Administrator can mute a delegated Moderator.' }, 403);
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
          chat_muted: shouldMute ? 1 : 0,
          chat_muted_reason: shouldMute ? reason : null
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

// ---------------------------------------------------------------------------
// Personal User Mutes (/api/mutes) — Chat-only; zero impact on baseball games
// ---------------------------------------------------------------------------
chatRouter.get('/mutes', requireAuth, async (c) => {
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

chatRouter.post('/mutes', requireAuth, async (c) => {
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

chatRouter.delete('/mutes/:userId', requireAuth, async (c) => {
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
