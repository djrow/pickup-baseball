/**
 * Shared Clubhouse Chat Helpers
 * Channel resolution, privacy/membership access control, member name abbreviation,
 * and message hydration (reactions + attachments).
 */

import { canAccessChannel } from '../../security.js';
import { abbreviateMemberNames } from '../../policy.js';
import { logEvent } from '../../errors.js';

export { abbreviateMemberNames };

/**
 * Split an array into chunks (keeps Cloudflare D1 `IN (...)` bound parameters well below 100).
 * @template T
 * @param {T[]} items
 * @param {number} [chunkSize=80]
 * @returns {T[][]}
 */
export function chunkArray(items, chunkSize = 80) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return [];
  const chunks = [];
  for (let i = 0; i < list.length; i += chunkSize) {
    chunks.push(list.slice(i, i + chunkSize));
  }
  return chunks;
}

/**
 * Resolve a channel by numeric ID or slug (including voice/war-room aliases).
 * @param {D1Database} chatDb
 * @param {string|number} channelParam
 * @returns {Promise<Record<string, any>|null>}
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
 * @param {Record<string, any>|null|undefined} channel
 * @returns {boolean}
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
 * Returns true only for the single public read-only announcements board visible to logged-out visitors.
 * @param {Record<string, any>|null|undefined} channel
 * @returns {boolean}
 */
export function isPublicGuestChannel(channel) {
  return Boolean(
    channel &&
    channel.channel_type !== 'dm' &&
    channel.channel_type !== 'group_dm' &&
    !isPrivateEncryptedBoard(channel) &&
    (channel.slug === 'announcements' || channel.min_role_read === 'public')
  );
}

/**
 * Check if a user can read or write a channel (including DM & private board membership checks).
 * @param {D1Database} chatDb
 * @param {AppUser|Record<string, any>|null} user
 * @param {Record<string, any>|null} channel
 * @param {'read'|'write'} [mode='read']
 * @returns {Promise<boolean>}
 */
export async function canUserAccessChannel(chatDb, user, channel, mode = 'read') {
  if (!user || !channel) return false;

  if (channel.channel_type === 'dm' || channel.channel_type === 'group_dm' || isPrivateEncryptedBoard(channel)) {
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

/**
 * Get all channels accessible to the user (batched DM & private board membership lookup to avoid N+1 D1 queries).
 * @param {D1Database} chatDb
 * @param {AppUser|Record<string, any>|null} user
 * @param {{includeHidden?: boolean}} [options]
 * @returns {Promise<Array<Record<string, any>>>}
 */
export async function getAccessibleChannels(chatDb, user, options = {}) {
  const { results: allChannels } = await chatDb.prepare(
    'SELECT * FROM channels ORDER BY sort_order ASC, id ASC'
  ).all();

  if (!user) return [];
  const isAdminUser = Boolean(user.isAdmin || user.role === 'admin' || user.is_admin === 1);

  let memberChannelIds = new Set();
  const hiddenChannelIds = new Set();
  try {
    const { results: memberRows } = await chatDb.prepare(
      'SELECT channel_id, COALESCE(hidden, 0) as hidden FROM channel_members WHERE user_id = ?'
    ).bind(user.id).all();
    for (const r of (memberRows || [])) {
      memberChannelIds.add(r.channel_id);
      if (Number(r.hidden) === 1) {
        hiddenChannelIds.add(r.channel_id);
      }
    }
  } catch (e) {
    logEvent('warn', 'chat_channel_membership_lookup_failed', { err: e });
  }

  /** @type {Array<Record<string, any>>} */
  const accessible = [];
  const keySharedChannelIds = [];
  for (const ch of (allChannels || [])) {
    const isDmType = ch.channel_type === 'dm' || ch.channel_type === 'group_dm';
    if (isDmType || isPrivateEncryptedBoard(ch)) {
      if (isDmType && !options.includeHidden && hiddenChannelIds.has(ch.id)) {
        continue;
      }
      if (memberChannelIds.has(ch.id)) {
        accessible.push({ ...ch, member_ids: [] });
        keySharedChannelIds.push(ch.id);
      }
    } else if (isAdminUser || canAccessChannel(user, ch, 'read')) {
      accessible.push(ch);
    }
  }

  if (keySharedChannelIds.length > 0) {
    try {
      const memberMap = new Map();
      for (const idChunk of chunkArray(keySharedChannelIds, 80)) {
        const ph = idChunk.map(() => '?').join(',');
        const { results: memberListRows } = await chatDb.prepare(
          `SELECT channel_id, user_id FROM channel_members WHERE channel_id IN (${ph})`
        ).bind(...idChunk).all();
        for (const row of (memberListRows || [])) {
          if (!memberMap.has(row.channel_id)) memberMap.set(row.channel_id, []);
          memberMap.get(row.channel_id).push(row.user_id);
        }
      }
      for (const ch of accessible) {
        if (ch.channel_type === 'dm' || ch.channel_type === 'group_dm' || isPrivateEncryptedBoard(ch)) {
          const list = memberMap.get(ch.id) ? [...memberMap.get(ch.id)] : [];
          if (ch.created_by && !list.includes(ch.created_by)) list.push(ch.created_by);
          ch.member_ids = list;
        }
      }
    } catch (e) {
      logEvent('warn', 'chat_channel_members_hydrate_failed', { err: e });
    }
  }

  return accessible;
}

/**
 * Format message row with parsed badges, reactions, and attachments (strips moderated originals).
 * @param {Record<string, any>} msg
 * @param {Map<any, Array<any>>} [reactionsByMsg]
 * @param {Map<any, Array<any>>} [attachmentsByMsg]
 * @returns {Record<string, any>}
 */
export function normalizeMessageRow(msg, reactionsByMsg = new Map(), attachmentsByMsg = new Map()) {
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

  const isSystem = Boolean(sanitized.message_type === 'system' || (parsedMetadata && parsedMetadata.is_system));

  if (sanitized.hidden_at) {
    return {
      ...sanitized,
      is_hidden: true,
      is_system: isSystem,
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
    is_system: isSystem,
    encryption_iv: sanitized.iv || null,
    author_badges_obj: parsedBadges,
    metadata: parsedMetadata,
    reactions: reactionsByMsg.get(sanitized.id) || [],
    attachments: attachmentsByMsg.get(sanitized.id) || []
  };
}

/**
 * Hydrate reactions and attachments for a batch of messages in 2 bulk queries.
 * @param {D1Database} chatDb
 * @param {Array<Record<string, any>>} messages
 * @returns {Promise<Array<Record<string, any>>>}
 */
export async function hydrateMessages(chatDb, messages) {
  if (!messages || messages.length === 0) return [];
  const msgIds = messages.map((m) => m.id);
  const idChunks = chunkArray(msgIds, 80);

  const reactionsByMsg = new Map();
  const attachmentsByMsg = new Map();

  try {
    for (const chunk of idChunks) {
      const placeholders = chunk.map(() => '?').join(',');
      const { results: reactions } = await chatDb.prepare(
        `SELECT * FROM message_reactions WHERE message_id IN (${placeholders}) AND user_id NOT IN (SELECT user_id FROM clubhouse_opted_out) ORDER BY id ASC`
      ).bind(...chunk).all();
      for (const r of (reactions || [])) {
        if (!reactionsByMsg.has(r.message_id)) reactionsByMsg.set(r.message_id, []);
        reactionsByMsg.get(r.message_id).push(r);
      }
    }
  } catch (e) {
    logEvent('warn', 'chat_reactions_hydrate_failed', { err: e });
  }

  try {
    for (const chunk of idChunks) {
      const placeholders = chunk.map(() => '?').join(',');
      const { results: attachments } = await chatDb.prepare(
        `SELECT id, channel_id, message_id, uploader_id, file_name, mime_type, file_size, storage_provider, upload_status, is_encrypted, iv, thumbnail_base64, promoted_media_id, created_at
         FROM chat_attachments WHERE message_id IN (${placeholders}) ORDER BY created_at ASC`
      ).bind(...chunk).all();
      for (const a of (attachments || [])) {
        if (!attachmentsByMsg.has(a.message_id)) attachmentsByMsg.set(a.message_id, []);
        attachmentsByMsg.get(a.message_id).push({
          ...a,
          stream_url: `/api/attachments/${a.id}/stream`
        });
      }
    }
  } catch (e) {
    logEvent('warn', 'chat_attachments_hydrate_failed', { err: e });
  }

  return messages.map((m) => normalizeMessageRow(m, reactionsByMsg, attachmentsByMsg));
}

/**
 * List user IDs personally blocked by `userId`.
 * @param {D1Database} chatDb
 * @param {number} userId
 * @returns {Promise<number[]>}
 */
export async function getBlockedUserIds(chatDb, userId) {
  if (!chatDb || !userId) return [];
  try {
    const { results } = await chatDb.prepare(
      'SELECT blocked_id FROM user_blocks WHERE blocker_id = ? ORDER BY created_at DESC'
    ).bind(userId).all();
    return (results || []).map((r) => Number(r.blocked_id)).filter((n) => Number.isFinite(n) && n > 0);
  } catch (e) {
    logEvent('warn', 'chat_blocked_users_load_failed', { userId, err: e });
    return [];
  }
}

/**
 * Return true if either member has blocked the other in `user_blocks`.
 * @param {D1Database} chatDb
 * @param {number} userAId
 * @param {number} userBId
 * @returns {Promise<boolean>}
 */
export async function isPeerBlocked(chatDb, userAId, userBId) {
  const a = Number(userAId);
  const b = Number(userBId);
  if (!chatDb || !a || !b || a === b) return false;
  const row = await chatDb.prepare(
    'SELECT 1 FROM user_blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?) LIMIT 1'
  ).bind(a, b, b, a).first();
  return Boolean(row);
}

/**
 * Resolve the peer user IDs of a 1:1 DM channel for `actorUserId`.
 * @param {D1Database} chatDb
 * @param {Record<string, any>|null} channel
 * @param {number} actorUserId
 * @returns {Promise<number[]>}
 */
export async function getDmPeerIds(chatDb, channel, actorUserId) {
  if (!chatDb || !channel || channel.channel_type !== 'dm') return [];
  const actor = Number(actorUserId);
  const peerSet = new Set();

  const { results: memberRows } = await chatDb.prepare(
    'SELECT user_id FROM channel_members WHERE channel_id = ?'
  ).bind(channel.id).all();
  for (const row of (memberRows || [])) {
    const uid = Number(row.user_id);
    if (uid > 0 && uid !== actor) {
      peerSet.add(uid);
    }
  }

  // Fallback to canonical `dm-<a>-<b>` slug if channel_members is incomplete
  if (peerSet.size === 0 && typeof channel.slug === 'string') {
    const m = /^dm-(\d+)-(\d+)$/.exec(channel.slug);
    if (m) {
      const id1 = Number(m[1]);
      const id2 = Number(m[2]);
      if (id1 > 0 && id1 !== actor) peerSet.add(id1);
      if (id2 > 0 && id2 !== actor) peerSet.add(id2);
    }
  }

  return Array.from(peerSet);
}

/**
 * Return true if `userId` has a bidirectional block with any user in `peerIds`.
 * @param {D1Database} chatDb
 * @param {number} userId
 * @param {number[]} peerIds
 * @returns {Promise<boolean>}
 */
export async function isAnyPeerBlocked(chatDb, userId, peerIds) {
  const actor = Number(userId);
  const targets = Array.from(new Set((peerIds || []).map(Number).filter((n) => Number.isFinite(n) && n > 0 && n !== actor)));
  if (!chatDb || !actor || targets.length === 0) return false;

  for (const idChunk of chunkArray(targets, 40)) {
    const placeholders = idChunk.map(() => '?').join(',');
    const row = await chatDb.prepare(
      `SELECT 1 FROM user_blocks
       WHERE (blocker_id = ? AND blocked_id IN (${placeholders}))
          OR (blocked_id = ? AND blocker_id IN (${placeholders}))
       LIMIT 1`
    ).bind(actor, ...idChunk, actor, ...idChunk).first();
    if (row) return true;
  }
  return false;
}

/**
 * Return a 403 PEER_BLOCKED response if `channel` is a 1:1 DM with a blocked peer.
 * @param {AppContext} c
 * @param {D1Database} chatDb
 * @param {Record<string, any>|null} channel
 * @param {number} userId
 * @param {string} [errorMessage]
 * @returns {Promise<Response|null>}
 */
export async function rejectIfDmPeerBlocked(
  c,
  chatDb,
  channel,
  userId,
  errorMessage = 'Direct messages are blocked between you and this member.'
) {
  if (!channel || channel.channel_type !== 'dm') return null;
  const peerIds = await getDmPeerIds(chatDb, channel, userId);
  if (await isAnyPeerBlocked(chatDb, userId, peerIds)) {
    return c.json({ error: errorMessage, code: 'PEER_BLOCKED' }, 403);
  }
  return null;
}
