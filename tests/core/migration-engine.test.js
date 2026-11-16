/**
 * Versioned Schema Migration Engine & `db:migrate` CLI Tests (Ticket #30)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const { createD1Adapter } = require('../../src/d1-sqlite');

const ROOT_DIR = path.join(__dirname, '..', '..');
const MIGRATE_SCRIPT = path.join(ROOT_DIR, 'scripts', 'migrate-db.js');

function createSpyD1(innerD1, options = {}) {
  const { delayBatchMs = 0, failOnSqlMatch = null } = options;
  const log = {
    prepared: [],
    batches: [],
    pragmaTables: [],
    alters: []
  };

  function recordSql(sql) {
    log.prepared.push(sql);
    const pragmaMatch = sql.match(/PRAGMA\s+table_info\(\s*([a-zA-Z0-9_]+)\s*\)/i);
    if (pragmaMatch) log.pragmaTables.push(pragmaMatch[1]);
    if (/^\s*ALTER\s+TABLE\b/i.test(sql)) log.alters.push(sql);
  }

  function wrapStmt(rawStmt, sql) {
    return {
      __raw: rawStmt,
      __sql: sql,
      bind(...params) {
        return wrapStmt(rawStmt.bind(...params), sql);
      },
      async first(col) {
        recordSql(sql);
        if (failOnSqlMatch && failOnSqlMatch(sql)) {
          throw new Error(`Injected SQL failure: ${sql}`);
        }
        return rawStmt.first(col);
      },
      async all() {
        recordSql(sql);
        if (failOnSqlMatch && failOnSqlMatch(sql)) {
          throw new Error(`Injected SQL failure: ${sql}`);
        }
        return rawStmt.all();
      },
      async run() {
        recordSql(sql);
        if (failOnSqlMatch && failOnSqlMatch(sql)) {
          throw new Error(`Injected SQL failure: ${sql}`);
        }
        return rawStmt.run();
      },
      raw() {
        recordSql(sql);
        return rawStmt.raw();
      }
    };
  }

  return {
    log,
    prepare(sql) {
      return wrapStmt(innerD1.prepare(sql), sql);
    },
    async batch(stmts) {
      const sqls = stmts.map((s) => s.__sql || '');
      log.batches.push(sqls);
      for (const sql of sqls) {
        recordSql(sql);
        if (failOnSqlMatch && failOnSqlMatch(sql)) {
          throw new Error(`Injected batch SQL failure: ${sql}`);
        }
      }
      if (delayBatchMs > 0) {
        await new Promise((r) => setTimeout(r, delayBatchMs));
      }
      return innerD1.batch(stmts.map((s) => s.__raw || s));
    }
  };
}

module.exports = function registerMigrationEngineTests() {
  test('Ticket #30: Versioned Migration Engine & db:migrate CLI', async (t) => {
    const engineMod = await import('../../src/app/schema/engine.js');
    const migrationsMod = await import('../../src/app/schema/migrations.js');
    const {
      ensureD1Schema,
      ensureChatD1Schema,
      ensureDualD1Schema,
      runVersionedMigrations,
      BASEBALL_SCHEMA_VERSION,
      CHAT_SCHEMA_VERSION
    } = engineMod;
    const {
      BASEBALL_MIGRATIONS,
      CHAT_MIGRATIONS,
      OLD_HIGHLIGHTS_TOPIC,
      NEW_HIGHLIGHTS_TOPIC
    } = migrationsMod;

    await t.test('1. Integer schema_version & ordered BASEBALL_MIGRATIONS / CHAT_MIGRATIONS', () => {
      assert.ok(Number.isInteger(BASEBALL_SCHEMA_VERSION) && BASEBALL_SCHEMA_VERSION >= 1);
      assert.ok(Number.isInteger(CHAT_SCHEMA_VERSION) && CHAT_SCHEMA_VERSION >= 1);
      assert.ok(Array.isArray(BASEBALL_MIGRATIONS) && BASEBALL_MIGRATIONS.length >= 1);
      assert.ok(Array.isArray(CHAT_MIGRATIONS) && CHAT_MIGRATIONS.length >= 1);
      assert.equal(
        BASEBALL_MIGRATIONS[BASEBALL_MIGRATIONS.length - 1].version,
        BASEBALL_SCHEMA_VERSION
      );
      assert.equal(
        CHAT_MIGRATIONS[CHAT_MIGRATIONS.length - 1].version,
        CHAT_SCHEMA_VERSION
      );
    });

    await t.test('2. Fresh-DB single-batch fast-path skips PRAGMA/ALTER and stamps integer schema_version', async () => {
      const rawBaseball = new Database(':memory:');
      const rawChat = new Database(':memory:');
      const spyBaseball = createSpyD1(createD1Adapter(rawBaseball));
      const spyChat = createSpyD1(createD1Adapter(rawChat));

      try {
        await ensureD1Schema(spyBaseball);
        await ensureChatD1Schema(spyChat);

        assert.equal(spyBaseball.log.pragmaTables.length, 0, 'Fresh BASEBALL_DB fast-path must skip PRAGMA table_info');
        assert.equal(spyBaseball.log.alters.length, 0, 'Fresh BASEBALL_DB fast-path must execute 0 ALTER TABLE statements');
        assert.ok(
          spyBaseball.log.batches.some((b) =>
            b.some((s) => /CREATE TABLE IF NOT EXISTS users/i.test(s)) &&
            b.some((s) => /INSERT OR REPLACE INTO app_settings/i.test(s))
          ),
          'Fresh BASEBALL_DB must create tables and stamp schema_version in one batch'
        );

        const bbVer = rawBaseball.prepare("SELECT value FROM app_settings WHERE key = 'schema_version'").get();
        assert.equal(bbVer.value, String(BASEBALL_SCHEMA_VERSION));

        assert.equal(spyChat.log.pragmaTables.length, 0, 'Fresh CHAT_DB fast-path must skip PRAGMA table_info');
        assert.equal(spyChat.log.alters.length, 0, 'Fresh CHAT_DB fast-path must execute 0 ALTER TABLE statements');
        assert.equal(spyChat.log.batches.length, 1, 'Fresh CHAT_DB must initialize tables, channels, and schema_version in 1 batch');

        const chatVer = rawChat.prepare("SELECT value FROM chat_meta WHERE key = 'schema_version'").get();
        assert.equal(chatVer.value, String(CHAT_SCHEMA_VERSION));
        const chCount = rawChat.prepare('SELECT COUNT(*) as c FROM channels').get().c;
        assert.equal(chCount, 7);
      } finally {
        rawBaseball.close();
        rawChat.close();
      }
    });

    await t.test('3. Existing legacy DB upgrades incrementally via PRAGMA table_info and alters only missing columns', async () => {
      const rawBaseball = new Database(':memory:');
      // Pre-migration legacy schema missing several columns & tables, and missing app_settings
      rawBaseball.exec(`
        CREATE TABLE users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          email TEXT NOT NULL UNIQUE COLLATE NOCASE,
          is_admin INTEGER DEFAULT 0,
          bio TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          user_id INTEGER NOT NULL,
          expires_at DATETIME NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE auth_codes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          email TEXT NOT NULL,
          name TEXT,
          code TEXT NOT NULL,
          token TEXT NOT NULL UNIQUE,
          expires_at DATETIME NOT NULL,
          used_at DATETIME,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          description TEXT,
          location TEXT NOT NULL,
          location_url TEXT,
          event_date DATETIME NOT NULL,
          max_players INTEGER DEFAULT NULL,
          status TEXT DEFAULT 'active',
          created_by INTEGER,
          reminder_sent INTEGER DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE attendees (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id INTEGER NOT NULL,
          user_id INTEGER,
          name TEXT NOT NULL,
          email TEXT NOT NULL,
          is_guest INTEGER DEFAULT 0,
          status TEXT DEFAULT 'attending',
          gear_bringing TEXT,
          notes TEXT,
          management_token TEXT UNIQUE,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE media_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT,
          caption TEXT,
          media_type TEXT NOT NULL,
          original_url TEXT,
          file_url TEXT NOT NULL,
          file_data TEXT,
          mime_type TEXT,
          file_size INTEGER DEFAULT 0,
          album TEXT DEFAULT 'General',
          date_taken TEXT NOT NULL,
          contributor_name TEXT,
          contributor_id INTEGER,
          event_id INTEGER,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);
      rawBaseball.prepare("INSERT INTO users (name, email, is_admin) VALUES ('Admin', 'a@example.org', 1)").run();
      rawBaseball.prepare("INSERT INTO events (title, location, event_date) VALUES ('Game 1', 'Bushrod Part Field 1', '2026-11-20T12:00:00Z')").run();
      rawBaseball.prepare("INSERT INTO attendees (event_id, name, email, status) VALUES (1, 'P1', 'p1@example.org', 'attending')").run();

      const spyBaseball = createSpyD1(createD1Adapter(rawBaseball));

      const rawChat = new Database(':memory:');
      rawChat.exec(`
        CREATE TABLE channels (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          slug TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          category TEXT NOT NULL DEFAULT 'Text Channels',
          channel_type TEXT NOT NULL DEFAULT 'text',
          topic TEXT DEFAULT '',
          min_role_read TEXT NOT NULL DEFAULT 'player',
          min_role_write TEXT NOT NULL DEFAULT 'player',
          is_encrypted INTEGER NOT NULL DEFAULT 1,
          linked_event_id INTEGER DEFAULT NULL,
          retention_days INTEGER DEFAULT 365,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_by INTEGER DEFAULT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE channel_members (
          channel_id INTEGER NOT NULL,
          user_id INTEGER NOT NULL,
          role TEXT DEFAULT 'member',
          last_read_message_id INTEGER DEFAULT 0,
          muted INTEGER DEFAULT 0,
          joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (channel_id, user_id)
        );
        CREATE TABLE messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          channel_id INTEGER NOT NULL,
          parent_message_id INTEGER DEFAULT NULL,
          author_id INTEGER NOT NULL,
          author_name TEXT NOT NULL,
          author_role TEXT DEFAULT 'player',
          author_badges TEXT DEFAULT '{}',
          content TEXT NOT NULL,
          iv TEXT DEFAULT NULL,
          key_epoch INTEGER DEFAULT 1,
          message_type TEXT NOT NULL DEFAULT 'text',
          metadata_json TEXT DEFAULT NULL,
          reply_count INTEGER NOT NULL DEFAULT 0,
          edited_at DATETIME DEFAULT NULL,
          deleted_at DATETIME DEFAULT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);
      rawChat.prepare(
        "INSERT INTO channels (slug, name, category, channel_type, topic) VALUES ('highlights-and-media', '#highlights-and-media', 'Text Channels', 'text', ?)"
      ).run(OLD_HIGHLIGHTS_TOPIC);

      const spyChat = createSpyD1(createD1Adapter(rawChat));

      try {
        await ensureD1Schema(spyBaseball);
        await ensureChatD1Schema(spyChat);

        // PRAGMA table_info must be queried and existing column `users.bio` must NOT be altered again
        assert.ok(spyBaseball.log.pragmaTables.includes('users'), 'Must probe PRAGMA table_info(users)');
        assert.ok(
          !spyBaseball.log.alters.some((sql) => /\bADD COLUMN bio\b/i.test(sql)),
          'Must skip ALTER TABLE for column already present (users.bio)'
        );
        assert.ok(
          spyBaseball.log.alters.some((sql) => /\bADD COLUMN calendar_token\b/i.test(sql)),
          'Must ALTER TABLE for missing column (users.calendar_token)'
        );

        // Verify backfills & version stamp
        const adminRow = rawBaseball.prepare("SELECT role FROM users WHERE email = 'a@example.org'").get();
        assert.equal(adminRow.role, 'admin');
        const evRow = rawBaseball.prepare('SELECT location FROM events WHERE id = 1').get();
        assert.equal(evRow.location, 'Bushrod Park Field 1');
        const attRow = rawBaseball.prepare('SELECT players_count FROM attendees WHERE id = 1').get();
        assert.equal(attRow.players_count, 1);
        const bbVer = rawBaseball.prepare("SELECT value FROM app_settings WHERE key = 'schema_version'").get();
        assert.equal(bbVer.value, String(BASEBALL_SCHEMA_VERSION));

        // Verify CHAT_DB incremental upgrade
        assert.ok(spyChat.log.pragmaTables.includes('messages'), 'Must probe PRAGMA table_info(messages)');
        assert.ok(spyChat.log.alters.some((sql) => /\bADD COLUMN is_private\b/i.test(sql)));
        const hlRow = rawChat.prepare("SELECT topic FROM channels WHERE slug = 'highlights-and-media'").get();
        assert.equal(hlRow.topic, NEW_HIGHLIGHTS_TOPIC);
        const chatVer = rawChat.prepare("SELECT value FROM chat_meta WHERE key = 'schema_version'").get();
        assert.equal(chatVer.value, String(CHAT_SCHEMA_VERSION));
      } finally {
        rawBaseball.close();
        rawChat.close();
      }
    });

    await t.test('4. Multi-step incremental upgrade skips completed steps and fails loud without advancing schema_version', async () => {
      const raw = new Database(':memory:');
      raw.exec(`
        CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT);
      `);
      raw.prepare("INSERT INTO app_settings (key, value) VALUES ('schema_version', '1')").run();
      const d1 = createD1Adapter(raw);

      let step1Ran = 0;
      let step2Ran = 0;
      const migrations = [
        {
          version: 1,
          name: 'step-1',
          async run() {
            step1Ran += 1;
          }
        },
        {
          version: 2,
          name: 'step-2-add-col',
          columns: [
            { table: 'items', column: 'label', sql: 'ALTER TABLE items ADD COLUMN label TEXT DEFAULT NULL' }
          ],
          async run() {
            step2Ran += 1;
          }
        },
        {
          version: 3,
          name: 'step-3-invalid-sql',
          sqlStatements: [
            'ALTER TABLE non_existent_table ADD COLUMN boom TEXT'
          ]
        }
      ];

      try {
        await assert.rejects(
          () => runVersionedMigrations(d1, {
            metaTable: 'app_settings',
            migrations
          }),
          /no such table: non_existent_table/i,
          'Failing migration step must throw loudly'
        );

        assert.equal(step1Ran, 0, 'Already-completed step 1 must be skipped when schema_version is 1');
        assert.equal(step2Ran, 1, 'Pending step 2 must run');

        const verAfterFail = raw.prepare("SELECT value FROM app_settings WHERE key = 'schema_version'").get();
        assert.equal(verAfterFail.value, '2', 'schema_version must advance to 2 and NOT advance to 3 after step 3 failed');
      } finally {
        raw.close();
      }
    });

    await t.test('5. Legacy string schema_version (2026-11-14.1) upgrades cleanly to integer schema_version', async () => {
      const raw = new Database(':memory:');
      const innerD1 = createD1Adapter(raw);
      await ensureD1Schema(innerD1);
      // Simulate legacy string schema_version stored prior to Ticket #30
      raw.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('schema_version', '2026-11-14.1')").run();

      const freshWrapper = createSpyD1(createD1Adapter(raw));
      try {
        await ensureD1Schema(freshWrapper);
        const ver = raw.prepare("SELECT value FROM app_settings WHERE key = 'schema_version'").get();
        assert.equal(ver.value, String(BASEBALL_SCHEMA_VERSION));
        assert.ok(freshWrapper.log.pragmaTables.includes('users'), 'Legacy string version must trigger PRAGMA verification, not parseInt("2026...") skip');
        assert.equal(freshWrapper.log.alters.length, 0, 'All columns already present so 0 ALTER TABLEs run');
      } finally {
        raw.close();
      }
    });

    await t.test('6. Cold-start concurrency lock deduplicates concurrent isolate calls and retries after failure', async () => {
      const rawBaseball = new Database(':memory:');
      const rawChat = new Database(':memory:');
      const spyBaseball = createSpyD1(createD1Adapter(rawBaseball), { delayBatchMs: 25 });
      const spyChat = createSpyD1(createD1Adapter(rawChat), { delayBatchMs: 25 });

      try {
        await Promise.all([
          ensureDualD1Schema({ BASEBALL_DB: spyBaseball, CHAT_DB: spyChat }),
          ensureDualD1Schema({ BASEBALL_DB: spyBaseball, CHAT_DB: spyChat }),
          ensureDualD1Schema({ BASEBALL_DB: spyBaseball, CHAT_DB: spyChat }),
          ensureDualD1Schema({ BASEBALL_DB: spyBaseball, CHAT_DB: spyChat }),
          ensureDualD1Schema({ BASEBALL_DB: spyBaseball, CHAT_DB: spyChat })
        ]);

        const schemaBatches = spyBaseball.log.batches.filter((b) =>
          b.some((s) => /CREATE TABLE IF NOT EXISTS users/i.test(s))
        );
        assert.equal(schemaBatches.length, 1, '5 concurrent cold-start ensureDualD1Schema calls must execute BASEBALL_DB DDL batch exactly once');
        assert.equal(spyChat.log.batches.length, 1, '5 concurrent cold-start ensureDualD1Schema calls must execute CHAT_DB batch exactly once');
      } finally {
        rawBaseball.close();
        rawChat.close();
      }

      // Failure must not poison WeakMap lock or WeakSet
      const rawFail = new Database(':memory:');
      let shouldFail = true;
      const failOnceDb = createSpyD1(createD1Adapter(rawFail), {
        failOnSqlMatch: (sql) => shouldFail && /CREATE TABLE IF NOT EXISTS users/i.test(sql)
      });

      try {
        await assert.rejects(
          () => Promise.all([
            ensureD1Schema(failOnceDb),
            ensureD1Schema(failOnceDb)
          ]),
          /Injected batch SQL failure/
        );
        shouldFail = false;
        await ensureD1Schema(failOnceDb);
        const ver = rawFail.prepare("SELECT value FROM app_settings WHERE key = 'schema_version'").get();
        assert.equal(ver.value, String(BASEBALL_SCHEMA_VERSION), 'Retry after cold-start failure must succeed');
      } finally {
        rawFail.close();
      }
    });

    await t.test('7. npm run db:migrate local SQLite execution & --remote adapter batching', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbf-migrate-cli-'));
      const bbPath = path.join(tmpDir, 'baseball.db');
      const chatPath = path.join(tmpDir, 'chat.db');

      try {
        // Fresh DB migration via CLI
        const stdout1 = execFileSync(process.execPath, [MIGRATE_SCRIPT], {
          cwd: ROOT_DIR,
          env: {
            ...process.env,
            DB_PATH: bbPath,
            CHAT_DB_PATH: chatPath
          },
          encoding: 'utf8'
        });
        assert.match(stdout1, /BASEBALL_DB/i);
        assert.match(stdout1, /CHAT_DB/i);

        const bb = new Database(bbPath);
        const chat = new Database(chatPath);
        try {
          const bbVer = bb.prepare("SELECT value FROM app_settings WHERE key = 'schema_version'").get();
          const chatVer = chat.prepare("SELECT value FROM chat_meta WHERE key = 'schema_version'").get();
          assert.equal(bbVer.value, String(BASEBALL_SCHEMA_VERSION));
          assert.equal(chatVer.value, String(CHAT_SCHEMA_VERSION));
        } finally {
          bb.close();
          chat.close();
        }

        // Idempotent second run
        execFileSync(process.execPath, [MIGRATE_SCRIPT], {
          cwd: ROOT_DIR,
          env: {
            ...process.env,
            DB_PATH: bbPath,
            CHAT_DB_PATH: chatPath
          },
          encoding: 'utf8'
        });

        // Verify --remote Wrangler D1 adapter parameter binding & batching
        const {
          bindSqlParameters,
          createWranglerD1Adapter
        } = require(MIGRATE_SCRIPT);

        assert.equal(
          bindSqlParameters("SELECT * FROM media_items WHERE original_url = ? AND note = 'what?' AND x = ?", [
            "https://youtube.com/watch?v=abc&q='1'",
            42
          ]),
          "SELECT * FROM media_items WHERE original_url = 'https://youtube.com/watch?v=abc&q=''1''' AND note = 'what?' AND x = 42"
        );

        const executedBatches = [];
        const mockRaw = new Database(':memory:');
        const remoteAdapter = createWranglerD1Adapter('pickup-baseball-db', {
          remote: true,
          executeSqlFile(sqlText, flags) {
            executedBatches.push({ sqlText, flags });
            // Simulate wrangler --json output using in-memory sqlite
            const stmts = sqlText
              .split(/;\s*\n/)
              .map((s) => s.trim())
              .filter(Boolean);
            return stmts.map((stmtSql) => {
              const s = mockRaw.prepare(stmtSql);
              if (s.reader) {
                return { results: s.all(), success: true, meta: { duration: 0 } };
              }
              s.run();
              return { results: [], success: true, meta: { duration: 0 } };
            });
          }
        });

        try {
          await ensureD1Schema(remoteAdapter);
          assert.ok(executedBatches.some((b) => b.flags.includes('--remote')));
          const ver = mockRaw.prepare("SELECT value FROM app_settings WHERE key = 'schema_version'").get();
          assert.equal(ver.value, String(BASEBALL_SCHEMA_VERSION));
        } finally {
          mockRaw.close();
        }
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    await t.test('8. Ticket #32: Chunked session ID backfill purges expired rows and hashes active sessions in 50-row batches', async () => {
      const { hashSessionId } = await import('../../src/app/security.js');
      const { getUserFromSession } = await import('../../src/app/security.js');
      const { CREATE_TABLES_SQL } = await import('../../src/app/schema/baseball-ddl.js');

      const raw = new Database(':memory:');
      for (const sql of CREATE_TABLES_SQL) {
        raw.exec(sql);
      }
      // Stamp DB at v1 (pre-session-hash-backfill)
      raw.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('schema_version', '1')").run();
      raw.prepare("INSERT INTO users (id, name, email, role) VALUES (1, 'Backfill Player', 'backfill@example.org', 'member')").run();

      const futureIso = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
      const pastIso = new Date(Date.now() - 3600 * 1000).toISOString();
      const pastSqlite = '2020-01-01 00:00:00';

      // Seed 120 active unhashed sessions (exercises 3 chunks: 50 + 50 + 20)
      const activeRawTokens = [];
      const insStmt = raw.prepare('INSERT INTO sessions (id, user_id, expires_at, is_temporary) VALUES (?, 1, ?, ?)');
      for (let i = 0; i < 120; i++) {
        const tok = `legacy_active_${i}_${crypto.randomBytes(8).toString('hex')}`;
        activeRawTokens.push(tok);
        insStmt.run(tok, futureIso, i % 2);
      }

      // Seed 15 expired unhashed sessions (both ISO and SQLite formats)
      const expiredTokens = [];
      for (let i = 0; i < 15; i++) {
        const tok = `legacy_expired_${i}_${crypto.randomBytes(8).toString('hex')}`;
        expiredTokens.push(tok);
        insStmt.run(tok, i % 2 === 0 ? pastIso : pastSqlite, 0);
      }

      // Seed 2 already-hashed active sessions
      const alreadyRaw1 = `already_hashed_1_${crypto.randomBytes(8).toString('hex')}`;
      const alreadyRaw2 = `already_hashed_2_${crypto.randomBytes(8).toString('hex')}`;
      const alreadyHash1 = `sha256:${crypto.createHash('sha256').update(alreadyRaw1).digest('hex')}`;
      const alreadyHash2 = `sha256:${crypto.createHash('sha256').update(alreadyRaw2).digest('hex')}`;
      insStmt.run(alreadyHash1, futureIso, 0);
      insStmt.run(alreadyHash2, futureIso, 1);

      const spyD1 = createSpyD1(createD1Adapter(raw));
      try {
        await ensureD1Schema(spyD1);

        // 1. Expired sessions must be purged
        for (const expTok of expiredTokens) {
          assert.equal(raw.prepare('SELECT id FROM sessions WHERE id = ?').get(expTok), undefined, 'Expired raw session must be purged');
          const expHash = await hashSessionId(expTok);
          assert.equal(raw.prepare('SELECT id FROM sessions WHERE id = ?').get(expHash), undefined, 'Expired session must not be hashed/kept');
        }

        // 2. All 120 active unhashed sessions must be hashed in-place; no unprefixed rows remain
        const unhashedRemaining = raw.prepare("SELECT COUNT(*) as c FROM sessions WHERE id NOT LIKE 'sha256:%'").get().c;
        assert.equal(unhashedRemaining, 0, 'Zero unhashed session rows may remain after backfill');
        assert.equal(raw.prepare('SELECT COUNT(*) as c FROM sessions').get().c, 122, 'All 120 active + 2 pre-hashed sessions must be preserved');

        for (const rawTok of activeRawTokens) {
          assert.equal(raw.prepare('SELECT id FROM sessions WHERE id = ?').get(rawTok), undefined);
          const expected = await hashSessionId(rawTok);
          const row = raw.prepare('SELECT * FROM sessions WHERE id = ?').get(expected);
          assert.ok(row, 'Active session must be hashed to sha256:<hex>');
        }

        // 3. Pre-hashed sessions must not be double-hashed
        assert.ok(raw.prepare('SELECT id FROM sessions WHERE id = ?').get(alreadyHash1), 'Already-hashed session #1 must remain intact');
        assert.ok(raw.prepare('SELECT id FROM sessions WHERE id = ?').get(alreadyHash2), 'Already-hashed session #2 must remain intact');

        // 4. Batches must be bounded to <= 50 statements per db.batch()
        const sessionUpdateBatches = spyD1.log.batches.filter((b) =>
          b.some((s) => /UPDATE\s+sessions\s+SET\s+id\s*=/i.test(s))
        );
        assert.deepEqual(
          sessionUpdateBatches.map((b) => b.length),
          [50, 50, 20],
          'Backfill must execute UPDATE batches in bounded chunks of 50 (50, 50, 20)'
        );

        // 5. Active cookies still authenticate after backfill
        const resolvedUser = await getUserFromSession(spyD1, activeRawTokens[0], null, { lightweight: true });
        assert.ok(resolvedUser && resolvedUser.id === 1, 'Original raw cookie must still authenticate after backfill');

        // 6. schema_version must advance to BASEBALL_SCHEMA_VERSION
        const ver = raw.prepare("SELECT value FROM app_settings WHERE key = 'schema_version'").get();
        assert.equal(ver.value, String(BASEBALL_SCHEMA_VERSION));

        // 7. Re-running with force=true must be idempotent (0 updates)
        spyD1.log.batches.length = 0;
        await ensureD1Schema(spyD1, true);
        const reRunUpdateBatches = spyD1.log.batches.filter((b) =>
          b.some((s) => /UPDATE\s+sessions\s+SET\s+id\s*=/i.test(s))
        );
        assert.equal(reRunUpdateBatches.length, 0, 'Idempotent re-run must not update already-hashed rows');
        assert.ok(raw.prepare('SELECT id FROM sessions WHERE id = ?').get(alreadyHash1));
      } finally {
        raw.close();
      }

      // 8. Verify --remote Wrangler D1 adapter executes JS-hashed backfill cleanly
      const { createWranglerD1Adapter } = require(MIGRATE_SCRIPT);
      const mockRemoteRaw = new Database(':memory:');
      for (const sql of CREATE_TABLES_SQL) {
        mockRemoteRaw.exec(sql);
      }
      mockRemoteRaw.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('schema_version', '1')").run();
      mockRemoteRaw.prepare("INSERT INTO users (id, name, email, role) VALUES (1, 'Remote Player', 'remote@example.org', 'member')").run();
      const remoteTok = `remote_legacy_${crypto.randomBytes(8).toString('hex')}`;
      mockRemoteRaw.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, 1, ?)').run(remoteTok, futureIso);

      const remoteAdapter = createWranglerD1Adapter('pickup-baseball-db', {
        remote: true,
        executeSqlFile(sqlText) {
          const stmts = sqlText.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean);
          return stmts.map((stmtSql) => {
            const s = mockRemoteRaw.prepare(stmtSql);
            if (s.reader) {
              return { results: s.all(), success: true, meta: { duration: 0 } };
            }
            s.run();
            return { results: [], success: true, meta: { duration: 0 } };
          });
        }
      });

      try {
        await ensureD1Schema(remoteAdapter);
        const expectedRemoteHash = await hashSessionId(remoteTok);
        assert.equal(mockRemoteRaw.prepare('SELECT id FROM sessions WHERE id = ?').get(remoteTok), undefined);
        assert.ok(mockRemoteRaw.prepare('SELECT id FROM sessions WHERE id = ?').get(expectedRemoteHash), 'Remote Wrangler adapter must complete JS-hashed session backfill');
        const remoteVer = mockRemoteRaw.prepare("SELECT value FROM app_settings WHERE key = 'schema_version'").get();
        assert.equal(remoteVer.value, String(BASEBALL_SCHEMA_VERSION));
      } finally {
        mockRemoteRaw.close();
      }
    });
  });

  test('Ticket #31: Additive Schema Parity (v149-upgraded vs fresh) & Backfills', async (t) => {
    const engineMod = await import('../../src/app/schema/engine.js');
    const {
      ensureDualD1Schema,
      BASEBALL_SCHEMA_VERSION,
      CHAT_SCHEMA_VERSION
    } = engineMod;

    // Snapshot of v149 BASEBALL_DB DDL (pre-Ticket #31)
    const V149_BASEBALL_SQL = `
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        bio TEXT,
        avatar_url TEXT,
        role TEXT DEFAULT 'player',
        is_admin INTEGER DEFAULT 0,
        is_moderator INTEGER DEFAULT 0,
        chat_muted INTEGER DEFAULT 0,
        chat_muted_reason TEXT DEFAULT NULL,
        chat_muted_by INTEGER DEFAULT NULL,
        chat_muted_at DATETIME DEFAULT NULL,
        machine_badge INTEGER DEFAULT 0,
        field_badge INTEGER DEFAULT 0,
        hero_credits INTEGER DEFAULT 0,
        waiver_status TEXT DEFAULT 'none',
        waiver_signed_at DATETIME DEFAULT NULL,
        clubhouse_opted_in INTEGER DEFAULT 0,
        calendar_token TEXT DEFAULT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at DATETIME NOT NULL,
        is_temporary INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE auth_codes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL COLLATE NOCASE,
        name TEXT,
        code TEXT NOT NULL,
        token TEXT NOT NULL UNIQUE,
        attempts INTEGER DEFAULT 0,
        shared_device INTEGER DEFAULT 0,
        expires_at DATETIME NOT NULL,
        used_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT,
        location TEXT NOT NULL,
        location_url TEXT,
        event_date DATETIME NOT NULL,
        max_players INTEGER DEFAULT NULL,
        actual_attendance INTEGER DEFAULT NULL,
        status TEXT DEFAULT 'active',
        created_by INTEGER REFERENCES users(id),
        reminder_sent INTEGER DEFAULT 0,
        rainout_note TEXT,
        rainout_at DATETIME,
        rainout_email_sent INTEGER DEFAULT 0,
        allowed_emails TEXT DEFAULT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE event_duties (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        description TEXT,
        slots_needed INTEGER DEFAULT 1,
        sort_order INTEGER DEFAULT 0
      );
      CREATE TABLE attendees (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        name TEXT NOT NULL,
        email TEXT NOT NULL COLLATE NOCASE,
        is_guest INTEGER DEFAULT 0,
        status TEXT DEFAULT 'attending',
        gear_bringing TEXT,
        notes TEXT,
        players_count INTEGER DEFAULT 1,
        spectators_count INTEGER DEFAULT 0,
        additional_guests INTEGER DEFAULT 0,
        guest_names TEXT,
        management_token TEXT UNIQUE,
        urgent_credit_awarded INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(event_id, email)
      );
      CREATE TABLE duty_assignments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        duty_id INTEGER NOT NULL REFERENCES event_duties(id) ON DELETE CASCADE,
        attendee_id INTEGER NOT NULL REFERENCES attendees(id) ON DELETE CASCADE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(duty_id, attendee_id)
      );
      CREATE TABLE comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        author_name TEXT NOT NULL,
        author_email TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE default_duties (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT,
        slots_needed INTEGER DEFAULT 1,
        sort_order INTEGER DEFAULT 0
      );
      CREATE TABLE posts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        summary TEXT,
        media_url TEXT,
        media_type TEXT,
        author_id INTEGER,
        author_name TEXT NOT NULL,
        event_id INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE media_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT,
        caption TEXT,
        media_type TEXT NOT NULL,
        original_url TEXT,
        file_url TEXT NOT NULL,
        file_data TEXT,
        mime_type TEXT,
        file_size INTEGER DEFAULT 0,
        album TEXT DEFAULT 'General',
        date_taken TEXT NOT NULL,
        contributor_name TEXT,
        contributor_id INTEGER,
        event_id INTEGER,
        is_approved INTEGER DEFAULT 0,
        approved_by INTEGER DEFAULT NULL,
        approved_at DATETIME DEFAULT NULL,
        delete_token TEXT DEFAULT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE banned_emails (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        reason TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE app_settings (
        key TEXT PRIMARY KEY,
        value TEXT
      );
      CREATE TABLE rate_limits (
        key TEXT PRIMARY KEY,
        count INTEGER DEFAULT 0,
        window_start INTEGER NOT NULL
      );
      CREATE TABLE batting_practice_signups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        attendee_id INTEGER REFERENCES attendees(id) ON DELETE SET NULL,
        slot_number INTEGER NOT NULL,
        player_name TEXT NOT NULL,
        notes TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(event_id, slot_number)
      );
      CREATE TABLE waivers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        certificate_id TEXT NOT NULL UNIQUE,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        email TEXT NOT NULL COLLATE NOCASE,
        printed_name TEXT NOT NULL,
        signed_date TEXT NOT NULL,
        signature_type TEXT DEFAULT 'drawn',
        signature_data TEXT NOT NULL,
        document_version TEXT NOT NULL DEFAULT '41335\\14760738.1',
        waiver_text_sha256 TEXT NOT NULL,
        document_sha256 TEXT NOT NULL,
        provenance_seal TEXT NOT NULL,
        signer_ip TEXT,
        user_agent TEXT,
        electronic_consent INTEGER DEFAULT 1,
        gdrive_file_id TEXT DEFAULT NULL,
        signed_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX idx_events_date ON events(event_date);
      CREATE INDEX idx_events_status_date ON events(status, event_date);
      CREATE INDEX idx_attendees_event ON attendees(event_id);
      CREATE INDEX idx_attendees_user ON attendees(user_id, event_id);
      CREATE INDEX idx_attendees_email ON attendees(email, event_id);
      CREATE INDEX idx_duty_assignments_attendee ON duty_assignments(attendee_id);
      CREATE INDEX idx_sessions_expires ON sessions(expires_at);
      CREATE INDEX idx_comments_event ON comments(event_id);
      CREATE INDEX idx_posts_created_at ON posts(created_at DESC);
      CREATE INDEX idx_media_date_taken ON media_items(date_taken DESC);
      CREATE INDEX idx_media_album ON media_items(album);
      CREATE INDEX idx_media_type ON media_items(media_type);
      CREATE INDEX idx_media_approved ON media_items(is_approved);
      CREATE INDEX idx_bp_signups_event ON batting_practice_signups(event_id, slot_number);
      CREATE INDEX idx_bp_signups_event_user ON batting_practice_signups(event_id, user_id);
      CREATE INDEX idx_bp_signups_event_attendee ON batting_practice_signups(event_id, attendee_id);
      CREATE INDEX idx_waivers_user ON waivers(user_id);
      CREATE INDEX idx_waivers_email ON waivers(email);
      CREATE INDEX idx_sessions_user ON sessions(user_id);
      CREATE INDEX idx_auth_codes_email ON auth_codes(email, used_at, expires_at);
      CREATE INDEX idx_event_duties_event ON event_duties(event_id, sort_order);
      CREATE INDEX idx_attendees_event_status ON attendees(event_id, status);
      CREATE INDEX idx_users_clubhouse_opt ON users(clubhouse_opted_in);
      CREATE UNIQUE INDEX idx_users_calendar_token ON users(calendar_token) WHERE calendar_token IS NOT NULL;
      INSERT INTO app_settings (key, value) VALUES ('schema_version', '1');
    `;

    // Snapshot of v149 CHAT_DB DDL (pre-Ticket #31)
    const V149_CHAT_SQL = `
      CREATE TABLE channels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'Text Channels',
        channel_type TEXT NOT NULL DEFAULT 'text',
        topic TEXT DEFAULT '',
        min_role_read TEXT NOT NULL DEFAULT 'player',
        min_role_write TEXT NOT NULL DEFAULT 'player',
        is_encrypted INTEGER NOT NULL DEFAULT 1,
        is_private INTEGER NOT NULL DEFAULT 0,
        linked_event_id INTEGER DEFAULT NULL,
        retention_days INTEGER DEFAULT 365,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_by INTEGER DEFAULT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE channel_members (
        channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL,
        role TEXT DEFAULT 'member',
        last_read_message_id INTEGER DEFAULT 0,
        muted INTEGER DEFAULT 0,
        hidden INTEGER NOT NULL DEFAULT 0,
        joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (channel_id, user_id)
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        parent_message_id INTEGER DEFAULT NULL REFERENCES messages(id) ON DELETE CASCADE,
        author_id INTEGER NOT NULL,
        author_name TEXT NOT NULL,
        author_role TEXT DEFAULT 'player',
        author_badges TEXT DEFAULT '{}',
        content TEXT NOT NULL,
        iv TEXT DEFAULT NULL,
        key_epoch INTEGER DEFAULT 1,
        message_type TEXT NOT NULL DEFAULT 'text',
        metadata_json TEXT DEFAULT NULL,
        reply_count INTEGER NOT NULL DEFAULT 0,
        edited_at DATETIME DEFAULT NULL,
        deleted_at DATETIME DEFAULT NULL,
        hidden_at DATETIME DEFAULT NULL,
        hidden_by INTEGER DEFAULT NULL,
        hidden_by_name TEXT DEFAULT NULL,
        hidden_reason TEXT DEFAULT NULL,
        original_content TEXT DEFAULT NULL,
        original_iv TEXT DEFAULT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE message_reactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL,
        user_name TEXT NOT NULL,
        emoji TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(message_id, user_id, emoji)
      );
      CREATE TABLE chat_attachments (
        id TEXT PRIMARY KEY,
        channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        message_id INTEGER DEFAULT NULL REFERENCES messages(id) ON DELETE SET NULL,
        uploader_id INTEGER NOT NULL,
        file_name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        storage_provider TEXT NOT NULL DEFAULT 'gdrive',
        drive_file_id TEXT DEFAULT NULL,
        resumable_session_uri TEXT DEFAULT NULL,
        upload_status TEXT NOT NULL DEFAULT 'pending',
        is_encrypted INTEGER NOT NULL DEFAULT 0,
        iv TEXT DEFAULT NULL,
        thumbnail_base64 TEXT DEFAULT NULL,
        local_data_base64 TEXT DEFAULT NULL,
        promoted_media_id INTEGER DEFAULT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE user_crypto_keys (
        user_id INTEGER PRIMARY KEY,
        ecdh_public_key_jwk TEXT NOT NULL,
        ecdsa_public_key_jwk TEXT NOT NULL,
        encrypted_private_vault TEXT DEFAULT NULL,
        vault_salt TEXT DEFAULT NULL,
        vault_iv TEXT DEFAULT NULL,
        privacy_relay_mode INTEGER NOT NULL DEFAULT 0,
        status_text TEXT DEFAULT '',
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE channel_key_shares (
        channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        key_epoch INTEGER NOT NULL DEFAULT 1,
        recipient_user_id INTEGER NOT NULL,
        sender_user_id INTEGER NOT NULL,
        wrapped_key_base64 TEXT NOT NULL,
        wrap_iv TEXT NOT NULL,
        sender_ephemeral_pub_jwk TEXT DEFAULT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (channel_id, key_epoch, recipient_user_id)
      );
      CREATE TABLE voice_participants (
        channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL,
        user_name TEXT NOT NULL,
        muted INTEGER NOT NULL DEFAULT 0,
        deafened INTEGER NOT NULL DEFAULT 0,
        screen_sharing INTEGER NOT NULL DEFAULT 0,
        heartbeat_at INTEGER NOT NULL,
        PRIMARY KEY (channel_id, user_id)
      );
      CREATE TABLE rtc_signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        sender_user_id INTEGER NOT NULL,
        recipient_user_id INTEGER NOT NULL,
        signal_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE sync_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        target_id INTEGER NOT NULL,
        payload_json TEXT DEFAULT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE chat_rate_limits (
        key TEXT PRIMARY KEY,
        count INTEGER DEFAULT 0,
        window_start INTEGER NOT NULL
      );
      CREATE TABLE chat_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        reporter_id INTEGER NOT NULL,
        reporter_name TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_user_id INTEGER DEFAULT NULL,
        target_user_name TEXT DEFAULT '',
        target_message_id INTEGER DEFAULT NULL,
        channel_id INTEGER DEFAULT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        reviewed_by INTEGER DEFAULT NULL,
        reviewed_by_name TEXT DEFAULT NULL,
        resolution_note TEXT DEFAULT NULL,
        reviewed_at DATETIME DEFAULT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE user_mutes (
        muter_user_id INTEGER NOT NULL,
        muted_user_id INTEGER NOT NULL,
        reason TEXT DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (muter_user_id, muted_user_id)
      );
      CREATE TABLE clubhouse_gifs (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        tags TEXT DEFAULT '',
        mime_type TEXT NOT NULL DEFAULT 'image/gif',
        file_size INTEGER NOT NULL DEFAULT 0,
        source_url TEXT DEFAULT NULL,
        sha256 TEXT DEFAULT NULL,
        storage_provider TEXT NOT NULL DEFAULT 'gdrive',
        drive_file_id TEXT DEFAULT NULL,
        local_data_base64 TEXT DEFAULT NULL,
        added_by INTEGER NOT NULL,
        added_by_name TEXT DEFAULT '',
        is_public INTEGER NOT NULL DEFAULT 1,
        use_count INTEGER NOT NULL DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE clubhouse_opted_out (
        user_id INTEGER PRIMARY KEY,
        opted_out_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE chat_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE INDEX idx_messages_channel_id ON messages(channel_id, id ASC);
      CREATE INDEX idx_messages_ch_del_id ON messages(channel_id, deleted_at, id ASC);
      CREATE INDEX idx_messages_parent_id ON messages(parent_message_id, id ASC);
      CREATE INDEX idx_messages_author ON messages(author_id);
      CREATE INDEX idx_channel_members_user ON channel_members(user_id);
      CREATE INDEX idx_channels_linked_event ON channels(linked_event_id);
      CREATE INDEX idx_voice_participants_hb ON voice_participants(heartbeat_at);
      CREATE INDEX idx_reactions_msg ON message_reactions(message_id);
      CREATE INDEX idx_attachments_msg ON chat_attachments(message_id);
      CREATE INDEX idx_rtc_signals_recipient ON rtc_signals(recipient_user_id, id ASC);
      CREATE INDEX idx_rtc_signals_created ON rtc_signals(created_at);
      CREATE INDEX idx_rtc_signals_recipient_created ON rtc_signals(recipient_user_id, created_at);
      CREATE INDEX idx_sync_events_id ON sync_events(id ASC);
      CREATE INDEX idx_chat_reports_status ON chat_reports(status, id DESC);
      CREATE INDEX idx_chat_reports_lookup ON chat_reports(reporter_id, target_type, status);
      CREATE INDEX idx_user_mutes_muter ON user_mutes(muter_user_id);
      CREATE INDEX idx_clubhouse_gifs_public ON clubhouse_gifs(is_public, use_count DESC, created_at DESC);
      CREATE INDEX idx_clubhouse_gifs_source ON clubhouse_gifs(source_url);
      CREATE INDEX idx_clubhouse_gifs_sha256 ON clubhouse_gifs(sha256);
      INSERT INTO chat_meta (key, value) VALUES ('schema_version', '1');
    `;

    function extractNormalizedSchema(sqliteDb) {
      const tableRows = sqliteDb.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name ASC"
      ).all();
      const tables = {};
      for (const { name } of tableRows) {
        const cols = sqliteDb.prepare(`PRAGMA table_info(${name})`).all().map((c) => ({
          cid: c.cid,
          name: c.name,
          type: c.type,
          notnull: c.notnull,
          dflt_value: c.dflt_value,
          pk: c.pk
        }));
        const idxList = sqliteDb.prepare(`PRAGMA index_list(${name})`).all()
          .filter((idx) => idx.origin === 'c')
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((idx) => {
            const idxMaster = sqliteDb.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?").get(idx.name);
            const idxCols = sqliteDb.prepare(`PRAGMA index_info(${idx.name})`).all().map((ic) => ic.name);
            return {
              name: idx.name,
              unique: idx.unique,
              partial: idx.partial,
              cols: idxCols,
              hasWhere: Boolean(idxMaster && /\bWHERE\b/i.test(idxMaster.sql))
            };
          });
        tables[name] = { columns: cols, indexes: idxList };
      }
      return tables;
    }

    await t.test('1. Upgraded v149 dual DBs match fresh DB schemas identically and execute all additive backfills', async () => {
      assert.ok(BASEBALL_SCHEMA_VERSION >= 3, 'BASEBALL_SCHEMA_VERSION must be >= 3');
      assert.ok(CHAT_SCHEMA_VERSION >= 2, 'CHAT_SCHEMA_VERSION must be >= 2');

      const upgradedBaseball = new Database(':memory:');
      const upgradedChat = new Database(':memory:');
      const freshBaseball = new Database(':memory:');
      const freshChat = new Database(':memory:');

      try {
        upgradedBaseball.exec(V149_BASEBALL_SQL);
        upgradedChat.exec(V149_CHAT_SQL);

        // Seed v149 data to verify backfills and zero synthetic consent_records
        upgradedBaseball.prepare("INSERT INTO users (name, email, role, clubhouse_opted_in) VALUES ('Opted User', 'opted@example.org', 'member', 1)").run();
        upgradedBaseball.prepare("INSERT INTO users (name, email, role, clubhouse_opted_in) VALUES ('Regular User', 'reg@example.org', 'player', 0)").run();
        upgradedBaseball.prepare("INSERT INTO events (title, location, event_date) VALUES ('Sunday Pickup', 'Bushrod Park Field 1', '2026-11-22T18:00:00Z')").run();
        upgradedBaseball.prepare("INSERT INTO attendees (event_id, user_id, name, email, status) VALUES (1, 1, 'Opted User', 'opted@example.org', 'attending')").run();

        upgradedBaseball.prepare("INSERT INTO event_duties (event_id, title, sort_order) VALUES (1, 'Game Facilitator', 1)").run();
        upgradedBaseball.prepare("INSERT INTO event_duties (event_id, title, sort_order) VALUES (1, 'Pitching machine and power', 2)").run();
        upgradedBaseball.prepare("INSERT INTO event_duties (event_id, title, sort_order) VALUES (1, 'Field Dragging', 3)").run();
        upgradedBaseball.prepare("INSERT INTO event_duties (event_id, title, sort_order) VALUES (1, 'Bases', 4)").run();

        upgradedBaseball.prepare("INSERT INTO default_duties (title, sort_order) VALUES ('Game Facilitator', 1)").run();
        upgradedBaseball.prepare("INSERT INTO default_duties (title, sort_order) VALUES ('Pitching Machine Setup', 2)").run();
        upgradedBaseball.prepare("INSERT INTO default_duties (title, sort_order) VALUES ('Infield Dragging', 3)").run();
        upgradedBaseball.prepare("INSERT INTO default_duties (title, sort_order) VALUES ('Water / Food', 4)").run();

        upgradedBaseball.prepare(`
          INSERT INTO waivers (certificate_id, user_id, email, printed_name, signed_date, signature_data, waiver_text_sha256, document_sha256, provenance_seal, signer_ip, user_agent, signed_at)
          VALUES ('cert-old', 1, 'opted@example.org', 'Opted User', '2026-09-01', 'sig', 'h1', 'h2', 'seal1', '203.0.113.10', 'OldUA/1.0', datetime('now', '-45 days'))
        `).run();
        upgradedBaseball.prepare(`
          INSERT INTO waivers (certificate_id, user_id, email, printed_name, signed_date, signature_data, waiver_text_sha256, document_sha256, provenance_seal, signer_ip, user_agent, signed_at)
          VALUES ('cert-recent', 2, 'reg@example.org', 'Regular User', '2026-11-12', 'sig', 'h1', 'h2', 'seal2', '203.0.113.20', 'NewUA/2.0', datetime('now', '-5 days'))
        `).run();

        upgradedBaseball.prepare(`
          INSERT INTO media_items (title, media_type, original_url, file_url, file_data, date_taken, is_approved)
          VALUES ('Local Photo', 'photo', NULL, '/api/media/1/file', 'ZmFrZS1iNjQ=', '2026-10-01', 1)
        `).run();
        upgradedBaseball.prepare(`
          INSERT INTO media_items (title, media_type, original_url, file_url, file_data, date_taken, is_approved)
          VALUES ('Drive Photo', 'photo', 'https://drive.google.com/file/d/123/view', 'https://drive.google.com/file/d/123/preview', NULL, '2026-10-02', 1)
        `).run();
        upgradedBaseball.prepare(`
          INSERT INTO media_items (title, media_type, original_url, file_url, file_data, date_taken, is_approved)
          VALUES ('Photos Link', 'photo', 'https://photos.google.com/share/abc', 'https://lh3.googleusercontent.com/d/abc', NULL, '2026-10-03', 1)
        `).run();
        upgradedBaseball.prepare(`
          INSERT INTO media_items (title, media_type, original_url, file_url, file_data, date_taken, is_approved)
          VALUES ('YouTube Clip', 'youtube', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', NULL, '2026-10-04', 1)
        `).run();

        upgradedBaseball.prepare("INSERT INTO rate_limits (key, count, window_start) VALUES ('auth:203.0.113.10', 3, 1700000000)").run();

        upgradedChat.prepare("INSERT INTO user_crypto_keys (user_id, ecdh_public_key_jwk, ecdsa_public_key_jwk) VALUES (1, '{}', '{}')").run();
        upgradedChat.prepare("INSERT INTO channels (slug, name) VALUES ('general', '#general')").run();
        upgradedChat.prepare("INSERT INTO chat_attachments (id, channel_id, uploader_id, file_name, mime_type, file_size) VALUES ('att-1', 1, 1, 'a.jpg', 'image/jpeg', 100)").run();
        upgradedChat.prepare("INSERT INTO clubhouse_gifs (id, title, added_by) VALUES ('gif-1', 'Homer', 1)").run();
        upgradedChat.prepare("INSERT INTO chat_rate_limits (key, count, window_start) VALUES ('msg:1:203.0.113.10', 5, 1700000000)").run();

        await ensureDualD1Schema({
          BASEBALL_DB: createD1Adapter(upgradedBaseball),
          CHAT_DB: createD1Adapter(upgradedChat)
        });
        await ensureDualD1Schema({
          BASEBALL_DB: createD1Adapter(freshBaseball),
          CHAT_DB: createD1Adapter(freshChat)
        });

        // Assert exact schema parity for both BASEBALL_DB and CHAT_DB
        const upgradedBaseballSchema = extractNormalizedSchema(upgradedBaseball);
        const freshBaseballSchema = extractNormalizedSchema(freshBaseball);
        const upgradedChatSchema = extractNormalizedSchema(upgradedChat);
        const freshChatSchema = extractNormalizedSchema(freshChat);

        assert.deepEqual(
          upgradedBaseballSchema,
          freshBaseballSchema,
          'Upgraded v149 BASEBALL_DB schema (tables, columns, defaults, indexes) must match fresh DB identically'
        );
        assert.deepEqual(
          upgradedChatSchema,
          freshChatSchema,
          'Upgraded v149 CHAT_DB schema (tables, columns, defaults, indexes) must match fresh DB identically'
        );

        // Explicitly assert required Ticket #31 tables, columns, and indexes are present
        const hasCols = (schemaObj, table, cols) => {
          const names = new Set(schemaObj[table].columns.map((c) => c.name));
          for (const col of cols) {
            assert.ok(names.has(col), `Expected column ${table}.${col} to exist`);
          }
        };
        const hasIdxs = (schemaObj, table, idxNames) => {
          const names = new Set(schemaObj[table].indexes.map((i) => i.name));
          for (const idx of idxNames) {
            assert.ok(names.has(idx), `Expected index ${idx} on ${table} to exist`);
          }
        };

        assert.ok(freshBaseballSchema.consent_records, 'consent_records table must exist');
        assert.ok(freshBaseballSchema.email_suppressions, 'email_suppressions table must exist');
        assert.ok(freshChatSchema.user_blocks, 'user_blocks table must exist');

        hasCols(freshBaseballSchema, 'event_duties', ['grants_coordinator', 'required_badge']);
        hasCols(freshBaseballSchema, 'default_duties', ['grants_coordinator', 'required_badge']);
        hasCols(freshBaseballSchema, 'events', ['invite_enabled', 'invite_version', 'auto_reminders']);
        hasCols(freshBaseballSchema, 'users', [
          'roster_visibility', 'profile_sharing', 'notify_rsvp_confirm',
          'notify_rainouts', 'notify_event_reminders', 'notify_community_updates'
        ]);
        hasCols(freshBaseballSchema, 'attendees', [
          'reminder_sent_at', 'last_notice_key', 'last_notice_sent_at',
          'notify_emails', 'roster_consent', 'paper_waiver_at', 'paper_waiver_by'
        ]);
        hasCols(freshBaseballSchema, 'waivers', [
          'waiver_locale', 'status', 'erasure_requested_at', 'retention_until', 'signer_ip_scrubbed_at'
        ]);
        hasCols(freshBaseballSchema, 'media_items', [
          'storage_provider', 'r2_key', 'upload_status', 'upload_token_hash'
        ]);
        hasCols(freshBaseballSchema, 'rate_limits', ['expires_at']);
        hasIdxs(freshBaseballSchema, 'attendees', ['idx_attendees_reminder_cursor']);
        hasIdxs(freshBaseballSchema, 'waivers', ['idx_waivers_status_retention']);
        hasIdxs(freshBaseballSchema, 'media_items', ['idx_media_upload_status']);
        hasIdxs(freshBaseballSchema, 'consent_records', ['idx_consent_user_type', 'idx_consent_email_type']);
        hasIdxs(freshBaseballSchema, 'rate_limits', ['idx_rate_limits_expires']);

        hasCols(freshChatSchema, 'user_crypto_keys', ['key_version', 'key_rotated_at']);
        hasCols(freshChatSchema, 'chat_attachments', ['r2_key']);
        hasCols(freshChatSchema, 'clubhouse_gifs', ['r2_key']);
        hasCols(freshChatSchema, 'chat_rate_limits', ['expires_at']);
        hasIdxs(freshChatSchema, 'user_blocks', ['idx_user_blocks_blocked']);
        hasIdxs(freshChatSchema, 'chat_attachments', ['idx_chat_attachments_upload_status']);
        hasIdxs(freshChatSchema, 'chat_rate_limits', ['idx_chat_rate_limits_expires']);

        // Verify schema versions
        assert.equal(
          upgradedBaseball.prepare("SELECT value FROM app_settings WHERE key = 'schema_version'").get().value,
          String(BASEBALL_SCHEMA_VERSION)
        );
        assert.equal(
          upgradedChat.prepare("SELECT value FROM chat_meta WHERE key = 'schema_version'").get().value,
          String(CHAT_SCHEMA_VERSION)
        );

        // Verify duty flag backfills
        const eventDuties = upgradedBaseball.prepare('SELECT title, grants_coordinator, required_badge FROM event_duties ORDER BY sort_order ASC').all();
        assert.deepEqual(eventDuties, [
          { title: 'Game Facilitator', grants_coordinator: 1, required_badge: null },
          { title: 'Pitching machine and power', grants_coordinator: 0, required_badge: 'machine' },
          { title: 'Field Dragging', grants_coordinator: 0, required_badge: 'field' },
          { title: 'Bases', grants_coordinator: 0, required_badge: null }
        ]);
        const defaultDuties = upgradedBaseball.prepare('SELECT title, grants_coordinator, required_badge FROM default_duties ORDER BY sort_order ASC').all();
        assert.deepEqual(defaultDuties, [
          { title: 'Game Facilitator', grants_coordinator: 1, required_badge: null },
          { title: 'Pitching Machine Setup', grants_coordinator: 0, required_badge: 'machine' },
          { title: 'Infield Dragging', grants_coordinator: 0, required_badge: 'field' },
          { title: 'Water / Food', grants_coordinator: 0, required_badge: null }
        ]);

        // Verify >30-day waiver telemetry scrub & <=30-day preservation
        const oldWaiver = upgradedBaseball.prepare("SELECT signer_ip, user_agent, signer_ip_scrubbed_at, waiver_locale, status FROM waivers WHERE certificate_id = 'cert-old'").get();
        assert.equal(oldWaiver.signer_ip, null);
        assert.equal(oldWaiver.user_agent, null);
        assert.ok(oldWaiver.signer_ip_scrubbed_at, 'Old waiver (>30d) must record signer_ip_scrubbed_at');
        assert.equal(oldWaiver.waiver_locale, 'en');
        assert.equal(oldWaiver.status, 'active');

        const recentWaiver = upgradedBaseball.prepare("SELECT signer_ip, user_agent, signer_ip_scrubbed_at FROM waivers WHERE certificate_id = 'cert-recent'").get();
        assert.equal(recentWaiver.signer_ip, '203.0.113.20');
        assert.equal(recentWaiver.user_agent, 'NewUA/2.0');
        assert.equal(recentWaiver.signer_ip_scrubbed_at, null);

        // Verify media storage_provider & upload_status backfills
        const mediaRows = upgradedBaseball.prepare('SELECT title, storage_provider, upload_status FROM media_items ORDER BY id ASC').all();
        assert.deepEqual(mediaRows, [
          { title: 'Local Photo', storage_provider: 'local', upload_status: 'ready' },
          { title: 'Drive Photo', storage_provider: 'gdrive', upload_status: 'ready' },
          { title: 'Photos Link', storage_provider: 'gdrive', upload_status: 'ready' },
          { title: 'YouTube Clip', storage_provider: 'external', upload_status: 'ready' }
        ]);

        // Verify rate_limits & chat_rate_limits purges + expires_at column
        assert.equal(upgradedBaseball.prepare('SELECT COUNT(*) as c FROM rate_limits').get().c, 0);
        assert.equal(upgradedChat.prepare('SELECT COUNT(*) as c FROM chat_rate_limits').get().c, 0);

        // Verify NO synthetic consent_records created for existing clubhouse_opted_in = 1 users
        assert.equal(upgradedBaseball.prepare('SELECT COUNT(*) as c FROM consent_records').get().c, 0);
        assert.equal(upgradedBaseball.prepare('SELECT clubhouse_opted_in FROM users WHERE id = 1').get().clubhouse_opted_in, 1);

        // Verify new tables constraints work on upgraded DB
        assert.throws(
          () => upgradedBaseball.prepare(
            "INSERT INTO consent_records (subject_type, consent_type, policy_version, policy_sha256, status) VALUES ('invalid', 'privacy', 'v1', 'abc', 'granted')"
          ).run(),
          /CHECK constraint failed/
        );
        upgradedBaseball.prepare("INSERT INTO email_suppressions (email, reason) VALUES ('Bounce@Example.org', 'hard_bounce')").run();
        assert.equal(
          upgradedBaseball.prepare("SELECT reason FROM email_suppressions WHERE email = 'bounce@example.org'").get().reason,
          'hard_bounce'
        );
        upgradedChat.prepare('INSERT INTO user_blocks (blocker_id, blocked_id) VALUES (1, 2)').run();
        assert.equal(upgradedChat.prepare('SELECT COUNT(*) as c FROM user_blocks WHERE blocked_id = 2').get().c, 1);
      } finally {
        upgradedBaseball.close();
        upgradedChat.close();
        freshBaseball.close();
        freshChat.close();
      }
    });
  });
};

if (require.main === module) {
  module.exports();
}
