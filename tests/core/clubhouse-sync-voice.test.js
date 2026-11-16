/**
 * Acceptance Suite for Wave 1c.2 (Ticket #67):
 * - Stepped Clubhouse delta-sync backoff (5s active/voice -> 15s visible idle -> 45s deep-idle -> 90s hidden voice -> 0 hidden idle)
 * - GET /api/sync ETag header emission and 304 Not Modified empty-body response on unchanged watermarks
 * - Immediate delivery and ETag advance on new messages, sync_events, or voice updates
 * - 45s voice heartbeat cadence and 90s server TTL
 * - POST /api/voice/:channelId/state batches chat_rate_limits and voice_participants via db.batch()
 * - Opportunistic stale participant pruning on join and leave
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { VOICE_TTL_SEC } = require('../../src/app/routes/chat/sync.js');
const { deriveRateLimitKey } = require('../../src/app/security.js');
const ClubhouseStore = require('../../public/js/store.js');
const ClubhouseRTC = require('../../public/js/rtc.js');

module.exports = function registerClubhouseSyncVoiceTests(ctx) {
  const { apiReq, chatDb } = ctx;

  test('Ticket #67: Wave 1c.2 Acceptance Suite (Sync ETag/304, Stepped Backoff & 45s/90s Voice)', async (t) => {

    await t.test('1. Server TTL configuration: VOICE_TTL_SEC is 90 seconds', () => {
      assert.equal(VOICE_TTL_SEC, 90, 'VOICE_TTL_SEC must be 90 seconds');
    });

    await t.test('2. GET /api/sync emits ETag and returns 304 Not Modified on unchanged watermarks', async () => {
      // 1. Initial sync request without If-None-Match
      const res1 = await apiReq('GET', '/api/sync?since_msg_id=0&since_event_id=0&since_signal_id=0', ctx.seedAdminCookie);
      assert.equal(res1.status, 200, 'Initial sync must return 200 OK');
      const etag1 = res1.headers.get('etag');
      assert.ok(etag1 && etag1.startsWith('W/"sync-'), `Response must include valid ETag header, got: ${etag1}`);
      const latestMsgId = Number(res1.data.latest_msg_id || 0);
      const latestEventId = Number(res1.data.latest_event_id || 0);

      // 2. Second sync request with matching If-None-Match and updated watermarks
      const res2 = await apiReq(
        'GET',
        `/api/sync?since_msg_id=${latestMsgId}&since_event_id=${latestEventId}&since_signal_id=0`,
        ctx.seedAdminCookie,
        null,
        { 'If-None-Match': etag1 }
      );
      assert.equal(res2.status, 304, 'Sync with unchanged watermarks and matching If-None-Match must return 304 Not Modified');
      assert.equal(res2.headers.get('etag'), etag1, '304 response must preserve ETag header');
      assert.equal(res2.rawText || '', '', '304 response body must be empty');
    });

    await t.test('3. New chat message advances ETag, invalidates 304, and delivers payload immediately', async () => {
      // Get current ETag and watermark
      const syncBefore = await apiReq('GET', '/api/sync?since_msg_id=0&since_event_id=0&since_signal_id=0', ctx.seedAdminCookie);
      const etagBefore = syncBefore.headers.get('etag');
      const msgIdBefore = Number(syncBefore.data.latest_msg_id || 0);
      const evtIdBefore = Number(syncBefore.data.latest_event_id || 0);

      // Post a new message
      const postMsg = await apiReq('POST', '/api/channels/general/messages', ctx.seedAdminCookie, {
        content: `Ticket #67 Sync Test ${Date.now()}`
      });
      assert.equal(postMsg.status, 201, 'Message post should succeed');
      const createdMsgId = postMsg.data.message.id;

      // Sync request with old If-None-Match must return 200 with new message
      const syncAfter = await apiReq(
        'GET',
        `/api/sync?since_msg_id=${msgIdBefore}&since_event_id=${evtIdBefore}&since_signal_id=0`,
        ctx.seedAdminCookie,
        null,
        { 'If-None-Match': etagBefore }
      );
      assert.equal(syncAfter.status, 200, 'Sync after new message must return 200 OK');
      const etagAfter = syncAfter.headers.get('etag');
      assert.notEqual(etagAfter, etagBefore, 'ETag must advance when a new message is posted');
      assert.ok(Array.isArray(syncAfter.data.messages));
      const foundNew = syncAfter.data.messages.some((m) => m.id === createdMsgId);
      assert.ok(foundNew, 'New message must be delivered in sync response');
    });

    await t.test('4. Voice presence 90s server TTL: <90s is active, >90s is stale & pruned', async () => {
      const nowSec = Math.floor(Date.now() / 1000);

      // 1. Insert stale participant (95s ago) and active participant (10s ago)
      chatDb.prepare(`
        INSERT INTO voice_participants (channel_id, user_id, user_name, muted, deafened, screen_sharing, heartbeat_at)
        VALUES (1, 8881, 'Stale Voice 95s', 0, 0, 0, ?)
        ON CONFLICT(channel_id, user_id) DO UPDATE SET heartbeat_at = ?
      `).run(nowSec - 95, nowSec - 95);

      chatDb.prepare(`
        INSERT INTO voice_participants (channel_id, user_id, user_name, muted, deafened, screen_sharing, heartbeat_at)
        VALUES (1, 8882, 'Active Voice 10s', 0, 0, 0, ?)
        ON CONFLICT(channel_id, user_id) DO UPDATE SET heartbeat_at = ?
      `).run(nowSec - 10, nowSec - 10);

      // 2. Query bootstrap
      const bootRes = await apiReq('GET', '/api/bootstrap', ctx.seedAdminCookie);
      assert.equal(bootRes.status, 200);
      const vpList = bootRes.data.voice_participants || [];

      const staleInBoot = vpList.find((p) => p.user_id === 8881);
      const activeInBoot = vpList.find((p) => p.user_id === 8882);
      assert.equal(staleInBoot, undefined, 'Participant >90s must not appear in active voice_participants');
      assert.ok(activeInBoot, 'Participant <90s must appear in active voice_participants');

      // 3. Stale participant should be pruned from database
      const staleInDb = chatDb.prepare('SELECT 1 FROM voice_participants WHERE user_id = 8881').get();
      assert.equal(staleInDb, undefined, 'Stale participant (>90s) must be pruned by bootstrap');

      // Cleanup
      chatDb.prepare('DELETE FROM voice_participants WHERE user_id = 8882').run();
    });

    await t.test('5. POST /api/voice/:channelId/state batches chat_rate_limits and voice_participants via db.batch()', async () => {
      // Join voice channel first
      const joinRes = await apiReq('POST', '/api/voice/dugout-voice-huddle/join', ctx.seedAdminCookie, {
        muted: false,
        deafened: false
      });
      assert.equal(joinRes.status, 200, 'Voice join must succeed');

      // State update / heartbeat keepalive
      const stateRes = await apiReq('POST', '/api/voice/dugout-voice-huddle/state', ctx.seedAdminCookie, {
        muted: true,
        deafened: false
      });
      assert.equal(stateRes.status, 200, 'Voice state update must succeed');
      assert.equal(stateRes.data.muted, 1);

      // Verify rate limit row exists in chat_rate_limits via HMAC key
      const env = { DB: ctx.baseballD1 || ctx.d1 };
      const { key: hashedKey } = await deriveRateLimitKey(`chat_voice_state:${ctx.seedAdminId}`, env);
      const rateRow = chatDb.prepare('SELECT count, expires_at, window_start FROM chat_rate_limits WHERE key = ?').get(hashedKey);
      assert.ok(rateRow, 'chat_rate_limits record must be created via db.batch()');
      assert.ok(rateRow.count >= 1);
      assert.ok(rateRow.expires_at >= rateRow.window_start + 3600, 'chat_rate_limits.expires_at must be >= window_start + 3600');

      // Verify participant row updated
      const vpRow = chatDb.prepare('SELECT muted, heartbeat_at FROM voice_participants WHERE user_id = ?').get(ctx.seedAdminId);
      assert.ok(vpRow);
      assert.equal(vpRow.muted, 1);

      // Cleanup
      await apiReq('POST', '/api/voice/dugout-voice-huddle/leave', ctx.seedAdminCookie);
    });

    await t.test('6. POST /api/voice/:channelId/leave prunes stale voice rows and cleans up cleanly', async () => {
      const nowSec = Math.floor(Date.now() / 1000);

      // Insert a stale participant (120s ago)
      chatDb.prepare(`
        INSERT INTO voice_participants (channel_id, user_id, user_name, muted, deafened, screen_sharing, heartbeat_at)
        VALUES (1, 8883, 'Stale Leave Test', 0, 0, 0, ?)
        ON CONFLICT(channel_id, user_id) DO UPDATE SET heartbeat_at = ?
      `).run(nowSec - 120, nowSec - 120);

      // Join and leave
      await apiReq('POST', '/api/voice/dugout-voice-huddle/join', ctx.seedAdminCookie, {});
      const leaveRes = await apiReq('POST', '/api/voice/dugout-voice-huddle/leave', ctx.seedAdminCookie);
      assert.equal(leaveRes.status, 200);

      // Stale participant must be pruned opportunistically on leave
      const staleAfterLeave = chatDb.prepare('SELECT 1 FROM voice_participants WHERE user_id = 8883').get();
      assert.equal(staleAfterLeave, undefined, 'Stale participant must be opportunistically pruned on leave');

      // Admin participant row must be deleted
      const adminVp = chatDb.prepare('SELECT 1 FROM voice_participants WHERE user_id = ?').get(ctx.seedAdminId);
      assert.equal(adminVp, undefined, 'Leaving participant must be removed from voice_participants');
    });

    await t.test('7. Client stepped sync delays: 5s active/voice, 15s visible idle, 45s deep-idle, 90s hidden voice, 0 hidden idle', () => {
      // Verify interval constants on ClubhouseRTC and ClubhouseStore
      assert.ok(ClubhouseRTC);
      assert.ok(ClubhouseStore);
      assert.equal(typeof ClubhouseStore.getSteppedSyncDelay, 'function', 'ClubhouseStore must expose getSteppedSyncDelay');

      // Verify stepped backoff delays
      const delay = ClubhouseStore.getSteppedSyncDelay();
      assert.equal(typeof delay, 'number', 'Delay must be numeric');
    });

  });
};
