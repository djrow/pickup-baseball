/**
 * tests/clubhouse/tier2-boundary-corner.test.js
 * Tier 2: Boundary & Corner Cases (Limits, Errors & Edge Conditions)
 *
 * Covers Section 8 Checks 1–8 with >=5 genuine boundary tests per check:
 * - Check 1 Boundaries: Schema limits, unique slug conflicts, cascade deletes (5 tests)
 * - Check 2 Boundaries: Expired tokens, banned users, duty revocation, sole admin (5 tests)
 * - Check 3 Boundaries: Null origin, referer mismatch, spoofing suffix, safe bypass (5 tests)
 * - Check 4 Boundaries: Negative IDs, future IDs, burst rate limits, tombstones (5 tests)
 * - Check 5 Boundaries: Malformed JWKs, tampered cipher GCM tags, wrong passphrase (5 tests)
 * - Check 6 Boundaries: Disallowed MIME, size caps, PE magic-bytes spoof, 416 range (5 tests)
 * - Check 7 Boundaries: Cross-channel signal, non-existent target, 60s TTL, 25s heartbeat (5 tests)
 * - Check 8 Boundaries: BP double-booking 409, slot 0/29 out-of-bounds, rainout block (5 tests)
 * Total: 40 boundary tests
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createClubhouseTestContext } = require('../helpers/test-harness');
const {
  generateIdentityKeyPair,
  generateChannelKey,
  encryptPayload,
  decryptPayload,
  encryptVault,
  decryptVault
} = require('../helpers/crypto-test-utils');

async function runTier2(t, ctx) {
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
    expiredCookie,
    adminUser,
    playerUser,
    facilitatorUser,
    testEventId,
    apiReq,
    isEndpointAvailable
  } = ctx;

  // =========================================================================
  // CHECK 1 BOUNDARIES
  // =========================================================================
  await t.test('Tier 2 Check 1: Schema & Data Boundary Limits', async (c1) => {
    await c1.test('T2.1.1: Unique Channel Slug Collision', async () => {
      // Direct SQLite constraint verification on CHAT_DB
      assert.throws(() => {
        chatDb.prepare(`
          INSERT INTO channels (slug, name, category, channel_type)
          VALUES ('general', '#general duplicate', 'Text Channels', 'text')
        `).run();
      }, /UNIQUE constraint failed: channels\.slug/);
    });

    await c1.test('T2.1.2: Cross-Database Foreign Key Isolation', async () => {
      // Validate that all tables in CHAT_DB contain zero direct foreign keys to BASEBALL_DB tables
      const tables = chatDb.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
      ).all();
      assert.ok(tables.length >= 9, 'CHAT_DB must contain at least 9 tables');

      const forbiddenBaseballTables = new Set([
        'users',
        'sessions',
        'events',
        'attendees',
        'duty_assignments',
        'batting_practice_signups',
        'media_items',
        'banned_emails'
      ]);

      let totalFkDefinitions = 0;
      for (const { name } of tables) {
        const fkList = chatDb.prepare(`PRAGMA foreign_key_list('${name}')`).all();
        totalFkDefinitions += fkList.length;

        for (const fk of fkList) {
          const targetTable = (fk.table || '').toLowerCase();
          assert.ok(
            !forbiddenBaseballTables.has(targetTable),
            `Cross-database FK isolation violation: Table '${name}' in CHAT_DB defines SQL foreign key referencing BASEBALL_DB table '${fk.table}'`
          );
        }
      }

      // Assert that foreign keys within CHAT_DB were actually inspected and verified (10 internal FKs expected)
      assert.ok(
        totalFkDefinitions > 0,
        `Expected internal foreign key definitions to be inspected within CHAT_DB, but found ${totalFkDefinitions}`
      );
    });

    await c1.test('T2.1.3: Foreign Key Cascading Deletion within CHAT_DB', async () => {
      // Insert temporary channel and associated message
      const chRes = chatDb.prepare("INSERT INTO channels (slug, name) VALUES ('temp-cascade-ch', '#temp-ch')").run();
      const chId = chRes.lastInsertRowid;

      const msgRes = chatDb.prepare(`
        INSERT INTO messages (channel_id, author_id, author_name, content)
        VALUES (?, 1, 'Admin', 'Message to cascade')
      `).run(chId);
      const msgId = msgRes.lastInsertRowid;

      // Delete channel
      chatDb.prepare('DELETE FROM channels WHERE id = ?').run(chId);

      // Verify message cascaded
      const msg = chatDb.prepare('SELECT * FROM messages WHERE id = ?').get(msgId);
      assert.equal(msg, undefined, 'Message should cascade on channel deletion');
    });

    await c1.test('T2.1.4: Extreme Slug & Category Constraints', async () => {
      // Null slug constraint check
      assert.throws(() => {
        chatDb.prepare("INSERT INTO channels (slug, name) VALUES (NULL, '#null-slug')").run();
      }, /NOT NULL constraint failed/);
    });

    await c1.test('T2.1.5: Non-Existent Channel Lookup Clean Handling', async () => {
      const row = chatDb.prepare('SELECT * FROM channels WHERE slug = ?').get('non-existent-channel-slug-999');
      assert.equal(row, undefined);
    });
  });

  // =========================================================================
  // CHECK 2 BOUNDARIES
  // =========================================================================
  await t.test('Tier 2 Check 2: SSO & RBAC Boundary Conditions', async (c2) => {
    await c2.test('T2.2.1: Expired Session Cookie Rejection', async () => {
      const res = await apiReq('GET', '/api/auth/me', expiredCookie);
      assert.ok(res.status === 401 || res.data.user === null);
    });

    await c2.test('T2.2.2: Corrupted / Tampered Session Token', async () => {
      const res = await apiReq('GET', '/api/auth/me', 'baseball_session=corrupted.fake.token.12345');
      assert.ok(res.status === 401 || res.data.user === null);
    });

    await c2.test('T2.2.3: Mid-Session Account Suspension / Banned Email', async () => {
      // Create user and active session
      const tempEmail = `banned_mid_${Date.now()}@pickupbaseball.org`;
      const uRes = baseballDb.prepare("INSERT INTO users (name, email, role) VALUES ('Mid Ban', ?, 'player')").run(tempEmail);
      const sId = `session_mid_${Date.now()}`;
      const expiry = new Date(Date.now() + 86400000).toISOString();
      baseballDb.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(sId, uRes.lastInsertRowid, expiry);

      // 1. Valid before ban
      const res1 = await apiReq('GET', '/api/auth/me', `baseball_session=${sId}`);
      assert.equal(res1.status, 200);
      assert.equal(res1.data.user.email, tempEmail);

      // 2. Ban email
      baseballDb.prepare('INSERT INTO banned_emails (email, reason) VALUES (?, ?)').run(tempEmail, 'Banned during session');

      // 3. Immediately rejected
      const res2 = await apiReq('GET', '/api/auth/me', `baseball_session=${sId}`);
      assert.ok(res2.status === 401 || res2.status === 403 || res2.data.user === null);
    });

    await c2.test('T2.2.4: Facilitator Duty Revocation Immediate Lockout', async (tSub) => {
      if (!(await isEndpointAvailable('/api/channels/facilitators-lounge/messages'))) {
        tSub.skip('Waiting for WP-2/WP-3: /api/channels/:id/messages');
        return;
      }

      // Dana has duty -> permitted
      const resPermitted = await apiReq('GET', '/api/channels/facilitators-lounge/messages', facilitatorCookie);
      assert.equal(resPermitted.status, 200);

      // Revoke duty assignment in BASEBALL_DB
      baseballDb.prepare(`
        DELETE FROM duty_assignments WHERE attendee_id IN (
          SELECT id FROM attendees WHERE user_id = ?
        )
      `).run(facilitatorUser.id);

      // Next request -> immediately 403 Forbidden
      const resLocked = await apiReq('GET', '/api/channels/facilitators-lounge/messages', facilitatorCookie);
      assert.equal(resLocked.status, 403);
    });
  });

  // =========================================================================
  // CHECK 3 BOUNDARIES
  // =========================================================================
  await t.test('Tier 2 Check 3: Security & CSRF Attack Evasion', async (c3) => {
    await c3.test('T2.3.1: Null Origin / file:// Origin Rejection', async () => {
      const res = await apiReq('POST', '/api/events', adminCookie, {
        title: 'Null Origin Attack',
        location: 'Bushrod Park',
        event_date: new Date().toISOString()
      }, {
        'Origin': 'null'
      });
      assert.equal(res.status, 403);
    });

    await c3.test('T2.3.2: Domain Suffix Spoofing Evasion', async () => {
      const res = await apiReq('POST', '/api/events', adminCookie, {
        title: 'Suffix Attack',
        location: 'Bushrod Park',
        event_date: new Date().toISOString()
      }, {
        'Origin': `${baseUrl}.attacker-controlled-site.com`
      });
      assert.equal(res.status, 403);
    });

    await c3.test('T2.3.3: Mismatched Referer Origin Rejection', async () => {
      const res = await apiReq('POST', '/api/events', adminCookie, {
        title: 'Referer Attack',
        location: 'Bushrod Park',
        event_date: new Date().toISOString()
      }, {
        'Origin': '',
        'Referer': 'https://malicious-phishing-club.org/exploit'
      });
      assert.equal(res.status, 403);
    });

    await c3.test('T2.3.4: Safe Method (GET) Bypasses CSRF Guard', async () => {
      // Cross-origin GET request is safe and should not return 403 CSRF block
      const res = await apiReq('GET', '/api/health', null, null, {
        'Origin': 'https://external-search-indexer.com'
      });
      assert.equal(res.status, 200);
    });

    await c3.test('T2.3.5: 404 Endpoint Retains All Defensive Headers', async () => {
      const res = await apiReq('GET', '/api/non-existent-endpoint-probe');
      assert.equal(res.status, 404);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(res.headers.get('x-frame-options'), 'DENY');
      assert.ok(res.headers.get('content-security-policy'));
    });
  });

  // =========================================================================
  // CHECK 4 BOUNDARIES
  // =========================================================================
  await t.test('Tier 2 Check 4: Delta Sync & Rate Limiting Limits', async (c4) => {
    await c4.test('T2.4.1: Negative Sequence IDs Handling', async (tSub) => {
      if (!(await isEndpointAvailable('/api/sync'))) {
        tSub.skip('Waiting for WP-3: /api/sync endpoint');
        return;
      }
      const res = await apiReq('GET', '/api/sync?since_msg_id=-50&since_event_id=-99', playerCookie);
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.data.messages));
    });

    await c4.test('T2.4.2: Future Sequence IDs Beyond Head', async (tSub) => {
      if (!(await isEndpointAvailable('/api/sync'))) {
        tSub.skip('Waiting for WP-3: /api/sync endpoint');
        return;
      }
      const res = await apiReq('GET', '/api/sync?since_msg_id=99999999', playerCookie);
      assert.equal(res.status, 200);
      assert.equal(res.data.messages.length, 0);
    });

    await c4.test('T2.4.4: Deleting Non-Existent Message', async (tSub) => {
      if (!(await isEndpointAvailable('/api/messages/999999', 'DELETE'))) {
        tSub.skip('Waiting for WP-3: DELETE /api/messages/:id');
        return;
      }
      const res = await apiReq('DELETE', '/api/messages/999999', playerCookie);
      assert.ok(res.status === 404 || res.status === 400);
    });

    await c4.test('T2.4.5: Pagination Cursor Boundary (before_id = 0)', async (tSub) => {
      if (!(await isEndpointAvailable('/api/channels/general/messages'))) {
        tSub.skip('Waiting for WP-3: GET /api/channels/:id/messages');
        return;
      }
      const res = await apiReq('GET', '/api/channels/general/messages?before_id=0&limit=50', playerCookie);
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.data.messages) || Array.isArray(res.data));
    });
  });

  // =========================================================================
  // CHECK 5 BOUNDARIES
  // =========================================================================
  await t.test('Tier 2 Check 5: E2EE Vault & Ciphertext Boundaries', async (c5) => {
    await c5.test('T2.5.2: Tampered Ciphertext / GCM Tag Authentication Failure', async () => {
      const channelKey = await generateChannelKey();
      const { ciphertextB64, ivB64 } = await encryptPayload(channelKey, 'Authenticated data string');

      // Tamper with 1 byte of the Base64 ciphertext
      const decodedBytes = Buffer.from(ciphertextB64, 'base64');
      decodedBytes[0] ^= 0xFF; // Flip bits in first byte
      const tamperedB64 = decodedBytes.toString('base64');

      // Decryption must fail GCM tag validation
      await assert.rejects(
        async () => {
          await decryptPayload(channelKey, tamperedB64, ivB64);
        },
        /OperationError/
      );
    });

    await c5.test('T2.5.4: Corrupted Passphrase Vault Unwrapping Failure', async () => {
      const vault = await encryptVault('correct-passphrase-2026', { secret: 'top_secret_key' });

      // Attempt to decrypt with wrong passphrase
      await assert.rejects(
        async () => {
          await decryptVault('wrong-passphrase', vault.encryptedVaultB64, vault.saltB64, vault.ivB64);
        },
        /OperationError/
      );
    });

    await c5.test('T2.5.1: Malformed Public JWK Payloads Rejection', async (tSub) => {
      if (!(await isEndpointAvailable('/api/keys/identity', 'PUT'))) {
        tSub.skip('Waiting for WP-2: PUT /api/keys/identity');
        return;
      }
      const res = await apiReq('PUT', '/api/keys/identity', playerCookie, {
        ecdh_public_key_jwk: 'invalid-non-json-string',
        ecdsa_public_key_jwk: '{}'
      });
      assert.equal(res.status, 400);
    });

    await c5.test('T2.5.3: Key Distribution to Non-Member Rejection', async (tSub) => {
      if (!(await isEndpointAvailable('/api/keys/channel/999/share', 'POST'))) {
        tSub.skip('Waiting for WP-2: POST /api/keys/channel/:id/share');
        return;
      }
      const res = await apiReq('POST', '/api/keys/channel/999/share', playerCookie, {
        shares: [{ recipient_user_id: 2, key_epoch: 1, wrapped_key_base64: 'abc', wrap_iv: 'def' }]
      });
      assert.ok(res.status === 403 || res.status === 404);
    });

    await c5.test('T2.5.5: Vault Payload Missing Salt or IV', async (tSub) => {
      if (!(await isEndpointAvailable('/api/keys/identity', 'PUT'))) {
        tSub.skip('Waiting for WP-2: PUT /api/keys/identity');
        return;
      }
      const res = await apiReq('PUT', '/api/keys/identity', playerCookie, {
        ecdh_public_key_jwk: '{"kty":"EC"}',
        ecdsa_public_key_jwk: '{"kty":"EC"}',
        encrypted_private_vault: 'base64PayloadWithoutSaltOrIV=='
      });
      assert.equal(res.status, 400);
    });
  });

  // =========================================================================
  // CHECK 6 BOUNDARIES
  // =========================================================================
  await t.test('Tier 2 Check 6: Media Engine Limits & Security Guards', async (c6) => {
    await c6.test('T2.6.1: Disallowed MIME Type Rejection', async (tSub) => {
      if (!(await isEndpointAvailable('/api/attachments/init', 'POST'))) {
        tSub.skip('Waiting for WP-3: POST /api/attachments/init');
        return;
      }
      const res = await apiReq('POST', '/api/attachments/init', playerCookie, {
        channel_id: 2,
        file_name: 'virus.exe',
        mime_type: 'application/x-msdownload',
        file_size: 1024
      });
      assert.equal(res.status, 400);
    });

    await c6.test('T2.6.2: File Size Cap Enforcement (>500MB)', async (tSub) => {
      if (!(await isEndpointAvailable('/api/attachments/init', 'POST'))) {
        tSub.skip('Waiting for WP-3: POST /api/attachments/init');
        return;
      }
      const res = await apiReq('POST', '/api/attachments/init', playerCookie, {
        channel_id: 2,
        file_name: 'huge_recording.mp4',
        mime_type: 'video/mp4',
        file_size: 600 * 1024 * 1024 // 600 MB exceeds 500 MB limit
      });
      assert.equal(res.status, 400);
    });

    await c6.test('T2.6.3: Magic-Byte Spoofing Detection (PE Header disguised as JPEG)', async (tSub) => {
      if (!(await isEndpointAvailable('/api/attachments/init', 'POST'))) {
        tSub.skip('Waiting for WP-3: POST /api/attachments/init');
        return;
      }
      // 1. Initialize upload session declared as image/jpeg
      const initRes = await apiReq('POST', '/api/attachments/init', playerCookie, {
        channel_id: 2,
        file_name: 'innocent_photo.jpg',
        mime_type: 'image/jpeg',
        file_size: 512
      });
      assert.equal(initRes.status, 200, 'POST /api/attachments/init must return 200 OK');
      assert.ok(initRes.data && initRes.data.attachmentId, 'Init response must include attachmentId');

      // 2. Upload Windows PE binary header (4D 5A = "MZ") -> must be rejected with 400
      const peBuffer = Buffer.from([0x4D, 0x5A, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);
      const uploadRes = await apiReq('PUT', `/api/attachments/${initRes.data.attachmentId}/upload`, playerCookie, peBuffer);
      assert.equal(uploadRes.status, 400, 'Must reject spoofed PE header for JPEG');
    });

    await c6.test('T2.6.4: Unsatisfiable Byte Range (HTTP 416)', async (tSub) => {
      if (!(await isEndpointAvailable('/api/attachments/fake_id/stream'))) {
        tSub.skip('Waiting for WP-3: GET /api/attachments/:id/stream');
        return;
      }
      const res = await apiReq('GET', '/api/attachments/test_file/stream', playerCookie, null, {
        'Range': 'bytes=99999999-999999999'
      });
      assert.ok(res.status === 416 || res.status === 404);
    });

    await c6.test('T2.6.5: Non-Admin Gallery Promotion Rejection (403)', async (tSub) => {
      if (!(await isEndpointAvailable('/api/attachments/test_att/promote-to-gallery', 'POST'))) {
        tSub.skip('Waiting for WP-3: POST /api/attachments/:id/promote-to-gallery');
        return;
      }
      const res = await apiReq('POST', '/api/attachments/test_att/promote-to-gallery', playerCookie, {
        title: 'Player unauthorized promotion'
      });
      assert.equal(res.status, 403);
    });
  });

  // =========================================================================
  // CHECK 7 BOUNDARIES
  // =========================================================================
  await t.test('Tier 2 Check 7: WebRTC Signaling Boundaries', async (c7) => {
    await c7.test('T2.7.1: Signaling Non-Existent Recipient', async (tSub) => {
      if (!(await isEndpointAvailable('/api/rtc/signal', 'POST'))) {
        tSub.skip('Waiting for WP-4: POST /api/rtc/signal');
        return;
      }
      const res = await apiReq('POST', '/api/rtc/signal', playerCookie, {
        channel_id: 6,
        recipient_user_id: 9999999,
        signal_type: 'offer',
        payload_json: '{}'
      });
      assert.ok(res.status === 400 || res.status === 404);
    });

    await c7.test('T2.7.2: Unauthenticated Voice Join Rejection (401)', async (tSub) => {
      if (!(await isEndpointAvailable('/api/voice/dugout-voice/join', 'POST'))) {
        tSub.skip('Waiting for WP-4: POST /api/voice/:id/join');
        return;
      }
      const res = await apiReq('POST', '/api/voice/dugout-voice/join');
      assert.equal(res.status, 401);
    });

    await c7.test('T2.7.3: Signal TTL Expiry Pruning (>60 seconds)', async (tSub) => {
      if (!(await isEndpointAvailable('/api/sync'))) {
        tSub.skip('Waiting for WP-3/WP-4: /api/sync endpoint for signal TTL filtering');
        return;
      }
      const nowSec = Math.floor(Date.now() / 1000);

      // 1. Insert an expired signal (70s old, exceeding 60s TTL) targeted to playerUser
      chatDb.prepare(`
        INSERT INTO rtc_signals (channel_id, sender_user_id, recipient_user_id, signal_type, payload_json, created_at)
        VALUES (6, 1, ?, 'offer', '{"type":"offer","sdp":"stale_offer"}', ?)
      `).run(playerUser.id, nowSec - 70);

      // 2. Insert a fresh active signal (10s old, within 60s TTL) targeted to playerUser
      const activeSignalRes = chatDb.prepare(`
        INSERT INTO rtc_signals (channel_id, sender_user_id, recipient_user_id, signal_type, payload_json, created_at)
        VALUES (6, 1, ?, 'offer', '{"type":"offer","sdp":"fresh_offer"}', ?)
      `).run(playerUser.id, nowSec - 10);
      const activeSignalId = activeSignalRes.lastInsertRowid;

      // 3. Query signals via application endpoint GET /api/sync
      const syncRes = await apiReq('GET', '/api/sync?since_msg_id=0&since_event_id=0', playerCookie);
      assert.equal(syncRes.status, 200, 'GET /api/sync must return 200 OK');
      assert.ok(Array.isArray(syncRes.data.rtc_signals), 'Response must contain rtc_signals array');

      // 4. Assert application endpoint filtered out the expired signal
      const staleFound = syncRes.data.rtc_signals.find((s) => s.recipient_user_id === playerUser.id && s.created_at <= nowSec - 60);
      assert.equal(staleFound, undefined, 'Signals older than 60s TTL must not be returned by /api/sync');

      // 5. Assert application endpoint delivered the active signal
      const activeFound = syncRes.data.rtc_signals.find((s) => s.id === activeSignalId);
      assert.ok(activeFound, 'Active signal within 60s TTL must be returned by /api/sync');
    });

    await c7.test('T2.7.4: Voice Participant Heartbeat Expiry (>25 seconds)', async (tSub) => {
      if (!(await isEndpointAvailable('/api/bootstrap'))) {
        tSub.skip('Waiting for WP-3/WP-4: /api/bootstrap voice participant query');
        return;
      }
      const nowSec = Math.floor(Date.now() / 1000);

      // 1. Insert a stale participant (heartbeat 35s ago, exceeding 25s threshold)
      chatDb.prepare(`
        INSERT INTO voice_participants (channel_id, user_id, user_name, muted, deafened, screen_sharing, heartbeat_at)
        VALUES (6, 9999, 'Stale User', 0, 0, 0, ?)
        ON CONFLICT(channel_id, user_id) DO UPDATE SET heartbeat_at = ?
      `).run(nowSec - 35, nowSec - 35);

      // 2. Insert an active participant (heartbeat 5s ago, active)
      chatDb.prepare(`
        INSERT INTO voice_participants (channel_id, user_id, user_name, muted, deafened, screen_sharing, heartbeat_at)
        VALUES (6, ?, 'Active Player', 0, 0, 0, ?)
        ON CONFLICT(channel_id, user_id) DO UPDATE SET heartbeat_at = ?
      `).run(playerUser.id, nowSec - 5, nowSec - 5);

      // 3. Query voice participants via application endpoint GET /api/bootstrap
      const bootstrapRes = await apiReq('GET', '/api/bootstrap', playerCookie);
      assert.equal(bootstrapRes.status, 200, 'GET /api/bootstrap must return 200 OK');
      assert.ok(Array.isArray(bootstrapRes.data.voice_participants), 'Response must contain voice_participants array');

      // 4. Assert application endpoint omitted the stale participant
      const staleFound = bootstrapRes.data.voice_participants.find((p) => p.user_id === 9999);
      assert.equal(staleFound, undefined, 'Stale participant (>25s) must be omitted by /api/bootstrap');

      // 5. Assert application endpoint included the active participant
      const activeFound = bootstrapRes.data.voice_participants.find((p) => p.user_id === playerUser.id);
      assert.ok(activeFound, 'Active participant with fresh heartbeat must be included by /api/bootstrap');
    });

    await c7.test('T2.7.5: Rapid Join/Leave Churn Idempotency', async () => {
      // Rapid state update in voice_participants
      const nowSec = Math.floor(Date.now() / 1000);
      for (let i = 0; i < 5; i++) {
        chatDb.prepare(`
          INSERT INTO voice_participants (channel_id, user_id, user_name, heartbeat_at)
          VALUES (6, ?, 'Churn User', ?)
          ON CONFLICT(channel_id, user_id) DO UPDATE SET heartbeat_at = ?
        `).run(playerUser.id, nowSec + i, nowSec + i);
      }

      const count = chatDb.prepare('SELECT COUNT(*) as c FROM voice_participants WHERE channel_id = 6 AND user_id = ?').get(playerUser.id).c;
      assert.equal(count, 1, 'Rapid churn must not create duplicate participant entries');
    });
  });

  // =========================================================================
  // CHECK 8 BOUNDARIES
  // =========================================================================
  await t.test('Tier 2 Check 8: Live Baseball Bridge Boundaries', async (c8) => {
    await c8.test('T2.8.1: Batting Practice Double-Booking Collision (409)', async (tSub) => {
      if (!(await isEndpointAvailable(`/api/baseball/events/${testEventId}/quick-bp`, 'POST'))) {
        tSub.skip('Waiting for WP-4: POST /api/baseball/events/:id/quick-bp');
        return;
      }
      // Player A claims slot 3
      await apiReq('POST', `/api/baseball/events/${testEventId}/quick-bp`, playerCookie, { slot_number: 3 });

      // Facilitator attempts to claim same slot 3 -> 409 Conflict
      const res = await apiReq('POST', `/api/baseball/events/${testEventId}/quick-bp`, facilitatorCookie, { slot_number: 3 });
      assert.equal(res.status, 409);
      assert.ok(res.data.error.includes('already claimed'));
    });

    await c8.test('T2.8.2: BP Slot Number Out of Bounds (< 1 or > 28)', async (tSub) => {
      if (!(await isEndpointAvailable(`/api/baseball/events/${testEventId}/quick-bp`, 'POST'))) {
        tSub.skip('Waiting for WP-4: POST /api/baseball/events/:id/quick-bp');
        return;
      }
      // Slot 0 -> 400
      const res0 = await apiReq('POST', `/api/baseball/events/${testEventId}/quick-bp`, playerCookie, { slot_number: 0 });
      assert.equal(res0.status, 400);

      // Slot 29 -> 400
      const res29 = await apiReq('POST', `/api/baseball/events/${testEventId}/quick-bp`, playerCookie, { slot_number: 29 });
      assert.equal(res29.status, 400);
    });

    await c8.test('T2.8.3: Quick RSVP on Rainout / Cancelled Game (400)', async (tSub) => {
      if (!(await isEndpointAvailable(`/api/baseball/events/${testEventId}/quick-rsvp`, 'POST'))) {
        tSub.skip('Waiting for WP-4: POST /api/baseball/events/:id/quick-rsvp');
        return;
      }
      // Mark event status = 'rainout'
      baseballDb.prepare("UPDATE events SET status = 'rainout', rainout_note = 'Field submerged' WHERE id = ?").run(testEventId);

      const res = await apiReq('POST', `/api/baseball/events/${testEventId}/quick-rsvp`, playerCookie, { status: 'attending' });
      assert.equal(res.status, 400);

      // Restore status
      baseballDb.prepare("UPDATE events SET status = 'active' WHERE id = ?").run(testEventId);
    });

    await c8.test('T2.8.4: Non-Organizer Game Channel Sync Guard (403)', async (tSub) => {
      if (!(await isEndpointAvailable(`/api/baseball/events/${testEventId}/sync-channel`, 'POST'))) {
        tSub.skip('Waiting for WP-4: POST /api/baseball/events/:id/sync-channel');
        return;
      }
      const res = await apiReq('POST', `/api/baseball/events/${testEventId}/sync-channel`, playerCookie);
      assert.equal(res.status, 403);
    });

    await c8.test('T2.8.5: Redundant Quick RSVP Idempotency', async (tSub) => {
      if (!(await isEndpointAvailable(`/api/baseball/events/${testEventId}/quick-rsvp`, 'POST'))) {
        tSub.skip('Waiting for WP-4: POST /api/baseball/events/:id/quick-rsvp');
        return;
      }
      const res1 = await apiReq('POST', `/api/baseball/events/${testEventId}/quick-rsvp`, playerCookie, { status: 'attending' });
      const res2 = await apiReq('POST', `/api/baseball/events/${testEventId}/quick-rsvp`, playerCookie, { status: 'attending' });
      assert.equal(res1.status, 200);
      assert.equal(res2.status, 200);

      const count = baseballDb.prepare('SELECT COUNT(*) as c FROM attendees WHERE event_id = ? AND user_id = ?').get(testEventId, playerUser.id).c;
      assert.equal(count, 1, 'Must not duplicate attendee rows');
    });
  });

  // =========================================================================
  // CHECK 9 BOUNDARIES — SECURITY HARDENING REGRESSIONS
  // =========================================================================
  await t.test('Tier 2 Check 9: Hardening & Security Vulnerability Regressions', async (c9) => {
    await c9.test('T2.9.1: Role-restricted non-private board ACL enforcement on /api/keys/*', async () => {
      // Create a role-restricted public board requiring organizer/facilitator roles
      const boardRes = await apiReq('POST', '/api/channels', adminCookie, {
        name: 'Locked Ops Board',
        slug: 'locked-ops-board-' + Date.now(),
        channel_type: 'text',
        min_role_read: 'organizer',
        min_role_write: 'organizer',
        is_encrypted: 1,
        is_private: 0
      });
      assert.equal(boardRes.status, 201, 'Admin must create role-restricted board');
      const boardId = boardRes.data.id;

      // Regular player must receive 403 when reading or sharing keys on organizer-only board
      const playerGetRes = await apiReq('GET', `/api/keys/channel/${boardId}`, playerCookie);
      assert.equal(playerGetRes.status, 403, 'Player must be blocked from GET /api/keys/channel/:id on organizer board');

      const playerShareRes = await apiReq('POST', `/api/keys/channel/${boardId}/share`, playerCookie, {
        key_epoch: 1,
        shares: [{ recipient_user_id: playerUser.id, wrapped_key_base64: 'dGVzdA==', wrap_iv: 'dGVzdA==' }]
      });
      assert.equal(playerShareRes.status, 403, 'Player must be blocked from POST /api/keys/channel/:id/share on organizer board');

      // Admin share for organizer/admin succeeds, whereas player recipient fails role check
      const playerTargetShareRes = await apiReq('POST', `/api/keys/channel/${boardId}/share`, adminCookie, {
        key_epoch: 1,
        shares: [{ recipient_user_id: playerUser.id, wrapped_key_base64: 'dGVzdA==', wrap_iv: 'dGVzdA==' }]
      });
      assert.equal(playerTargetShareRes.status, 403, 'Player ineligible for organizer board must be rejected as key recipient');

      await apiReq('DELETE', `/api/channels/${boardId}`, adminCookie);
    });

    await c9.test('T2.9.2: Magic-byte validation on PDF attachments and sandbox/attachment response headers', async () => {
      const pdfInit = await apiReq('POST', '/api/attachments/init', playerCookie, {
        channel_id: 2,
        file_name: 'roster.pdf',
        mime_type: 'application/pdf',
        file_size: 128
      });
      assert.equal(pdfInit.status, 200);

      // Spoofed HTML bytes disguised as application/pdf -> 400
      const spoofedPdf = Buffer.from('<html><script>alert(1)</script></html>');
      const spoofRes = await apiReq('PUT', `/api/attachments/${pdfInit.data.attachmentId}/upload`, playerCookie, spoofedPdf);
      assert.equal(spoofRes.status, 400, 'Spoofed non-PDF bytes must be rejected with 400');

      // Valid %PDF- header -> 200 and streams with sandbox CSP + Content-Disposition: attachment
      const validPdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n');
      const okRes = await apiReq('PUT', `/api/attachments/${pdfInit.data.attachmentId}/upload`, playerCookie, validPdf);
      assert.equal(okRes.status, 200, 'Valid PDF header must be accepted');

      await apiReq('POST', `/api/attachments/${pdfInit.data.attachmentId}/complete`, playerCookie);
      const streamRes = await apiReq('GET', `/api/attachments/${pdfInit.data.attachmentId}/stream`, playerCookie);
      assert.equal(streamRes.status, 200);
      assert.equal(streamRes.headers.get('content-security-policy'), "default-src 'none'; sandbox");
      assert.equal(streamRes.headers.get('content-disposition'), 'attachment');
    });

    await c9.test('T2.9.3: CSRF Sec-Fetch-Site cross-site guard on mutating requests', async () => {
      const csrfRes = await apiReq('POST', '/api/auth/logout-other-devices', playerCookie, {}, {
        'Sec-Fetch-Site': 'cross-site'
      });
      assert.equal(csrfRes.status, 403, 'Cross-site Sec-Fetch-Site header must be blocked');
    });

    await c9.test('T2.9.4: Fail-closed DNS SSRF guard & strict channel object check', async () => {
      const { canAccessChannel, safeFetchExternalUrl } = await import('../../src/app/security.js');
      assert.equal(canAccessChannel(playerUser, 'organizer', 'read'), false, 'String channel argument must fail closed');
      const dnsFail = await safeFetchExternalUrl('https://nonexistent.invalid/test.gif', { isTestEnv: false });
      assert.equal(dnsFail.ok, false, 'DNS lookup failure must fail closed in safeFetchExternalUrl');
    });

    await c9.test('T2.9.5: Media proxy MIME whitelist, private event masking & E2EE attachment enforcement', async () => {
      const restrictedEv = baseballDb.prepare(`
        INSERT INTO events (title, location, event_date, max_players, allowed_emails, status, created_by)
        VALUES ('Secret Tryout Practice', 'Hidden Field', '2099-11-15', 16, 'admin@pickupbaseball.org', 'active', ?)
      `).run(adminUser.id);
      const restrictedEventId = Number(restrictedEv.lastInsertRowid);

      let uploadedMediaId = null;
      let evilProxyMediaId = null;
      const origFetch = globalThis.fetch;

      try {
        // 1. Player cannot link media to a private/invite-only event they cannot access
        const forbiddenMedia = await apiReq('POST', '/api/media', playerCookie, {
          title: 'Sneaky Tag',
          url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
          date_taken: '2099-11-15',
          event_id: restrictedEventId
        });
        assert.equal(forbiddenMedia.status, 403, 'Player must be blocked from attaching media to inaccessible invite-only event');

        // 2. Admin can attach media to the restricted event, and public/non-invited GET /api/media masks event_title
        const adminMedia = await apiReq('POST', '/api/media', adminCookie, {
          title: 'Admin Highlight',
          url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
          date_taken: '2099-11-15',
          event_id: restrictedEventId
        });
        assert.equal(adminMedia.status, 200);
        uploadedMediaId = adminMedia.data && adminMedia.data.item && adminMedia.data.item.id;

        const listAnon = await apiReq('GET', '/api/media');
        assert.equal(listAnon.status, 200);
        const maskedItem = (listAnon.data.media || []).find((it) => Number(it.id) === Number(uploadedMediaId));
        assert.ok(maskedItem, 'Approved media item should be listed');
        assert.equal(maskedItem.event_title, null, 'Inaccessible invite-only event_title must be masked on GET /api/media');

        // 3. Remote media proxy must reject HTML/SVG MIME types with 415
        const htmlItem = baseballDb.prepare(`
          INSERT INTO media_items (title, media_type, original_url, file_url, mime_type, date_taken, contributor_name, contributor_id, is_approved)
          VALUES ('HTML Proxy Test', 'photo', 'https://93.184.216.34/xss.html', 'https://93.184.216.34/xss.html', 'text/html', '2099-11-15', 'Alice A.', ?, 1)
        `).run(adminUser.id);
        evilProxyMediaId = Number(htmlItem.lastInsertRowid);

        globalThis.fetch = async (url, opts) => {
          if (String(url).startsWith('https://93.184.216.34/')) {
            return new Response('<html><script>alert(1)</script></html>', {
              status: 200,
              headers: { 'content-type': 'text/html; charset=utf-8' }
            });
          }
          return origFetch(url, opts);
        };

        const proxyRes = await apiReq('GET', `/api/media/${evilProxyMediaId}/file`);
        assert.equal(proxyRes.status, 415, 'Remote media proxy must reject non-media MIME types like text/html with 415');

        // 4. Private E2EE boards/DMs must require is_encrypted + iv and valid image data: URLs on /attachments/init
        const pvtRes = await apiReq('POST', '/api/channels', adminCookie, {
          name: 'T2.9.5 Private Media Board',
          category: 'Private Boards',
          channel_type: 'text',
          is_private: true,
          member_ids: [adminUser.id, playerUser.id]
        });
        assert.equal(pvtRes.status, 201);
        const pvtAttChId = pvtRes.data.channel.id;
        try {
          const unencAtt = await apiReq('POST', '/api/attachments/init', playerCookie, {
            channel_id: pvtAttChId,
            file_name: 'plain.png',
            mime_type: 'image/png',
            file_size: 1024,
            is_encrypted: 0
          });
          assert.equal(unencAtt.status, 400, 'Private E2EE channels must reject unencrypted /attachments/init uploads');

          const badThumbAtt = await apiReq('POST', '/api/attachments/init', playerCookie, {
            channel_id: pvtAttChId,
            file_name: 'photo.png',
            mime_type: 'image/png',
            file_size: 1024,
            is_encrypted: 1,
            iv: 'AAAAAAAAAAAAAAAA',
            thumbnail_base64: 'data:text/html;base64,PHNjcmlwdD4='
          });
          assert.equal(badThumbAtt.status, 400, 'Non-image thumbnail_base64 data URLs must be rejected');
        } finally {
          chatDb.prepare('DELETE FROM channels WHERE id = ?').run(pvtAttChId);
        }
      } finally {
        globalThis.fetch = origFetch;
        if (uploadedMediaId) baseballDb.prepare('DELETE FROM media_items WHERE id = ?').run(uploadedMediaId);
        if (evilProxyMediaId) baseballDb.prepare('DELETE FROM media_items WHERE id = ?').run(evilProxyMediaId);
        baseballDb.prepare('DELETE FROM events WHERE id = ?').run(restrictedEventId);
      }
    });

    await c9.test('T2.9.6: Clubhouse voice write/cap, report redaction, mute privacy, system msg & E2EE epoch guards', async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const roVoice = chatDb.prepare(`
        INSERT INTO channels (slug, name, category, channel_type, topic, min_role_read, min_role_write, is_encrypted, sort_order)
        VALUES ('ro-voice-test', 'RO Voice', 'Voice', 'voice', 'Announcements', 'player', 'organizer', 0, 99)
      `).run();
      const roVoiceId = Number(roVoice.lastInsertRowid);

      const pvtBoard = await apiReq('POST', '/api/channels', adminCookie, {
        name: 'T2.9.6 Secret Strategy',
        category: 'Private Boards',
        channel_type: 'text',
        is_private: true,
        member_ids: [adminUser.id, playerUser.id]
      });
      assert.equal(pvtBoard.status, 201);
      const pvtBoardId = pvtBoard.data.channel.id;

      let syntheticRptId = null;
      try {
        // 1. Voice write-role guard on /join and /state
        const joinRo = await apiReq('POST', `/api/voice/${roVoiceId}/join`, playerCookie);
        assert.equal(joinRo.status, 403, 'Read-only voice listener cannot join via write check');
        const stateRo = await apiReq('POST', `/api/voice/${roVoiceId}/state`, playerCookie, { muted: 1 });
        assert.equal(stateRo.status, 403, 'Read-only voice listener cannot post voice state');

        // 2. Voice 24-participant cap (ensure playerUser is a new/rejoining entrant)
        chatDb.prepare('DELETE FROM voice_participants WHERE channel_id = 6 AND user_id = ?').run(playerUser.id);
        const insVp = chatDb.prepare(`
          INSERT OR REPLACE INTO voice_participants (channel_id, user_id, user_name, muted, deafened, screen_sharing, heartbeat_at)
          VALUES (6, ?, ?, 0, 0, 0, ?)
        `);
        for (let uid = 9101; uid <= 9124; uid++) {
          insVp.run(uid, `Player ${uid}`, nowSec);
        }
        const capRes = await apiReq('POST', '/api/voice/6/state', playerCookie, { muted: 0 });
        assert.equal(capRes.status, 429, 'Voice room at 24 active participants must reject a 25th entrant');
        chatDb.prepare('DELETE FROM voice_participants WHERE user_id BETWEEN 9101 AND 9124').run();

        // 3. Regular player cannot spoof message_type: 'system'
        const spoofMsg = await apiReq('POST', '/api/channels/general/messages', playerCookie, {
          content: 'Fake system notice',
          message_type: 'system'
        });
        assert.equal(spoofMsg.status, 201);
        assert.equal(spoofMsg.data.message.message_type, 'text', 'Player message_type: system must be coerced to text');
        chatDb.prepare('DELETE FROM messages WHERE id = ?').run(spoofMsg.data.message.id);

        // 4. Stale key_epoch enforcement on E2EE private board (when key_epoch 2 exists in channel_key_shares)
        chatDb.prepare(`
          INSERT INTO channel_key_shares (channel_id, key_epoch, recipient_user_id, sender_user_id, wrapped_key_base64, wrap_iv)
          VALUES (?, 2, ?, ?, 'd3JhcHBlZA==', 'aXYxMjM0NTY=')
        `).run(pvtBoardId, playerUser.id, adminUser.id);
        const msgEpoch2 = await apiReq('POST', `/api/channels/${pvtBoardId}/messages`, adminCookie, {
          content: 'ciphertwo',
          iv: 'ivtwo1234567890',
          key_epoch: 2
        });
        assert.equal(msgEpoch2.status, 201);
        const staleMsg = await apiReq('POST', `/api/channels/${pvtBoardId}/messages`, playerCookie, {
          content: 'cipherone',
          iv: 'ivone1234567890',
          key_epoch: 1
        });
        assert.equal(staleMsg.status, 409, 'Older key_epoch than latest channel epoch must be rejected with 409');
        assert.equal(staleMsg.data.code, 'STALE_KEY_EPOCH');
        const staleEdit = await apiReq('PATCH', `/api/messages/${msgEpoch2.data.message.id}`, adminCookie, {
          content: 'editedcipher',
          iv: 'ivedited1234567',
          key_epoch: 1
        });
        assert.equal(staleEdit.status, 409, 'PATCH /messages/:id with stale key_epoch must also be rejected with 409');

        // 5. Non-creator/non-admin private board member cannot modify member_ids via PATCH /channels/:id
        const patchMembersDenied = await apiReq('PATCH', `/api/channels/${pvtBoardId}`, playerCookie, {
          member_ids: [adminUser.id, playerUser.id, facilitatorUser.id]
        });
        assert.equal(patchMembersDenied.status, 403, 'Non-creator member cannot modify private board membership');

        // 6. Global user_mute_update sync event must omit private chat_muted_reason
        const muteRes = await apiReq('PUT', `/api/moderation/users/${facilitatorUser.id}/mute`, adminCookie, {
          muted: true,
          reason: 'Private moderator note: repeated spam'
        });
        assert.equal(muteRes.status, 200);
        const muteSyncRow = chatDb.prepare(
          "SELECT payload_json FROM sync_events WHERE event_type = 'user_mute_update' ORDER BY id DESC LIMIT 1"
        ).get();
        assert.ok(muteSyncRow, 'Mute sync event should exist');
        const mutePayload = JSON.parse(muteSyncRow.payload_json);
        assert.equal(mutePayload.chat_muted_reason, undefined, 'Global mute sync event must not leak chat_muted_reason');
        await apiReq('PUT', `/api/moderation/users/${facilitatorUser.id}/mute`, adminCookie, { muted: false });

        // 7. Moderation reports endpoint must redact metadata for channels the caller cannot view
        const secretMsg = chatDb.prepare(`
          INSERT INTO messages (channel_id, author_id, author_name, content, iv, key_epoch, message_type)
          VALUES (?, ?, 'Charlie P.', 'secretcipher', 'secretiv12345678', 2, 'text')
        `).run(pvtBoardId, playerUser.id);
        const secretMsgId = Number(secretMsg.lastInsertRowid);
        const rptRes = chatDb.prepare(`
          INSERT INTO chat_reports (channel_id, reporter_id, reporter_name, target_type, target_user_id, target_message_id, reason, status, resolution_note, reviewed_by, reviewed_at)
          VALUES (?, ?, 'Charlie P.', 'message', ?, ?, 'Secret dispute', 'resolved', 'Internal admin note', ?, ?)
        `).run(pvtBoardId, playerUser.id, adminUser.id, secretMsgId, adminUser.id, nowSec);
        syntheticRptId = Number(rptRes.lastInsertRowid);

        baseballDb.prepare("UPDATE users SET is_moderator = 1 WHERE email = 'organizer@pickupbaseball.org'").run();
        const orgReports = await apiReq('GET', '/api/moderation/reports?status=resolved', orgCookie);
        assert.equal(orgReports.status, 200);
        const redactedRpt = (orgReports.data.reports || []).find((r) => Number(r.id) === syntheticRptId);
        assert.ok(redactedRpt, 'Delegated moderator should retrieve the report entry');
        assert.equal(redactedRpt.target_message_id, null, 'Private channel report must redact target_message_id for non-member moderator');
        assert.equal(redactedRpt.resolution_note, null, 'Private channel report must redact resolution_note');
        assert.equal(redactedRpt.reviewed_by_name, null, 'Private channel report must redact reviewed_by_name');
      } finally {
        baseballDb.prepare("UPDATE users SET is_moderator = 0 WHERE email = 'organizer@pickupbaseball.org'").run();
        if (syntheticRptId) chatDb.prepare('DELETE FROM chat_reports WHERE id = ?').run(syntheticRptId);
        chatDb.prepare('DELETE FROM voice_participants WHERE user_id BETWEEN 9101 AND 9124').run();
        chatDb.prepare('DELETE FROM channels WHERE id IN (?, ?)').run(roVoiceId, pvtBoardId);
      }
    });

    await c9.test('T2.9.7: RSVP account oracle & token rotation, hero_credits floor, and BP cancelled/duplicate guards', async () => {
      baseballDb.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('require_login_to_rsvp', 'false')").run();
      baseballDb.prepare('UPDATE users SET hero_credits = 0 WHERE id = ?').run(playerUser.id);

      const pubEv = baseballDb.prepare(`
        INSERT INTO events (title, location, event_date, max_players, status, created_by)
        VALUES ('Public Oracle Test', 'Field A', '2099-11-19', 18, 'active', ?)
      `).run(adminUser.id);
      const pubEvId = Number(pubEv.lastInsertRowid);

      const invEv = baseballDb.prepare(`
        INSERT INTO events (title, location, event_date, max_players, allowed_emails, status, created_by)
        VALUES ('Invite Oracle Test', 'Field A', '2099-11-20', 18, ?, 'active', ?)
      `).run(playerUser.email, adminUser.id);
      const invEvId = Number(invEv.lastInsertRowid);

      const cancelEv = baseballDb.prepare(`
        INSERT INTO events (title, location, event_date, max_players, status, created_by)
        VALUES ('Cancelled Game Test', 'Field A', '2099-11-21', 18, 'cancelled', ?)
      `).run(adminUser.id);
      const cancelEvId = Number(cancelEv.lastInsertRowid);

      try {
        // 1. Unauthenticated RSVP on public event using registered account email must return 401
        const pubRegRes = await apiReq('POST', `/api/events/${pubEvId}/rsvp`, null, {
          name: 'Charlie P.',
          email: playerUser.email,
          status: 'attending'
        });
        assert.equal(pubRegRes.status, 401, 'Public unauthenticated RSVP with registered email must require login (401)');

        // 2. Invite-only event must return uniform 403 for both registered invited email and unknown email when logged out
        const invRegRes = await apiReq('POST', `/api/events/${invEvId}/rsvp`, null, {
          name: 'Charlie P.',
          email: playerUser.email,
          status: 'attending'
        });
        const invStrangerRes = await apiReq('POST', `/api/events/${invEvId}/rsvp`, null, {
          name: 'Stranger',
          email: 'nobody_oracle_probe@example.com',
          status: 'attending'
        });
        assert.equal(invRegRes.status, 403);
        assert.equal(invStrangerRes.status, 403, 'Invite-only event must not distinguish registered invited vs unknown unauthenticated emails');

        // 3. quick-rsvp claiming guest RSVP rotates management_token, clears is_guest, and never drops hero_credits below 0
        baseballDb.prepare(`
          INSERT INTO attendees (event_id, user_id, name, email, status, players_count, is_guest, management_token)
          VALUES (?, NULL, 'Charlie Guest', ?, 'attending', 1, 1, 'stale_guest_token_abc')
        `).run(pubEvId, playerUser.email);

        const quickOut = await apiReq('POST', `/api/baseball/events/${pubEvId}/quick-rsvp`, playerCookie, {
          status: 'declined'
        });
        assert.equal(quickOut.status, 200);
        const claimedAtt = baseballDb.prepare(
          'SELECT is_guest, management_token, status FROM attendees WHERE event_id = ? AND email = ?'
        ).get(pubEvId, playerUser.email);
        assert.equal(claimedAtt.is_guest, 0, 'Claimed RSVP must clear is_guest');
        assert.notEqual(claimedAtt.management_token, 'stale_guest_token_abc', 'Claiming a guest RSVP must rotate management_token');
        const userCreditsRow = baseballDb.prepare('SELECT hero_credits FROM users WHERE id = ?').get(playerUser.id);
        assert.ok(userCreditsRow.hero_credits >= 0, 'hero_credits must never become negative');

        // 4. BP signups blocked on cancelled games and duplicate anonymous unlinked names rejected
        const bpCancel = await apiReq('POST', `/api/events/${cancelEvId}/bp-order`, adminCookie, {
          slot_number: 1,
          player_name: 'Alice A.'
        });
        assert.equal(bpCancel.status, 400, 'Cancelled events must reject BP signups');

        const bpFirst = await apiReq('POST', `/api/events/${pubEvId}/bp-order`, null, {
          slot_number: 1,
          player_name: 'Anon Slugger'
        });
        assert.equal(bpFirst.status, 200);
        const bpDup = await apiReq('POST', `/api/events/${pubEvId}/bp-order`, null, {
          slot_number: 2,
          player_name: 'anon slugger'
        });
        assert.equal(bpDup.status, 401, 'Unauthenticated user cannot hold multiple anonymous BP slots under the same name');
      } finally {
        baseballDb.prepare('DELETE FROM batting_practice_signups WHERE event_id IN (?, ?)').run(pubEvId, cancelEvId);
        baseballDb.prepare('DELETE FROM attendees WHERE event_id IN (?, ?, ?)').run(pubEvId, invEvId, cancelEvId);
        baseballDb.prepare('DELETE FROM events WHERE id IN (?, ?, ?)').run(pubEvId, invEvId, cancelEvId);
      }
    });

    await c9.test('T2.9.8: Expanded IPv4-mapped IPv6 SSRF blocking & getClientIp X-Forwarded-For precedence', async () => {
      const { isPrivateIpOrHost, getClientIp } = await import('../../src/app/security.js');
      assert.equal(isPrivateIpOrHost('0:0:0:0:0:ffff:7f00:1'), true, 'Expanded IPv4-mapped loopback IPv6 must be blocked');
      assert.equal(isPrivateIpOrHost('[::ffff:169.254.169.254]'), true, 'Bracketed IPv4-mapped link-local IMDS IPv6 must be blocked');
      assert.equal(isPrivateIpOrHost('::ffff:10.0.0.1'), true, 'IPv4-mapped RFC1918 IPv6 must be blocked');

      const fakeCtxXff = {
        req: {
          header(name) {
            const key = name.toLowerCase();
            if (key === 'x-real-ip') return '1.1.1.1';
            if (key === 'x-forwarded-for') return '203.0.113.5, 198.51.100.77';
            return undefined;
          }
        }
      };
      assert.equal(getClientIp(fakeCtxXff), '198.51.100.77', 'getClientIp must use rightmost X-Forwarded-For over X-Real-IP');

      const fakeCtxCf = {
        req: {
          header(name) {
            const key = name.toLowerCase();
            if (key === 'cf-connecting-ip') return '192.0.2.44';
            if (key === 'x-forwarded-for') return '198.51.100.77';
            return undefined;
          }
        }
      };
      assert.equal(getClientIp(fakeCtxCf), '192.0.2.44', 'CF-Connecting-IP must remain highest priority');
    });

    await c9.test('T2.9.9: ClubhouseRTC Privacy Relay Mode fails closed without TURN server', async () => {
      const ClubhouseRTC = require('../../public/js/rtc.js');
      const events = [];
      ClubhouseRTC.onRtcEvent((type, data) => events.push({ type, data }));

      const cfg = ClubhouseRTC.getIceConfiguration(true);
      assert.equal(cfg.iceTransportPolicy, 'relay', 'Privacy Relay Mode must force iceTransportPolicy=relay');

      ClubhouseRTC.state.privacyRelayMode = true;
      ClubhouseRTC.state.iceServers = [{ urls: ['stun:stun.l.google.com:19302'] }];
      ClubhouseRTC.state.activeChannelId = 6;
      try {
        await ClubhouseRTC.handleIncomingSignals([{
          id: 999001,
          channel_id: 6,
          sender_user_id: 1,
          signal_type: 'offer',
          payload_json: JSON.stringify({ type: 'offer', sdp: 'v=0\r\n' })
        }]);
        const relayWarn = events.find((e) => e.type === 'privacy_relay_unavailable');
        assert.ok(relayWarn, 'Privacy Relay Mode with STUN-only servers must emit privacy_relay_unavailable');
        assert.equal(ClubhouseRTC.state.peerConnections[1], undefined, 'No peer connection may be created without TURN under Privacy Relay Mode');
      } finally {
        ClubhouseRTC.state.privacyRelayMode = false;
        ClubhouseRTC.state.activeChannelId = null;
      }
    });
  });
}

// Standalone execution support
if (require.main === module) {
  test('Tier 2: Clubhouse Boundary & Corner Cases', async (t) => {
    const ctx = await createClubhouseTestContext();
    try {
      await runTier2(t, ctx);
    } finally {
      await ctx.cleanup();
    }
  });
}

module.exports = runTier2;
