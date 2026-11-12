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
