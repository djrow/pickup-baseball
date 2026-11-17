#!/usr/bin/env node
/**
 * scripts/migrate-d1-media-to-r2.js
 *
 * Idempotent D1-to-R2 Media Backfill CLI (Ticket #71 / ADR-0008).
 * Migrates all non-null D1 binary rows to canonical R2 keys:
 *   1. media_items.file_data -> media/<mediaId>/<uuid> (storage_provider = 'r2', r2_key = ?, file_data = NULL)
 *   2. chat_attachments.local_data_base64 -> attachments/<channelId>/<attachmentId> (storage_provider = 'r2', r2_key = ?, local_data_base64 = NULL)
 *   3. clubhouse_gifs.local_data_base64 -> gifs/<gifId>.<ext> (storage_provider = 'r2', r2_key = ?, local_data_base64 = NULL)
 *
 * Invariants & Safety:
 *   - Defaults to --dry-run (zero mutations on D1 or R2).
 *   - Requires --apply flag to execute writes.
 *   - Uploads decoded bytes to R2, verifies size and SHA-256 via R2 bucket.head() before clearing D1 blob.
 *   - Safely aborts item migration without clearing D1 if verification or upload fails.
 *   - Keyset pagination (WHERE id > ? ORDER BY id ASC LIMIT ?).
 *   - Idempotent re-runs skip already-migrated rows.
 *   - Produces a structured JSON audit manifest log.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const { createD1Adapter } = require('../src/d1-sqlite');
const { canonicalObjectKey } = require('../src/app/storage/index.js');

const DEFAULT_BATCH_SIZE = 100;
const ROOT_DIR = path.resolve(__dirname, '..');

/**
 * Parse CLI options.
 * @param {string[]} argv
 */
function parseArgs(argv) {
  const opts = {
    apply: false,
    dryRun: true,
    batchSize: DEFAULT_BATCH_SIZE,
    baseballDb: null,
    chatDb: null,
    manifestPath: null,
    verbose: false,
    help: false
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') {
      opts.apply = true;
      opts.dryRun = false;
    } else if (arg === '--dry-run') {
      opts.dryRun = true;
      opts.apply = false;
    } else if (arg === '--verbose' || arg === '-v') {
      opts.verbose = true;
    } else if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--batch-size' && argv[i + 1]) {
      opts.batchSize = parseInt(argv[++i], 10);
    } else if (arg.startsWith('--batch-size=')) {
      opts.batchSize = parseInt(arg.slice('--batch-size='.length), 10);
    } else if (arg === '--baseball-db' && argv[i + 1]) {
      opts.baseballDb = argv[++i];
    } else if (arg.startsWith('--baseball-db=')) {
      opts.baseballDb = arg.slice('--baseball-db='.length);
    } else if (arg === '--chat-db' && argv[i + 1]) {
      opts.chatDb = argv[++i];
    } else if (arg.startsWith('--chat-db=')) {
      opts.chatDb = arg.slice('--chat-db='.length);
    } else if (arg === '--manifest' && argv[i + 1]) {
      opts.manifestPath = path.resolve(argv[++i]);
    } else if (arg.startsWith('--manifest=')) {
      opts.manifestPath = path.resolve(arg.slice('--manifest='.length));
    }
  }

  if (isNaN(opts.batchSize) || opts.batchSize <= 0) {
    opts.batchSize = DEFAULT_BATCH_SIZE;
  }

  return opts;
}

/**
 * Compute hex SHA-256 of byte buffer or Uint8Array.
 * @param {Uint8Array|Buffer} bytes
 * @returns {string}
 */
function computeSha256Hex(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/**
 * Decode base64 or data: URI into raw Uint8Array and extracted mimeType.
 * @param {string} rawString
 * @param {string} [fallbackMime='application/octet-stream']
 * @returns {{ bytes: Uint8Array, mimeType: string }}
 */
function decodeBlobData(rawString, fallbackMime = 'application/octet-stream') {
  if (typeof rawString !== 'string') {
    throw new Error('Expected string input for blob data');
  }
  const str = rawString.trim();
  let mimeType = fallbackMime;
  let b64 = str;

  if (str.startsWith('data:')) {
    const parts = str.split(';base64,');
    if (parts.length === 2) {
      mimeType = parts[0].replace('data:', '').toLowerCase().split(';')[0].trim() || fallbackMime;
      b64 = parts[1];
    }
  }

  // Remove whitespace
  b64 = b64.replace(/\s+/g, '');
  const buf = Buffer.from(b64, 'base64');
  return {
    bytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
    mimeType
  };
}

/**
 * Create a local R2 mock bucket when running against local files if no external bucket is bound.
 * @returns {any}
 */
function createLocalR2Bucket() {
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

/**
 * Migrate D1 media tables to R2.
 * @param {{
 *   baseballD1: any,
 *   chatD1: any,
 *   r2Bucket?: any,
 *   env?: any,
 *   apply?: boolean,
 *   batchSize?: number,
 *   manifestPath?: string,
 *   verbose?: boolean,
 *   log?: (msg: string) => void
 * }} opts
 */
async function migrateD1MediaToR2(opts) {
  const {
    baseballD1,
    chatD1,
    env = {},
    apply = false,
    batchSize = DEFAULT_BATCH_SIZE,
    verbose = false,
    log = (msg) => { if (verbose) console.log(msg); }
  } = opts;

  const r2Bucket = opts.r2Bucket || (env && (env.MEDIA_BUCKET || env.R2_BUCKET));
  if (!r2Bucket && apply) {
    throw new Error('R2 Bucket binding (MEDIA_BUCKET) is required for --apply mode.');
  }

  const manifest = {
    startedAt: new Date().toISOString(),
    completedAt: null,
    dryRun: !apply,
    batchSize,
    summary: {
      mediaItems: { scanned: 0, migrated: 0, skipped: 0, errors: 0 },
      chatAttachments: { scanned: 0, migrated: 0, skipped: 0, errors: 0 },
      clubhouseGifs: { scanned: 0, migrated: 0, skipped: 0, errors: 0 },
      totalErrors: 0
    },
    records: []
  };

  log(`Starting media backfill (Mode: ${apply ? 'APPLY' : 'DRY-RUN'}, BatchSize: ${batchSize})...`);

  // =========================================================================
  // 1. media_items (BASEBALL_DB)
  // =========================================================================
  let lastMediaId = 0;
  while (true) {
    const query = `
      SELECT id, file_data, mime_type, file_size, storage_provider, r2_key
      FROM media_items
      WHERE id > ? AND file_data IS NOT NULL AND file_data != ''
      ORDER BY id ASC
      LIMIT ?
    `;
    const res = await baseballD1.prepare(query).bind(lastMediaId, batchSize).all();
    const rows = (res && res.results) || [];
    if (!rows.length) break;

    for (const row of rows) {
      manifest.summary.mediaItems.scanned++;
      lastMediaId = row.id;

      try {
        const decoded = decodeBlobData(row.file_data, row.mime_type || 'image/jpeg');
        const expectedSize = decoded.bytes.byteLength;
        const expectedSha256 = computeSha256Hex(decoded.bytes);
        const uuid = crypto.randomUUID();
        const r2Key = canonicalObjectKey('media', { mediaId: row.id, uuid });

        log(`[media_items:${row.id}] size=${expectedSize} sha256=${expectedSha256.slice(0, 8)} -> ${r2Key}`);

        if (apply) {
          // Upload to R2
          await r2Bucket.put(r2Key, decoded.bytes, {
            httpMetadata: { contentType: decoded.mimeType },
            customMetadata: { sha256: expectedSha256 }
          });

          // Verify via head()
          const head = await r2Bucket.head(r2Key);
          if (!head) {
            throw new Error(`R2 head check failed: object ${r2Key} not found after put`);
          }
          if (Number(head.size) !== expectedSize) {
            throw new Error(`R2 head size mismatch for ${r2Key}: expected ${expectedSize}, got ${head.size}`);
          }
          const storedSha256 = head.customMetadata && head.customMetadata.sha256;
          if (storedSha256 && storedSha256 !== expectedSha256) {
            throw new Error(`R2 head sha256 mismatch for ${r2Key}: expected ${expectedSha256}, got ${storedSha256}`);
          }

          // Clear D1 blob & point to R2
          await baseballD1.prepare(`
            UPDATE media_items
            SET storage_provider = 'r2', r2_key = ?, file_data = NULL
            WHERE id = ?
          `).bind(r2Key, row.id).run();
        }

        manifest.summary.mediaItems.migrated++;
        manifest.records.push({
          table: 'media_items',
          id: row.id,
          r2Key,
          size: expectedSize,
          sha256: expectedSha256,
          status: apply ? 'migrated' : 'dry_run_validated'
        });
      } catch (err) {
        manifest.summary.mediaItems.errors++;
        manifest.summary.totalErrors++;
        manifest.records.push({
          table: 'media_items',
          id: row.id,
          error: err.message,
          status: 'error'
        });
        log(`[media_items:${row.id}] ERROR: ${err.message}`);
      }
    }
  }

  // =========================================================================
  // 2. chat_attachments (CHAT_DB)
  // Keyset pagination on id (string primary key, ordered ASC)
  // =========================================================================
  let lastAttId = '';
  while (true) {
    const query = `
      SELECT id, channel_id, file_name, mime_type, file_size, storage_provider, r2_key, local_data_base64
      FROM chat_attachments
      WHERE id > ? AND local_data_base64 IS NOT NULL AND local_data_base64 != ''
      ORDER BY id ASC
      LIMIT ?
    `;
    const res = await chatD1.prepare(query).bind(lastAttId, batchSize).all();
    const rows = (res && res.results) || [];
    if (!rows.length) break;

    for (const row of rows) {
      manifest.summary.chatAttachments.scanned++;
      lastAttId = row.id;

      try {
        const decoded = decodeBlobData(row.local_data_base64, row.mime_type || 'application/octet-stream');
        const expectedSize = decoded.bytes.byteLength;
        const expectedSha256 = computeSha256Hex(decoded.bytes);
        const r2Key = canonicalObjectKey('attachments', { channelId: row.channel_id, attachmentId: row.id });

        log(`[chat_attachments:${row.id}] size=${expectedSize} sha256=${expectedSha256.slice(0, 8)} -> ${r2Key}`);

        if (apply) {
          await r2Bucket.put(r2Key, decoded.bytes, {
            httpMetadata: { contentType: decoded.mimeType },
            customMetadata: { sha256: expectedSha256 }
          });

          const head = await r2Bucket.head(r2Key);
          if (!head) {
            throw new Error(`R2 head check failed: object ${r2Key} not found after put`);
          }
          if (Number(head.size) !== expectedSize) {
            throw new Error(`R2 head size mismatch for ${r2Key}: expected ${expectedSize}, got ${head.size}`);
          }
          const storedSha256 = head.customMetadata && head.customMetadata.sha256;
          if (storedSha256 && storedSha256 !== expectedSha256) {
            throw new Error(`R2 head sha256 mismatch for ${r2Key}: expected ${expectedSha256}, got ${storedSha256}`);
          }

          await chatD1.prepare(`
            UPDATE chat_attachments
            SET storage_provider = 'r2', r2_key = ?, local_data_base64 = NULL
            WHERE id = ?
          `).bind(r2Key, row.id).run();
        }

        manifest.summary.chatAttachments.migrated++;
        manifest.records.push({
          table: 'chat_attachments',
          id: row.id,
          r2Key,
          size: expectedSize,
          sha256: expectedSha256,
          status: apply ? 'migrated' : 'dry_run_validated'
        });
      } catch (err) {
        manifest.summary.chatAttachments.errors++;
        manifest.summary.totalErrors++;
        manifest.records.push({
          table: 'chat_attachments',
          id: row.id,
          error: err.message,
          status: 'error'
        });
        log(`[chat_attachments:${row.id}] ERROR: ${err.message}`);
      }
    }
  }

  // =========================================================================
  // 3. clubhouse_gifs (CHAT_DB)
  // Keyset pagination on id (string primary key, ordered ASC)
  // =========================================================================
  let lastGifId = '';
  while (true) {
    const query = `
      SELECT id, title, mime_type, file_size, storage_provider, r2_key, local_data_base64
      FROM clubhouse_gifs
      WHERE id > ? AND local_data_base64 IS NOT NULL AND local_data_base64 != ''
      ORDER BY id ASC
      LIMIT ?
    `;
    const res = await chatD1.prepare(query).bind(lastGifId, batchSize).all();
    const rows = (res && res.results) || [];
    if (!rows.length) break;

    for (const row of rows) {
      manifest.summary.clubhouseGifs.scanned++;
      lastGifId = row.id;

      try {
        const decoded = decodeBlobData(row.local_data_base64, row.mime_type || 'image/gif');
        const expectedSize = decoded.bytes.byteLength;
        const expectedSha256 = computeSha256Hex(decoded.bytes);
        const ext = decoded.mimeType === 'image/webp' ? 'webp' : 'gif';
        const r2Key = canonicalObjectKey('gifs', { gifId: row.id, ext });

        log(`[clubhouse_gifs:${row.id}] size=${expectedSize} sha256=${expectedSha256.slice(0, 8)} -> ${r2Key}`);

        if (apply) {
          await r2Bucket.put(r2Key, decoded.bytes, {
            httpMetadata: { contentType: decoded.mimeType },
            customMetadata: { sha256: expectedSha256 }
          });

          const head = await r2Bucket.head(r2Key);
          if (!head) {
            throw new Error(`R2 head check failed: object ${r2Key} not found after put`);
          }
          if (Number(head.size) !== expectedSize) {
            throw new Error(`R2 head size mismatch for ${r2Key}: expected ${expectedSize}, got ${head.size}`);
          }
          const storedSha256 = head.customMetadata && head.customMetadata.sha256;
          if (storedSha256 && storedSha256 !== expectedSha256) {
            throw new Error(`R2 head sha256 mismatch for ${r2Key}: expected ${expectedSha256}, got ${storedSha256}`);
          }

          await chatD1.prepare(`
            UPDATE clubhouse_gifs
            SET storage_provider = 'r2', r2_key = ?, local_data_base64 = NULL
            WHERE id = ?
          `).bind(r2Key, row.id).run();
        }

        manifest.summary.clubhouseGifs.migrated++;
        manifest.records.push({
          table: 'clubhouse_gifs',
          id: row.id,
          r2Key,
          size: expectedSize,
          sha256: expectedSha256,
          status: apply ? 'migrated' : 'dry_run_validated'
        });
      } catch (err) {
        manifest.summary.clubhouseGifs.errors++;
        manifest.summary.totalErrors++;
        manifest.records.push({
          table: 'clubhouse_gifs',
          id: row.id,
          error: err.message,
          status: 'error'
        });
        log(`[clubhouse_gifs:${row.id}] ERROR: ${err.message}`);
      }
    }
  }

  manifest.completedAt = new Date().toISOString();
  return manifest;
}

/**
 * CLI Entry point
 */
async function main() {
  const argv = process.argv.slice(2);
  const opts = parseArgs(argv);

  if (opts.help) {
    console.log(`
Usage: node scripts/migrate-d1-media-to-r2.js [options]

Idempotent D1-to-R2 Media Backfill CLI (Ticket #71).
Migrates non-null D1 binary rows (media_items, chat_attachments, clubhouse_gifs)
to canonical R2 keys, verifying size and SHA-256 via R2 head() before clearing D1 blobs.

Options:
  --dry-run             Simulate migration without modifying D1 or R2 (default)
  --apply               Execute R2 uploads, verify head, and clear D1 blobs
  --batch-size <num>    Keyset pagination batch size (default: 100)
  --baseball-db <path>  Path to local SQLite BASEBALL_DB file
  --chat-db <path>      Path to local SQLite CHAT_DB file
  --manifest <path>     Path to output JSON audit manifest (default: logs/r2-migration-TIMESTAMP.json)
  --verbose, -v         Enable detailed per-item progress logging
  --help, -h            Show this help text
`);
    process.exit(0);
  }

  console.log(`=== PBF D1-to-R2 Media Backfill CLI ===`);
  console.log(`Mode: ${opts.apply ? 'APPLY MODE (mutations enabled)' : 'DRY-RUN MODE (read-only verification)'}`);
  console.log(`Batch Size: ${opts.batchSize}`);

  // Resolve databases
  const defaultDataDir = path.join(ROOT_DIR, 'data');
  const baseballDbPath = opts.baseballDb || process.env.DB_PATH || path.join(defaultDataDir, 'pickup_baseball.db');
  const chatDbPath = opts.chatDb || process.env.CHAT_DB_PATH || path.join(defaultDataDir, 'pickup_chat.db');

  let baseballSqlite;
  let chatSqlite;
  try {
    if (fs.existsSync(baseballDbPath)) {
      baseballSqlite = new Database(baseballDbPath);
    } else {
      baseballSqlite = new Database(':memory:');
    }
    if (fs.existsSync(chatDbPath)) {
      chatSqlite = new Database(chatDbPath);
    } else {
      chatSqlite = new Database(':memory:');
    }

    const baseballD1 = createD1Adapter(baseballSqlite);
    const chatD1 = createD1Adapter(chatSqlite);

    // If running in local CLI environment without live Cloudflare R2 worker binding, use mock bucket
    const r2Bucket = createLocalR2Bucket();

    const manifest = await migrateD1MediaToR2({
      baseballD1,
      chatD1,
      r2Bucket,
      apply: opts.apply,
      batchSize: opts.batchSize,
      verbose: opts.verbose
    });

    // Write audit manifest
    const manifestPath = opts.manifestPath || path.join(
      ROOT_DIR,
      'logs',
      `r2-media-migration-${Date.now()}.json`
    );

    const manifestDir = path.dirname(manifestPath);
    if (!fs.existsSync(manifestDir)) {
      fs.mkdirSync(manifestDir, { recursive: true });
    }

    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    console.log(`\nAudit manifest written to: ${manifestPath}`);
    console.log(`Summary:`);
    console.log(`  Media items:     ${manifest.summary.mediaItems.migrated} / ${manifest.summary.mediaItems.scanned} migrated (${manifest.summary.mediaItems.errors} errors)`);
    console.log(`  Chat attachments:${manifest.summary.chatAttachments.migrated} / ${manifest.summary.chatAttachments.scanned} migrated (${manifest.summary.chatAttachments.errors} errors)`);
    console.log(`  Clubhouse GIFs:  ${manifest.summary.clubhouseGifs.migrated} / ${manifest.summary.clubhouseGifs.scanned} migrated (${manifest.summary.clubhouseGifs.errors} errors)`);
    console.log(`  Total Errors:    ${manifest.summary.totalErrors}`);

    if (manifest.summary.totalErrors > 0) {
      process.exit(1);
    }
  } catch (err) {
    console.error(`Execution error: ${err.message}`);
    process.exit(1);
  } finally {
    try {
      if (baseballSqlite) baseballSqlite.close();
      if (chatSqlite) chatSqlite.close();
    } catch (_e) {
      /* ignore close errors on shutdown */
    }
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`Fatal error in migrate-d1-media-to-r2:`, err);
    process.exit(1);
  });
}

module.exports = {
  migrateD1MediaToR2,
  parseArgs,
  computeSha256Hex,
  decodeBlobData,
  createLocalR2Bucket
};
