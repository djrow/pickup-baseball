/**
 * Versioned Schema Migration Engine & `db:migrate` CLI Tests (Ticket #30)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
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
  });
};

if (require.main === module) {
  module.exports();
}
