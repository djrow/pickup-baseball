/**
 * Shared Clubhouse Chat Helpers
 * Channel resolution, privacy/membership access control, member name abbreviation,
 * and message hydration (reactions + attachments).
 */

import { canAccessChannel } from '../../security.js';

/**
 * Abbreviate last names in a member directory ("First L.", or "First La."
 * when multiple distinct users share the same first name and last initial).
 * @param {Array<{user_id?: number, id?: number, name?: string}>} records
 * @returns {string[]}
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
 * Resolve a channel by numeric ID or slug (including voice/war-room aliases).
 * @param {object} chatDb
 * @param {string|number} channelParam
 * @returns {Promise<object|null>}
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
 * @param {object|null} channel
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
 * @param {object|null} channel
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
 * @param {object} chatDb
 * @param {object} user
 * @param {object} channel
 * @param {'read'|'write'} [mode='read']
 * @returns {Promise<boolean>}
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

/**
 * Get all channels accessible to the user (batched DM & private board membership lookup to avoid N+1 D1 queries).
 * @param {object} chatDb
 * @param {object} user
 * @param {{includeHidden?: boolean}} [options]
 * @returns {Promise<Array<object>>}
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
  } catch (e) {}

  const accessible = [];
  const keySharedChannelIds = [];
  for (const ch of (allChannels || [])) {
    const isDmType = ch.channel_type === 'dm' || ch.channel_type === 'group_dm';
    if (isDmType || isPrivateEncryptedBoard(ch)) {
      if (isDmType && !options.includeHidden && hiddenChannelIds.has(ch.id)) {
        continue;
      }
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
 * Format message row with parsed badges, reactions, and attachments (strips moderated originals).
 * @param {object} msg
 * @param {Map<number, Array>} [reactionsByMsg]
 * @param {Map<number, Array>} [attachmentsByMsg]
 * @returns {object}
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
 * Hydrate reactions and attachments for a batch of messages in 2 bulk queries.
 * @param {object} chatDb
 * @param {Array<object>} messages
 * @returns {Promise<Array<object>>}
 */
export async function hydrateMessages(chatDb, messages) {
  if (!messages || messages.length === 0) return [];
  const msgIds = messages.map((m) => m.id);
  const placeholders = msgIds.map(() => '?').join(',');

  const reactionsByMsg = new Map();
  const attachmentsByMsg = new Map();

  try {
    const { results: reactions } = await chatDb.prepare(
      `SELECT * FROM message_reactions WHERE message_id IN (${placeholders}) AND user_id NOT IN (SELECT user_id FROM clubhouse_opted_out) ORDER BY id ASC`
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
