/**
 * Clubhouse Bootstrap & High-Efficiency Delta Sync Routes
 * - GET /bootstrap — initial UI hydration (channels, voice, unread counts, directory, upcoming game)
 * - GET /sync — fast-path watermarked delta polling for messages, sync_events, voice & WebRTC signals
 */

import { Hono } from 'hono';
import { requireAuth } from '../../security.js';
import {
  abbreviateMemberNames,
  resolveChannel,
  getAccessibleChannels,
  hydrateMessages
} from './helpers.js';

export const chatSyncRouter = new Hono();

let lastSyncPruneSec = 0;

chatSyncRouter.get('/bootstrap', requireAuth, async (c) => {
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
    'SELECT * FROM voice_participants WHERE heartbeat_at > ? AND user_id NOT IN (SELECT user_id FROM clubhouse_opted_out) ORDER BY heartbeat_at DESC'
  ).bind(nowSec - 25).all();
  const voice_participants = (rawVoice || []).filter((vp) => accessibleIds.has(vp.channel_id));

  // Unread counts per accessible channel
  const unread_counts = {};
  if (channels.length > 0) {
    try {
      const ph = channels.map(() => '?').join(',');
      const { results: unreadRows } = await chatDb.prepare(`
        SELECT m.channel_id, COUNT(*) as c
        FROM messages m
        LEFT JOIN channel_members cm ON cm.channel_id = m.channel_id AND cm.user_id = ?
        WHERE m.channel_id IN (${ph})
          AND m.deleted_at IS NULL
          AND m.author_id NOT IN (SELECT user_id FROM clubhouse_opted_out)
          AND m.id > COALESCE(cm.last_read_message_id, 0)
        GROUP BY m.channel_id
      `).bind(user.id, ...channels.map((ch) => ch.id)).all();
      const countMap = new Map((unreadRows || []).map((r) => [r.channel_id, r.c || 0]));

      for (const ch of channels) {
        const cnt = countMap.get(ch.id) || 0;
        unread_counts[ch.id] = cnt;
        unread_counts[ch.slug] = cnt;
      }
    } catch (e) {}
  }

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
        WHERE COALESCE(clubhouse_opted_in, 0) = 1
          AND NOT EXISTS (SELECT 1 FROM banned_emails b WHERE LOWER(b.email) = LOWER(users.email))
        ORDER BY CASE WHEN role = 'admin' OR is_admin = 1 THEN 1 WHEN is_moderator = 1 THEN 2 WHEN role = 'organizer' THEN 3 ELSE 4 END, name ASC
        LIMIT 200
      `).all();

      const memberIds = (usersList || []).map((u) => u.id);
      let cryptoRows = [];
      if (memberIds.length > 0) {
        const ph = memberIds.map(() => '?').join(',');
        const cryptoRes = await chatDb.prepare(
          `SELECT user_id, status_text, (ecdh_public_key_jwk IS NOT NULL) as has_key FROM user_crypto_keys WHERE user_id IN (${ph})`
        ).bind(...memberIds).all();
        cryptoRows = cryptoRes.results || [];
      }
      const cryptoMap = new Map(cryptoRows.map((r) => [r.user_id, r]));

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

chatSyncRouter.get('/sync', requireAuth, async (c) => {
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

    const { results: rawMsgs } = await chatDb.prepare(
      `SELECT * FROM messages
       WHERE id > ? AND channel_id IN (${placeholders}) AND deleted_at IS NULL
         AND author_id NOT IN (SELECT user_id FROM clubhouse_opted_out)
       ORDER BY id ASC
       LIMIT 200`
    ).bind(sinceMsgId, ...targetChannelIds).all();

    messages = await hydrateMessages(chatDb, rawMsgs || []);

    const { results: rawEvents } = await chatDb.prepare(
      `SELECT * FROM sync_events
       WHERE id > ? AND (channel_id = 0 OR channel_id IN (${placeholders}))
       ORDER BY id ASC
       LIMIT 200`
    ).bind(sinceEventId, ...targetChannelIds).all();

    events = rawEvents || [];
  }

  // Throttle background TTL pruning writes to at most once every 60s and only when expired rows exist
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

  const { results: rawVoice } = await chatDb.prepare(
    'SELECT * FROM voice_participants WHERE heartbeat_at > ? AND user_id NOT IN (SELECT user_id FROM clubhouse_opted_out) ORDER BY heartbeat_at DESC'
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
