/**
 * Scoped WebRTC Voice/Video/Screen-Share Room Presence & Signaling Router
 * Enforces 25s participant heartbeats, 60s signal TTL, and strict channel RBAC + recipient isolation.
 */

import { Hono } from 'hono';
import { requireAuth, rejectIfChatMuted, rejectIfClubhouseOptedOut } from '../security.js';
import { resolveChannel, canUserAccessChannel } from './chat.js';

export const voiceRouter = new Hono();
export const rtcRouter = new Hono();

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

  if (!(await canUserAccessChannel(chatDb, user, channel, 'read'))) {
    return c.json({ error: 'Access denied: insufficient permissions to join this voice room.' }, 403);
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

  if (!(await canUserAccessChannel(chatDb, user, channel, 'read'))) {
    return c.json({ error: 'Access denied.' }, 403);
  }

  const body = await c.req.json().catch(() => ({}));
  const existing = await chatDb.prepare(
    'SELECT * FROM voice_participants WHERE channel_id = ? AND user_id = ?'
  ).bind(channel.id, user.id).first();

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

  await chatDb.prepare(`
    INSERT INTO sync_events (channel_id, event_type, target_id, payload_json, created_at)
    VALUES (?, 'voice_update', ?, ?, ?)
  `).bind(
    channel.id,
    user.id,
    JSON.stringify({ action: 'state', channel_id: channel.id, user_id: user.id, user_name: user.name, muted, deafened, screen_sharing: screenSharing }),
    nowSec
  ).run();

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

  const nowSec = Math.floor(Date.now() / 1000);

  await chatDb.prepare(
    'DELETE FROM voice_participants WHERE channel_id = ? AND user_id = ?'
  ).bind(channel.id, user.id).run();

  await chatDb.prepare(`
    INSERT INTO sync_events (channel_id, event_type, target_id, payload_json, created_at)
    VALUES (?, 'voice_update', ?, ?, ?)
  `).bind(
    channel.id,
    user.id,
    JSON.stringify({ action: 'leave', channel_id: channel.id, user_id: user.id }),
    nowSec
  ).run();

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

  if (!ALLOWED_SIGNAL_TYPES.has(signalType.toLowerCase())) {
    return c.json({ error: 'Unsupported WebRTC signal_type.' }, 400);
  }

  if (payloadJson.length > MAX_SIGNAL_PAYLOAD_CHARS) {
    return c.json({ error: 'Signal payload exceeds maximum allowed size (64 KB).' }, 400);
  }

  const channel = await resolveChannel(chatDb, channelParam);
  if (!channel) {
    return c.json({ error: 'Target channel not found.' }, 404);
  }

  // Verify sender has permission to access this room
  if (!(await canUserAccessChannel(chatDb, user, channel, 'read'))) {
    return c.json({ error: 'Access denied: insufficient permissions for this voice/signaling room.' }, 403);
  }

  // Verify recipient user exists in BASEBALL_DB
  if (baseballDb) {
    const recipientUser = await baseballDb.prepare('SELECT id, email FROM users WHERE id = ?').bind(recipientUserId).first();
    if (!recipientUser) {
      return c.json({ error: 'Recipient user not found.' }, 404);
    }
  }

  const nowSec = Math.floor(Date.now() / 1000);

  // Prune expired signals (>60s) only if expired rows exist
  try {
    const staleSig = await chatDb.prepare('SELECT 1 FROM rtc_signals WHERE created_at <= ? LIMIT 1').bind(nowSec - 60).first();
    if (staleSig) {
      await chatDb.prepare('DELETE FROM rtc_signals WHERE created_at <= ?').bind(nowSec - 60).run();
    }
  } catch (e) {}

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
