const test = require('node:test');
const assert = require('node:assert/strict');
const sender = import('../../src/app/push-sender.js');

const b64u = (u) => Buffer.from(u).toString('base64url');
const enc = new TextEncoder();
async function hk(ikm, salt, info, len) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, len * 8));
}

test('encryptPayload produces an RFC 8291 aes128gcm body the subscriber can decrypt', async () => {
  const { encryptPayload } = await sender;
  const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const uaPub = new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const body = await encryptPayload(b64u(uaPub), b64u(auth), 'hello ??');
  const salt = body.slice(0, 16);
  const idlen = body[20];
  const asPub = body.slice(21, 21 + idlen);
  const ct = body.slice(21 + idlen);
  const peer = await crypto.subtle.importKey('raw', asPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, ua.privateKey, 256));
  const prk = await hk(shared, auth, Buffer.concat([enc.encode('WebPush: info\0'), uaPub, asPub]), 32);
  const cek = await hk(prk, salt, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hk(prk, salt, enc.encode('Content-Encoding: nonce\0'), 12);
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const pt = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, aes, ct));
  assert.equal(new TextDecoder().decode(pt.slice(0, -1)), 'hello ??');
  assert.equal(pt[pt.length - 1], 2);
});

test('isQuietNow honors wrap-around windows and timezones', async () => {
  const { isQuietNow } = await sender;
  const now = new Date('2026-01-01T23:30:00Z');
  const base = { quiet_enabled: 1, quiet_start: '22:00', quiet_end: '07:00' };
  assert.equal(isQuietNow({ ...base, quiet_tz: 'UTC' }, now), true);
  assert.equal(isQuietNow({ ...base, quiet_enabled: 0, quiet_tz: 'UTC' }, now), false);
  assert.equal(isQuietNow({ ...base, quiet_tz: 'Asia/Tokyo' }, now), false);
});

function createMockPreparedDb(handler) {
  return {
    prepare(sql) {
      let args = [];
      return {
        bind(...params) {
          args = params;
          return this;
        },
        async all() {
          return { results: handler(sql, args, 'all') || [] };
        },
        async first() {
          const rows = handler(sql, args, 'first') || [];
          return Array.isArray(rows) ? (rows[0] || null) : rows;
        },
        async run() {
          handler(sql, args, 'run');
          return { success: true };
        }
      };
    }
  };
}

test('dispatchMessagePush delivers @mention in public channels without channel_members row, while enforcing opt-out/mute/restricted rules', async () => {
  const { dispatchMessagePush } = await sender;

  const vapidKp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const vapidPubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', vapidKp.publicKey));
  const vapidPrivJwk = await crypto.subtle.exportKey('jwk', vapidKp.privateKey);
  const subKp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const subPubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', subKp.publicKey));
  const subAuth = crypto.getRandomValues(new Uint8Array(16));

  const users = [
    { id: 1, name: 'Alice', role: 'organizer', is_admin: 0, is_moderator: 0 },
    { id: 2, name: 'Bob', role: 'member', is_admin: 0, is_moderator: 0 },
    { id: 3, name: 'Cara', role: 'member', is_admin: 0, is_moderator: 0 },
    { id: 4, name: 'Dan', role: 'member', is_admin: 0, is_moderator: 0 }
  ];
  const subs = [2, 3, 4].map((uid) => ({
    id: uid,
    user_id: uid,
    endpoint: `https://push.example.test/sub/${uid}`,
    p256dh: b64u(subPubRaw),
    auth: b64u(subAuth),
    notify_mentions: 1,
    notify_everyone: 1,
    quiet_enabled: 0,
    hide_previews: 0
  }));

  const baseballDb = createMockPreparedDb((sql, args) => {
    if (sql.includes('FROM users WHERE id IN')) return users.filter((u) => args.includes(u.id));
    if (sql.includes('FROM push_subscriptions WHERE user_id IN')) return subs.filter((s) => args.includes(s.user_id));
    if (sql.includes('FROM push_subscriptions WHERE notify_everyone = 1')) return subs.map((s) => ({ user_id: s.user_id }));
    return [];
  });

  const chatDb = createMockPreparedDb((sql, args) => {
    if (sql.includes('FROM channel_members WHERE channel_id = ? AND user_id IN')) {
      // Bob (2) has no channel_members row at all; Cara (3) muted the channel; Dan (4) has no row
      return args.slice(1).includes(3) ? [{ user_id: 3, muted: 1 }] : [];
    }
    if (sql.includes('FROM clubhouse_opted_out')) {
      // Dan (4) opted out of Clubhouse
      return args.includes(4) ? [{ user_id: 4 }] : [];
    }
    if (sql.includes('FROM channel_members WHERE channel_id = ? AND user_id = ?')) {
      // Used by canUserAccessChannel for private/DM channels
      return [];
    }
    return [];
  });

  const env = {
    BASEBALL_DB: baseballDb,
    CHAT_DB: chatDb,
    VAPID_PUBLIC_KEY: b64u(vapidPubRaw),
    VAPID_PRIVATE_KEY: vapidPrivJwk.d,
    VAPID_SUBJECT: 'mailto:test@example.com'
  };

  const pushedUrls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    pushedUrls.push(String(url));
    return new Response('', { status: 201 });
  };

  try {
    const publicChannel = { id: 10, name: 'general', slug: 'general', channel_type: 'text', is_private: 0, min_role_read: 'member' };
    await dispatchMessagePush(env, {
      channel: publicChannel,
      message: { id: 99, content: 'Hey @Bob @Cara @Dan', iv: null },
      author: { id: 1, name: 'Alice', role: 'organizer', isOrganizer: true },
      mentionIds: [2, 3, 4],
      mentionEveryone: false
    });
    assert.deepEqual(pushedUrls, ['https://push.example.test/sub/2']);

    pushedUrls.length = 0;
    const privateChannel = { id: 11, name: 'captains', slug: 'captains', channel_type: 'text', is_private: 1, min_role_read: 'invite' };
    await dispatchMessagePush(env, {
      channel: privateChannel,
      message: { id: 100, content: 'Hey @Bob', iv: 'iv1', key_epoch: 1 },
      author: { id: 1, name: 'Alice', role: 'organizer', isOrganizer: true },
      mentionIds: [2],
      mentionEveryone: false
    });
    assert.deepEqual(pushedUrls, []);
  } finally {
    globalThis.fetch = origFetch;
  }
});
