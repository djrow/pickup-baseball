/**
 * Test suite for Ticket #71: Idempotent D1-to-R2 Media Backfill CLI
 * Verifies:
 * 1. CLI help / option parsing
 * 2. Keyset pagination on media_items, chat_attachments, and clubhouse_gifs
 * 3. Default --dry-run makes zero D1 or R2 writes
 * 4. --apply uploads decoded payloads to canonical R2 keys, verifies size + SHA-256 via R2 head, and clears D1 blob
 * 5. Safe abort when SHA-256 verification fails (without clearing D1 blob)
 * 6. Safe idempotency when re-run against already-migrated database
 * 7. Structured JSON audit manifest log generation
 * 8. CLI subprocess invocation via child_process
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const { createD1Adapter } = require('../../src/d1-sqlite');
const { ensureD1Schema, ensureChatD1Schema } = require('../../src/app/schema.js');
const {
  migrateD1MediaToR2,
  parseArgs,
  computeSha256Hex,
  decodeBlobData
} = require('../../scripts/migrate-d1-media-to-r2.js');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const SCRIPT_PATH = path.join(ROOT_DIR, 'scripts', 'migrate-d1-media-to-r2.js');

function createMockR2Bucket(options = {}) {
  const { simulateCorruptedHead = false } = options;
  const store = new Map();

  return {
    _store: store,
    async put(key, value, putOpts = {}) {
      const bytes = value instanceof Uint8Array ? value : Buffer.from(value);
      const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      store.set(key, {
        bytes,
        size: bytes.byteLength,
        httpMetadata: putOpts.httpMetadata || {},
        customMetadata: {
          sha256,
          ...(putOpts.customMetadata || {})
        }
      });
      return { key, size: bytes.byteLength };
    },
    async head(key) {
      const item = store.get(key);
      if (!item) return null;
      if (simulateCorruptedHead) {
        return {
          size: item.size,
          httpMetadata: item.httpMetadata,
          customMetadata: { sha256: '0000000000000000000000000000000000000000000000000000000000000000' }
        };
      }
      return {
        size: item.size,
        httpMetadata: item.httpMetadata,
        customMetadata: item.customMetadata
      };
    },
    async delete(key) {
      store.delete(key);
    }
  };
}

function registerMigrateD1MediaTests() {
  test('Wave 1c.5 (Ticket #71): D1-to-R2 Media Backfill CLI', async (suite) => {
    await suite.test('1. parseArgs & helper utilities', () => {
      const defaults = parseArgs([]);
      assert.equal(defaults.dryRun, true);
      assert.equal(defaults.apply, false);
      assert.equal(defaults.batchSize, 100);

      const applied = parseArgs(['--apply', '--batch-size=25', '--verbose']);
      assert.equal(applied.dryRun, false);
      assert.equal(applied.apply, true);
      assert.equal(applied.batchSize, 25);
      assert.equal(applied.verbose, true);

      // Decoding helpers
      const rawText = 'Test payload content for sha256 and base64';
      const b64 = Buffer.from(rawText).toString('base64');
      const dataUri = `data:text/plain;base64,${b64}`;

      const fromB64 = decodeBlobData(b64);
      assert.equal(Buffer.from(fromB64.bytes).toString('utf8'), rawText);
      assert.equal(fromB64.mimeType, 'application/octet-stream');

      const fromUri = decodeBlobData(dataUri);
      assert.equal(Buffer.from(fromUri.bytes).toString('utf8'), rawText);
      assert.equal(fromUri.mimeType, 'text/plain');

      const expectedSha = crypto.createHash('sha256').update(rawText).digest('hex');
      assert.equal(computeSha256Hex(fromB64.bytes), expectedSha);
    });

    await suite.test('2. --dry-run performs zero writes to D1 and R2', async () => {
      const baseballSqlite = new Database(':memory:');
      const chatSqlite = new Database(':memory:');
      const baseballD1 = createD1Adapter(baseballSqlite);
      const chatD1 = createD1Adapter(chatSqlite);
      await ensureD1Schema(baseballD1);
      await ensureChatD1Schema(chatD1);

      const r2Bucket = createMockR2Bucket();

      const sampleSvg = '<svg><circle r="10"/></svg>';
      const sampleSvgB64 = Buffer.from(sampleSvg).toString('base64');
      baseballSqlite.prepare(`
        INSERT INTO media_items (id, title, media_type, file_url, file_data, mime_type, file_size, date_taken, is_approved, storage_provider)
        VALUES (101, 'Photo 101', 'photo', '/api/media/101/file', ?, 'image/svg+xml', ?, '2026-11-16', 1, 'local')
      `).run(sampleSvgB64, sampleSvg.length);

      chatSqlite.prepare(`
        INSERT INTO chat_attachments (id, channel_id, message_id, uploader_id, file_name, mime_type, file_size, storage_provider, local_data_base64, upload_status)
        VALUES ('att-101', 1, NULL, 1, 'note.txt', 'text/plain', 12, 'local', ?, 'completed')
      `).run(Buffer.from('hello attachment').toString('base64'));

      chatSqlite.prepare(`
        INSERT INTO clubhouse_gifs (id, title, mime_type, file_size, storage_provider, local_data_base64, added_by)
        VALUES ('gif-101', 'Homerun', 'image/gif', 10, 'local', ?, 1)
      `).run(Buffer.from('GIF89a sample').toString('base64'));

      const manifest = await migrateD1MediaToR2({
        baseballD1,
        chatD1,
        r2Bucket,
        apply: false,
        batchSize: 10
      });

      assert.equal(manifest.dryRun, true);
      assert.equal(manifest.summary.mediaItems.scanned, 1);
      assert.equal(manifest.summary.mediaItems.migrated, 1);
      assert.equal(manifest.summary.chatAttachments.scanned, 1);
      assert.equal(manifest.summary.chatAttachments.migrated, 1);
      assert.equal(manifest.summary.clubhouseGifs.scanned, 1);
      assert.equal(manifest.summary.clubhouseGifs.migrated, 1);
      assert.equal(manifest.summary.totalErrors, 0);

      // Verify ZERO writes occurred
      assert.equal(r2Bucket._store.size, 0, 'R2 store must be empty in dry-run mode');
      const mediaRow = baseballSqlite.prepare('SELECT file_data, storage_provider, r2_key FROM media_items WHERE id = 101').get();
      assert.ok(mediaRow.file_data !== null, 'media_items.file_data must not be cleared in dry-run');
      assert.equal(mediaRow.storage_provider, 'local');
      assert.equal(mediaRow.r2_key, null);

      const attRow = chatSqlite.prepare('SELECT local_data_base64, storage_provider, r2_key FROM chat_attachments WHERE id = ?').get('att-101');
      assert.ok(attRow.local_data_base64 !== null);
      assert.equal(attRow.r2_key, null);

      const gifRow = chatSqlite.prepare('SELECT local_data_base64, r2_key FROM clubhouse_gifs WHERE id = ?').get('gif-101');
      assert.ok(gifRow.local_data_base64 !== null);
      assert.equal(gifRow.r2_key, null);
    });

    await suite.test('3. --apply uploads to canonical keys, verifies size/SHA-256 via head, and clears D1 blob', async () => {
      const baseballSqlite = new Database(':memory:');
      const chatSqlite = new Database(':memory:');
      const baseballD1 = createD1Adapter(baseballSqlite);
      const chatD1 = createD1Adapter(chatSqlite);
      await ensureD1Schema(baseballD1);
      await ensureChatD1Schema(chatD1);

      const r2Bucket = createMockR2Bucket();

      const sampleSvg = '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40"/></svg>';
      const sampleSvgB64 = Buffer.from(sampleSvg).toString('base64');
      baseballSqlite.prepare(`
        INSERT INTO media_items (id, title, media_type, file_url, file_data, mime_type, file_size, date_taken, is_approved, storage_provider)
        VALUES (201, 'Photo 201', 'photo', '/api/media/201/file', ?, 'image/svg+xml', ?, '2026-11-16', 1, 'local')
      `).run(sampleSvgB64, sampleSvg.length);

      const attContent = 'Chat attachment payload content';
      chatSqlite.prepare(`
        INSERT INTO chat_attachments (id, channel_id, message_id, uploader_id, file_name, mime_type, file_size, storage_provider, local_data_base64, upload_status)
        VALUES ('att-201', 1, NULL, 2, 'data.txt', 'text/plain', ?, 'local', ?, 'completed')
      `).run(attContent.length, Buffer.from(attContent).toString('base64'));

      const gifContent = 'GIF89a fake gif content';
      chatSqlite.prepare(`
        INSERT INTO clubhouse_gifs (id, title, mime_type, file_size, storage_provider, local_data_base64, added_by)
        VALUES ('gif-201', 'Slide', 'image/gif', ?, 'local', ?, 3)
      `).run(gifContent.length, Buffer.from(gifContent).toString('base64'));

      const manifest = await migrateD1MediaToR2({
        baseballD1,
        chatD1,
        r2Bucket,
        apply: true,
        batchSize: 10
      });

      assert.equal(manifest.dryRun, false);
      assert.equal(manifest.summary.totalErrors, 0);
      assert.equal(r2Bucket._store.size, 3);

      // 1. Media item check
      const mediaRow = baseballSqlite.prepare('SELECT file_data, storage_provider, r2_key FROM media_items WHERE id = 201').get();
      assert.equal(mediaRow.file_data, null, 'file_data should be NULL');
      assert.equal(mediaRow.storage_provider, 'r2');
      assert.ok(mediaRow.r2_key.startsWith('media/201/'));
      assert.ok(r2Bucket._store.has(mediaRow.r2_key));
      const mediaHead = await r2Bucket.head(mediaRow.r2_key);
      assert.equal(mediaHead.size, sampleSvg.length);
      assert.equal(mediaHead.customMetadata.sha256, crypto.createHash('sha256').update(sampleSvg).digest('hex'));

      // 2. Chat attachment check
      const attRow = chatSqlite.prepare('SELECT local_data_base64, storage_provider, r2_key FROM chat_attachments WHERE id = ?').get('att-201');
      assert.equal(attRow.local_data_base64, null, 'local_data_base64 should be NULL');
      assert.equal(attRow.storage_provider, 'r2');
      assert.equal(attRow.r2_key, 'attachments/1/att-201');
      assert.ok(r2Bucket._store.has(attRow.r2_key));

      // 3. Clubhouse GIF check
      const gifRow = chatSqlite.prepare('SELECT local_data_base64, storage_provider, r2_key FROM clubhouse_gifs WHERE id = ?').get('gif-201');
      assert.equal(gifRow.local_data_base64, null, 'local_data_base64 should be NULL');
      assert.equal(gifRow.storage_provider, 'r2');
      assert.equal(gifRow.r2_key, 'gifs/gif-201.gif');
      assert.ok(r2Bucket._store.has(gifRow.r2_key));
    });

    await suite.test('4. SHA-256 verification mismatch aborts safely without clearing D1 blob', async () => {
      const baseballSqlite = new Database(':memory:');
      const chatSqlite = new Database(':memory:');
      const baseballD1 = createD1Adapter(baseballSqlite);
      const chatD1 = createD1Adapter(chatSqlite);
      await ensureD1Schema(baseballD1);
      await ensureChatD1Schema(chatD1);

      // Force bucket head to return wrong SHA-256
      const r2Bucket = createMockR2Bucket({ simulateCorruptedHead: true });

      const sampleSvg = '<svg>integrity failure test</svg>';
      const sampleSvgB64 = Buffer.from(sampleSvg).toString('base64');
      baseballSqlite.prepare(`
        INSERT INTO media_items (id, title, media_type, file_url, file_data, mime_type, file_size, date_taken, is_approved, storage_provider)
        VALUES (301, 'Corrupted Photo', 'photo', '/api/media/301/file', ?, 'image/svg+xml', ?, '2026-11-16', 1, 'local')
      `).run(sampleSvgB64, sampleSvg.length);

      const manifest = await migrateD1MediaToR2({
        baseballD1,
        chatD1,
        r2Bucket,
        apply: true,
        batchSize: 10
      });

      assert.equal(manifest.summary.totalErrors, 1);
      assert.equal(manifest.summary.mediaItems.errors, 1);
      assert.equal(manifest.summary.mediaItems.migrated, 0);

      // D1 blob must remain untouched
      const mediaRow = baseballSqlite.prepare('SELECT file_data, storage_provider, r2_key FROM media_items WHERE id = 301').get();
      assert.equal(mediaRow.file_data, sampleSvgB64, 'D1 blob MUST NOT be cleared when verification fails');
      assert.equal(mediaRow.storage_provider, 'local');
      assert.equal(mediaRow.r2_key, null);
    });

    await suite.test('5. Safely idempotent when re-run against already-migrated database', async () => {
      const baseballSqlite = new Database(':memory:');
      const chatSqlite = new Database(':memory:');
      const baseballD1 = createD1Adapter(baseballSqlite);
      const chatD1 = createD1Adapter(chatSqlite);
      await ensureD1Schema(baseballD1);
      await ensureChatD1Schema(chatD1);

      const r2Bucket = createMockR2Bucket();

      const sampleSvg = '<svg>idempotency test</svg>';
      baseballSqlite.prepare(`
        INSERT INTO media_items (id, title, media_type, file_url, file_data, mime_type, file_size, date_taken, is_approved, storage_provider)
        VALUES (401, 'Idempotent Photo', 'photo', '/api/media/401/file', ?, 'image/svg+xml', ?, '2026-11-16', 1, 'local')
      `).run(Buffer.from(sampleSvg).toString('base64'), sampleSvg.length);

      // Run 1: apply
      const manifest1 = await migrateD1MediaToR2({
        baseballD1,
        chatD1,
        r2Bucket,
        apply: true
      });
      assert.equal(manifest1.summary.mediaItems.migrated, 1);

      // Run 2: re-run apply
      const manifest2 = await migrateD1MediaToR2({
        baseballD1,
        chatD1,
        r2Bucket,
        apply: true
      });
      assert.equal(manifest2.summary.mediaItems.scanned, 0);
      assert.equal(manifest2.summary.mediaItems.migrated, 0);
      assert.equal(manifest2.summary.chatAttachments.scanned, 0);
      assert.equal(manifest2.summary.clubhouseGifs.scanned, 0);
      assert.equal(manifest2.summary.totalErrors, 0);
    });

    await suite.test('6. Keyset pagination correctly processes multiple batches', async () => {
      const baseballSqlite = new Database(':memory:');
      const chatSqlite = new Database(':memory:');
      const baseballD1 = createD1Adapter(baseballSqlite);
      const chatD1 = createD1Adapter(chatSqlite);
      await ensureD1Schema(baseballD1);
      await ensureChatD1Schema(chatD1);

      const r2Bucket = createMockR2Bucket();

      // Insert 7 items and run with batchSize 2 (requires 4 page queries)
      for (let i = 1; i <= 7; i++) {
        const payload = `item ${i}`;
        baseballSqlite.prepare(`
          INSERT INTO media_items (id, title, media_type, file_url, file_data, mime_type, file_size, date_taken, is_approved, storage_provider)
          VALUES (?, ?, 'photo', ?, ?, 'text/plain', ?, '2026-11-16', 1, 'local')
        `).run(i, `Title ${i}`, `/api/media/${i}/file`, Buffer.from(payload).toString('base64'), payload.length);
      }

      const manifest = await migrateD1MediaToR2({
        baseballD1,
        chatD1,
        r2Bucket,
        apply: true,
        batchSize: 2
      });

      assert.equal(manifest.summary.mediaItems.scanned, 7);
      assert.equal(manifest.summary.mediaItems.migrated, 7);
      assert.equal(r2Bucket._store.size, 7);

      const countRemaining = baseballSqlite.prepare('SELECT COUNT(*) as cnt FROM media_items WHERE file_data IS NOT NULL').get().cnt;
      assert.equal(countRemaining, 0);
    });

    await suite.test('7. CLI subprocess execution with --dry-run and --apply against local SQLite files', () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbf-migrate-cli-'));
      const baseballPath = path.join(tempDir, 'test-baseball.db');
      const chatPath = path.join(tempDir, 'test-chat.db');
      const manifestPath = path.join(tempDir, 'manifest.json');

      try {
        const bSql = new Database(baseballPath);
        const cSql = new Database(chatPath);

        // Initialize schema
        bSql.exec(`
          CREATE TABLE IF NOT EXISTS media_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT, caption TEXT, media_type TEXT NOT NULL,
            original_url TEXT, file_url TEXT NOT NULL, file_data TEXT,
            mime_type TEXT, file_size INTEGER DEFAULT 0, album TEXT DEFAULT 'General',
            date_taken TEXT NOT NULL, contributor_name TEXT, contributor_id INTEGER,
            event_id INTEGER, is_approved INTEGER DEFAULT 0, approved_by INTEGER DEFAULT NULL,
            approved_at DATETIME DEFAULT NULL, delete_token TEXT DEFAULT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP, storage_provider TEXT NOT NULL DEFAULT 'local',
            r2_key TEXT DEFAULT NULL, upload_status TEXT NOT NULL DEFAULT 'ready',
            upload_token_hash TEXT DEFAULT NULL
          );
        `);
        cSql.exec(`
          CREATE TABLE IF NOT EXISTS chat_attachments (
            id TEXT PRIMARY KEY, channel_id INTEGER NOT NULL, message_id INTEGER DEFAULT NULL,
            uploader_id INTEGER NOT NULL, file_name TEXT NOT NULL, mime_type TEXT NOT NULL,
            file_size INTEGER NOT NULL, storage_provider TEXT NOT NULL DEFAULT 'local',
            drive_file_id TEXT DEFAULT NULL, resumable_session_uri TEXT DEFAULT NULL,
            upload_status TEXT NOT NULL DEFAULT 'pending', is_encrypted INTEGER NOT NULL DEFAULT 0,
            iv TEXT DEFAULT NULL, thumbnail_base64 TEXT DEFAULT NULL, local_data_base64 TEXT DEFAULT NULL,
            promoted_media_id INTEGER DEFAULT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            r2_key TEXT DEFAULT NULL
          );
          CREATE TABLE IF NOT EXISTS clubhouse_gifs (
            id TEXT PRIMARY KEY, title TEXT NOT NULL, tags TEXT DEFAULT '',
            mime_type TEXT NOT NULL DEFAULT 'image/gif', file_size INTEGER NOT NULL DEFAULT 0,
            source_url TEXT DEFAULT NULL, sha256 TEXT DEFAULT NULL, storage_provider TEXT NOT NULL DEFAULT 'local',
            drive_file_id TEXT DEFAULT NULL, local_data_base64 TEXT DEFAULT NULL, added_by INTEGER NOT NULL,
            added_by_name TEXT DEFAULT '', is_public INTEGER NOT NULL DEFAULT 1, use_count INTEGER NOT NULL DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP, r2_key TEXT DEFAULT NULL
          );
        `);

        bSql.prepare(`
          INSERT INTO media_items (id, title, media_type, file_url, file_data, mime_type, file_size, date_taken, is_approved, storage_provider)
          VALUES (501, 'CLI Photo', 'photo', '/api/media/501/file', ?, 'image/svg+xml', 10, '2026-11-16', 1, 'local')
        `).run(Buffer.from('<svg></svg>').toString('base64'));

        // Close bSql and cSql before invoking CLI subprocesses so Windows does not lock DB files
        bSql.close();
        cSql.close();

        // 7a. CLI Subprocess with --help
        const helpOut = execFileSync(process.execPath, [SCRIPT_PATH, '--help'], { encoding: 'utf8' });
        assert.ok(helpOut.includes('--dry-run'), 'Help output must document --dry-run');
        assert.ok(helpOut.includes('--apply'), 'Help output must document --apply');

        // 7b. CLI Subprocess with default dry run
        const dryOut = execFileSync(
          process.execPath,
          [
            SCRIPT_PATH,
            `--baseball-db=${baseballPath}`,
            `--chat-db=${chatPath}`,
            `--manifest=${manifestPath}`
          ],
          { encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test' } }
        );

        assert.ok(dryOut.includes('DRY-RUN MODE'));
        assert.ok(fs.existsSync(manifestPath), 'Audit manifest must be written to disk');
        const dryManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        assert.equal(dryManifest.dryRun, true);
        assert.equal(dryManifest.summary.mediaItems.scanned, 1);

        // 7c. CLI Subprocess with --apply
        const applyOut = execFileSync(
          process.execPath,
          [
            SCRIPT_PATH,
            '--apply',
            `--baseball-db=${baseballPath}`,
            `--chat-db=${chatPath}`,
            `--manifest=${manifestPath}`
          ],
          { encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test' } }
        );

        assert.ok(applyOut.includes('APPLY MODE'));
        const applyManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        assert.equal(applyManifest.dryRun, false);
        assert.equal(applyManifest.summary.mediaItems.migrated, 1);

        // Verify DB was modified
        const bCheck = new Database(baseballPath);
        const updatedRow = bCheck.prepare('SELECT file_data, storage_provider, r2_key FROM media_items WHERE id = 501').get();
        bCheck.close();
        assert.equal(updatedRow.file_data, null);
        assert.equal(updatedRow.storage_provider, 'r2');
        assert.ok(updatedRow.r2_key.startsWith('media/501/'));
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });
}

module.exports = registerMigrateD1MediaTests;

if (require.main === module) {
  registerMigrateD1MediaTests();
}
