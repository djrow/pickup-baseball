/**
 * tests/clubhouse/tier1-feature-coverage.test.js
 * Tier 1: Feature Coverage (Isolation Happy-Paths)
 *
 * Covers Section 8 Checks 1–8 with >=5 genuine tests per check:
 * - Check 1: Dual-D1 Schema & Seed Verification (6 tests)
 * - Check 2: SSO & RBAC Verification (6 tests)
 * - Check 3: Security Headers & CSRF Verification (5 tests)
 * - Check 4: Delta Sync Efficiency Verification (6 tests)
 * - Check 5: E2EE Key Vault & Channel Key Wrapping (5 tests)
 * - Check 6: PBF Shared Drive Resumable Flow & Streaming (6 tests)
 * - Check 7: Scoped WebRTC Signaling Verification (5 tests)
 * - Check 8: Live Baseball Bridge Verification (6 tests)
 * Total: 45 feature tests
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createClubhouseTestContext } = require('../helpers/test-harness');
const {
  generateIdentityKeyPair,
  generateChannelKey,
  encryptPayload,
  decryptPayload,
  deriveEcdhSharedKey,
  wrapChannelKey,
  unwrapChannelKey,
  encryptVault,
  decryptVault
} = require('../helpers/crypto-test-utils');
const { stripJpegMetadata } = require('../../src/app/security');

async function runTier1(t, ctx) {
  const {
    baseUrl,
    baseballDb,
    chatDb,
    baseballD1,
    chatD1,
    adminCookie,
    orgCookie,
    playerCookie,
    facilitatorCookie,
    bannedCookie,
    adminUser,
    playerUser,
    facilitatorUser,
    testEventId,
    apiReq,
    isEndpointAvailable
  } = ctx;

  // =========================================================================
  // CHECK 1: Dual-D1 Schema & Seed Verification
  // =========================================================================
  await t.test('Tier 1 Check 1: Dual-D1 Schema & Seed Verification', async (c1) => {
    await c1.test('T1.1.1: CHAT_DB Core Schema Creation (9 tables)', async () => {
      const rows = chatDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
      const tableNames = rows.map((r) => r.name);

      const requiredTables = [
        'channels',
        'channel_members',
        'messages',
        'message_reactions',
        'chat_attachments',
        'user_crypto_keys',
        'channel_key_shares',
        'voice_participants',
        'rtc_signals'
      ];

      for (const table of requiredTables) {
        assert.ok(tableNames.includes(table), `Table ${table} must exist in CHAT_DB`);
      }
    });

    await c1.test('T1.1.2: CHAT_DB Operational Tables & Indexes', async () => {
      const tableRows = chatDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
      const tableNames = tableRows.map((r) => r.name);
      assert.ok(tableNames.includes('sync_events'), 'sync_events table must exist');
      assert.ok(tableNames.includes('chat_rate_limits'), 'chat_rate_limits table must exist');

      const indexRows = chatDb.prepare("SELECT name FROM sqlite_master WHERE type='index'").all();
      const indexNames = indexRows.map((r) => r.name);

      const requiredIndexes = [
        'idx_messages_channel_id',
        'idx_messages_parent_id',
        'idx_reactions_msg',
        'idx_attachments_msg',
        'idx_rtc_signals_recipient',
        'idx_sync_events_id'
      ];

      for (const idx of requiredIndexes) {
        assert.ok(indexNames.includes(idx), `Index ${idx} must exist in CHAT_DB`);
      }
    });

    await c1.test('T1.1.3: BASEBALL_DB Non-Destructive Preservation (15 tables)', async () => {
      const rows = baseballDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
      const tableNames = rows.map((r) => r.name);

      const requiredBaseballTables = [
        'users',
        'sessions',
        'auth_codes',
        'events',
        'event_duties',
        'attendees',
        'duty_assignments',
        'comments',
        'default_duties',
        'posts',
        'media_items',
        'banned_emails',
        'app_settings',
        'rate_limits',
        'batting_practice_signups'
      ];

      for (const table of requiredBaseballTables) {
        assert.ok(tableNames.includes(table), `Baseball table ${table} must remain intact`);
      }
    });

    await c1.test('T1.1.4: Default 7 Channels Seeding', async () => {
      const channels = chatDb.prepare('SELECT slug, name, category, channel_type, min_role_read, min_role_write, is_encrypted FROM channels ORDER BY sort_order ASC').all();
      assert.equal(channels.length, 7, 'Must seed exactly 7 default channels');

      const slugs = channels.map((c) => c.slug);
      assert.ok(slugs.includes('announcements'));
      assert.ok(slugs.includes('general'));
      assert.ok(slugs.includes('sunday-game-day'));
      assert.ok(slugs.includes('highlights-and-media'));
      assert.ok(slugs.includes('facilitators-lounge'));
      assert.ok(slugs.includes('dugout-voice-huddle'));
      assert.ok(slugs.includes('organizers-war-room'));

      // Check specific role restrictions
      const announcements = channels.find((c) => c.slug === 'announcements');
      assert.equal(announcements.min_role_write, 'organizer');

      const facilitatorsLounge = channels.find((c) => c.slug === 'facilitators-lounge');
      assert.equal(facilitatorsLounge.min_role_read, 'facilitator');

      const dugoutVoice = channels.find((c) => c.slug === 'dugout-voice-huddle');
      assert.equal(dugoutVoice.channel_type, 'voice');
    });

    await c1.test('T1.1.5: Schema Initializer Idempotency', async () => {
      const countBefore = chatDb.prepare('SELECT COUNT(*) as c FROM channels').get().c;
      assert.equal(countBefore, 7);

      const { ensureChatD1Schema } = require('../../src/app/schema.js');
      if (typeof ensureChatD1Schema === 'function') {
        await ensureChatD1Schema(chatD1, true);
        await ensureChatD1Schema(chatD1, true);
      }

      const countAfter = chatDb.prepare('SELECT COUNT(*) as c FROM channels').get().c;
      assert.equal(countAfter, 7, 'Re-running initializer must not duplicate channels');
    });

    await c1.test('T1.1.6: Server Health & Version Discovery Endpoints', async () => {
      const verRes = await apiReq('GET', '/api/version');
      assert.equal(verRes.status, 200);
      assert.ok(verRes.data.version);

      const healthRes = await apiReq('GET', '/api/health');
      assert.equal(healthRes.status, 200);
      assert.equal(healthRes.data.status, 'ok');
    });
  });

  // =========================================================================
  // CHECK 2: SSO & RBAC Verification
  // =========================================================================
  await t.test('Tier 1 Check 2: SSO & RBAC Verification', async (c2) => {
    await c2.test('T1.2.1: Cross-Subdomain Session Auth via BASEBALL_DB.sessions', async () => {
      const res = await apiReq('GET', '/api/auth/me', playerCookie);
      assert.equal(res.status, 200);
      assert.ok(res.data.user);
      assert.equal(res.data.user.id, playerUser.id);
    });

    await c2.test('T1.2.2: Role Mapping Resolution (admin, organizer, player)', async () => {
      const adminMe = await apiReq('GET', '/api/auth/me', adminCookie);
      assert.equal(adminMe.data.user.role, 'admin');
      assert.equal(adminMe.data.user.isAdmin, true);

      const orgMe = await apiReq('GET', '/api/auth/me', orgCookie);
      assert.equal(orgMe.data.user.role, 'organizer');

      const playerMe = await apiReq('GET', '/api/auth/me', playerCookie);
      assert.equal(playerMe.data.user.role, 'player');
    });

    await c2.test('T1.2.3: Dynamic Badge Calculation', async (tSub) => {
      const res = await apiReq('GET', '/api/auth/me', facilitatorCookie);
      assert.equal(res.status, 200, 'GET /api/auth/me must return 200 OK');
      assert.ok(res.data.user, 'Response must contain authenticated user object');

      // Check if dynamic badges (playingSunday, isGameFacilitator) are returned on /api/auth/me (pending WP-2)
      if (res.data.user.isGameFacilitator === undefined || res.data.user.playingSunday === undefined) {
        tSub.skip('Waiting for WP-2: Dynamic badges playingSunday/isGameFacilitator on /api/auth/me');
        return;
      }

      // 1. Facilitator user: assigned Game Facilitator duty and attending upcoming Sunday game
      assert.equal(res.data.user.isGameFacilitator, true, 'Facilitator user must have isGameFacilitator badge');
      assert.equal(res.data.user.playingSunday, true, 'Facilitator attending Sunday game must have playingSunday badge');
      assert.equal(res.data.user.machineBadge, false, 'Facilitator should not have machineBadge');
      assert.equal(res.data.user.fieldBadge, false, 'Facilitator should not have fieldBadge');

      // 2. Regular player user: attending upcoming Sunday game, but NOT assigned Game Facilitator duty
      const playerRes = await apiReq('GET', '/api/auth/me', playerCookie);
      assert.equal(playerRes.status, 200);
      assert.ok(playerRes.data.user);
      assert.equal(playerRes.data.user.playingSunday, true, 'Player attending Sunday game must have playingSunday badge');
      assert.equal(playerRes.data.user.isGameFacilitator, false, 'Regular player must not have isGameFacilitator badge');
      assert.equal(playerRes.data.user.machineBadge, false);
      assert.equal(playerRes.data.user.fieldBadge, false);

      // 3. Admin user: machine_badge = 1, not attending upcoming Sunday game
      const adminRes = await apiReq('GET', '/api/auth/me', adminCookie);
      assert.equal(adminRes.status, 200);
      assert.equal(adminRes.data.user.machineBadge, true, 'Admin must have machineBadge');
      assert.equal(adminRes.data.user.fieldBadge, false);
      assert.equal(adminRes.data.user.playingSunday, false, 'Non-attending user must not have playingSunday badge');

      // 4. Organizer user: field_badge = 1, not attending upcoming Sunday game
      const orgRes = await apiReq('GET', '/api/auth/me', orgCookie);
      assert.equal(orgRes.status, 200);
      assert.equal(orgRes.data.user.fieldBadge, true, 'Organizer must have fieldBadge');
      assert.equal(orgRes.data.user.machineBadge, false);
    });

    await c2.test('T1.2.4: Banned Email Enforcement', async () => {
      const res = await apiReq('GET', '/api/auth/me', bannedCookie);
      assert.ok(res.status === 401 || res.status === 403 || res.data.user === null);
    });

    await c2.test('T1.2.5: Role-Gated Channel Access Guard (#facilitators-lounge)', async (tSub) => {
      if (!(await isEndpointAvailable('/api/channels/facilitators-lounge/messages'))) {
        tSub.skip('Waiting for WP-2/WP-3: /api/channels/:id/messages');
        return;
      }

      // Regular player without facilitator duty -> 403
      const playerRes = await apiReq('GET', '/api/channels/facilitators-lounge/messages', playerCookie);
      assert.equal(playerRes.status, 403);

      // Organizer -> 200
      const orgRes = await apiReq('GET', '/api/channels/facilitators-lounge/messages', orgCookie);
      assert.equal(orgRes.status, 200);

      // Admin -> 200
      const adminRes = await apiReq('GET', '/api/channels/facilitators-lounge/messages', adminCookie);
      assert.equal(adminRes.status, 200);
    });

    await c2.test('T1.2.6: Announcement Write Guard (#announcements)', async (tSub) => {
      if (!(await isEndpointAvailable('/api/channels/announcements/messages', 'POST'))) {
        tSub.skip('Waiting for WP-2/WP-3: POST /api/channels/:id/messages');
        return;
      }

      // Player attempting to write in announcements -> 403
      const playerPost = await apiReq('POST', '/api/channels/announcements/messages', playerCookie, {
        content: 'Unauthorized announcement'
      });
      assert.equal(playerPost.status, 403);

      // Organizer writing in announcements -> 201
      const orgPost = await apiReq('POST', '/api/channels/announcements/messages', orgCookie, {
        content: 'Official Sunday Schedule Announcement'
      });
      assert.equal(orgPost.status, 201);
    });
  });

  // =========================================================================
  // CHECK 3: Security Headers & CSRF Verification
  // =========================================================================
  await t.test('Tier 1 Check 3: Security Headers & CSRF Verification', async (c3) => {
    await c3.test('T1.3.1: Strict HTML Content-Security-Policy (CSP)', async () => {
      const res = await apiReq('GET', '/index.html');
      const csp = res.headers.get('content-security-policy') || '';
      assert.ok(csp.length > 0, 'CSP header must be present on HTML');
      assert.ok(csp.includes("frame-ancestors 'none'") || csp.includes("frame-ancestors 'self'"));
    });

    await c3.test('T1.3.2: API Endpoint CSP Lockdown', async () => {
      const res = await apiReq('GET', '/api/health');
      const csp = res.headers.get('content-security-policy') || '';
      assert.ok(csp.includes("default-src 'none'"));
      assert.ok(csp.includes("frame-ancestors 'none'"));
    });

    await c3.test('T1.3.3: Standard Defensive Headers', async () => {
      const res = await apiReq('GET', '/api/version');
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(res.headers.get('x-frame-options'), 'DENY');
      assert.ok(res.headers.get('strict-transport-security'));
      assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
    });

    await c3.test('T1.3.4: Permissions-Policy Scoping', async () => {
      const res = await apiReq('GET', '/api/version');
      const pp = res.headers.get('permissions-policy') || '';
      assert.ok(pp.includes('geolocation=()'));
      assert.ok(pp.includes('payment=()'));
    });

    await c3.test('T1.3.5: CSRF State-Changing Request Origin Enforcement', async () => {
      // Cross-origin POST attempt -> 403
      const crossOriginRes = await apiReq('POST', '/api/events', adminCookie, {
        title: 'Attacker Game',
        location: 'Nowhere',
        event_date: new Date().toISOString()
      }, {
        'Origin': 'https://evil-attacker.example.com'
      });
      assert.equal(crossOriginRes.status, 403);
      assert.ok(crossOriginRes.data.error.includes('Cross-origin'));

      // Same-origin POST attempt -> 200
      const sameOriginRes = await apiReq('POST', '/api/events', adminCookie, {
        title: 'Authorized Game',
        location: 'Bushrod Park',
        event_date: new Date(Date.now() + 86400000).toISOString()
      }, {
        'Origin': baseUrl
      });
      assert.equal(sameOriginRes.status, 200);
    });
  });

  // =========================================================================
  // CHECK 4: Delta Sync Efficiency Verification
  // =========================================================================
  await t.test('Tier 1 Check 4: Delta Sync Efficiency Verification', async (c4) => {
    await c4.test('T1.4.1: Baseline Initial Sync Hydration', async (tSub) => {
      if (!(await isEndpointAvailable('/api/sync'))) {
        tSub.skip('Waiting for WP-3: /api/sync endpoint');
        return;
      }
      const res = await apiReq('GET', '/api/sync?since_msg_id=0&since_event_id=0', playerCookie);
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.data.messages));
      assert.ok(Array.isArray(res.data.events));
      assert.ok(Array.isArray(res.data.rtc_signals));
    });

    await c4.test('T1.4.2: Incremental Message Delta', async (tSub) => {
      if (!(await isEndpointAvailable('/api/sync')) || !(await isEndpointAvailable('/api/channels/general/messages', 'POST'))) {
        tSub.skip('Waiting for WP-3: /api/sync and /api/channels/:id/messages endpoints');
        return;
      }
      const m1Res = await apiReq('POST', '/api/channels/general/messages', playerCookie, { content: 'Delta Msg 1' });
      assert.equal(m1Res.status, 201, 'm1 message post must succeed with 201 Created');
      assert.ok(m1Res.data && m1Res.data.id, 'm1 response must include message id');

      const m2Res = await apiReq('POST', '/api/channels/general/messages', playerCookie, { content: 'Delta Msg 2' });
      assert.equal(m2Res.status, 201, 'm2 message post must succeed with 201 Created');
      assert.ok(m2Res.data && m2Res.data.id, 'm2 response must include message id');

      const syncRes = await apiReq('GET', `/api/sync?since_msg_id=${m1Res.data.id}&since_event_id=0`, playerCookie);
      assert.equal(syncRes.status, 200, 'GET /api/sync must return 200 OK');
      assert.ok(Array.isArray(syncRes.data.messages), 'Delta sync response must contain messages array');
      const ids = syncRes.data.messages.map((m) => m.id);
      assert.ok(!ids.includes(m1Res.data.id), 'm1 must not be included when since_msg_id equals m1.id');
      assert.ok(ids.includes(m2Res.data.id), 'm2 must be included in incremental delta sync');
    });

    await c4.test('T1.4.3: Message Edit Tombstone Delta', async (tSub) => {
      if (!(await isEndpointAvailable('/api/sync')) || !(await isEndpointAvailable('/api/channels/general/messages', 'POST'))) {
        tSub.skip('Waiting for WP-3: /api/sync and /api/channels/:id/messages endpoints');
        return;
      }
      const mRes = await apiReq('POST', '/api/channels/general/messages', playerCookie, { content: 'Original text' });
      assert.equal(mRes.status, 201, 'Initial message post must return 201 Created');
      assert.ok(mRes.data && mRes.data.id, 'Initial message post must return message id');

      const patchRes = await apiReq('PATCH', `/api/messages/${mRes.data.id}`, playerCookie, { content: 'Edited text' });
      assert.equal(patchRes.status, 200, 'PATCH /api/messages/:id must return 200 OK');

      const syncRes = await apiReq('GET', '/api/sync?since_msg_id=0&since_event_id=0', playerCookie);
      assert.equal(syncRes.status, 200, 'GET /api/sync must return 200 OK');
      assert.ok(Array.isArray(syncRes.data.events), 'sync events must be an array');
      const editEvent = syncRes.data.events.find((e) => e.event_type === 'message_edit' && String(e.target_id) === String(mRes.data.id));
      assert.ok(editEvent, 'Edit tombstone event must appear in delta sync');
    });

    await c4.test('T1.4.4: Soft-Delete Tombstone Delta', async (tSub) => {
      if (!(await isEndpointAvailable('/api/sync')) || !(await isEndpointAvailable('/api/channels/general/messages', 'POST'))) {
        tSub.skip('Waiting for WP-3: /api/sync and /api/channels/:id/messages endpoints');
        return;
      }
      const mRes = await apiReq('POST', '/api/channels/general/messages', playerCookie, { content: 'To delete' });
      assert.equal(mRes.status, 201, 'Initial message post must return 201 Created');
      assert.ok(mRes.data && mRes.data.id, 'Initial message post must return message id');

      const delRes = await apiReq('DELETE', `/api/messages/${mRes.data.id}`, playerCookie);
      assert.equal(delRes.status, 200, 'DELETE /api/messages/:id must return 200 OK');

      const syncRes = await apiReq('GET', '/api/sync?since_msg_id=0&since_event_id=0', playerCookie);
      assert.equal(syncRes.status, 200, 'GET /api/sync must return 200 OK');
      assert.ok(Array.isArray(syncRes.data.events), 'sync events must be an array');
      const delEvent = syncRes.data.events.find((e) => e.event_type === 'message_delete' && String(e.target_id) === String(mRes.data.id));
      assert.ok(delEvent, 'Delete tombstone event must appear in delta sync');
    });

    await c4.test('T1.4.5: Emoji Reaction Toggle Delta', async (tSub) => {
      if (!(await isEndpointAvailable('/api/sync')) || !(await isEndpointAvailable('/api/channels/general/messages', 'POST'))) {
        tSub.skip('Waiting for WP-3: /api/sync and /api/channels/:id/messages endpoints');
        return;
      }
      const mRes = await apiReq('POST', '/api/channels/general/messages', playerCookie, { content: 'Reaction target' });
      assert.equal(mRes.status, 201, 'Initial message post must return 201 Created');
      assert.ok(mRes.data && mRes.data.id, 'Initial message post must return message id');

      const rxRes = await apiReq('POST', `/api/messages/${mRes.data.id}/reactions`, playerCookie, { emoji: '⚾' });
      assert.equal(rxRes.status, 200, 'POST /api/messages/:id/reactions must return 200 OK');

      const syncRes = await apiReq('GET', '/api/sync?since_msg_id=0&since_event_id=0', playerCookie);
      assert.equal(syncRes.status, 200, 'GET /api/sync must return 200 OK');
      assert.ok(Array.isArray(syncRes.data.events), 'sync events must be an array');
      const rxEvent = syncRes.data.events.find((e) => e.event_type === 'reaction_add' && String(e.target_id) === String(mRes.data.id));
      assert.ok(rxEvent, 'Reaction add event must appear in delta sync');
    });

    await c4.test('T1.4.6: Up-to-Date Zero Overhead Query', async (tSub) => {
      if (!(await isEndpointAvailable('/api/sync'))) {
        tSub.skip('Waiting for WP-3: /api/sync endpoint');
        return;
      }
      const syncRes = await apiReq('GET', '/api/sync?since_msg_id=99999999&since_event_id=99999999', playerCookie);
      assert.equal(syncRes.status, 200);
      assert.equal(syncRes.data.messages.length, 0);
      assert.equal(syncRes.data.events.length, 0);
    });
  });

  // =========================================================================
  // CHECK 5: E2EE Key Vault & Channel Key Wrapping
  // =========================================================================
  await t.test('Tier 1 Check 5: E2EE Key Vault & Channel Key Wrapping', async (c5) => {
    await c5.test('T1.5.1: Identity Public Keys & Encrypted Vault Upload', async (tSub) => {
      if (!(await isEndpointAvailable('/api/keys/identity', 'PUT'))) {
        tSub.skip('Waiting for WP-2: PUT /api/keys/identity');
        return;
      }
      const keys = await generateIdentityKeyPair();
      const vault = await encryptVault('super-secret-passphrase', { ecdhPriv: keys.ecdhPrivateJwk });

      const res = await apiReq('PUT', '/api/keys/identity', playerCookie, {
        ecdh_public_key_jwk: JSON.stringify(keys.ecdhPublicJwk),
        ecdsa_public_key_jwk: JSON.stringify(keys.ecdsaPublicJwk),
        encrypted_private_vault: vault.encryptedVaultB64,
        vault_salt: vault.saltB64,
        vault_iv: vault.ivB64,
        privacy_relay_mode: 0
      });
      assert.equal(res.status, 200);
      assert.equal(res.data.success, true);
    });

    await c5.test('T1.5.2: Identity Key Directory Retrieval', async (tSub) => {
      if (!(await isEndpointAvailable(`/api/keys/identity/${playerUser.id}`))) {
        tSub.skip('Waiting for WP-2: GET /api/keys/identity/:id');
        return;
      }
      const res = await apiReq('GET', `/api/keys/identity/${playerUser.id}`, adminCookie);
      assert.equal(res.status, 200);
      assert.ok(res.data.ecdh_public_key_jwk);
      assert.ok(res.data.ecdsa_public_key_jwk);
      assert.equal(res.data.encrypted_private_vault, undefined);
    });

    await c5.test('T1.5.3: Channel Epoch Key Distribution', async (tSub) => {
      if (!(await isEndpointAvailable('/api/keys/channel/2/share', 'POST'))) {
        tSub.skip('Waiting for WP-2: POST /api/keys/channel/:id/share');
        return;
      }
      const res = await apiReq('POST', '/api/keys/channel/2/share', adminCookie, {
        shares: [
          {
            recipient_user_id: playerUser.id,
            key_epoch: 1,
            wrapped_key_base64: 'mockWrappedKeyPayload==',
            wrap_iv: 'mockWrapIV12Bytes=='
          }
        ]
      });
      assert.equal(res.status, 200);
      assert.equal(res.data.success, true);
    });

    await c5.test('T1.5.4: Channel Epoch Key Retrieval', async (tSub) => {
      if (!(await isEndpointAvailable('/api/keys/channel/2'))) {
        tSub.skip('Waiting for WP-2: GET /api/keys/channel/:id');
        return;
      }
      const res = await apiReq('GET', '/api/keys/channel/2', playerCookie);
      assert.equal(res.status, 200);
      assert.equal(res.data.keyEpoch, 1);
      assert.equal(res.data.wrappedKeyBase64, 'mockWrappedKeyPayload==');
    });

    await c5.test('T1.5.5: End-to-End Ciphertext Round-Trip Decryption via WebCrypto', async () => {
      const aliceKeys = await generateIdentityKeyPair();
      const bobKeys = await generateIdentityKeyPair();

      const aliceSharedKey = await deriveEcdhSharedKey(aliceKeys.ecdhPair.privateKey, bobKeys.ecdhPair.publicKey);
      const bobSharedKey = await deriveEcdhSharedKey(bobKeys.ecdhPair.privateKey, aliceKeys.ecdhPair.publicKey);

      const channelKey = await generateChannelKey();
      const { wrappedKeyBase64, wrapIv } = await wrapChannelKey(channelKey, aliceSharedKey);
      const unwrappedChannelKey = await unwrapChannelKey(wrappedKeyBase64, bobSharedKey, wrapIv);

      const plaintext = 'Bottom of the 9th: Bases Loaded with 2 Outs!';
      const { ciphertextB64, ivB64 } = await encryptPayload(channelKey, plaintext);

      const decrypted = await decryptPayload(unwrappedChannelKey, ciphertextB64, ivB64);
      assert.equal(decrypted, plaintext, 'Decrypted plaintext must match original exactly');
    });
  });

  // =========================================================================
  // CHECK 6: PBF Shared Drive Resumable Flow, Range Streaming & Gallery Promotion
  // =========================================================================
  await t.test('Tier 1 Check 6: PBF Shared Drive Resumable Flow, Range Streaming & Gallery Promotion', async (c6) => {
    let attachmentId = null;

    await c6.test('T1.6.1: Resumable Upload Initialization', async (tSub) => {
      if (!(await isEndpointAvailable('/api/attachments/init', 'POST'))) {
        tSub.skip('Waiting for WP-3: POST /api/attachments/init');
        return;
      }
      const res = await apiReq('POST', '/api/attachments/init', playerCookie, {
        channel_id: 4,
        file_name: 'game_winning_catch.mp4',
        mime_type: 'video/mp4',
        file_size: 1048576
      });
      assert.equal(res.status, 200);
      assert.ok(res.data.attachmentId);
      assert.ok(res.data.uploadUrl);
      attachmentId = res.data.attachmentId;
    });

    await c6.test('T1.6.2: Local Fallback Binary Upload & Completion', async (tSub) => {
      if (!attachmentId || !(await isEndpointAvailable(`/api/attachments/${attachmentId}/upload`, 'PUT'))) {
        tSub.skip('Waiting for WP-3: PUT /api/attachments/:id/upload');
        return;
      }
      const testBuffer = Buffer.alloc(1024, 0x42);
      const uploadRes = await apiReq('PUT', `/api/attachments/${attachmentId}/upload`, playerCookie, testBuffer);
      assert.equal(uploadRes.status, 200);

      const completeRes = await apiReq('POST', `/api/attachments/${attachmentId}/complete`, playerCookie);
      assert.equal(completeRes.status, 200);
    });

    await c6.test('T1.6.3: Zero-Copy Range Streaming (HTTP 206 Partial Content)', async (tSub) => {
      if (!attachmentId || !(await isEndpointAvailable(`/api/attachments/${attachmentId}/stream`))) {
        tSub.skip('Waiting for WP-3: GET /api/attachments/:id/stream');
        return;
      }
      const rangeRes = await apiReq('GET', `/api/attachments/${attachmentId}/stream`, playerCookie, null, {
        'Range': 'bytes=0-63'
      });
      assert.equal(rangeRes.status, 206);
      assert.ok(rangeRes.headers.get('content-range'));
      assert.equal(rangeRes.headers.get('content-length'), '64');
    });

    await c6.test('T1.6.4: Full Attachment Download (HTTP 200)', async (tSub) => {
      if (!attachmentId || !(await isEndpointAvailable(`/api/attachments/${attachmentId}/stream`))) {
        tSub.skip('Waiting for WP-3: GET /api/attachments/:id/stream');
        return;
      }
      const fullRes = await apiReq('GET', `/api/attachments/${attachmentId}/stream`, playerCookie);
      assert.equal(fullRes.status, 200);
      assert.equal(fullRes.headers.get('content-length'), '1024');
    });

    await c6.test('T1.6.5: Admin 1-Click Gallery Promotion to BASEBALL_DB.media_items', async (tSub) => {
      if (!attachmentId || !(await isEndpointAvailable(`/api/attachments/${attachmentId}/promote-to-gallery`, 'POST'))) {
        tSub.skip('Waiting for WP-3: POST /api/attachments/:id/promote-to-gallery');
        return;
      }
      const promoRes = await apiReq('POST', `/api/attachments/${attachmentId}/promote-to-gallery`, adminCookie, {
        title: 'Walk-Off Grand Slam Highlight',
        caption: 'Fall 2026 Championship'
      });
      assert.equal(promoRes.status, 200);
      assert.equal(promoRes.data.success, true);
      assert.ok(promoRes.data.media_id);

      const mediaRow = baseballDb.prepare('SELECT * FROM media_items WHERE id = ?').get(promoRes.data.media_id);
      assert.ok(mediaRow);
      assert.equal(mediaRow.is_approved, 1);
    });

    await c6.test('T1.6.6: Client-Side EXIF/GPS Metadata Stripper', async () => {
      const syntheticJpegWithGps = Buffer.from([
        0xFF, 0xD8,
        0xFF, 0xE1, 0x00, 0x08, 0x45, 0x78, 0x69, 0x66,
        0xFF, 0xDA, 0x00, 0x02, 0x12, 0x34,
        0xFF, 0xD9
      ]);

      const stripped = stripJpegMetadata(syntheticJpegWithGps);
      assert.ok(
        stripped instanceof ArrayBuffer ||
        Buffer.isBuffer(stripped) ||
        stripped instanceof Uint8Array,
        'Stripped output must be a buffer or ArrayBuffer'
      );
      const strippedBuf = Buffer.from(stripped instanceof ArrayBuffer ? new Uint8Array(stripped) : stripped);

      assert.equal(strippedBuf[0], 0xFF);
      assert.equal(strippedBuf[1], 0xD8);

      let hasApp1 = false;
      for (let i = 0; i < strippedBuf.length - 1; i++) {
        if (strippedBuf[i] === 0xFF && strippedBuf[i + 1] === 0xE1) {
          hasApp1 = true;
          break;
        }
      }
      assert.equal(hasApp1, false, 'APP1 EXIF segment must be stripped');
    });
  });

  // =========================================================================
  // CHECK 7: Scoped WebRTC Signaling Verification
  // =========================================================================
  await t.test('Tier 1 Check 7: Scoped WebRTC Signaling Verification', async (c7) => {
    await c7.test('T1.7.1: Voice Room Participation Registration', async (tSub) => {
      if (!(await isEndpointAvailable('/api/voice/dugout-voice/join', 'POST'))) {
        tSub.skip('Waiting for WP-4: POST /api/voice/:id/join');
        return;
      }
      const joinRes = await apiReq('POST', '/api/voice/dugout-voice/join', playerCookie);
      assert.equal(joinRes.status, 200);

      const stateRes = await apiReq('POST', '/api/voice/dugout-voice/state', playerCookie, {
        muted: 0,
        deafened: 0,
        screen_sharing: 0
      });
      assert.equal(stateRes.status, 200);
    });

    await c7.test('T1.7.2: Voice Participant Heartbeat', async (tSub) => {
      if (!(await isEndpointAvailable('/api/voice/dugout-voice/state', 'POST'))) {
        tSub.skip('Waiting for WP-4: POST /api/voice/:id/state');
        return;
      }
      const stateRes = await apiReq('POST', '/api/voice/dugout-voice/state', playerCookie, {
        muted: 1
      });
      assert.equal(stateRes.status, 200);
      const participant = chatDb.prepare('SELECT * FROM voice_participants WHERE user_id = ?').get(playerUser.id);
      assert.ok(participant);
      assert.ok(participant.heartbeat_at > 0);
    });

    await c7.test('T1.7.3: Scoped WebRTC SDP Offer Deposit', async (tSub) => {
      if (!(await isEndpointAvailable('/api/rtc/signal', 'POST'))) {
        tSub.skip('Waiting for WP-4: POST /api/rtc/signal');
        return;
      }
      const signalRes = await apiReq('POST', '/api/rtc/signal', playerCookie, {
        channel_id: 6,
        recipient_user_id: facilitatorUser.id,
        signal_type: 'offer',
        payload_json: JSON.stringify({ type: 'offer', sdp: 'v=0...' })
      });
      assert.equal(signalRes.status, 200);
      assert.equal(signalRes.data.success, true);
    });

    await c7.test('T1.7.4: Recipient Isolation & Scoped Delivery', async (tSub) => {
      if (!(await isEndpointAvailable('/api/sync'))) {
        tSub.skip('Waiting for WP-3/WP-4: /api/sync rtc_signals');
        return;
      }
      const facSync = await apiReq('GET', '/api/sync?since_msg_id=0&since_event_id=0', facilitatorCookie);
      const offer = facSync.data.rtc_signals.find((s) => s.recipient_user_id === facilitatorUser.id);
      assert.ok(offer, 'Target recipient must receive signal');

      const adminSync = await apiReq('GET', '/api/sync?since_msg_id=0&since_event_id=0', adminCookie);
      const leaked = adminSync.data.rtc_signals.find((s) => s.recipient_user_id === facilitatorUser.id);
      assert.equal(leaked, undefined, 'Third party must not observe targeted signal');
    });

    await c7.test('T1.7.5: Voice Room Departure', async (tSub) => {
      if (!(await isEndpointAvailable('/api/voice/dugout-voice/leave', 'POST'))) {
        tSub.skip('Waiting for WP-4: POST /api/voice/:id/leave');
        return;
      }
      const leaveRes = await apiReq('POST', '/api/voice/dugout-voice/leave', playerCookie);
      assert.equal(leaveRes.status, 200);
      const participant = chatDb.prepare('SELECT * FROM voice_participants WHERE user_id = ?').get(playerUser.id);
      assert.equal(participant, undefined, 'User must be removed on leave');
    });
  });

  // =========================================================================
  // CHECK 8: Live Baseball Bridge Verification
  // =========================================================================
  await t.test('Tier 1 Check 8: Live Baseball Bridge Verification', async (c8) => {
    await c8.test('T1.8.1: Query Upcoming Sunday Game', async (tSub) => {
      if (!(await isEndpointAvailable('/api/baseball/upcoming'))) {
        tSub.skip('Waiting for WP-4: GET /api/baseball/upcoming');
        return;
      }
      const res = await apiReq('GET', '/api/baseball/upcoming');
      assert.equal(res.status, 200);
      assert.ok(res.data.event);
      assert.equal(res.data.event.id, testEventId);
    });

    await c8.test('T1.8.2: 1-Click Sunday RSVP Toggle (Attending)', async (tSub) => {
      if (!(await isEndpointAvailable(`/api/baseball/events/${testEventId}/quick-rsvp`, 'POST'))) {
        tSub.skip('Waiting for WP-4: POST /api/baseball/events/:id/quick-rsvp');
        return;
      }
      const res = await apiReq('POST', `/api/baseball/events/${testEventId}/quick-rsvp`, playerCookie, {
        status: 'attending'
      });
      assert.equal(res.status, 200);
      assert.equal(res.data.status, 'attending');

      const att = baseballDb.prepare('SELECT status FROM attendees WHERE event_id = ? AND user_id = ?').get(testEventId, playerUser.id);
      assert.equal(att.status, 'attending');
    });

    await c8.test('T1.8.3: 1-Click Sunday RSVP Toggle (Declined)', async (tSub) => {
      if (!(await isEndpointAvailable(`/api/baseball/events/${testEventId}/quick-rsvp`, 'POST'))) {
        tSub.skip('Waiting for WP-4: POST /api/baseball/events/:id/quick-rsvp');
        return;
      }
      const res = await apiReq('POST', `/api/baseball/events/${testEventId}/quick-rsvp`, playerCookie, {
        status: 'declined'
      });
      assert.equal(res.status, 200);
      assert.equal(res.data.status, 'declined');

      const att = baseballDb.prepare('SELECT status FROM attendees WHERE event_id = ? AND user_id = ?').get(testEventId, playerUser.id);
      assert.equal(att.status, 'declined');
    });

    await c8.test('T1.8.4: 1-Click Batting Practice Slot Signup', async (tSub) => {
      if (!(await isEndpointAvailable(`/api/baseball/events/${testEventId}/quick-bp`, 'POST'))) {
        tSub.skip('Waiting for WP-4: POST /api/baseball/events/:id/quick-bp');
        return;
      }
      const res = await apiReq('POST', `/api/baseball/events/${testEventId}/quick-bp`, playerCookie, {
        slot_number: 7
      });
      assert.equal(res.status, 200);
      assert.equal(res.data.slot_number, 7);

      const bp = baseballDb.prepare('SELECT * FROM batting_practice_signups WHERE event_id = ? AND slot_number = ?').get(testEventId, 7);
      assert.ok(bp);
      assert.equal(bp.user_id, playerUser.id);
    });

    await c8.test('T1.8.5: 1-Click Batting Practice Slot Release', async (tSub) => {
      if (!(await isEndpointAvailable(`/api/baseball/events/${testEventId}/quick-bp`, 'POST'))) {
        tSub.skip('Waiting for WP-4: POST /api/baseball/events/:id/quick-bp');
        return;
      }
      const res = await apiReq('POST', `/api/baseball/events/${testEventId}/quick-bp`, playerCookie, {
        action: 'release',
        slot_number: 7
      });
      assert.equal(res.status, 200);

      const bp = baseballDb.prepare('SELECT * FROM batting_practice_signups WHERE event_id = ? AND slot_number = ?').get(testEventId, 7);
      assert.equal(bp, undefined);
    });

    await c8.test('T1.8.6: Game-Day Channel Automatic Sync', async (tSub) => {
      if (!(await isEndpointAvailable(`/api/baseball/events/${testEventId}/sync-channel`, 'POST'))) {
        tSub.skip('Waiting for WP-4: POST /api/baseball/events/:id/sync-channel');
        return;
      }
      const res = await apiReq('POST', `/api/baseball/events/${testEventId}/sync-channel`, orgCookie);
      assert.equal(res.status, 200);
      assert.ok(res.data.channel_id);

      const channel = chatDb.prepare('SELECT * FROM channels WHERE linked_event_id = ?').get(testEventId);
      assert.ok(channel);
    });
  });
}

// Standalone execution support
if (require.main === module) {
  test('Tier 1: Clubhouse Feature Coverage', async (t) => {
    const ctx = await createClubhouseTestContext();
    try {
      await runTier1(t, ctx);
    } finally {
      await ctx.cleanup();
    }
  });
}

module.exports = runTier1;
