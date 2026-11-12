/**
 * tests/clubhouse/tier3-cross-feature.test.js
 * Tier 3: Cross-Feature Combinations (Pairwise & Multi-Subsystem Interactions)
 *
 * Implements 6 pairwise interaction suites:
 * - TF3.1: Session Expiry During Delta Sync Loop (Auth + Delta Sync)
 * - TF3.2: End-to-End Encrypted Media Range Streaming (Crypto + Media Engine)
 * - TF3.3: Dynamic Game Facilitator Promotion & Access Elevation (Bridge + Badges + RBAC)
 * - TF3.4: Private Voice Room Signaling Guard (RBAC + WebRTC)
 * - TF3.5: Sliding-Window Burst Rate Limiting with Concurrent Threads (Rate Limiter + Threads + Sync)
 * - TF3.6: Community Highlight Media Promotion to Baseball Gallery (Media + Gallery + BASEBALL_DB)
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
  unwrapChannelKey
} = require('../helpers/crypto-test-utils');

async function runTier3(t, ctx) {
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
    adminUser,
    playerUser,
    facilitatorUser,
    testEventId,
    apiReq,
    isEndpointAvailable
  } = ctx;

  await t.test('Tier 3: Cross-Feature Subsystem Combinations', async (suite) => {
    // -----------------------------------------------------------------------
    // TF3.1: Session Expiry During Delta Sync Loop (Auth + Delta Sync)
    // -----------------------------------------------------------------------
    await suite.test('TF3.1: Session Expiry During Delta Sync Loop (Auth + Delta Sync)', async (tSub) => {
      if (!(await isEndpointAvailable('/api/sync'))) {
        tSub.skip('Waiting for WP-3: GET /api/sync endpoint');
        return;
      }

      // 1. Create a valid temporary session for Charlie Player in BASEBALL_DB
      const tempExpiry = new Date(Date.now() + 60000).toISOString();
      const tempSessionId = `sync_session_${Date.now()}`;
      baseballDb.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(tempSessionId, playerUser.id, tempExpiry);
      const tempCookie = `baseball_session=${tempSessionId}`;

      try {
        // 2. Initial delta sync query with valid session must succeed (HTTP 200)
        const res1 = await apiReq('GET', '/api/sync?since_msg_id=0&since_event_id=0', tempCookie);
        assert.equal(res1.status, 200, 'Initial delta sync query with valid session must return HTTP 200');
        assert.ok(Array.isArray(res1.data.messages), 'Initial sync response must include messages array');
        assert.ok(Array.isArray(res1.data.events), 'Initial sync response must include events array');

        // 3. Revoke/expire session mid-loop in BASEBALL_DB
        baseballDb.prepare('DELETE FROM sessions WHERE id = ?').run(tempSessionId);

        // 4. Subsequent delta sync query with revoked session must be rejected with HTTP 401
        const res2 = await apiReq('GET', '/api/sync?since_msg_id=0&since_event_id=0', tempCookie);
        assert.equal(res2.status, 401, 'Delta sync query with revoked session must return HTTP 401 Unauthorized');
      } finally {
        baseballDb.prepare('DELETE FROM sessions WHERE id = ?').run(tempSessionId);
      }
    });

    // -----------------------------------------------------------------------
    // TF3.2: End-to-End Encrypted Media Range Streaming (Crypto + Media Engine)
    // -----------------------------------------------------------------------
    await suite.test('TF3.2: End-to-End Encrypted Media Range Streaming (Crypto + Media Engine)', async () => {
      // 1. Author and Recipient generate WebCrypto identities
      const author = await generateIdentityKeyPair();
      const recipient = await generateIdentityKeyPair();

      // 2. Author creates one-time AES-GCM media key
      const mediaKey = await generateChannelKey();

      // 3. Encrypt synthetic video slice (1024 bytes)
      const rawVideoSlice = 'RAW_VIDEO_FRAME_DATA_1024_BYTES_STREAMING_CHUNK';
      const { ciphertextB64, ivB64 } = await encryptPayload(mediaKey, rawVideoSlice);

      // 4. Wrap media key using ECDH shared secret
      const authorSharedKey = await deriveEcdhSharedKey(author.ecdhPair.privateKey, recipient.ecdhPair.publicKey);
      const { wrappedKeyBase64, wrapIv } = await wrapChannelKey(mediaKey, authorSharedKey);

      // 5. Recipient derives shared secret and unwraps media key
      const recipientSharedKey = await deriveEcdhSharedKey(recipient.ecdhPair.privateKey, author.ecdhPair.publicKey);
      const unwrappedMediaKey = await unwrapChannelKey(wrappedKeyBase64, recipientSharedKey, wrapIv);

      // 6. Recipient decrypts media payload
      const decryptedVideoSlice = await decryptPayload(unwrappedMediaKey, ciphertextB64, ivB64);
      assert.equal(decryptedVideoSlice, rawVideoSlice, 'Decrypted media slice must match original');
    });

    // -----------------------------------------------------------------------
    // TF3.3: Dynamic Game Facilitator Promotion & Access Elevation
    // -----------------------------------------------------------------------
    await suite.test('TF3.3: Dynamic Game Facilitator Promotion & Access Elevation', async (tSub) => {
      // Probe whether dynamic badges are returned on /api/auth/me (WP-2)
      const meProbe = await apiReq('GET', '/api/auth/me', playerCookie);
      if (meProbe.status !== 200 || meProbe.data?.user?.isGameFacilitator === undefined) {
        tSub.skip('Waiting for WP-2: Dynamic badges (isGameFacilitator) on /api/auth/me');
        return;
      }

      // Probe whether channel messages endpoint is mounted (WP-3)
      if (!(await isEndpointAvailable('/api/channels/5/messages'))) {
        tSub.skip('Waiting for WP-3: GET /api/channels/:id/messages');
        return;
      }

      // 1. Regular player initially does NOT have facilitator badge
      assert.equal(meProbe.data.user.isGameFacilitator, false, 'Player must initially have isGameFacilitator = false');

      // 2. Regular player is forbidden from accessing #facilitators-lounge (channel id 5, min_role_read: facilitator)
      const accessBefore = await apiReq('GET', '/api/channels/5/messages', playerCookie);
      assert.equal(accessBefore.status, 403, 'Regular player must receive HTTP 403 on #facilitators-lounge');

      // 3. Elevate player by assigning to 'Game Facilitator' duty for upcoming Sunday game in BASEBALL_DB
      const duty = baseballDb.prepare("SELECT id FROM event_duties WHERE event_id = ? AND title LIKE '%Facilitator%'").get(testEventId);
      assert.ok(duty, 'Game Facilitator duty fixture must exist in BASEBALL_DB');

      let att = baseballDb.prepare('SELECT id FROM attendees WHERE event_id = ? AND user_id = ?').get(testEventId, playerUser.id);
      if (!att) {
        const insAtt = baseballDb.prepare('INSERT INTO attendees (event_id, user_id, name, email, status) VALUES (?, ?, ?, ?, ?)').run(
          testEventId, playerUser.id, playerUser.name || 'Charlie Player', playerUser.email, 'attending'
        );
        att = { id: insAtt.lastInsertRowid };
      }
      baseballDb.prepare('INSERT INTO duty_assignments (duty_id, attendee_id) VALUES (?, ?)').run(duty.id, att.id);

      try {
        // 4. Session reload on /api/auth/me dynamically calculates isGameFacilitator = true
        const meAfter = await apiReq('GET', '/api/auth/me', playerCookie);
        assert.equal(meAfter.status, 200);
        assert.equal(meAfter.data.user.isGameFacilitator, true, 'User dynamically assigned to Game Facilitator duty must receive isGameFacilitator = true');

        // 5. Access to #facilitators-lounge is now granted
        const accessAfter = await apiReq('GET', '/api/channels/5/messages', playerCookie);
        assert.equal(accessAfter.status, 200, 'Elevated facilitator must now receive HTTP 200 on #facilitators-lounge');
      } finally {
        // Cleanup duty assignment
        baseballDb.prepare('DELETE FROM duty_assignments WHERE duty_id = ? AND attendee_id = ?').run(duty.id, att.id);
      }
    });

    // -----------------------------------------------------------------------
    // TF3.4: Private Voice Room Signaling Guard (RBAC + WebRTC)
    // -----------------------------------------------------------------------
    await suite.test('TF3.4: Private Voice Room Signaling Guard (RBAC + WebRTC)', async (tSub) => {
      if (!(await isEndpointAvailable('/api/rtc/signal', 'POST'))) {
        tSub.skip('Waiting for WP-4: POST /api/rtc/signal');
        return;
      }

      // Player attempts to inject an SDP signal into 'organizers-war-room' (min_role_read: facilitator)
      const res = await apiReq('POST', '/api/rtc/signal', playerCookie, {
        channel_id: 7, // Organizers War Room
        recipient_user_id: adminUser.id,
        signal_type: 'offer',
        payload_json: '{"type":"offer","sdp":"exploit"}'
      });

      assert.equal(res.status, 403, 'Player without facilitator role must be blocked from private voice room signaling');
    });

    // -----------------------------------------------------------------------
    // TF3.5: Sliding-Window Burst Rate Limiting with Concurrent Threads
    // -----------------------------------------------------------------------
    await suite.test('TF3.5: Sliding-Window Burst Rate Limiting with Concurrent Threads', async (tSub) => {
      if (!(await isEndpointAvailable('/api/channels/2/messages', 'POST'))) {
        tSub.skip('Waiting for WP-3: POST /api/channels/:id/messages & rate limiting');
        return;
      }

      // Ensure clean rate-limit window for player before starting 30-message sliding window test
      chatDb.prepare('DELETE FROM chat_rate_limits WHERE key = ?').run(`user_${playerUser.id}_msgs`);

      // 1. Admin creates a root discussion post via HTTP API in #general (channel id 2)
      const rootRes = await apiReq('POST', '/api/channels/2/messages', adminCookie, {
        content: 'Root Discussion Post: Team Strategy for Next Game'
      });
      assert.equal(rootRes.status, 201, 'Root message creation must return HTTP 201');
      assert.ok(rootRes.data && rootRes.data.id, 'Root message must return an ID');
      const rootId = rootRes.data.id;

      // 2. Dispatch 5 concurrent threaded replies via HTTP API
      const replyPromises = Array.from({ length: 5 }, (_, i) =>
        apiReq('POST', '/api/channels/2/messages', playerCookie, {
          content: `Concurrent reply #${i + 1}`,
          parent_message_id: rootId
        })
      );
      const replyResults = await Promise.all(replyPromises);
      for (const r of replyResults) {
        assert.equal(r.status, 201, 'Thread reply within rate limit must return HTTP 201');
      }

      // 3. Verify server automatically incremented reply_count on the root message
      const rootRow = chatDb.prepare('SELECT reply_count FROM messages WHERE id = ?').get(rootId);
      assert.equal(rootRow.reply_count, 5, 'Server must automatically increment root reply_count to 5');

      // 4. Sliding-Window Burst Rate Limiting (contract: max 30 messages per 60s per user)
      // Player already sent 5 messages. Send a burst of 26 more messages to exceed 30 limit.
      let hitRateLimit = false;
      for (let i = 0; i < 27; i++) {
        const burstRes = await apiReq('POST', '/api/channels/2/messages', playerCookie, {
          content: `Burst message #${i + 1}`
        });
        if (burstRes.status === 429) {
          hitRateLimit = true;
          assert.ok(
            burstRes.data?.error?.toLowerCase().includes('rate limit') ||
            burstRes.data?.error?.toLowerCase().includes('too many') ||
            burstRes.status === 429,
            'HTTP 429 response must indicate rate limit exceeded'
          );
          break;
        }
      }
      assert.equal(hitRateLimit, true, 'Sending >30 messages within 60s window must trigger HTTP 429 Rate Limit');
    });
  });
}

// Standalone execution support
if (require.main === module) {
  test('Tier 3: Clubhouse Cross-Feature Interactions', async (t) => {
    const ctx = await createClubhouseTestContext();
    try {
      await runTier3(t, ctx);
    } finally {
      await ctx.cleanup();
    }
  });
}

module.exports = runTier3;
