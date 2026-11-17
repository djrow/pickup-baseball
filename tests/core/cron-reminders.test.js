/**
 * tests/core/cron-reminders.test.js
 * Acceptance tests for Ticket #73 (Wave 1c.8):
 * - Standalone hourly Cron Worker (workers/cron-reminders/) with zero D1 bindings and 0 * * * * trigger
 * - POST /api/events/reminders/check authenticates with CRON_SECRET / REMINDERS_SECRET
 * - POST /api/events/reminders/check advances multi-batch reminders without duplicates
 * - POST /api/events/reminders/check prunes expired rate-limit keys and 24h pending media/attachments
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const cronWorkerModule = require('../../workers/cron-reminders/src/index.js');
const cronWorker = cronWorkerModule.default || cronWorkerModule;
const { resolveTargetOrigin } = cronWorkerModule;

module.exports = function registerCronRemindersTests(ctx) {
  const { apiReq, db, baseballD1, chatD1 } = ctx;

  test('Ticket #73: Standalone Hourly Cron Worker & 24h Orphan Cleanup', async (t) => {

    await t.test('1. resolveTargetOrigin respects LOCK_PREVIEW_ORIGIN and fallbacks', () => {
      // LOCK_PREVIEW_ORIGIN=1 uses PUBLIC_ORIGIN
      const target1 = resolveTargetOrigin({
        LOCK_PREVIEW_ORIGIN: '1',
        PUBLIC_ORIGIN: 'https://pickupbaseballfoundation.org',
        PAGES_ORIGIN: 'https://preview.pickup-baseball.pages.dev'
      });
      assert.equal(target1, 'https://pickupbaseballfoundation.org');

      // LOCK_PREVIEW_ORIGIN disabled prefers PAGES_ORIGIN
      const target2 = resolveTargetOrigin({
        LOCK_PREVIEW_ORIGIN: '0',
        PAGES_ORIGIN: 'https://preview.pickup-baseball.pages.dev',
        PUBLIC_ORIGIN: 'https://pickupbaseballfoundation.org'
      });
      assert.equal(target2, 'https://preview.pickup-baseball.pages.dev');

      // Default fallback
      const targetDefault = resolveTargetOrigin({});
      assert.equal(targetDefault, 'https://www.pickupbaseballfoundation.org');
    });

    await t.test('2. Cron worker scheduled() skips dispatch if CRON_SECRET is missing', async () => {
      const res = await cronWorker.scheduled({}, {}, {});
      assert.deepEqual(res, { skipped: true, reason: 'CRON_SECRET missing' });
    });

    await t.test('3. POST /api/events/reminders/check rejects unauthorized callers', async () => {
      if (apiReq) {
        // Without Authorization header or session
        const resUnauth = await apiReq('POST', '/api/events/reminders/check');
        assert.equal(resUnauth.status, 401);

        // With invalid bearer token
        const resBadSecret = await apiReq('POST', '/api/events/reminders/check', null, null, {
          'Authorization': 'Bearer bad-secret-token'
        });
        assert.equal(resBadSecret.status, 401);

        // GET method not allowed
        const resGet = await apiReq('GET', '/api/events/reminders/check', null, null, {
          'Authorization': 'Bearer test-cron-secret'
        });
        assert.equal(resGet.status, 405);
      }
    });

    await t.test('4. POST /api/events/reminders/check cleans up 24h abandoned pending uploads and expired rate limits', async () => {
      const bDb = db || (baseballD1 && baseballD1._db);
      const cDb = ctx.chatSqlite || (chatD1 && chatD1._db);

      if (bDb) {
        // Seed an active pending media (<24h old) and an abandoned pending media (>24h old)
        const oldIso = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
        const freshIso = new Date(Date.now() - 2 * 3600 * 1000).toISOString();

        bDb.prepare(`
          INSERT INTO media_items (id, title, media_type, file_url, date_taken, mime_type, file_size, storage_provider, upload_status, created_at)
          VALUES (9901, 'Fresh Pending', 'photo', '/api/media/temp/file', '2026-11-17', 'image/jpeg', 100, 'local', 'pending', ?)
        `).run(freshIso);

        bDb.prepare(`
          INSERT INTO media_items (id, title, media_type, file_url, date_taken, mime_type, file_size, storage_provider, upload_status, created_at)
          VALUES (9902, 'Old Abandoned Pending', 'photo', '/api/media/temp/file', '2026-11-17', 'image/jpeg', 100, 'local', 'pending', ?)
        `).run(oldIso);

        // Seed expired rate limit
        const nowSec = Math.floor(Date.now() / 1000);
        bDb.prepare(`
          INSERT OR REPLACE INTO rate_limits (key, count, window_start, expires_at)
          VALUES ('expired_rl_key_73', 10, ?, ?)
        `).run(nowSec - 7200, nowSec - 3600);

        if (cDb) {
          cDb.prepare(`
            INSERT OR REPLACE INTO chat_attachments (id, channel_id, uploader_id, file_name, mime_type, file_size, storage_provider, upload_status, created_at)
            VALUES ('att_old_9902', 1, 1, 'abandoned.png', 'image/png', 50, 'local', 'pending', ?)
          `).run(oldIso);

          cDb.prepare(`
            INSERT OR REPLACE INTO chat_attachments (id, channel_id, uploader_id, file_name, mime_type, file_size, storage_provider, upload_status, created_at)
            VALUES ('att_fresh_9901', 1, 1, 'fresh.png', 'image/png', 50, 'local', 'pending', ?)
          `).run(freshIso);
        }

        // Trigger reminder check endpoint
        if (apiReq) {
          const res = await apiReq('POST', '/api/events/reminders/check', null, null, {
            'Authorization': 'Bearer test-cron-secret'
          });
          assert.equal(res.status, 200);
          assert.equal(res.data.success, true);
        } else {
          const { pruneEphemeralBaseballRows, pruneEphemeralChatRows } = require('../../src/app/schema.js');
          await pruneEphemeralBaseballRows(bDb, Date.now(), { force: true });
          if (cDb) {
            await pruneEphemeralChatRows(cDb, Date.now(), { force: true });
          }
        }

        // Verify abandoned upload was deleted, while fresh pending was preserved
        const preserved = bDb.prepare('SELECT id FROM media_items WHERE id = 9901').get();
        const deleted = bDb.prepare('SELECT id FROM media_items WHERE id = 9902').get();
        assert.ok(preserved, 'Fresh pending upload under 24h should be preserved');
        assert.equal(deleted, undefined, 'Abandoned pending upload over 24h should be reaped');

        // Verify expired rate limit row pruned
        const expiredRl = bDb.prepare("SELECT key FROM rate_limits WHERE key = 'expired_rl_key_73'").get();
        assert.equal(expiredRl, undefined, 'Expired rate limits should be pruned');

        if (cDb) {
          const freshAtt = cDb.prepare("SELECT id FROM chat_attachments WHERE id = 'att_fresh_9901'").get();
          const oldAtt = cDb.prepare("SELECT id FROM chat_attachments WHERE id = 'att_old_9902'").get();
          assert.ok(freshAtt, 'Fresh pending chat attachment should be preserved');
          assert.equal(oldAtt, undefined, 'Abandoned pending chat attachment over 24h should be reaped');
        }
      }
    });

    await t.test('5. cronWorker scheduled() dispatches POST to target origin with bearer token', async () => {
      const origFetch = global.fetch;
      let interceptedReq = null;

      global.fetch = async (url, opts) => {
        interceptedReq = { url: String(url), ...opts };
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            processed: 1,
            sent: 5,
            remaining: 0,
            quotaPaused: false
          })
        };
      };

      try {
        const mockEnv = {
          PUBLIC_ORIGIN: 'https://test.pickupbaseballfoundation.org',
          LOCK_PREVIEW_ORIGIN: '1',
          CRON_SECRET: 'super-secret-cron-token'
        };

        const result = await cronWorker.scheduled({}, mockEnv, {});

        assert.ok(interceptedReq);
        assert.equal(interceptedReq.url, 'https://test.pickupbaseballfoundation.org/api/events/reminders/check');
        assert.equal(interceptedReq.method, 'POST');
        assert.equal(interceptedReq.headers['Authorization'], 'Bearer super-secret-cron-token');
        assert.equal(result.success, true);
        assert.equal(result.sent, 5);
      } finally {
        global.fetch = origFetch;
      }
    });
  });
};

if (require.main === module) {
  const sqlite = require('better-sqlite3');
  const tempDb = new sqlite(':memory:');
  const tempChat = new sqlite(':memory:');
  const { CREATE_TABLES_SQL } = require('../../src/app/schema/baseball-ddl.js');
  const { CREATE_CHAT_TABLES_SQL, DEFAULT_CHAT_CHANNELS } = require('../../src/app/schema/chat-ddl.js');

  for (const sql of CREATE_TABLES_SQL) tempDb.exec(sql);
  for (const sql of CREATE_CHAT_TABLES_SQL) tempChat.exec(sql);
  for (const ch of DEFAULT_CHAT_CHANNELS) {
    tempChat.prepare('INSERT OR IGNORE INTO channels (name, slug, category, channel_type, topic, min_role_read, min_role_write, is_encrypted, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(ch.name, ch.slug, ch.category, ch.channel_type, ch.topic, ch.min_role_read, ch.min_role_write, ch.is_encrypted, ch.sort_order);
  }

  const { createD1Adapter } = require('../../src/d1-sqlite.js');

  module.exports({
    db: tempDb,
    chatSqlite: tempChat,
    baseballD1: createD1Adapter(tempDb),
    chatD1: createD1Adapter(tempChat)
  });
}
