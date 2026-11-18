/**
 * E2EE Key Rotation Audit Trail, Rate Limiting & TOFU Hard-Block Tests (Wave 1b.4 / Ticket #42)
 * Covers:
 * 1. Initial key enrollment sets key_version = 1 and key_rotated_at = null
 * 2. Vault-only / metadata updates (unchanged public JWKs) preserve key_version and key_rotated_at without audit spam
 * 3. Public key rotation increments key_version, stamps key_rotated_at, and emits non-spoofable server `key_rotated`
 *    sync_events + timeline system notices to active DM and Private Board channels (and NOT unrelated channels)
 * 4. Rate limiting on repeated key rotations (max 5 per hour -> 429) while allowing vault-only updates
 * 5. Self-service key recovery without requiring old private key signature + spoofing prevention on POST / PATCH /api/messages
 * 6. Client TOFU hard-block (E2EE_KEY_CHANGED) + `key_rotated` delta sync handling in ClubhouseStore / ClubhouseCrypto
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const { createD1Adapter } = require('../../src/d1-sqlite');
const { app: honoApp } = require('../../src/app/index.js');
const {
  generateIdentityKeyPair,
  encryptVault,
  generateChannelKey,
  deriveEcdhSharedKey,
  wrapChannelKey
} = require('../helpers/crypto-test-utils');

const ROOT_DIR = path.join(__dirname, '..', '..');

function createIsolatedEnv(envOverrides = {}) {
  const baseballSqlite = new Database(':memory:');
  baseballSqlite.pragma('foreign_keys = ON');
  const chatSqlite = new Database(':memory:');
  chatSqlite.pragma('foreign_keys = ON');

  const baseballD1 = createD1Adapter(baseballSqlite);
  const chatD1 = createD1Adapter(chatSqlite);

  const env = {
    NODE_ENV: 'test',
    DB: baseballD1,
    BASEBALL_DB: baseballD1,
    CHAT_DB: chatD1,
    ...envOverrides
  };

  async function apiFetch(pathname, { method = 'GET', cookie = null, body = null } = {}) {
    const headers = new Headers();
    const url = `https://community.example.org${pathname}`;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) {
      headers.set('Origin', 'https://community.example.org');
    }
    if (cookie) {
      headers.set('Cookie', cookie);
    }
    let reqBody;
    if (body !== null && body !== undefined) {
      headers.set('Content-Type', 'application/json');
      reqBody = JSON.stringify(body);
    }
    const res = await honoApp.fetch(new Request(url, { method, headers, body: reqBody }), env);
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // non-JSON
    }
    return { status: res.status, headers: res.headers, json, text };
  }

  function seedUser({ name, email, role = 'member', isAdmin = 0, isModerator = 0 }) {
    const res = baseballSqlite.prepare(`
      INSERT INTO users (name, email, role, is_admin, is_moderator, clubhouse_opted_in)
      VALUES (?, ?, ?, ?, ?, 1)
    `).run(name, email, role, isAdmin, isModerator);
    const userId = Number(res.lastInsertRowid);
    const rawSid = crypto.randomBytes(24).toString('hex');
    const hashedSid = `sha256:${crypto.createHash('sha256').update(rawSid).digest('hex')}`;
    const expiresAt = new Date(Date.now() + 86400 * 1000).toISOString();
    baseballSqlite.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(hashedSid, userId, expiresAt);
    return { userId, name, email, cookie: `baseball_session=${rawSid}` };
  }

  function close() {
    baseballSqlite.close();
    chatSqlite.close();
  }

  return { baseballSqlite, chatSqlite, baseballD1, chatD1, env, apiFetch, seedUser, close };
}

function registerKeyRotationAuditTests() {
  test('Wave 1b.4 (Ticket #42): E2EE Key Rotation Audit Trail, Rate Limiting & TOFU Hard-Block', async (t) => {
    await t.test('1. Initial enrollment sets key_version = 1 and key_rotated_at = null across all identity & bootstrap endpoints', async () => {
      const ctx = createIsolatedEnv();
      try {
        await ctx.apiFetch('/api/events');
        const alice = ctx.seedUser({ name: 'Alice Pitcher', email: 'alice@example.org' });
        const bob = ctx.seedUser({ name: 'Bob Catcher', email: 'bob@example.org' });

        await ctx.apiFetch('/api/bootstrap', { cookie: alice.cookie });
        const keys1 = await generateIdentityKeyPair();
        const vault1 = await encryptVault('alice-pass-1', { ecdhPriv: keys1.ecdhPrivateJwk });

        const putRes = await ctx.apiFetch('/api/keys/identity', {
          method: 'PUT',
          cookie: alice.cookie,
          body: {
            ecdh_public_key_jwk: keys1.ecdhPublicJwk,
            ecdsa_public_key_jwk: keys1.ecdsaPublicJwk,
            encrypted_private_vault: vault1.encryptedVaultB64,
            vault_salt: vault1.saltB64,
            vault_iv: vault1.ivB64
          }
        });
        assert.equal(putRes.status, 200);
        assert.equal(putRes.json.key_version, 1);
        assert.equal(putRes.json.keyVersion, 1);
        assert.equal(putRes.json.key_rotated_at, null);
        assert.equal(putRes.json.keyRotatedAt, null);
        assert.equal(putRes.json.rotated, false);

        const selfRes = await ctx.apiFetch('/api/keys/identity', { cookie: alice.cookie });
        assert.equal(selfRes.status, 200);
        assert.equal(selfRes.json.key_version, 1);
        assert.equal(selfRes.json.key_rotated_at, null);
        assert.ok(selfRes.json.encrypted_private_vault, 'Self identity lookup must include private vault');

        const peerRes = await ctx.apiFetch(`/api/keys/identity/${alice.userId}`, { cookie: bob.cookie });
        assert.equal(peerRes.status, 200);
        assert.equal(peerRes.json.key_version, 1);
        assert.equal(peerRes.json.key_rotated_at, null);
        assert.equal(peerRes.json.encrypted_private_vault, undefined, 'Peer identity lookup must omit private vault');

        const usersRes = await ctx.apiFetch(`/api/keys/users?ids=${alice.userId}`, { cookie: bob.cookie });
        assert.equal(usersRes.status, 200);
        assert.equal(usersRes.json.users.length, 1);
        assert.equal(usersRes.json.users[0].key_version, 1);
        assert.equal(usersRes.json.users[0].key_rotated_at, null);

        const bootRes = await ctx.apiFetch('/api/bootstrap', { cookie: bob.cookie });
        assert.equal(bootRes.status, 200);
        const aliceMember = bootRes.json.members.find((m) => Number(m.id) === alice.userId);
        assert.ok(aliceMember);
        assert.equal(aliceMember.hasKeys, true);
        assert.equal(aliceMember.key_version, 1);
        assert.equal(aliceMember.key_rotated_at, null);
      } finally {
        ctx.close();
      }
    });

    await t.test('2. Vault-only update (same public JWKs, new passphrase/relay/status) keeps key_version = 1 and emits no rotation audit notices', async () => {
      const ctx = createIsolatedEnv();
      try {
        await ctx.apiFetch('/api/events');
        const alice = ctx.seedUser({ name: 'Alice Pitcher', email: 'alice2@example.org' });
        const bob = ctx.seedUser({ name: 'Bob Catcher', email: 'bob2@example.org' });
        await ctx.apiFetch('/api/bootstrap', { cookie: alice.cookie });

        const dmRes = await ctx.apiFetch('/api/channels', {
          method: 'POST',
          cookie: alice.cookie,
          body: { channel_type: 'dm', dm_user_id: bob.userId, is_encrypted: true }
        });
        assert.equal(dmRes.status, 201);
        const dmId = dmRes.json.channel.id;

        const keys1 = await generateIdentityKeyPair();
        const vault1 = await encryptVault('passphrase-one', { ecdhPriv: keys1.ecdhPrivateJwk });
        const enrollRes = await ctx.apiFetch('/api/keys/identity', {
          method: 'PUT',
          cookie: alice.cookie,
          body: {
            ecdh_public_key_jwk: keys1.ecdhPublicJwk,
            ecdsa_public_key_jwk: keys1.ecdsaPublicJwk,
            encrypted_private_vault: vault1.encryptedVaultB64,
            vault_salt: vault1.saltB64,
            vault_iv: vault1.ivB64
          }
        });
        assert.equal(enrollRes.status, 200);

        // Update vault with a new passphrase + privacy_relay_mode + status_text, keeping identical public JWKs
        const vault2 = await encryptVault('passphrase-two', { ecdhPriv: keys1.ecdhPrivateJwk });
        const updateRes = await ctx.apiFetch('/api/keys/identity', {
          method: 'PUT',
          cookie: alice.cookie,
          body: {
            ecdh_public_key_jwk: keys1.ecdhPublicJwk,
            ecdsa_public_key_jwk: keys1.ecdsaPublicJwk,
            encrypted_private_vault: vault2.encryptedVaultB64,
            vault_salt: vault2.saltB64,
            vault_iv: vault2.ivB64,
            privacy_relay_mode: 1,
            status_text: 'Ready for Sunday BP'
          }
        });
        assert.equal(updateRes.status, 200);
        assert.equal(updateRes.json.key_version, 1);
        assert.equal(updateRes.json.key_rotated_at, null);
        assert.equal(updateRes.json.rotated, false);

        const auditEvents = ctx.chatSqlite.prepare("SELECT * FROM sync_events WHERE event_type = 'key_rotated'").all();
        assert.equal(auditEvents.length, 0, 'Vault-only update must not emit key_rotated sync_events');

        const dmMsgs = ctx.chatSqlite.prepare('SELECT * FROM messages WHERE channel_id = ?').all(dmId);
        assert.equal(dmMsgs.length, 0, 'Vault-only update must not insert system audit messages into DM');
      } finally {
        ctx.close();
      }
    });

    await t.test('3. Key rotation increments key_version, sets key_rotated_at, and emits audit notices only to active DM and Private Board channels', async () => {
      const ctx = createIsolatedEnv();
      try {
        await ctx.apiFetch('/api/events');
        const admin = ctx.seedUser({ name: 'Admin Coach', email: 'admin3@example.org', role: 'admin', isAdmin: 1 });
        const alice = ctx.seedUser({ name: 'Alice Pitcher', email: 'alice3@example.org' });
        const bob = ctx.seedUser({ name: 'Bob Catcher', email: 'bob3@example.org' });
        const carol = ctx.seedUser({ name: 'Carol Shortstop', email: 'carol3@example.org' });

        await ctx.apiFetch('/api/bootstrap', { cookie: admin.cookie });

        // 1. Create active DM between Alice and Bob
        const aliceBobDm = await ctx.apiFetch('/api/channels', {
          method: 'POST',
          cookie: alice.cookie,
          body: { channel_type: 'dm', dm_user_id: bob.userId, is_encrypted: true }
        });
        assert.equal(aliceBobDm.status, 201);
        const aliceBobDmId = aliceBobDm.json.channel.id;

        // 2. Create unrelated DM between Bob and Carol (Alice is NOT a member)
        const bobCarolDm = await ctx.apiFetch('/api/channels', {
          method: 'POST',
          cookie: bob.cookie,
          body: { channel_type: 'dm', dm_user_id: carol.userId, is_encrypted: true }
        });
        assert.equal(bobCarolDm.status, 201);
        const bobCarolDmId = bobCarolDm.json.channel.id;

        // 3. Create Private Board with Admin, Alice, and Carol
        const privBoard = await ctx.apiFetch('/api/channels', {
          method: 'POST',
          cookie: admin.cookie,
          body: {
            name: 'captains-private-board',
            category: 'Private Boards',
            channel_type: 'text',
            is_private: true,
            member_ids: [alice.userId, carol.userId]
          }
        });
        assert.equal(privBoard.status, 201);
        const privBoardId = privBoard.json.channel.id;

        // 4. Create unrelated Private Board with Admin and Carol only
        const otherPrivBoard = await ctx.apiFetch('/api/channels', {
          method: 'POST',
          cookie: admin.cookie,
          body: {
            name: 'other-private-board',
            category: 'Private Boards',
            channel_type: 'text',
            is_private: true,
            member_ids: [carol.userId]
          }
        });
        assert.equal(otherPrivBoard.status, 201);
        const otherPrivBoardId = otherPrivBoard.json.channel.id;

        // 5. Alice enrolls initial keys (v1)
        const keysV1 = await generateIdentityKeyPair();
        const enrollRes = await ctx.apiFetch('/api/keys/identity', {
          method: 'PUT',
          cookie: alice.cookie,
          body: {
            ecdh_public_key_jwk: keysV1.ecdhPublicJwk,
            ecdsa_public_key_jwk: keysV1.ecdsaPublicJwk
          }
        });
        assert.equal(enrollRes.status, 200);
        assert.equal(enrollRes.json.key_version, 1);

        // 6. Alice rotates to new keys (v2) — no old key signature required (self-service recovery)
        const keysV2 = await generateIdentityKeyPair();
        const rotateRes = await ctx.apiFetch('/api/keys/identity', {
          method: 'PUT',
          cookie: alice.cookie,
          body: {
            ecdh_public_key_jwk: keysV2.ecdhPublicJwk,
            ecdsa_public_key_jwk: keysV2.ecdsaPublicJwk
          }
        });
        assert.equal(rotateRes.status, 200);
        assert.equal(rotateRes.json.key_version, 2);
        assert.equal(rotateRes.json.keyVersion, 2);
        assert.ok(rotateRes.json.key_rotated_at, 'key_rotated_at must be stamped on rotation');
        assert.equal(rotateRes.json.rotated, true);

        // 7. Verify sync_events emitted ONLY for aliceBobDmId and privBoardId
        const syncRows = ctx.chatSqlite.prepare("SELECT * FROM sync_events WHERE event_type = 'key_rotated' ORDER BY channel_id ASC").all();
        const syncChannelIds = syncRows.map((r) => Number(r.channel_id)).sort((a, b) => a - b);
        const expectedChannels = [Number(aliceBobDmId), Number(privBoardId)].sort((a, b) => a - b);
        assert.deepEqual(syncChannelIds, expectedChannels, 'key_rotated sync_events must target only Alice active DM and Private Board');

        for (const row of syncRows) {
          assert.equal(Number(row.target_id), alice.userId);
          const payload = JSON.parse(row.payload_json);
          assert.equal(payload.user_id, alice.userId);
          assert.equal(payload.user_name, alice.name);
          assert.equal(payload.key_version, 2);
          assert.equal(payload.key_rotated_at, rotateRes.json.key_rotated_at);
        }

        // 8. Verify timeline system messages inserted in aliceBobDmId and privBoardId, and NOT in general, bobCarolDmId, or otherPrivBoardId
        const dmMsgsRes = await ctx.apiFetch(`/api/channels/${aliceBobDmId}/messages`, { cookie: bob.cookie });
        assert.equal(dmMsgsRes.status, 200);
        assert.equal(dmMsgsRes.json.messages.length, 1);
        const dmNotice = dmMsgsRes.json.messages[0];
        assert.equal(dmNotice.message_type, 'system');
        assert.equal(dmNotice.is_system, true);
        assert.equal(dmNotice.iv, null);
        assert.ok(dmNotice.content.includes('rotated their E2EE identity key (v2)'));
        assert.equal(dmNotice.metadata.audit_type, 'key_rotated');
        assert.equal(dmNotice.metadata.key_version, 2);

        const privMsgsRes = await ctx.apiFetch(`/api/channels/${privBoardId}/messages`, { cookie: carol.cookie });
        assert.equal(privMsgsRes.status, 200);
        assert.equal(privMsgsRes.json.messages.length, 1);
        assert.equal(privMsgsRes.json.messages[0].message_type, 'system');
        assert.equal(privMsgsRes.json.messages[0].is_system, true);

        const unrelatedDmMsgs = ctx.chatSqlite.prepare('SELECT * FROM messages WHERE channel_id = ?').all(bobCarolDmId);
        assert.equal(unrelatedDmMsgs.length, 0, 'Unrelated DM must not receive Alice key_rotated notice');

        const unrelatedPrivMsgs = ctx.chatSqlite.prepare('SELECT * FROM messages WHERE channel_id = ?').all(otherPrivBoardId);
        assert.equal(unrelatedPrivMsgs.length, 0, 'Unrelated Private Board must not receive Alice key_rotated notice');

        const generalCh = ctx.chatSqlite.prepare("SELECT id FROM channels WHERE slug = 'general'").get();
        const generalMsgs = ctx.chatSqlite.prepare('SELECT * FROM messages WHERE channel_id = ?').all(generalCh.id);
        assert.equal(generalMsgs.length, 0, 'Public #general board must not receive E2EE key_rotated notice');

        // 9. Verify GET /api/sync delivers both the system message and the key_rotated event to Bob
        const bobSync = await ctx.apiFetch('/api/sync?since_msg_id=0&since_event_id=0', { cookie: bob.cookie });
        assert.equal(bobSync.status, 200);
        assert.ok(bobSync.json.events.some((e) => e.event_type === 'key_rotated' && Number(e.channel_id) === Number(aliceBobDmId)));
        assert.ok(bobSync.json.messages.some((m) => m.message_type === 'system' && Number(m.channel_id) === Number(aliceBobDmId)));
      } finally {
        ctx.close();
      }
    });

    await t.test('4. Rate-limiting on key rotations allows max 5 rotations per hour and returns 429 on the 6th', async () => {
      const ctx = createIsolatedEnv();
      try {
        await ctx.apiFetch('/api/events');
        const alice = ctx.seedUser({ name: 'Alice Rotator', email: 'alice4@example.org' });
        await ctx.apiFetch('/api/bootstrap', { cookie: alice.cookie });

        // Initial enrollment (v1) — does not consume rotation quota
        const initialKeys = await generateIdentityKeyPair();
        const initRes = await ctx.apiFetch('/api/keys/identity', {
          method: 'PUT',
          cookie: alice.cookie,
          body: {
            ecdh_public_key_jwk: initialKeys.ecdhPublicJwk,
            ecdsa_public_key_jwk: initialKeys.ecdsaPublicJwk
          }
        });
        assert.equal(initRes.status, 200);
        assert.equal(initRes.json.key_version, 1);

        // Perform 5 valid rotations -> versions 2..6
        let lastKeys = initialKeys;
        for (let i = 1; i <= 5; i++) {
          lastKeys = await generateIdentityKeyPair();
          const rotRes = await ctx.apiFetch('/api/keys/identity', {
            method: 'PUT',
            cookie: alice.cookie,
            body: {
              ecdh_public_key_jwk: lastKeys.ecdhPublicJwk,
              ecdsa_public_key_jwk: lastKeys.ecdsaPublicJwk
            }
          });
          assert.equal(rotRes.status, 200, `Rotation #${i} must succeed`);
          assert.equal(rotRes.json.key_version, i + 1);
        }

        // 6th rotation within the hour -> 429 Too Many Requests
        const sixthKeys = await generateIdentityKeyPair();
        const blockedRes = await ctx.apiFetch('/api/keys/identity', {
          method: 'PUT',
          cookie: alice.cookie,
          body: {
            ecdh_public_key_jwk: sixthKeys.ecdhPublicJwk,
            ecdsa_public_key_jwk: sixthKeys.ecdsaPublicJwk
          }
        });
        assert.equal(blockedRes.status, 429);
        assert.ok(blockedRes.headers.get('Retry-After'));

        // Verify stored key_version remained 6
        const checkId = await ctx.apiFetch('/api/keys/identity', { cookie: alice.cookie });
        assert.equal(checkId.json.key_version, 6);
      } finally {
        ctx.close();
      }
    });

    await t.test('5. Non-spoofable audit notices: POST / PATCH /api/messages reject client attempts to spoof system or key_rotated messages', async () => {
      const ctx = createIsolatedEnv();
      try {
        await ctx.apiFetch('/api/events');
        const admin = ctx.seedUser({ name: 'Admin User', email: 'admin5@example.org', role: 'admin', isAdmin: 1 });
        const alice = ctx.seedUser({ name: 'Alice Pitcher', email: 'alice5@example.org' });
        const bob = ctx.seedUser({ name: 'Bob Catcher', email: 'bob5@example.org' });
        await ctx.apiFetch('/api/bootstrap', { cookie: admin.cookie });

        const dmRes = await ctx.apiFetch('/api/channels', {
          method: 'POST',
          cookie: alice.cookie,
          body: { channel_type: 'dm', dm_user_id: bob.userId, is_encrypted: true }
        });
        const dmId = dmRes.json.channel.id;

        // 1. Client attempting to post message_type: 'system' (even as Admin) -> 403
        const spoofType = await ctx.apiFetch('/api/channels/general/messages', {
          method: 'POST',
          cookie: admin.cookie,
          body: {
            content: 'Fake system notice',
            message_type: 'system'
          }
        });
        assert.equal(spoofType.status, 403);

        // 2. Client attempting to pass is_system: 1 -> 400
        const spoofFlag = await ctx.apiFetch('/api/channels/general/messages', {
          method: 'POST',
          cookie: alice.cookie,
          body: {
            content: 'Fake system flag',
            is_system: 1
          }
        });
        assert.equal(spoofFlag.status, 400);

        // 3. Client attempting to pass metadata_json with audit_type: 'key_rotated' or is_system: 1 -> 400
        const spoofMeta = await ctx.apiFetch(`/api/channels/${dmId}/messages`, {
          method: 'POST',
          cookie: alice.cookie,
          body: {
            content: 'dGVzdA==',
            encryption_iv: 'dGVzdGl2MTIzNDU2',
            metadata_json: { audit_type: 'key_rotated', is_system: 1 }
          }
        });
        assert.equal(spoofMeta.status, 400);

        // 4. Genuine server-generated key_rotated system message cannot be edited via PATCH /api/messages/:id
        const k1 = await generateIdentityKeyPair();
        await ctx.apiFetch('/api/keys/identity', {
          method: 'PUT',
          cookie: alice.cookie,
          body: { ecdh_public_key_jwk: k1.ecdhPublicJwk, ecdsa_public_key_jwk: k1.ecdsaPublicJwk }
        });
        const k2 = await generateIdentityKeyPair();
        await ctx.apiFetch('/api/keys/identity', {
          method: 'PUT',
          cookie: alice.cookie,
          body: { ecdh_public_key_jwk: k2.ecdhPublicJwk, ecdsa_public_key_jwk: k2.ecdsaPublicJwk }
        });

        const sysMsg = ctx.chatSqlite.prepare("SELECT id FROM messages WHERE channel_id = ? AND message_type = 'system'").get(dmId);
        assert.ok(sysMsg, 'Server system notice must exist');

        const editSysAttempt = await ctx.apiFetch(`/api/messages/${sysMsg.id}`, {
          method: 'PATCH',
          cookie: alice.cookie,
          body: { content: 'Tampered audit notice', encryption_iv: 'dGVzdGl2MTIzNDU2' }
        });
        assert.equal(editSysAttempt.status, 403, 'System audit notices must not be editable');
      } finally {
        ctx.close();
      }
    });

    await t.test('6. Client TOFU hard-block (E2EE_KEY_CHANGED) blocks DM encryption/decryption until peer re-verifies & handles key_rotated delta sync', async () => {
      const cryptoJs = fs.readFileSync(path.join(ROOT_DIR, 'public', 'js', 'crypto.js'), 'utf8');
      const storeJs = ['store.js', 'store/idb.js', 'store/e2ee.js', 'store/sync.js', 'store/actions.js']
        .map((f) => fs.readFileSync(path.join(ROOT_DIR, 'public', 'js', f), 'utf8'))
        .join('\n');
      const clubhouseJs = ['clubhouse/layout.js', 'clubhouse/messages.js', 'clubhouse/e2ee-ui.js', 'clubhouse/panels.js', 'clubhouse.js']
        .map((f) => fs.readFileSync(path.join(ROOT_DIR, 'public', 'js', f), 'utf8'))
        .join('\n');

      for (const [name, src] of [
        ['crypto.js', cryptoJs],
        ['store.js', storeJs],
        ['clubhouse.js', clubhouseJs]
      ]) {
        assert.equal(/[\w$\])]\?\./.test(src), false, `${name} must not use optional chaining (?.)`);
        assert.equal(src.includes('??'), false, `${name} must not use nullish coalescing (??)`);
      }

      const prevFetch = globalThis.fetch;
      const prevIndexedDB = globalThis.indexedDB;
      const prevLocalStorage = globalThis.localStorage;
      try {
        delete require.cache[require.resolve('../../public/js/crypto.js')];
        delete require.cache[require.resolve('../../public/js/store.js')];
        globalThis.indexedDB = null;

        const ClubhouseCrypto = require('../../public/js/crypto.js');
        globalThis.ClubhouseCrypto = ClubhouseCrypto;
        const ClubhouseStore = require('../../public/js/store.js');

        ClubhouseCrypto.setPinOwner(10);
        const aliceKeys = await ClubhouseCrypto.generateIdentityKeyPair();
        const bobKeysV1 = await generateIdentityKeyPair();
        const bobKeysV2 = await generateIdentityKeyPair();

        let currentBobJwk = bobKeysV1.ecdhPublicJwk;
        let currentBobVersion = 1;
        let currentBobRotatedAt = null;

        // Pre-wrap a channel key for channel 77 using Bob's V1 key -> Alice's key
        const rawChannelKey = await generateChannelKey();
        const bobPrivKeyV1 = bobKeysV1.ecdhPair.privateKey;
        const bobPrivKeyV2 = bobKeysV2.ecdhPair.privateKey;
        const alicePubKey = await globalThis.crypto.subtle.importKey(
          'jwk',
          aliceKeys.ecdhPublicJwk,
          { name: 'ECDH', namedCurve: 'P-256' },
          true,
          []
        );
        const sharedKeyV1 = await deriveEcdhSharedKey(bobPrivKeyV1, alicePubKey);
        const sharedKeyV2 = await deriveEcdhSharedKey(bobPrivKeyV2, alicePubKey);
        const wrappedForAliceV1 = await wrapChannelKey(rawChannelKey, sharedKeyV1);
        const wrappedForAliceV2 = await wrapChannelKey(rawChannelKey, sharedKeyV2);
        let currentWrappedForAlice = wrappedForAliceV1;

        let syncEventsQueue = [];
        let syncMessagesQueue = [];

        globalThis.fetch = async (url) => {
          const u = String(url);
          if (u.includes('/api/bootstrap')) {
            return {
              ok: true,
              status: 200,
              headers: new Headers(),
              async text() {
                return JSON.stringify({
                  user: { id: 10, name: 'Alice', clubhouseOptedIn: true },
                  channels: [
                    { id: 77, slug: 'dm-10-20', name: 'DM: Bob', channel_type: 'dm', is_encrypted: 1, member_ids: [10, 20] }
                  ],
                  members: [
                    { id: 10, name: 'Alice', hasKeys: true, key_version: 1, key_rotated_at: null },
                    { id: 20, name: 'Bob', hasKeys: true, key_version: currentBobVersion, key_rotated_at: currentBobRotatedAt }
                  ],
                  last_message_id: 1,
                  last_event_id: 1
                });
              }
            };
          }
          if (u.includes('/api/keys/channel/77')) {
            return {
              ok: true,
              status: 200,
              headers: new Headers(),
              async text() {
                return JSON.stringify({
                  channelId: 77,
                  keyEpoch: 1,
                  recipientUserId: 10,
                  senderUserId: 20,
                  wrappedKeyBase64: currentWrappedForAlice.wrappedKeyBase64,
                  wrapIv: currentWrappedForAlice.wrapIv,
                  sharedUserIds: [10, 20]
                });
              }
            };
          }
          if (u.includes('/api/keys/identity/20')) {
            return {
              ok: true,
              status: 200,
              headers: new Headers(),
              async text() {
                return JSON.stringify({
                  user_id: 20,
                  ecdh_public_key_jwk: JSON.stringify(currentBobJwk),
                  ecdsa_public_key_jwk: JSON.stringify(bobKeysV1.ecdsaPublicJwk),
                  key_version: currentBobVersion,
                  key_rotated_at: currentBobRotatedAt
                });
              }
            };
          }
          if (u.includes('/api/keys/users')) {
            return {
              ok: true,
              status: 200,
              headers: new Headers(),
              async text() {
                return JSON.stringify({
                  users: [
                    {
                      user_id: 10,
                      ecdh_public_key_jwk: JSON.stringify(aliceKeys.ecdhPublicJwk),
                      key_version: 1,
                      key_rotated_at: null
                    },
                    {
                      user_id: 20,
                      ecdh_public_key_jwk: JSON.stringify(currentBobJwk),
                      key_version: currentBobVersion,
                      key_rotated_at: currentBobRotatedAt
                    }
                  ]
                });
              }
            };
          }
          if (u.includes('/api/sync')) {
            const evts = syncEventsQueue.slice();
            const msgs = syncMessagesQueue.slice();
            syncEventsQueue = [];
            syncMessagesQueue = [];
            return {
              ok: true,
              status: 200,
              headers: new Headers(),
              async text() {
                return JSON.stringify({
                  messages: msgs,
                  events: evts,
                  rtc_signals: [],
                  voice_participants: [],
                  latest_msg_id: msgs.length ? msgs[msgs.length - 1].id : 1,
                  latest_event_id: evts.length ? evts[evts.length - 1].id : 1
                });
              }
            };
          }
          return { ok: true, status: 200, headers: new Headers(), async text() { return '{}'; } };
        };

        await ClubhouseStore.bootstrap();
        ClubhouseStore.stopAdaptiveSyncLoop();

        // First E2EE key resolution pins Bob's V1 fingerprint via TOFU
        const key1 = await ClubhouseStore.ensureChannelE2eeKey(77, { readonly: false });
        assert.ok(key1, 'Initial TOFU pin must allow unwrapping DM channel key');

        // Simulate Bob rotating his identity key to V2 and server emitting key_rotated sync_event + audit system message
        currentBobJwk = bobKeysV2.ecdhPublicJwk;
        currentBobVersion = 2;
        currentBobRotatedAt = '2026-11-16T04:00:00.000Z';
        currentWrappedForAlice = wrappedForAliceV2;

        let rotatedEventReceived = null;
        ClubhouseStore.subscribe((evType, detail) => {
          if (evType === 'key_rotated') rotatedEventReceived = detail;
        });

        syncEventsQueue.push({
          id: 2,
          channel_id: 77,
          event_type: 'key_rotated',
          target_id: 20,
          payload_json: JSON.stringify({
            user_id: 20,
            user_name: 'Bob',
            key_version: 2,
            key_rotated_at: currentBobRotatedAt
          })
        });
        syncMessagesQueue.push({
          id: 2,
          channel_id: 77,
          author_id: 20,
          author_name: 'Bob',
          content: '🔐 Bob rotated their E2EE identity key (v2). Verify their safety number before sending new messages.',
          iv: null,
          message_type: 'system',
          is_system: true,
          metadata: { audit_type: 'key_rotated', is_system: 1, key_version: 2 }
        });

        await ClubhouseStore.pollDeltaSync();

        assert.ok(rotatedEventReceived, 'key_rotated event must be emitted by ClubhouseStore on delta sync');
        assert.equal(rotatedEventReceived.userId, 20);
        assert.equal(rotatedEventReceived.keyVersion, 2);
        assert.equal(rotatedEventReceived.keyChangedWarning, true);

        // Verify system audit notice in DM channel 77 was NOT blocked by E2EE missing-IV guard
        const ch77Msgs = ClubhouseStore.state.messagesByChannel[77] || [];
        assert.equal(ch77Msgs.length, 1);
        assert.equal(ch77Msgs[0].is_system, true);
        assert.equal(ch77Msgs[0].is_e2ee_locked, false);
        assert.ok(ch77Msgs[0].decrypted_content.includes('rotated their E2EE identity key (v2)'));

        // Mandatory TOFU hard-block: attempting to get channel key for sending or unwrapping MUST reject with E2EE_KEY_CHANGED
        await assert.rejects(
          () => ClubhouseStore.ensureChannelE2eeKey(77, { readonly: false }),
          (err) => err && err.code === 'E2EE_KEY_CHANGED'
        );

        // Verify getChannelVerificationInfo reports anyKeyChanged: true and peer keyVersion: 2
        const verInfoBefore = await ClubhouseStore.getChannelVerificationInfo(77);
        assert.equal(verInfoBefore.anyKeyChanged, true);
        assert.equal(verInfoBefore.peers[0].keyChangedWarning, true);
        assert.equal(verInfoBefore.peers[0].keyVersion, 2);
        assert.equal(verInfoBefore.peers[0].keyRotatedAt, currentBobRotatedAt);

        // Once Alice explicitly re-verifies Bob's new fingerprint, the TOFU hard-block clears
        const newBobFp = verInfoBefore.peers[0].fingerprint;
        await ClubhouseStore.verifyPeerIdentityKey(20, newBobFp);

        const verInfoAfter = await ClubhouseStore.getChannelVerificationInfo(77);
        assert.equal(verInfoAfter.anyKeyChanged, false);
        assert.equal(verInfoAfter.allVerified, true);

        const keyAfterVerify = await ClubhouseStore.ensureChannelE2eeKey(77, { readonly: false });
        assert.ok(keyAfterVerify, 'After explicit re-verification, ensureChannelE2eeKey must succeed again');
      } finally {
        globalThis.fetch = prevFetch;
        globalThis.indexedDB = prevIndexedDB;
        globalThis.localStorage = prevLocalStorage;
        delete globalThis.ClubhouseCrypto;
        delete globalThis.ClubhouseStore;
        delete require.cache[require.resolve('../../public/js/crypto.js')];
        delete require.cache[require.resolve('../../public/js/store.js')];
      }
    });
  });
}

module.exports = registerKeyRotationAuditTests;

if (require.main === module) {
  registerKeyRotationAuditTests();
}
