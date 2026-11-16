/**
 * Acceptance Suite for Wave 1c.3 (Ticket #68 / ADR-0008 / ADR-0010):
 * - Split monolithic src/app/routes/media.js into sub-routers (gallery, attachments, admin)
 * - Unified STORAGE_PROVIDER adapter factory (r2, gdrive, local)
 * - R2 presigned PUT/GET URLs, canonical keys, and 302 redirects
 * - Local storage <= 1 MB raw cap and Rule 3 GIF binary rejection
 * - GET /api/admin/storage-status endpoint
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveStorageProvider,
  canonicalObjectKey,
  getStorageAdapter
} = require('../../src/app/storage/index.js');
const { r2StorageAdapter } = require('../../src/app/storage/r2.js');
const { localStorageAdapter } = require('../../src/app/storage/local.js');
const { gdriveStorageAdapter } = require('../../src/app/storage/gdrive.js');
const { clearSessionMemoryCache } = require('../../src/app/security.js');

module.exports = function registerStorageProviderTests(ctx) {
  const { apiReq, db, chatDb } = ctx;

  test('Ticket #68: Wave 1c.3 Acceptance Suite (STORAGE_PROVIDER & routes/media/ split)', async (t) => {

    await t.test('1. resolveStorageProvider priority and auto-detection', () => {
      // Explicit override
      assert.equal(resolveStorageProvider({ STORAGE_PROVIDER: 'r2' }), 'r2');
      assert.equal(resolveStorageProvider({ STORAGE_PROVIDER: 'gdrive' }), 'gdrive');
      assert.equal(resolveStorageProvider({ STORAGE_PROVIDER: 'local' }), 'local');

      // Adapter factory returns correct instance
      assert.equal(getStorageAdapter({ STORAGE_PROVIDER: 'r2' }), r2StorageAdapter);
      assert.equal(getStorageAdapter({ STORAGE_PROVIDER: 'gdrive' }), gdriveStorageAdapter);
      assert.equal(getStorageAdapter({ STORAGE_PROVIDER: 'local' }), localStorageAdapter);

      // Invalid explicit provider falls back to auto-detection
      assert.equal(resolveStorageProvider({ STORAGE_PROVIDER: 'invalid_provider' }), 'local');

      // Auto-detect MEDIA_BUCKET / R2
      assert.equal(resolveStorageProvider({ MEDIA_BUCKET: {} }), 'r2');
      assert.equal(resolveStorageProvider({ R2_BUCKET: 'media-bucket' }), 'r2');
      assert.equal(resolveStorageProvider({ R2_ACCOUNT_ID: 'acc123' }), 'r2');

      // Auto-detect Google Drive
      assert.equal(resolveStorageProvider({ GOOGLE_DRIVE_FOLDER_ID: 'folder-123' }), 'gdrive');

      // Default fallback
      assert.equal(resolveStorageProvider({}), 'local');
      assert.equal(resolveStorageProvider(null), 'local');
    });

    await t.test('2. canonicalObjectKey formatting for all resource kinds', () => {
      const mediaKey = canonicalObjectKey('media', { mediaId: 42, fileUuid: 'abc-123' });
      assert.equal(mediaKey, 'media/42/abc-123');

      const attKey = canonicalObjectKey('attachments', { channelId: 10, attachmentId: 99 });
      assert.equal(attKey, 'attachments/10/99');

      const gifKey = canonicalObjectKey('gifs', { gifId: 7, ext: 'webp' });
      assert.equal(gifKey, 'gifs/7.webp');

      const waiverKey = canonicalObjectKey('waivers', { certificateId: 'cert-xyz-789' });
      assert.equal(waiverKey, 'waivers/cert-xyz-789.html');
    });

    await t.test('3. r2StorageAdapter: presigned PUT & GET signing', async () => {
      const testEnv = {
        R2_ACCOUNT_ID: 'test-account-id',
        R2_ACCESS_KEY_ID: 'test-access-key',
        R2_SECRET_ACCESS_KEY: 'test-secret-key-32-bytes-minimum-length-req',
        R2_BUCKET: 'test-bucket'
      };

      // uploadInit generates presigned PUT with X-Amz-Expires=900 (15 min)
      const initResult = await r2StorageAdapter.uploadInit(testEnv, {
        kind: 'attachments',
        objectKey: 'attachments/1/42',
        mimeType: 'image/png',
        fileSize: 2048,
        fileName: 'test.png'
      });

      assert.equal(initResult.uploadMode, 'r2_presigned_put');
      assert.ok(initResult.uploadUrl, 'uploadUrl must be present');
      assert.ok(initResult.uploadUrl.includes('X-Amz-Expires=900'), 'Must include 15-minute expiration');
      assert.ok(initResult.uploadUrl.includes('X-Amz-Signature='), 'Must include AWS4 signature');
      assert.equal(initResult.r2Key, 'attachments/1/42');

      // getDownloadTarget generates presigned GET with 302 redirect
      const downloadTarget = await r2StorageAdapter.getDownloadTarget(testEnv, {
        kind: 'attachments',
        objectKey: 'attachments/1/42',
        mimeType: 'image/png',
        fileName: 'test.png',
        isEncrypted: true,
        approved: true
      });

      assert.equal(downloadTarget.type, 'redirect');
      assert.ok(downloadTarget.url.includes('X-Amz-Expires=300'), 'Must include 5-minute GET expiration');
      assert.ok(downloadTarget.url.includes('response-content-type=application%2Foctet-stream'), 'Encrypted must override content-type');
      assert.ok(downloadTarget.url.includes('response-content-disposition=attachment'), 'Encrypted must force attachment disposition');
      assert.equal(downloadTarget.cacheControl, 'private, no-store');
    });

    await t.test('4. localStorageAdapter: <= 1 MB raw cap and Rule 3 GIF binary rejection', async () => {
      const testEnv = {};

      // uploadInit accepts <= 1 MB
      const smallInit = await localStorageAdapter.uploadInit(testEnv, {
        kind: 'attachments',
        objectKey: 'attachments/1/100',
        mimeType: 'image/jpeg',
        fileSize: 1024 * 1024 // exactly 1 MB
      });
      assert.equal(smallInit.uploadMode, 'local_put');

      // uploadInit rejects > 1 MB
      const oversizedInit = await localStorageAdapter.uploadInit(testEnv, {
        kind: 'attachments',
        objectKey: 'attachments/1/101',
        mimeType: 'image/jpeg',
        fileSize: 1024 * 1024 + 1 // 1 MB + 1 byte
      });
      assert.equal(oversizedInit.ok, false);
      assert.ok(oversizedInit.error.includes('1 MB'));

      // putObject strictly rejects GIF binaries per Rule 3
      await assert.rejects(
        async () => {
          await localStorageAdapter.putObject(testEnv, {
            kind: 'gifs',
            objectKey: 'gifs/123.gif',
            data: Buffer.from('GIF89a...'),
            mimeType: 'image/gif'
          });
        },
        (err) => {
          assert.ok(err.message.includes('AGENTS.md Rule 3'));
          return true;
        }
      );
    });

    await t.test('5. GET /api/admin/storage-status: RBAC guard and status reporting', async () => {
      // Non-admin viewer is rejected with 403
      const anonRes = await apiReq('GET', '/api/admin/storage-status');
      assert.equal(anonRes.status, 401);

      const playerRes = await apiReq('GET', '/api/admin/storage-status', ctx.seedPlayerCookie);
      assert.equal(playerRes.status, 403);

      // Admin viewer receives 200 with active provider status and DB counts
      const adminRes = await apiReq('GET', '/api/admin/storage-status', ctx.seedAdminCookie);
      assert.equal(adminRes.status, 200);
      assert.ok(adminRes.data, 'Must return JSON data');
      assert.ok(adminRes.data.activeProvider, 'Must return activeProvider');
      assert.ok(adminRes.data.r2, 'Must return r2 status');
      assert.ok(adminRes.data.local, 'Must return local status');
      assert.ok(adminRes.data.chatDb, 'Must return chatDb stats');
      assert.ok(adminRes.data.baseballDb, 'Must return baseballDb stats');
      const expectedMediaCount = Number(db.prepare('SELECT COUNT(*) as count FROM media_items').get().count || 0);
      assert.equal(adminRes.data.baseballDb.mediaCount, expectedMediaCount);
      assert.equal(typeof adminRes.data.chatDb.attachmentCount, 'number');
    });

    await t.test('6. POST /api/attachments/init with R2 returns presigned PUT & stores r2_key', async () => {
      // Ensure seed player is opted into clubhouse
      db.prepare('UPDATE users SET clubhouse_opted_in = 1 WHERE id = ?').run(ctx.seedPlayerId);
      clearSessionMemoryCache();

      // Create a public test channel
      const chRes = chatDb.prepare(`
        INSERT INTO channels (name, slug, category, channel_type, is_private, created_by)
        VALUES ('Storage Test Channel', 'storage-test-ch-${Date.now()}', 'general', 'text', 0, ?)
      `).run(ctx.seedPlayerId);
      const channelId = Number(chRes.lastInsertRowid);

      chatDb.prepare(`
        INSERT INTO channel_members (channel_id, user_id, role)
        VALUES (?, ?, 'member')
      `).run(channelId, ctx.seedPlayerId);

      // Set environment variables for R2 on process.env so Hono router picks them up
      const prevProvider = process.env.STORAGE_PROVIDER;
      const prevAcc = process.env.R2_ACCOUNT_ID;
      const prevKey = process.env.R2_ACCESS_KEY_ID;
      const prevSec = process.env.R2_SECRET_ACCESS_KEY;
      const prevBucket = process.env.R2_BUCKET;

      process.env.STORAGE_PROVIDER = 'r2';
      process.env.R2_ACCOUNT_ID = 'test-r2-account';
      process.env.R2_ACCESS_KEY_ID = 'test-r2-key';
      process.env.R2_SECRET_ACCESS_KEY = 'test-r2-secret-key-32-chars-at-least';
      process.env.R2_BUCKET = 'test-r2-bucket';

      let attachmentId = null;
      try {
        const initRes = await apiReq('POST', '/api/attachments/init', ctx.seedPlayerCookie, {
          channel_id: channelId,
          file_name: 'test-upload.png',
          mime_type: 'image/png',
          file_size: 4096,
          is_encrypted: 0
        });

        assert.equal(initRes.status, 200);
        assert.ok(initRes.data.attachment_id);
        attachmentId = initRes.data.attachment_id;
        assert.equal(initRes.data.upload_mode, 'r2_presigned_put');
        assert.ok(initRes.data.r2_presigned_put, 'Must provide r2_presigned_put');
        assert.ok(initRes.data.r2_presigned_put.includes('X-Amz-Expires=900'));

        // Verify row in chat_attachments
        const attRow = chatDb.prepare('SELECT storage_provider, r2_key FROM chat_attachments WHERE id = ?').get(attachmentId);
        assert.equal(attRow.storage_provider, 'r2');
        assert.ok(attRow.r2_key.startsWith('attachments/'));

        // GET /api/attachments/:id/stream returns 302 redirect
        const streamRes = await apiReq('GET', `/api/attachments/${attachmentId}/stream`, ctx.seedPlayerCookie);
        assert.equal(streamRes.status, 302);
        const location = streamRes.headers.get('location');
        assert.ok(location, 'Must set Location header');
        assert.ok(location.includes('X-Amz-Expires=300'), 'Must redirect to presigned GET URL');

      } finally {
        if (prevProvider !== undefined) process.env.STORAGE_PROVIDER = prevProvider; else delete process.env.STORAGE_PROVIDER;
        if (prevAcc !== undefined) process.env.R2_ACCOUNT_ID = prevAcc; else delete process.env.R2_ACCOUNT_ID;
        if (prevKey !== undefined) process.env.R2_ACCESS_KEY_ID = prevKey; else delete process.env.R2_ACCESS_KEY_ID;
        if (prevSec !== undefined) process.env.R2_SECRET_ACCESS_KEY = prevSec; else delete process.env.R2_SECRET_ACCESS_KEY;
        if (prevBucket !== undefined) process.env.R2_BUCKET = prevBucket; else delete process.env.R2_BUCKET;

        if (attachmentId) {
          chatDb.prepare('DELETE FROM chat_attachments WHERE id = ?').run(attachmentId);
        }
        chatDb.prepare('DELETE FROM channel_members WHERE channel_id = ?').run(channelId);
        chatDb.prepare('DELETE FROM channels WHERE id = ?').run(channelId);
      }
    });

  });
};
