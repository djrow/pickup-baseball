/**
 * Scoped WebRTC Voice/Video/Screen-Share Room Presence & Signaling Router
 * Enforces 25s participant heartbeats, 60s signal TTL, and strict channel RBAC + recipient isolation.
 */

import { Hono } from 'hono';
import { requireAuth, rejectIfChatMuted, rejectIfClubhouseOptedOut } from '../security.js';
import { resolveChannel, canUserAccessChannel } from './chat.js';

export const voiceRouter = new Hono();
export const rtcRouter = new Hono();
let lastSignalPruneSec = 0;

// ---------------------------------------------------------------------------
// POST /api/voice/:channelId/join - Join Voice Huddle Room
// ---------------------------------------------------------------------------
voiceRouter.post('/:channelId/join', requireAuth, async (c) => {
  const user = c.get('user');
  const optResp = rejectIfClubhouseOptedOut(c, user);
  if (optResp) return optResp;
  const mutedResp = rejectIfChatMuted(c, user);
  if (mutedResp) return mutedResp;
  const chatDb = c.env && c.env.CHAT_DB;
  if (!chatDb) return c.json({ error: 'Chat database unavailable.' }, 500);

  const channel = await resolveChannel(chatDb, c.req.param('channelId'));
  if (!channel) {
    return c.json({ error: 'Voice channel not found.' }, 404);
  }
  if (channel.channel_type !== 'voice' && channel.channel_type !== 'dm' && channel.channel_type !== 'group_dm') {
    return c.json({ error: 'This channel does not support voice or WebRTC calls.' }, 400);
  }

  if (!(await canUserAccessChannel(chatDb, user, channel, 'write'))) {
    return c.json({ error: 'Access denied: insufficient permissions to join this voice room.' }, 403);
  }

  const nowSecJoin = Math.floor(Date.now() / 1000);
  const joinRateKey = `user_${user.id}_voice_join`;
  const joinCutoff = nowSecJoin - 60;
  try {
    await chatDb.prepare(`
      INSERT INTO chat_rate_limits (key, count, window_start)
      VALUES (?, 1, ?)
      ON CONFLICT(key) DO UPDATE SET
        count = CASE WHEN chat_rate_limits.window_start <= ? THEN 1 ELSE chat_rate_limits.count + 1 END,
        window_start = CASE WHEN chat_rate_limits.window_start <= ? THEN ? ELSE chat_rate_limits.window_start END
    `).bind(joinRateKey, nowSecJoin, joinCutoff, joinCutoff, nowSecJoin).run();
    const joinRateRow = await chatDb.prepare('SELECT count FROM chat_rate_limits WHERE key = ?').bind(joinRateKey).first();
    if (joinRateRow && joinRateRow.count > 30) {
      return c.json({ error: 'Too many voice join requests. Please wait a moment.' }, 429);
    }
  } catch (e) {}

  const vpCountRow = await chatDb.prepare(
    'SELECT COUNT(*) as total FROM voice_participants WHERE channel_id = ? AND user_id != ? AND heartbeat_at > ?'
  ).bind(channel.id, user.id, nowSecJoin - 25).first();
  if (vpCountRow && vpCountRow.total >= 24) {
    return c.json({ error: 'This voice room has reached its maximum capacity (24 participants).' }, 429);
  }

  const body = await c.req.json().catch(() => ({}));
  const muted = body.muted ? 1 : 0;
  const deafened = body.deafened ? 1 : 0;
  const screenSharing = body.screen_sharing ? 1 : 0;
  const nowSec = Math.floor(Date.now() / 1000);

  // Prune stale participants (>25s) only if expired rows exist
  try {
    const staleVp = await chatDb.prepare('SELECT 1 FROM voice_participants WHERE heartbeat_at <= ? LIMIT 1').bind(nowSec - 25).first();
    if (staleVp) {
      await chatDb.prepare('DELETE FROM voice_participants WHERE heartbeat_at <= ?').bind(nowSec - 25).run();
    }
  } catch (e) {}

  await chatDb.prepare(`
    INSERT INTO voice_participants (channel_id, user_id, user_name, muted, deafened, screen_sharing, heartbeat_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(channel_id, user_id) DO UPDATE SET
      user_name = excluded.user_name,
      muted = excluded.muted,
      deafened = excluded.deafened,
      screen_sharing = excluded.screen_sharing,
      heartbeat_at = excluded.heartbeat_at
  `).bind(channel.id, user.id, user.name, muted, deafened, screenSharing, nowSec).run();

  await chatDb.prepare(`
    INSERT INTO sync_events (channel_id, event_type, target_id, payload_json, created_at)
    VALUES (?, 'voice_update', ?, ?, ?)
  `).bind(
    channel.id,
    user.id,
    JSON.stringify({ action: 'join', channel_id: channel.id, user_id: user.id, user_name: user.name, muted, deafened, screen_sharing: screenSharing }),
    nowSec
  ).run();

  const { results: participants } = await chatDb.prepare(
    'SELECT * FROM voice_participants WHERE channel_id = ? AND heartbeat_at > ? ORDER BY heartbeat_at DESC'
  ).bind(channel.id, nowSec - 25).all();

  return c.json({
    success: true,
    channel_id: channel.id,
    participants: participants || []
  });
});

// ---------------------------------------------------------------------------
// POST /api/voice/:channelId/state - Update Voice State & Refresh 25s Heartbeat
// ---------------------------------------------------------------------------
voiceRouter.post('/:channelId/state', requireAuth, async (c) => {
  const user = c.get('user');
  const optResp = rejectIfClubhouseOptedOut(c, user);
  if (optResp) return optResp;
  const mutedResp = rejectIfChatMuted(c, user);
  if (mutedResp) return mutedResp;
  const chatDb = c.env && c.env.CHAT_DB;
  if (!chatDb) return c.json({ error: 'Chat database unavailable.' }, 500);

  const channel = await resolveChannel(chatDb, c.req.param('channelId'));
  if (!channel) {
    return c.json({ error: 'Voice channel not found.' }, 404);
  }
  if (channel.channel_type !== 'voice' && channel.channel_type !== 'dm' && channel.channel_type !== 'group_dm') {
    return c.json({ error: 'This channel does not support voice or WebRTC calls.' }, 400);
  }

  if (!(await canUserAccessChannel(chatDb, user, channel, 'write'))) {
    return c.json({ error: 'Access denied.' }, 403);
  }

  const nowSecState = Math.floor(Date.now() / 1000);
  const stateRateKey = `user_${user.id}_voice_state`;
  const stateCutoff = nowSecState - 60;
  try {
    await chatDb.prepare(`
      INSERT INTO chat_rate_limits (key, count, window_start)
      VALUES (?, 1, ?)
      ON CONFLICT(key) DO UPDATE SET
        count = CASE WHEN chat_rate_limits.window_start <= ? THEN 1 ELSE chat_rate_limits.count + 1 END,
        window_start = CASE WHEN chat_rate_limits.window_start <= ? THEN ? ELSE chat_rate_limits.window_start END
    `).bind(stateRateKey, nowSecState, stateCutoff, stateCutoff, nowSecState).run();
    const stateRateRow = await chatDb.prepare('SELECT count FROM chat_rate_limits WHERE key = ?').bind(stateRateKey).first();
    if (stateRateRow && stateRateRow.count > 60) {
      return c.json({ error: 'Too many voice state requests. Please wait a moment.' }, 429);
    }
  } catch (e) {}

  const body = await c.req.json().catch(() => ({}));
  const existing = await chatDb.prepare(
    'SELECT * FROM voice_participants WHERE channel_id = ? AND user_id = ?'
  ).bind(channel.id, user.id).first();

  if (!existing || Number(existing.heartbeat_at || 0) <= nowSecState - 25) {
    const vpCountRow = await chatDb.prepare(
      'SELECT COUNT(*) as total FROM voice_participants WHERE channel_id = ? AND user_id != ? AND heartbeat_at > ?'
    ).bind(channel.id, user.id, nowSecState - 25).first();
    if (vpCountRow && vpCountRow.total >= 24) {
      return c.json({ error: 'This voice room has reached its maximum capacity (24 participants).' }, 429);
    }
  }

  const muted = body.muted !== undefined ? (body.muted ? 1 : 0) : (existing ? existing.muted : 0);
  const deafened = body.deafened !== undefined ? (body.deafened ? 1 : 0) : (existing ? existing.deafened : 0);
  const screenSharing = body.screen_sharing !== undefined ? (body.screen_sharing ? 1 : 0) : (existing ? existing.screen_sharing : 0);
  const nowSec = Math.floor(Date.now() / 1000);

  await chatDb.prepare(`
    INSERT INTO voice_participants (channel_id, user_id, user_name, muted, deafened, screen_sharing, heartbeat_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(channel_id, user_id) DO UPDATE SET
      user_name = excluded.user_name,
      muted = excluded.muted,
      deafened = excluded.deafened,
      screen_sharing = excluded.screen_sharing,
      heartbeat_at = excluded.heartbeat_at
  `).bind(channel.id, user.id, user.name, muted, deafened, screenSharing, nowSec).run();

  // Only emit a sync_events row when voice state actually changed (skip no-op heartbeat refreshes)
  const stateChanged = !existing ||
    Number(existing.muted) !== muted ||
    Number(existing.deafened) !== deafened ||
    Number(existing.screen_sharing) !== screenSharing ||
    String(existing.user_name || '') !== String(user.name || '');

  if (stateChanged) {
    await chatDb.prepare(`
      INSERT INTO sync_events (channel_id, event_type, target_id, payload_json, created_at)
      VALUES (?, 'voice_update', ?, ?, ?)
    `).bind(
      channel.id,
      user.id,
      JSON.stringify({ action: 'state', channel_id: channel.id, user_id: user.id, user_name: user.name, muted, deafened, screen_sharing: screenSharing }),
      nowSec
    ).run();
  }

  return c.json({
    success: true,
    channel_id: channel.id,
    muted,
    deafened,
    screen_sharing: screenSharing,
    heartbeat_at: nowSec
  });
});

// ---------------------------------------------------------------------------
// POST /api/voice/:channelId/leave - Leave Voice Huddle Room
// ---------------------------------------------------------------------------
voiceRouter.post('/:channelId/leave', requireAuth, async (c) => {
  const user = c.get('user');
  const chatDb = c.env && c.env.CHAT_DB;
  if (!chatDb) return c.json({ error: 'Chat database unavailable.' }, 500);

  const channel = await resolveChannel(chatDb, c.req.param('channelId'));
  if (!channel) {
    return c.json({ error: 'Voice channel not found.' }, 404);
  }
  if (!(await canUserAccessChannel(chatDb, user, channel, 'read'))) {
    return c.json({ error: 'Access denied.' }, 403);
  }

  const nowSec = Math.floor(Date.now() / 1000);

  const delRes = await chatDb.prepare(
    'DELETE FROM voice_participants WHERE channel_id = ? AND user_id = ?'
  ).bind(channel.id, user.id).run();

  if (delRes && delRes.meta && delRes.meta.changes > 0) {
    await chatDb.prepare(`
      INSERT INTO sync_events (channel_id, event_type, target_id, payload_json, created_at)
      VALUES (?, 'voice_update', ?, ?, ?)
    `).bind(
      channel.id,
      user.id,
      JSON.stringify({ action: 'leave', channel_id: channel.id, user_id: user.id }),
      nowSec
    ).run();
  }

  return c.json({
    success: true,
    channel_id: channel.id
  });
});

const ALLOWED_SIGNAL_TYPES = new Set(['offer', 'answer', 'ice-candidate', 'candidate', 'renegotiate']);
const MAX_SIGNAL_PAYLOAD_CHARS = 65536;

// ---------------------------------------------------------------------------
// POST /api/rtc/signal - Deposit Scoped WebRTC SDP / ICE Candidate Signal
// ---------------------------------------------------------------------------
rtcRouter.post('/signal', requireAuth, async (c) => {
  const user = c.get('user');
  const optResp = rejectIfClubhouseOptedOut(c, user);
  if (optResp) return optResp;
  const mutedResp = rejectIfChatMuted(c, user);
  if (mutedResp) return mutedResp;
  const chatDb = c.env && c.env.CHAT_DB;
  const baseballDb = c.env && (c.env.BASEBALL_DB || c.env.DB);

  if (!chatDb) return c.json({ error: 'Chat database unavailable.' }, 500);

  const nowSec = Math.floor(Date.now() / 1000);
  const sigRateKey = `user_${user.id}_rtc_sig`;
  const sigCutoff = nowSec - 60;
  try {
    await chatDb.prepare(`
      INSERT INTO chat_rate_limits (key, count, window_start)
      VALUES (?, 1, ?)
      ON CONFLICT(key) DO UPDATE SET
        count = CASE WHEN chat_rate_limits.window_start <= ? THEN 1 ELSE chat_rate_limits.count + 1 END,
        window_start = CASE WHEN chat_rate_limits.window_start <= ? THEN ? ELSE chat_rate_limits.window_start END
    `).bind(sigRateKey, nowSec, sigCutoff, sigCutoff, nowSec).run();
    const sigRateRow = await chatDb.prepare('SELECT count FROM chat_rate_limits WHERE key = ?').bind(sigRateKey).first();
    if (sigRateRow && sigRateRow.count > 120) {
      return c.json({ error: 'Too many signaling requests. Please wait a moment.' }, 429);
    }
  } catch (e) {}

  const body = await c.req.json().catch(() => ({}));
  const channelParam = body.channel_id;
  const recipientUserId = parseInt(body.recipient_user_id !== undefined ? body.recipient_user_id : body.to_user_id, 10);
  const signalType = String(body.signal_type || body.type || '').trim();
  const payloadJson = typeof body.payload_json === 'string'
    ? body.payload_json
    : (body.payload_json ? JSON.stringify(body.payload_json) : '');

  if (!channelParam || !recipientUserId || isNaN(recipientUserId) || !signalType || !payloadJson) {
    return c.json({ error: 'channel_id, recipient_user_id, signal_type, and payload_json are required.' }, 400);
  }

  const channel = await resolveChannel(chatDb, channelParam);
  if (!channel) {
    return c.json({ error: 'Target channel not found.' }, 404);
  }

  // Verify sender has permission to access this room before disclosing channel type or validating payload details
  if (!(await canUserAccessChannel(chatDb, user, channel, 'write'))) {
    return c.json({ error: 'Access denied: insufficient permissions for this voice/signaling room.' }, 403);
  }

  if (recipientUserId === user.id) {
    return c.json({ error: 'Cannot send WebRTC signals to yourself.' }, 400);
  }

  const sigLower = signalType.toLowerCase();
  if (!ALLOWED_SIGNAL_TYPES.has(sigLower)) {
    return c.json({ error: 'Unsupported WebRTC signal_type.' }, 400);
  }

  if (payloadJson.length > MAX_SIGNAL_PAYLOAD_CHARS) {
    return c.json({ error: 'Signal payload exceeds maximum allowed size (64 KB).' }, 400);
  }

  let parsedPayload = null;
  try {
    parsedPayload = JSON.parse(payloadJson);
  } catch (e) {
    return c.json({ error: 'Invalid signal payload JSON.' }, 400);
  }
  if (!parsedPayload || typeof parsedPayload !== 'object') {
    return c.json({ error: 'Signal payload must be a JSON object.' }, 400);
  }
  if (sigLower === 'offer' || sigLower === 'answer' || sigLower === 'renegotiate') {
    if (typeof parsedPayload.type !== 'string' || typeof parsedPayload.sdp !== 'string' || !parsedPayload.sdp) {
      return c.json({ error: 'Invalid SDP payload structure.' }, 400);
    }
  } else if (sigLower === 'ice-candidate' || sigLower === 'candidate') {
    if (!parsedPayload.candidate) {
      return c.json({ error: 'Invalid ICE candidate payload structure.' }, 400);
    }
  }

  if (channel.channel_type !== 'voice' && channel.channel_type !== 'dm' && channel.channel_type !== 'group_dm') {
    return c.json({ error: 'This channel does not support WebRTC signaling.' }, 400);
  }

  // Verify recipient user exists in BASEBALL_DB and can access this channel
  if (baseballDb) {
    const recipientUser = await baseballDb.prepare(`
      SELECT u.id, u.email, u.role, u.is_admin, u.is_moderator, COALESCE(u.clubhouse_opted_in, 0) as clubhouse_opted_in,
             EXISTS(SELECT 1 FROM banned_emails b WHERE LOWER(b.email) = LOWER(u.email)) as is_banned,
             CASE WHEN COALESCE(u.role, 'player') = 'facilitator' THEN 1 ELSE EXISTS(
               SELECT 1 FROM duty_assignments da
               JOIN event_duties ed ON ed.id = da.duty_id
               JOIN events e ON e.id = ed.event_id
               JOIN attendees a ON a.id = da.attendee_id
               WHERE (e.status IS NULL OR e.status NOT IN ('cancelled', 'rainout'))
                 AND datetime(e.event_date) >= datetime('now', '-1 day')
                 AND (ed.title = 'Game Facilitator' OR ed.title LIKE '%Facilitator%')
                 AND (a.user_id = u.id OR LOWER(a.email) = LOWER(u.email))
                 AND a.status = 'attending'
             ) END as facilitator_flag
      FROM users u WHERE u.id = ?
    `).bind(recipientUserId).first();
    if (!recipientUser) {
      return c.json({ error: 'Recipient user not found.' }, 404);
    }
    if (recipientUser.is_banned || Number(recipientUser.clubhouse_opted_in) === 0) {
      return c.json({ error: 'Recipient cannot receive Clubhouse signals.' }, 403);
    }
    const rRole = (recipientUser.role || (recipientUser.is_admin === 1 ? 'admin' : 'player')).toLowerCase();
    const recipientNorm = {
      id: recipientUser.id,
      email: recipientUser.email,
      role: rRole,
      isAdmin: rRole === 'admin' || Boolean(recipientUser.is_admin),
      is_admin: recipientUser.is_admin ? 1 : 0,
      isModerator: Boolean(recipientUser.is_moderator) || rRole === 'admin' || Boolean(recipientUser.is_admin),
      isGameFacilitator: Boolean(recipientUser.facilitator_flag),
      canManageEvents: rRole === 'organizer' || rRole === 'admin' || Boolean(recipientUser.is_admin)
    };
    if (!(await canUserAccessChannel(chatDb, recipientNorm, channel, 'read'))) {
      return c.json({ error: 'Recipient does not have permission to access this channel.' }, 403);
    }
  }

  // Require sender to have an active voice participant presence in this room (prevents stealth wiretapping)
  const senderActiveVp = await chatDb.prepare(
    'SELECT 1 FROM voice_participants WHERE channel_id = ? AND user_id = ? AND heartbeat_at > ? LIMIT 1'
  ).bind(channel.id, user.id, nowSec - 25).first();
  if (!senderActiveVp) {
    return c.json({ error: 'Access denied: you must join this voice room before sending WebRTC signals.' }, 403);
  }

  // Check if recipient personally muted sender
  try {
    const muteRow = await chatDb.prepare(
      'SELECT 1 FROM user_mutes WHERE muter_user_id = ? AND muted_user_id = ? LIMIT 1'
    ).bind(recipientUserId, user.id).first();
    if (muteRow) {
      return c.json({ error: 'Recipient is not accepting signals from you.' }, 403);
    }
  } catch (e) {}

  // Prune expired signals (>60s) at most once every 60 seconds per isolate
  if (nowSec - lastSignalPruneSec >= 60) {
    lastSignalPruneSec = nowSec;
    try {
      const staleSig = await chatDb.prepare('SELECT 1 FROM rtc_signals WHERE created_at <= ? LIMIT 1').bind(nowSec - 60).first();
      if (staleSig) {
        await chatDb.prepare('DELETE FROM rtc_signals WHERE created_at <= ?').bind(nowSec - 60).run();
      }
    } catch (e) {}
  }

  const insRes = await chatDb.prepare(`
    INSERT INTO rtc_signals (channel_id, sender_user_id, recipient_user_id, signal_type, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(
    channel.id,
    user.id,
    recipientUserId,
    signalType,
    payloadJson,
    nowSec
  ).run();

  return c.json({
    success: true,
    signal_id: insRes.meta.last_row_id,
    channel_id: channel.id,
    recipient_user_id: recipientUserId
  });
});
