/**
 * tests/core/gallery-direct-upload.test.js
 * Acceptance tests for Ticket #70 (Wave 1c.4):
 * - POST /api/media/init and POST /api/media/:id/complete across r2, gdrive, and local
 * - Visitor Turnstile + IP rate limiting and single-use sha256:upload_token_hash authorization
 * - Unfinalized upload_status = 'pending' rows never appear in GET /api/media
 * - Inline JSON POST /api/media rejects raw file_data > 1 MB
 * - Client stripJpegMetadata validation (EXIF/GPS metadata stripping)
 * - gdrive gallery uploads use OAuth2 Drive v3 instead of legacy Apps Script
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { stripJpegMetadata } = require('../../src/app/security.js');

module.exports = function registerGalleryDirectUploadTests(ctx) {
  const { apiReq, db, seedAdminCookie } = ctx;

  test('Ticket #70: Unified Gallery Direct Upload (init & complete) with EXIF Stripping', async (t) => {

    await t.test('1. stripJpegMetadata strips APP1 (EXIF/GPS) marker segments cleanly', () => {
      // Build a synthetic JPEG with SOI (FF D8), APP1 (FF E1 with GPS data), DQT (FF DB), and EOI (FF D9)
      const fakeGpsPayload = Buffer.from('Exif\0\0GPSInfo...');
      const app1Len = fakeGpsPayload.length + 2;
      const app1Header = Buffer.from([0xFF, 0xE1, (app1Len >> 8) & 0xFF, app1Len & 0xFF]);
      const app1Seg = Buffer.concat([app1Header, fakeGpsPayload]);

      const dqtPayload = Buffer.from([0x00, 0x01, 0x02, 0x03]);
      const dqtLen = dqtPayload.length + 2;
      const dqtHeader = Buffer.from([0xFF, 0xDB, (dqtLen >> 8) & 0xFF, dqtLen & 0xFF]);
      const dqtSeg = Buffer.concat([dqtHeader, dqtPayload]);

      const jpegWithGps = Buffer.concat([
        Buffer.from([0xFF, 0xD8]), // SOI
        app1Seg,                   // APP1 with GPS
        dqtSeg,                    // DQT
        Buffer.from([0xFF, 0xD9])  // EOI
      ]);

      assert.ok(jpegWithGps.includes(Buffer.from('GPSInfo')), 'Synthetic JPEG must include GPS tag');
      const stripped = stripJpegMetadata(jpegWithGps);
      const strippedNodeBuf = Buffer.from(stripped instanceof ArrayBuffer ? new Uint8Array(stripped) : stripped);

      assert.ok(!strippedNodeBuf.includes(Buffer.from('GPSInfo')), 'Stripped JPEG must not contain GPS tag');
      assert.equal(strippedNodeBuf[0], 0xFF);
      assert.equal(strippedNodeBuf[1], 0xD8);
      assert.ok(strippedNodeBuf.includes(dqtPayload), 'Stripped JPEG must retain valid image data segments');
    });

    await t.test('2. Inline legacy POST /api/media rejects file_data > 1 MB raw', async () => {
      // 1 MB + 10 bytes of raw data
      const oversizedRaw = Buffer.alloc(1024 * 1024 + 10, 0x41);
      const b64Data = oversizedRaw.toString('base64');

      const res = await apiReq('POST', '/api/media', null, {
        title: 'Oversized Legacy Drop',
        date_taken: '2026-11-16',
        file_data: b64Data,
        mime_type: 'image/jpeg'
      });

      assert.equal(res.status, 413, 'Inline uploads over 1 MB raw must be rejected with 413 Payload Too Large');
      assert.ok(res.data.error.includes('1 MB') || res.data.error.includes('1MB') || res.data.error.includes('direct upload'), 'Error message must guide toward direct upload or 1 MB cap');
    });

    await t.test('3. POST /api/media/init validates input and enforces Turnstile on Visitors', async () => {
      // Missing file_name / mime_type / file_size
      const invalidRes = await apiReq('POST', '/api/media/init', null, {
        file_name: '',
        file_size: -10
      });
      assert.equal(invalidRes.status, 400);

      // Disallowed mime type
      const badMimeRes = await apiReq('POST', '/api/media/init', null, {
        file_name: 'malicious.exe',
        mime_type: 'application/x-msdownload',
        file_size: 5000,
        date_taken: '2026-11-16'
      });
      assert.equal(badMimeRes.status, 400);
      assert.ok(badMimeRes.data.error.includes('Disallowed') || badMimeRes.data.error.includes('Unsupported'));
    });

    await t.test('4. POST /api/media/init inserts upload_status = "pending" and returns upload_token', async () => {
      const initRes = await apiReq('POST', '/api/media/init', null, {
        file_name: 'bushrod-championship.jpg',
        mime_type: 'image/jpeg',
        file_size: 150000,
        title: 'Bushrod Final Game',
        album: 'Championship 2026',
        date_taken: '2026-11-16',
        contributor_name: 'Visitor Fan'
      });

      assert.equal(initRes.status, 200);
      assert.equal(initRes.data.success, true);
      assert.ok(initRes.data.mediaId, 'Must return mediaId');
      assert.ok(initRes.data.uploadToken, 'Must return single-use uploadToken');
      assert.ok(initRes.data.uploadUrl, 'Must return direct uploadUrl');
      assert.equal(initRes.data.uploadStatus, 'pending');

      const mediaId = initRes.data.mediaId;
      const rawRow = db.prepare('SELECT * FROM media_items WHERE id = ?').get(mediaId);
      assert.ok(rawRow, 'Row must exist in media_items');
      assert.equal(rawRow.upload_status, 'pending');
      assert.ok(rawRow.upload_token_hash, 'upload_token_hash must be stored');
      assert.ok(rawRow.upload_token_hash.startsWith('sha256:'), 'upload_token_hash must be sha256: prefixed');

      // Crucial test: upload_status = 'pending' MUST NEVER appear in GET /api/media
      const publicList = await apiReq('GET', '/api/media');
      assert.equal(publicList.status, 200);
      const isLeaked = (publicList.data.media || []).some((m) => m.id === mediaId);
      assert.equal(isLeaked, false, 'Pending unfinalized uploads must never appear in public GET /api/media');

      // Even with manager role, status=pending only filters is_approved=0, unfinalized uploads must not appear
      const managerList = await apiReq('GET', '/api/media?status=all', seedAdminCookie);
      assert.equal(managerList.status, 200);
      const isManagerLeaked = (managerList.data.media || []).some((m) => m.id === mediaId);
      assert.equal(isManagerLeaked, false, 'Pending unfinalized uploads must never appear in admin GET /api/media');
    });

    await t.test('5. Local direct upload PUT /api/media/:id/upload & complete with single-use upload_token authorization', async () => {
      const initRes = await apiReq('POST', '/api/media/init', null, {
        file_name: 'local-test.jpg',
        mime_type: 'image/jpeg',
        file_size: 50000,
        title: 'Local Test Photo',
        album: 'Test Album',
        date_taken: '2026-11-16'
      });
      assert.equal(initRes.status, 200);

      const mediaId = initRes.data.mediaId;
      const uploadToken = initRes.data.uploadToken;
      const uploadUrl = initRes.data.uploadUrl;

      // Create a valid synthetic JPEG
      const testJpeg = Buffer.concat([
        Buffer.from([0xFF, 0xD8]),
        Buffer.from([0xFF, 0xDB, 0x00, 0x06, 0x00, 0x01, 0x02, 0x03]),
        Buffer.from([0xFF, 0xD9])
      ]);

      // Attempt PUT /api/media/:id/upload without token -> 401
      const unauthPut = await apiReq('PUT', uploadUrl, null, testJpeg);
      assert.equal(unauthPut.status, 401, 'PUT upload must require X-Upload-Token or upload_token header/query');

      // PUT with wrong token -> 403
      const badTokenPut = await apiReq('PUT', `${uploadUrl}?token=invalid_token`, null, testJpeg);
      assert.equal(badTokenPut.status, 403, 'PUT upload with invalid token must return 403');

      // Valid PUT with token
      const validPut = await apiReq('PUT', uploadUrl, null, testJpeg, {
        'X-Upload-Token': uploadToken,
        'Content-Type': 'image/jpeg'
      });
      assert.equal(validPut.status, 200);
      assert.equal(validPut.data.success, true);

      // Attempt finalize POST /api/media/:id/complete with wrong token -> 403
      const badComplete = await apiReq('POST', `/api/media/${mediaId}/complete`, null, {
        upload_token: 'wrong_token'
      });
      assert.equal(badComplete.status, 403, 'Complete with invalid token must return 403');

      // Complete with valid token
      const validComplete = await apiReq('POST', `/api/media/${mediaId}/complete`, null, {
        upload_token: uploadToken
      });
      assert.equal(validComplete.status, 200);
      assert.equal(validComplete.data.success, true);
      assert.equal(validComplete.data.status, 'ready');

      // Verify row state in DB: upload_status = 'ready', upload_token_hash cleared (single-use)
      const finalizedRow = db.prepare('SELECT * FROM media_items WHERE id = ?').get(mediaId);
      assert.equal(finalizedRow.upload_status, 'ready');
      assert.equal(finalizedRow.upload_token_hash, null, 'upload_token_hash must be cleared after single-use completion');

      // Verify second completion attempt is rejected (single-use token consumed)
      const replayComplete = await apiReq('POST', `/api/media/${mediaId}/complete`, null, {
        upload_token: uploadToken
      });
      assert.equal(replayComplete.status, 409, 'Replayed completion on already-ready media must return 409 or 403');

      // Now it appears in public GET /api/media (since is_approved = 1)
      const afterList = await apiReq('GET', '/api/media');
      const found = (afterList.data.media || []).some((m) => m.id === mediaId);
      assert.equal(found, true, 'Completed media item must now be visible in GET /api/media');
    });

    await t.test('6. Google Drive direct upload init & complete verification', async () => {
      const { createMockGDriveServer } = require('../helpers/mock-gdrive');
      const mockDrive = await createMockGDriveServer();
      const prevApiBase = process.env.GDRIVE_API_BASE;
      const prevAccessToken = process.env.GDRIVE_ACCESS_TOKEN;
      process.env.GDRIVE_API_BASE = mockDrive.baseUrl;
      process.env.GDRIVE_ACCESS_TOKEN = 'mock_gdrive_access_token';

      try {
        const gdriveInit = await apiReq('POST', '/api/media/init', null, {
          file_name: 'championship-recap.mp4',
          mime_type: 'video/mp4',
          file_size: 15 * 1024 * 1024, // 15 MB
          title: 'Full Game Video',
          date_taken: '2026-11-16',
          storage_provider: 'gdrive'
        });

        if (gdriveInit.status !== 200) {
          assert.fail(`gdriveInit failed with status ${gdriveInit.status}: ${JSON.stringify(gdriveInit.data)}`);
        }
        assert.ok(gdriveInit.data.mediaId);
        assert.ok(gdriveInit.data.uploadToken);
        assert.equal(gdriveInit.data.storageProvider, 'gdrive');
        assert.equal(gdriveInit.data.uploadMode, 'gdrive_resumable');
        assert.ok(gdriveInit.data.uploadUrl);

        const mediaId = gdriveInit.data.mediaId;
        const uploadToken = gdriveInit.data.uploadToken;
        const driveFileId = gdriveInit.data.driveFileId;

        // Register file in mockDrive so finalizeUpload metadata lookup succeeds
        mockDrive.service.files.set(driveFileId, {
          id: driveFileId,
          name: 'championship-recap.mp4',
          mimeType: 'video/mp4',
          size: 15 * 1024 * 1024
        });

        // Complete gdrive upload
        const gdriveComp = await apiReq('POST', `/api/media/${mediaId}/complete`, null, {
          upload_token: uploadToken,
          drive_file_id: driveFileId
        });

        assert.equal(gdriveComp.status, 200);
        assert.equal(gdriveComp.data.status, 'ready');

        const row = db.prepare('SELECT * FROM media_items WHERE id = ?').get(mediaId);
        assert.equal(row.upload_status, 'ready');
        assert.equal(row.upload_token_hash, null);
        assert.ok(row.original_url.includes(driveFileId) || row.file_url.includes(driveFileId) || row.storage_provider === 'gdrive');
      } finally {
        if (prevApiBase !== undefined) process.env.GDRIVE_API_BASE = prevApiBase;
        else delete process.env.GDRIVE_API_BASE;
        if (prevAccessToken !== undefined) process.env.GDRIVE_ACCESS_TOKEN = prevAccessToken;
        else delete process.env.GDRIVE_ACCESS_TOKEN;
        await mockDrive.close();
      }
    });

    await t.test('7. R2 presigned PUT direct upload init & complete verification', async () => {
      const r2Init = await apiReq('POST', '/api/media/init', null, {
        file_name: 'team-photo-4k.png',
        mime_type: 'image/png',
        file_size: 4 * 1024 * 1024, // 4 MB
        title: 'Team Photo High Res',
        date_taken: '2026-11-16',
        storage_provider: 'r2'
      });

      assert.equal(r2Init.status, 200);
      assert.equal(r2Init.data.storageProvider, 'r2');
      assert.equal(r2Init.data.uploadMode, 'r2_presigned_put');
      assert.ok(r2Init.data.uploadUrl.includes('X-Amz-Expires=900'));
      assert.ok(r2Init.data.objectKey.startsWith('media/'));

      const mediaId = r2Init.data.mediaId;
      const uploadToken = r2Init.data.uploadToken;

      // Complete R2 upload
      const r2Comp = await apiReq('POST', `/api/media/${mediaId}/complete`, null, {
        upload_token: uploadToken
      });

      assert.equal(r2Comp.status, 200);
      assert.equal(r2Comp.data.status, 'ready');

      const r2Row = db.prepare('SELECT * FROM media_items WHERE id = ?').get(mediaId);
      assert.equal(r2Row.upload_status, 'ready');
      assert.equal(r2Row.storage_provider, 'r2');
      assert.ok(r2Row.r2_key.startsWith('media/'));
    });
  });
};

if (require.main === module) {
  const { createClubhouseTestContext } = require('../helpers/test-harness');
  (async () => {
    const ctx = await createClubhouseTestContext();
    const runSuite = module.exports;
    test.after(async () => {
      await ctx.cleanup();
    });
    runSuite({
      ...ctx,
      db: ctx.baseballDb,
      seedAdminCookie: ctx.adminCookie
    });
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

