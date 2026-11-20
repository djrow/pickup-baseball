/**
 * @fileoverview Opt-in Web Push delivery (RFC 8030 / 8291 aes128gcm / RFC 8292 VAPID)
 * using only WebCrypto so it runs identically on Workers and Node.
 * Every category is opt-in per subscription; see routes/push.js for the preference columns.
 * Encrypted (E2EE) messages never contribute plaintext to a notification.
 *
 * Env: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY (base64url), VAPID_SUBJECT (mailto:/https:).
 *
 * @module app/push-sender
 */

import { logEvent } from './errors.js';
import { canUserAccessChannel, isPrivateEncryptedBoard, chunkArray } from './routes/chat/helpers.js';

const enc = new TextEncoder();
const MAX_RECIPIENTS = 500;
const PREVIEW_CHARS = 100;

/** @param {string} s */
function b64uToBytes(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** @param {Uint8Array} bytes */
function bytesToB64u(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** @param {...Uint8Array} parts */
function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/** @param {Uint8Array} ikm @param {Uint8Array} salt @param {Uint8Array} info @param {number} len */
async function hkdf(ikm, salt, info, len) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, len * 8);
  return new Uint8Array(bits);
}

/**
 * Encrypt a payload for a push subscription (aes128gcm, single record).
 * @param {string} p256dhB64u @param {string} authB64u @param {string} text
 */
export async function encryptPayload(p256dhB64u, authB64u, text) {
  const uaPublic = b64uToBytes(p256dhB64u);
  const authSecret = b64uToBytes(authB64u);
  const eph = /** @type {CryptoKeyPair} */ (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']));
  const asPublic = new Uint8Array(/** @type {ArrayBuffer} */ (await crypto.subtle.exportKey('raw', eph.publicKey)));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits(/** @type {any} */ ({ name: 'ECDH', public: uaKey }), eph.privateKey, 256));
  const prk = await hkdf(shared, authSecret, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(prk, salt, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(prk, salt, enc.encode('Content-Encoding: nonce\0'), 12);
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const cipher = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce }, aes, concat(enc.encode(text), new Uint8Array([2]))
  ));
  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096, false);
  header[20] = asPublic.length;
  return concat(header, asPublic, cipher);
}

/** @param {Record<string, any>} env @param {string} endpoint */
async function vapidAuthHeader(env, endpoint) {
  const pub = String(env.VAPID_PUBLIC_KEY || '').trim();
  const priv = String(env.VAPID_PRIVATE_KEY || '').trim();
  const pubBytes = b64uToBytes(pub);
  const jwk = {
    kty: 'EC', crv: 'P-256', d: priv,
    x: bytesToB64u(pubBytes.slice(1, 33)), y: bytesToB64u(pubBytes.slice(33, 65))
  };
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const head = bytesToB64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = bytesToB64u(enc.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: String(env.VAPID_SUBJECT || 'mailto:admin@example.com')
  })));
  const sig = new Uint8Array(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(head + '.' + claims)
  ));
  return 'vapid t=' + head + '.' + claims + '.' + bytesToB64u(sig) + ', k=' + pub;
}

/**
 * Send one push; returns HTTP status (0 on network failure).
 * @param {Record<string, any>} env @param {{endpoint: string, p256dh: string, auth: string}} sub
 * @param {Record<string, any>} payload
 */
export async function sendPush(env, sub, payload) {
  const body = await encryptPayload(sub.p256dh, sub.auth, JSON.stringify(payload));
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidAuthHeader(env, sub.endpoint),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '3600',
      Urgency: 'normal'
    },
    body
  });
  return res.status;
}

/** True when the subscription's quiet hours are active at `now`. @param {Record<string, any>} sub @param {Date} now */
export function isQuietNow(sub, now) {
  if (!sub.quiet_enabled) return false;
  let hhmm;
  try {
    hhmm = new Intl.DateTimeFormat('en-GB', {
      timeZone: sub.quiet_tz || 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).format(now);
  } catch (e) {
    return false;
  }
  const start = sub.quiet_start || '22:00';
  const end = sub.quiet_end || '07:00';
  if (start === end) return false;
  return start < end ? (hhmm >= start && hhmm < end) : (hhmm >= start || hhmm < end);
}

/**
 * @typedef {{flag: string, payload: Record<string, any>, hidden: Record<string, any>}} PushOption
 */

/**
 * Deliver to users, honoring each subscription's opt-ins, quiet hours and preview privacy.
 * @param {Record<string, any>} env
 * @param {Map<number, PushOption[]>} targets userId -> options in priority order
 */
export async function deliver(env, targets) {
  const db = env && (env.BASEBALL_DB || env.DB);
  if (!db || !env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || targets.size === 0) return;
  const ids = Array.from(targets.keys()).slice(0, MAX_RECIPIENTS);
  const now = new Date();
  /** @type {Array<{sub: any, payload: Record<string, any>}>} */
  const jobs = [];
  for (const chunk of chunkArray(ids, 50)) {
    const placeholders = chunk.map(() => '?').join(',');
    const { results } = await db.prepare(
      `SELECT * FROM push_subscriptions WHERE user_id IN (${placeholders})`
    ).bind(...chunk).all();
    for (const sub of (results || [])) {
      const opts = targets.get(sub.user_id) || [];
      const opt = opts.find((o) => Boolean(sub[o.flag]));
      if (!opt || isQuietNow(sub, now)) continue;
      jobs.push({ sub, payload: sub.hide_previews ? opt.hidden : opt.payload });
    }
  }
  for (const batch of chunkArray(jobs, 10)) {
    await Promise.all(batch.map(async (j) => {
      try {
        const status = await sendPush(env, j.sub, j.payload);
        if (status === 404 || status === 410) {
          await db.prepare('DELETE FROM push_subscriptions WHERE id = ?').bind(j.sub.id).run();
        }
      } catch (e) {
        logEvent('warn', 'push_send_failed', { err: e });
      }
    }));
  }
}

/** Run a push task without delaying the response. @param {any} c @param {() => Promise<any>} task */
export function schedulePush(c, task) {
  const p = Promise.resolve().then(task).catch((e) => logEvent('warn', 'push_dispatch_failed', { err: e }));
  try {
    if (c.executionCtx && c.executionCtx.waitUntil) c.executionCtx.waitUntil(p);
  } catch (e) { /* Node: no execution context */ }
}

/** @param {string} s */
function preview(s) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > PREVIEW_CHARS ? t.slice(0, PREVIEW_CHARS - 1) + '…' : t;
}

/**
 * Users who may be notified about activity in a channel: still opted in to Clubhouse, have access,
 * haven't muted the channel, and haven't muted/blocked the actor. Optionally require an E2EE key share.
 * @param {Record<string, any>} env @param {Record<string, any>} channel
 * @param {number[]} candidateIds @param {number} actorId
 * @param {{requireMember: boolean, keyEpoch?: number|null}} opts
 * @returns {Promise<Set<number>>}
 */
async function eligibleUsers(env, channel, candidateIds, actorId, opts) {
  const db = env.BASEBALL_DB || env.DB;
  const chatDb = env.CHAT_DB;
  const out = new Set();
  const ids = Array.from(new Set(candidateIds)).filter((n) => Number.isInteger(n) && n !== actorId).slice(0, MAX_RECIPIENTS);
  for (const chunk of chunkArray(ids, 50)) {
    const placeholders = chunk.map(() => '?').join(',');
    const { results: users } = await db.prepare(
      `SELECT id, role, is_admin, is_moderator FROM users WHERE id IN (${placeholders})`
    ).bind(...chunk).all();
    const { results: members } = await chatDb.prepare(
      `SELECT user_id, COALESCE(muted, 0) AS muted FROM channel_members WHERE channel_id = ? AND user_id IN (${placeholders})`
    ).bind(channel.id, ...chunk).all();
    const { results: optedOut } = await chatDb.prepare(
      `SELECT user_id FROM clubhouse_opted_out WHERE user_id IN (${placeholders})`
    ).bind(...chunk).all();
    const { results: mutedActor } = await chatDb.prepare(
      `SELECT muter_user_id AS uid FROM user_mutes WHERE muted_user_id = ? AND muter_user_id IN (${placeholders})
       UNION SELECT blocker_id AS uid FROM user_blocks WHERE blocked_id = ? AND blocker_id IN (${placeholders})`
    ).bind(actorId, ...chunk, actorId, ...chunk).all();
    let keyed = null;
    if (opts.keyEpoch) {
      const { results: shares } = await chatDb.prepare(
        `SELECT DISTINCT recipient_user_id AS uid FROM channel_key_shares
         WHERE channel_id = ? AND key_epoch = ? AND recipient_user_id IN (${placeholders})`
      ).bind(channel.id, opts.keyEpoch, ...chunk).all();
      keyed = new Set((shares || []).map((r) => r.uid));
    }
    const memberMap = new Map((members || []).map((m) => [m.user_id, m]));
    const blocked = new Set([...(optedOut || []).map((r) => r.user_id), ...(mutedActor || []).map((r) => r.uid)]);
    for (const u of (users || [])) {
      const m = memberMap.get(u.id);
      if (blocked.has(u.id)) continue;
      if (opts.requireMember && (!m || m.muted)) continue;
      if (m && m.muted) continue;
      if (keyed && !keyed.has(u.id)) continue;
      const appUser = { id: u.id, role: u.role, isAdmin: u.is_admin === 1, is_admin: u.is_admin };
      if (await canUserAccessChannel(chatDb, appUser, channel, 'read')) out.add(u.id);
    }
  }
  return out;
}

/**
 * Notify about a newly posted chat message (DMs, replies/threads, @mentions, @everyone).
 * @param {Record<string, any>} env
 * @param {{channel: Record<string, any>, message: Record<string, any>, author: Record<string, any>,
 *   mentionIds?: number[], mentionEveryone?: boolean}} ev
 */
export async function dispatchMessagePush(env, ev) {
  const chatDb = env && env.CHAT_DB;
  if (!chatDb || !env.VAPID_PUBLIC_KEY) return;
  const { channel, message, author } = ev;
  const encrypted = Boolean(message.iv) || channel.channel_type === 'dm' || channel.channel_type === 'group_dm' || isPrivateEncryptedBoard(channel);
  const keyEpoch = message.iv ? Number(message.key_epoch) || 1 : null;
  const isDm = channel.channel_type === 'dm' || channel.channel_type === 'group_dm';
  const chanLabel = isDm ? 'a direct message' : '#' + channel.name;
  const url = '/clubhouse.html';
  const tag = 'chat-' + channel.id;

  /** @type {Map<string, Set<number>>} */
  const reasons = new Map([['mention', new Set()], ['everyone', new Set()], ['dm', new Set()], ['reply', new Set()]]);

  if (isDm) {
    const { results } = await chatDb.prepare('SELECT user_id FROM channel_members WHERE channel_id = ?').bind(channel.id).all();
    (results || []).forEach((r) => reasons.get('dm').add(r.user_id));
  }
  if (message.parent_message_id) {
    const { results } = await chatDb.prepare(
      'SELECT DISTINCT author_id FROM messages WHERE (id = ? OR parent_message_id = ?) AND deleted_at IS NULL'
    ).bind(message.parent_message_id, message.parent_message_id).all();
    (results || []).forEach((r) => reasons.get('reply').add(r.author_id));
  }
  const mentionIds = (ev.mentionIds || []).filter((n) => Number.isInteger(n)).slice(0, 20);
  mentionIds.forEach((id) => reasons.get('mention').add(id));
  const canEveryone = Boolean(author.isAdmin || author.isModerator || author.canModerateChat || author.role === 'organizer' || author.isOrganizer);
  if (ev.mentionEveryone && canEveryone && !isDm) {
    const { results } = await chatDb.prepare(
      'SELECT user_id FROM channel_members WHERE channel_id = ? AND COALESCE(muted, 0) = 0 LIMIT ?'
    ).bind(channel.id, MAX_RECIPIENTS).all();
    (results || []).forEach((r) => reasons.get('everyone').add(r.user_id));
  }

  const all = new Set();
  reasons.forEach((s) => s.forEach((id) => all.add(id)));
  if (all.size === 0) return;
  const ok = await eligibleUsers(env, channel, Array.from(all), author.id, { requireMember: true, keyEpoch });
  if (ok.size === 0) return;

  const body = encrypted ? 'Open Clubhouse to read it.' : preview(message.content);
  const mk = (/** @type {string} */ kind, /** @type {string} */ flag, /** @type {string} */ title, /** @type {string} */ hiddenBody) => ({
    flag,
    payload: { title, body, url, tag },
    hidden: { title: 'Pickup Baseball', body: hiddenBody, url, tag }
  });
  /** @type {Map<number, PushOption[]>} */
  const targets = new Map();
  ok.forEach((id) => {
    const opts = [];
    if (reasons.get('mention').has(id)) opts.push(mk('mention', 'notify_mentions', author.name + ' mentioned you in ' + chanLabel, 'You were mentioned in Clubhouse.'));
    if (reasons.get('dm').has(id)) opts.push(mk('dm', 'notify_dms', author.name + ' (direct message)', 'New direct message.'));
    if (reasons.get('reply').has(id)) opts.push(mk('reply', 'notify_replies', author.name + ' replied in ' + chanLabel, 'New reply in Clubhouse.'));
    if (reasons.get('everyone').has(id)) opts.push(mk('everyone', 'notify_everyone', author.name + ' alerted everyone in ' + chanLabel, 'Channel-wide alert in Clubhouse.'));
    if (opts.length) targets.set(id, opts);
  });
  await deliver(env, targets);
}

/**
 * Notify a message author that someone reacted.
 * @param {Record<string, any>} env
 * @param {{channel: Record<string, any>, message: Record<string, any>, actor: Record<string, any>, emoji: string}} ev
 */
export async function dispatchReactionPush(env, ev) {
  if (!env || !env.CHAT_DB || !env.VAPID_PUBLIC_KEY) return;
  const { channel, message, actor, emoji } = ev;
  if (message.author_id === actor.id) return;
  const keyEpoch = message.iv ? Number(message.key_epoch) || 1 : null;
  const ok = await eligibleUsers(env, channel, [message.author_id], actor.id, { requireMember: false, keyEpoch });
  if (!ok.has(message.author_id)) return;
  const label = channel.channel_type === 'dm' || channel.channel_type === 'group_dm' ? 'a direct message' : '#' + channel.name;
  const url = '/clubhouse.html';
  const tag = 'chat-rx-' + message.id;
  await deliver(env, new Map([[message.author_id, [{
    flag: 'notify_reactions',
    payload: { title: actor.name + ' reacted ' + emoji, body: 'To your message in ' + label, url, tag },
    hidden: { title: 'Pickup Baseball', body: 'Someone reacted to your message.', url, tag }
  }]]]));
}

/**
 * Moderation notices: new report -> moderators/admins; hidden message -> its author.
 * @param {Record<string, any>} env
 * @param {{kind: 'report'|'hidden', actorId: number, targetUserId?: number|null}} ev
 */
export async function dispatchModerationPush(env, ev) {
  const db = env && (env.BASEBALL_DB || env.DB);
  if (!db || !env.VAPID_PUBLIC_KEY) return;
  const url = ev.kind === 'report' ? '/admin.html' : '/clubhouse.html';
  const tag = 'mod-' + ev.kind;
  const copy = ev.kind === 'report'
    ? { title: 'New Clubhouse report', body: 'A report needs moderator review.' }
    : { title: 'Message hidden', body: 'A moderator hid one of your Clubhouse messages.' };
  const opt = {
    flag: 'notify_moderation',
    payload: Object.assign({ url, tag }, copy),
    hidden: { title: 'Pickup Baseball', body: 'You have a moderation notice.', url, tag }
  };
  /** @type {number[]} */
  let ids = [];
  if (ev.kind === 'report') {
    const { results } = await db.prepare(
      'SELECT id FROM users WHERE (is_admin = 1 OR is_moderator = 1) AND id != ? LIMIT ?'
    ).bind(ev.actorId, MAX_RECIPIENTS).all();
    ids = (results || []).map((r) => r.id);
  } else if (ev.targetUserId && ev.targetUserId !== ev.actorId) {
    ids = [ev.targetUserId];
  }
  await deliver(env, new Map(ids.map((id) => [id, [opt]])));
}
