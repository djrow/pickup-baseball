/**
 * Wave 1b.3 (Ticket #40 / ADR-0002 §2): Two-Mode Database Backup Hygiene Tests
 * Covers:
 * 1. Scrubbed Operational SQL (`GET /api/events/admin/backup-db?db=baseball|chat`) — zero PII/tokens/vaults
 * 2. Encrypted Full DR Backup (`POST /api/events/admin/backup-db?db=baseball|chat`) — AES-256-GCM envelope & Cache-Control: no-store
 * 3. Permanent exclusion of ephemeral tables & credential columns from ALL backups
 * 4. Standalone `scripts/restore-backup.js` round-trip decryption, CLI file I/O, and wrong-passphrase/tamper rejection
 * 5. Admin UI (`public/admin.html`, `public/js/admin.js`) & 14-locale i18n parity
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const { createD1Adapter } = require('../../src/d1-sqlite');
const { app: honoApp } = require('../../src/app/index.js');
const {
  deriveBackupWrappingKey,
  decryptDrBackupEnvelope,
  runRestoreCli
} = require('../../scripts/restore-backup.js');

const ROOT_DIR = path.join(__dirname, '..', '..');

async function createBackupTestEnv(envOverrides = {}) {
  const { ensureD1Schema, ensureChatD1Schema } = await import('../../src/app/schema.js');

  const baseballSqlite = new Database(':memory:');
  baseballSqlite.pragma('foreign_keys = ON');
  const chatSqlite = new Database(':memory:');
  chatSqlite.pragma('foreign_keys = ON');

  const baseballD1 = createD1Adapter(baseballSqlite);
  const chatD1 = createD1Adapter(chatSqlite);

  await ensureD1Schema(baseballD1);
  await ensureChatD1Schema(chatD1);

  const env = {
    NODE_ENV: 'test',
    DB: baseballD1,
    BASEBALL_DB: baseballD1,
    CHAT_DB: chatD1,
    ...envOverrides
  };

  async function apiFetch(pathname, { method = 'GET', cookie = null, body = null, rawBody = null, envOverride = null } = {}) {
    const headers = new Headers();
    const url = `https://community.example.org${pathname}`;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) {
      headers.set('Origin', 'https://community.example.org');
    }
    if (cookie) {
      headers.set('Cookie', cookie);
    }
    let reqBody;
    if (rawBody !== null && rawBody !== undefined) {
      headers.set('Content-Type', 'application/json');
      reqBody = rawBody;
    } else if (body !== null && body !== undefined) {
      headers.set('Content-Type', 'application/json');
      reqBody = JSON.stringify(body);
    }
    const res = await honoApp.fetch(new Request(url, { method, headers, body: reqBody }), envOverride || env);
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // plain text / SQL response
    }
    return { status: res.status, headers: res.headers, json, text };
  }

  function seedUser({ name, email, role = 'member', isAdmin = 0, calendarToken = null }) {
    const res = baseballSqlite.prepare(`
      INSERT INTO users (name, email, role, is_admin, clubhouse_opted_in, calendar_token)
      VALUES (?, ?, ?, ?, 1, ?)
    `).run(name, email, role, isAdmin, calendarToken);
    const userId = Number(res.lastInsertRowid);
    const rawSid = crypto.randomBytes(24).toString('hex');
    const hashedSid = `sha256:${crypto.createHash('sha256').update(rawSid).digest('hex')}`;
    const expiresAt = new Date(Date.now() + 86400 * 1000).toISOString();
    baseballSqlite.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(hashedSid, userId, expiresAt);
    return { userId, cookie: `baseball_session=${rawSid}`, rawSid, hashedSid };
  }

  function seedRichFixtures(adminUserId, memberUserId) {
    // Ephemeral auth codes & rate limits in BASEBALL_DB
    baseballSqlite.prepare(`
      INSERT INTO auth_codes (email, name, code, token, expires_at)
      VALUES ('secret_otp_user@example.org', 'OTP User', '123456', 'magic_tok_secret_999', datetime('now', '+10 minutes'))
    `).run();
    baseballSqlite.prepare(`
      INSERT INTO rate_limits (key, count, window_start, expires_at)
      VALUES ('rl_secret_bucket_key', 3, 1700000000, 1700003600)
    `).run();

    // Events (with private allowed_emails whitelist) + duties
    const evRes = baseballSqlite.prepare(`
      INSERT INTO events (title, description, location, event_date, allowed_emails, created_by)
      VALUES ('Sunday Bushrod Classic', 'Bring gloves', 'Bushrod Park Field 1', '2026-11-22T20:00:00Z', 'vip_whitelist_secret@example.org,coach_private@example.org', ?)
    `).run(adminUserId);
    const eventId = Number(evRes.lastInsertRowid);

    const dutyRes = baseballSqlite.prepare(`
      INSERT INTO event_duties (event_id, title, description, slots_needed, grants_coordinator)
      VALUES (?, 'Bases', 'Bring throw-down bases', 1, 0)
    `).run(eventId);
    const dutyId = Number(dutyRes.lastInsertRowid);

    // Attendees + management token + duty assignment + comment + BP signup
    const attRes = baseballSqlite.prepare(`
      INSERT INTO attendees (event_id, user_id, name, email, is_guest, status, players_count, guest_names, management_token)
      VALUES (?, ?, 'Alice Private Member', 'alice_pii_member@example.org', 0, 'attending', 2, 'Junior Private Guest', 'sha256:secret_mgmt_token_hash_abc123')
    `).run(eventId, memberUserId);
    const attendeeId = Number(attRes.lastInsertRowid);

    baseballSqlite.prepare(`
      INSERT INTO duty_assignments (duty_id, attendee_id) VALUES (?, ?)
    `).run(dutyId, attendeeId);

    baseballSqlite.prepare(`
      INSERT INTO comments (event_id, user_id, author_name, author_email, content)
      VALUES (?, ?, 'Alice Private Member', 'alice_pii_member@example.org', 'Carpool from Rockridge BART!')
    `).run(eventId, memberUserId);

    baseballSqlite.prepare(`
      INSERT INTO batting_practice_signups (event_id, user_id, attendee_id, slot_number, player_name, notes)
      VALUES (?, ?, ?, 1, 'Alice Private Member', 'Switch hitter')
    `).run(eventId, memberUserId, attendeeId);

    // Posts & Media items (1 approved, 1 unapproved)
    baseballSqlite.prepare(`
      INSERT INTO posts (title, content, summary, author_id, author_name, event_id)
      VALUES ('Opening Day Recap', 'Great 9-inning game!', 'Summary text', ?, 'Admin Author', ?)
    `).run(adminUserId, eventId);

    baseballSqlite.prepare(`
      INSERT INTO media_items (title, caption, media_type, file_url, file_data, date_taken, contributor_name, contributor_id, is_approved, delete_token, upload_token_hash)
      VALUES ('Approved Team Photo', 'At home plate', 'photo', 'https://example.org/photo1.jpg', 'DATA_URI_INLINE_BLOB_SECRET', '2026-11-15', 'Contributor PII Name', ?, 1, 'del_tok_secret_777', 'up_hash_secret_888')
    `).run(memberUserId);

    baseballSqlite.prepare(`
      INSERT INTO media_items (title, caption, media_type, file_url, date_taken, contributor_name, is_approved, delete_token)
      VALUES ('Unapproved Pending Photo', 'Private draft', 'photo', 'https://example.org/pending_secret.jpg', '2026-11-15', 'Pending Uploader PII', 0, 'del_tok_pending_999')
    `).run();

    // Banned emails, waivers, consent_records, email_suppressions, app_settings
    baseballSqlite.prepare(`
      INSERT INTO banned_emails (email, reason) VALUES ('troll_banned_pii@example.org', 'Spam')
    `).run();

    baseballSqlite.prepare(`
      INSERT INTO waivers (certificate_id, user_id, email, printed_name, signed_date, signature_data, waiver_text_sha256, document_sha256, provenance_seal, signer_ip)
      VALUES ('CERT-DR-TEST-1', ?, 'alice_pii_member@example.org', 'Alice Full Legal Name', '2026-11-15', 'data:image/png;base64,SIGNATURE_SECRET', 'sha_txt', 'sha_doc', 'seal_123', '203.0.113.55')
    `).run(memberUserId);

    baseballSqlite.prepare(`
      INSERT INTO consent_records (subject_type, user_id, subject_email_hash, consent_type, policy_version, policy_sha256, status)
      VALUES ('member', ?, 'hash_email_consent_1', 'waiver', 'v1', 'pol_sha_1', 'granted')
    `).run(memberUserId);

    baseballSqlite.prepare(`
      INSERT INTO email_suppressions (email, reason, bounce_type)
      VALUES ('bounced_pii_addr@example.org', 'hard_bounce', 'Permanent')
    `).run();

    baseballSqlite.prepare(`
      INSERT OR REPLACE INTO app_settings (key, value) VALUES
        ('schema_version', '2'),
        ('require_login_to_rsvp', '0'),
        ('disallow_zero_login_media', '1'),
        ('waiver_provenance_secret', 'SUPER_SECRET_WAIVER_HMAC_KEY_999'),
        ('appscript_upload_url', 'https://script.google.com/macros/s/SUPER_SECRET_APPSCRIPT/exec')
    `).run();

    // CHAT_DB fixtures
    const dmRes = chatSqlite.prepare(`
      INSERT INTO channels (slug, name, category, channel_type, is_encrypted, is_private)
      VALUES ('dm-1-2', 'Private DM Alice & Admin', 'Direct Messages', 'dm', 1, 1)
    `).run();
    const dmChannelId = Number(dmRes.lastInsertRowid);

    chatSqlite.prepare(`
      INSERT INTO channel_members (channel_id, user_id, role) VALUES (?, ?, 'member')
    `).run(dmChannelId, memberUserId);

    const msgRes = chatSqlite.prepare(`
      INSERT INTO messages (channel_id, author_id, author_name, content, iv)
      VALUES (?, ?, 'Alice Private Member', 'CIPHERTEXT_DM_PAYLOAD_XYZ', 'iv_dm_123')
    `).run(dmChannelId, memberUserId);
    const msgId = Number(msgRes.lastInsertRowid);

    chatSqlite.prepare(`
      INSERT INTO message_reactions (message_id, channel_id, user_id, user_name, emoji)
      VALUES (?, ?, ?, 'Alice Private Member', '⚾')
    `).run(msgId, dmChannelId, memberUserId);

    chatSqlite.prepare(`
      INSERT INTO chat_attachments (id, channel_id, message_id, uploader_id, file_name, mime_type, file_size, resumable_session_uri)
      VALUES ('att_dr_1', ?, ?, ?, 'private_clip.mp4', 'video/mp4', 1024, 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=SECRET_OAUTH_UPLOAD_SESSION')
    `).run(dmChannelId, msgId, memberUserId);

    chatSqlite.prepare(`
      INSERT INTO user_crypto_keys (user_id, ecdh_public_key_jwk, ecdsa_public_key_jwk, encrypted_private_vault, vault_salt, vault_iv)
      VALUES (?, '{"kty":"EC","crv":"P-256","x":"pubX"}', '{"kty":"EC","crv":"P-256","x":"sigX"}', 'SECRET_ENCRYPTED_PRIVATE_VAULT_BLOB', 'SECRET_VAULT_SALT_B64', 'SECRET_VAULT_IV_B64')
    `).run(memberUserId);

    chatSqlite.prepare(`
      INSERT INTO channel_key_shares (channel_id, key_epoch, recipient_user_id, sender_user_id, wrapped_key_base64, wrap_iv)
      VALUES (?, 1, ?, ?, 'WRAPPED_CHANNEL_EPOCH_KEY_SECRET', 'wrap_iv_1')
    `).run(dmChannelId, memberUserId, adminUserId);

    chatSqlite.prepare(`
      INSERT INTO voice_participants (channel_id, user_id, user_name, heartbeat_at)
      VALUES (1, ?, 'Alice Private Member', 1700000000)
    `).run(memberUserId);

    chatSqlite.prepare(`
      INSERT INTO rtc_signals (channel_id, sender_user_id, recipient_user_id, signal_type, payload_json, created_at)
      VALUES (1, ?, ?, 'candidate', '{"candidate":"candidate:1 1 UDP 2122252543 198.51.100.99 54321 typ host"}', 1700000000)
    `).run(memberUserId, adminUserId);

    chatSqlite.prepare(`
      INSERT INTO chat_rate_limits (key, count, window_start, expires_at)
      VALUES ('chat_rl_secret_bucket', 2, 1700000000, 1700003600)
    `).run();

    chatSqlite.prepare(`
      INSERT INTO chat_reports (reporter_id, reporter_name, target_type, target_user_id, target_user_name, reason)
      VALUES (?, 'Alice Private Member', 'user', 999, 'Reported User', 'Confidential moderation report reason')
    `).run(memberUserId);

    chatSqlite.prepare(`
      INSERT INTO user_mutes (muter_user_id, muted_user_id, reason)
      VALUES (?, 999, 'Personal mute note')
    `).run(memberUserId);

    chatSqlite.prepare(`
      INSERT INTO user_blocks (blocker_id, blocked_id)
      VALUES (?, 999)
    `).run(memberUserId);

    chatSqlite.prepare(`
      INSERT INTO clubhouse_gifs (id, title, tags, file_size, storage_provider, drive_file_id, local_data_base64, is_public, added_by, added_by_name)
      VALUES ('gif_batflip_1', 'Bat Flip Celebration', 'baseball,celebration', 2048, 'gdrive', 'gdrive_gif_file_123', 'INLINE_GIF_BASE64_SHOULD_BE_SCRUBBED', 1, ?, 'Alice Private Member')
    `).run(memberUserId);

    chatSqlite.prepare(`
      INSERT INTO clubhouse_gifs (id, title, tags, file_size, storage_provider, drive_file_id, local_data_base64, is_public, added_by, added_by_name)
      VALUES ('gif_private_1', 'Private Dugout Clip', 'private', 1024, 'gdrive', 'gdrive_gif_private_456', 'PRIVATE_GIF_BASE64', 0, ?, 'Alice Private Member')
    `).run(memberUserId);

    chatSqlite.prepare(`
      INSERT INTO clubhouse_opted_out (user_id) VALUES (888)
    `).run();
  }

  function close() {
    baseballSqlite.close();
    chatSqlite.close();
  }

  return { baseballSqlite, chatSqlite, baseballD1, chatD1, env, apiFetch, seedUser, seedRichFixtures, close };
}

function registerBackupDrTests() {
  test('Wave 1b.3 (Ticket #40): Two-Mode Database Backups (Scrubbed Operational SQL vs Encrypted Full DR)', async (t) => {
    await t.test('1. GET /api/events/admin/backup-db?db=baseball exports ONLY scrubbed non-PII operational tables', async () => {
      const ctx = await createBackupTestEnv();
      try {
        const admin = ctx.seedUser({
          name: 'Admin User',
          email: 'admin_pii@example.org',
          role: 'admin',
          isAdmin: 1,
          calendarToken: 'cal_tok_admin_secret_111'
        });
        const member = ctx.seedUser({
          name: 'Alice Private Member',
          email: 'alice_pii_member@example.org',
          role: 'member',
          isAdmin: 0,
          calendarToken: 'cal_tok_alice_secret_222'
        });
        ctx.seedRichFixtures(admin.userId, member.userId);

        const res = await ctx.apiFetch('/api/events/admin/backup-db?db=baseball', {
          method: 'GET',
          cookie: admin.cookie
        });
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('cache-control'), 'no-store');
        assert.ok((res.headers.get('content-type') || '').includes('application/sql'));

        const sql = res.text;
        // Allowed operational tables present
        assert.ok(sql.includes('-- Mode: scrubbed-operational'), 'Header must mark scrubbed-operational mode');
        assert.ok(sql.includes('INSERT OR IGNORE INTO "events"'), 'Must export events');
        assert.ok(sql.includes('Sunday Bushrod Classic'), 'Must preserve event title');
        assert.ok(sql.includes('INSERT OR IGNORE INTO "event_duties"'), 'Must export event_duties');
        assert.ok(sql.includes('INSERT OR IGNORE INTO "default_duties"'), 'Must export default_duties');
        assert.ok(sql.includes('INSERT OR IGNORE INTO "posts"'), 'Must export posts');
        assert.ok(sql.includes("'Community Organizer'"), 'Must scrub posts.author_name to Community Organizer');
        assert.ok(sql.includes('INSERT OR IGNORE INTO "media_items"'), 'Must export approved media_items');
        assert.ok(sql.includes('Approved Team Photo'), 'Approved media metadata must be exported');
        assert.ok(sql.includes('INSERT OR IGNORE INTO "app_settings"'), 'Must export non-secret app_settings');
        assert.ok(sql.includes("'require_login_to_rsvp'"), 'Must include public app_settings key');

        // Prohibited tables and PII/credential values must be 100% absent
        const forbiddenSubstrings = [
          'INSERT OR IGNORE INTO "users"',
          'INSERT OR IGNORE INTO "sessions"',
          'INSERT OR IGNORE INTO "auth_codes"',
          'INSERT OR IGNORE INTO "rate_limits"',
          'INSERT OR IGNORE INTO "attendees"',
          'INSERT OR IGNORE INTO "duty_assignments"',
          'INSERT OR IGNORE INTO "comments"',
          'INSERT OR IGNORE INTO "batting_practice_signups"',
          'INSERT OR IGNORE INTO "waivers"',
          'INSERT OR IGNORE INTO "banned_emails"',
          'INSERT OR IGNORE INTO "consent_records"',
          'INSERT OR IGNORE INTO "email_suppressions"',
          'admin_pii@example.org',
          'alice_pii_member@example.org',
          'Admin Author',
          'vip_whitelist_secret@example.org',
          'coach_private@example.org',
          'cal_tok_admin_secret_111',
          'cal_tok_alice_secret_222',
          'secret_mgmt_token_hash_abc123',
          'magic_tok_secret_999',
          'rl_secret_bucket_key',
          'Junior Private Guest',
          'Carpool from Rockridge BART',
          'Contributor PII Name',
          'DATA_URI_INLINE_BLOB_SECRET',
          'del_tok_secret_777',
          'up_hash_secret_888',
          'Unapproved Pending Photo',
          'Pending Uploader PII',
          'del_tok_pending_999',
          'troll_banned_pii@example.org',
          'Alice Full Legal Name',
          'SIGNATURE_SECRET',
          '203.0.113.55',
          'hash_email_consent_1',
          'bounced_pii_addr@example.org',
          'waiver_provenance_secret',
          'SUPER_SECRET_WAIVER_HMAC_KEY_999',
          'appscript_upload_url',
          'SUPER_SECRET_APPSCRIPT',
          admin.hashedSid
        ];
        for (const forbidden of forbiddenSubstrings) {
          assert.equal(
            sql.includes(forbidden),
            false,
            `Scrubbed baseball SQL must NEVER contain "${forbidden}"`
          );
        }
      } finally {
        ctx.close();
      }
    });

    await t.test('2. GET /api/events/admin/backup-db?db=chat exports ONLY non-DM channels and scrubbed GIF metadata', async () => {
      const ctx = await createBackupTestEnv();
      try {
        const admin = ctx.seedUser({ name: 'Admin', email: 'admin@example.org', role: 'admin', isAdmin: 1 });
        const member = ctx.seedUser({ name: 'Alice', email: 'alice@example.org', role: 'member', isAdmin: 0 });
        ctx.seedRichFixtures(admin.userId, member.userId);

        const res = await ctx.apiFetch('/api/events/admin/backup-db?db=chat', {
          method: 'GET',
          cookie: admin.cookie
        });
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('cache-control'), 'no-store');

        const sql = res.text;
        assert.ok(sql.includes('-- Mode: scrubbed-operational'));
        assert.ok(sql.includes('INSERT OR IGNORE INTO "channels"'), 'Must export public/staff channels');
        assert.ok(sql.includes('#announcements'), 'Must include default #announcements channel');
        assert.ok(sql.includes('INSERT OR IGNORE INTO "clubhouse_gifs"'), 'Must export clubhouse_gifs metadata');
        assert.ok(sql.includes('Bat Flip Celebration'), 'Must include GIF title');
        assert.ok(sql.includes('gdrive_gif_file_123'), 'Must include GIF Drive file ID');

        const forbiddenChatSubstrings = [
          'Private DM Alice & Admin',
          "'dm'",
          "'group_dm'",
          'INLINE_GIF_BASE64_SHOULD_BE_SCRUBBED',
          'gif_private_1',
          'Private Dugout Clip',
          'gdrive_gif_private_456',
          'Alice Private Member',
          'INSERT OR IGNORE INTO "channel_members"',
          'INSERT OR IGNORE INTO "messages"',
          'INSERT OR IGNORE INTO "message_reactions"',
          'INSERT OR IGNORE INTO "chat_attachments"',
          'INSERT OR IGNORE INTO "user_crypto_keys"',
          'INSERT OR IGNORE INTO "channel_key_shares"',
          'INSERT OR IGNORE INTO "voice_participants"',
          'INSERT OR IGNORE INTO "rtc_signals"',
          'INSERT OR IGNORE INTO "sync_events"',
          'INSERT OR IGNORE INTO "chat_rate_limits"',
          'INSERT OR IGNORE INTO "chat_reports"',
          'INSERT OR IGNORE INTO "user_mutes"',
          'INSERT OR IGNORE INTO "user_blocks"',
          'INSERT OR IGNORE INTO "clubhouse_opted_out"',
          'CIPHERTEXT_DM_PAYLOAD_XYZ',
          'SECRET_ENCRYPTED_PRIVATE_VAULT_BLOB',
          'SECRET_VAULT_SALT_B64',
          'SECRET_VAULT_IV_B64',
          'WRAPPED_CHANNEL_EPOCH_KEY_SECRET',
          '198.51.100.99',
          'Confidential moderation report reason',
          'SECRET_OAUTH_UPLOAD_SESSION'
        ];
        for (const forbidden of forbiddenChatSubstrings) {
          assert.equal(
            sql.includes(forbidden),
            false,
            `Scrubbed chat SQL must NEVER contain "${forbidden}"`
          );
        }
      } finally {
        ctx.close();
      }
    });

    await t.test('3. POST /api/events/admin/backup-db enforces RBAC, target validation, and wrappingKey/KDF validation', async () => {
      const ctx = await createBackupTestEnv();
      try {
        const admin = ctx.seedUser({ name: 'Admin', email: 'admin@example.org', role: 'admin', isAdmin: 1 });
        const org = ctx.seedUser({ name: 'Org', email: 'org@example.org', role: 'organizer', isAdmin: 0 });
        const member = ctx.seedUser({ name: 'Member', email: 'member@example.org', role: 'member', isAdmin: 0 });

        const validSalt = crypto.randomBytes(16).toString('base64');
        const validKey = crypto.randomBytes(32).toString('base64');
        const validBody = { wrappingKey: validKey, kdfSalt: validSalt, kdfIterations: 600000 };

        // RBAC checks
        const anonRes = await ctx.apiFetch('/api/events/admin/backup-db', { method: 'POST', body: validBody });
        assert.equal(anonRes.status, 401);

        const memberRes = await ctx.apiFetch('/api/events/admin/backup-db', { method: 'POST', cookie: member.cookie, body: validBody });
        assert.equal(memberRes.status, 403);

        const orgRes = await ctx.apiFetch('/api/events/admin/backup-db', { method: 'POST', cookie: org.cookie, body: validBody });
        assert.equal(orgRes.status, 403);

        // Invalid db target
        const badDbRes = await ctx.apiFetch('/api/events/admin/backup-db?db=unknown', {
          method: 'POST',
          cookie: admin.cookie,
          body: validBody
        });
        assert.equal(badDbRes.status, 400);

        // Missing CHAT_DB binding -> 503
        const noChatRes = await ctx.apiFetch('/api/events/admin/backup-db?db=chat', {
          method: 'POST',
          cookie: admin.cookie,
          body: validBody,
          envOverride: { ...ctx.env, CHAT_DB: null }
        });
        assert.equal(noChatRes.status, 503);

        // Invalid JSON / missing wrappingKey / wrong length / all-zero key / bad salt / low iterations
        const badPayloads = [
          null,
          {},
          { wrappingKey: 'not-base64!!!', kdfSalt: validSalt, kdfIterations: 600000 },
          { wrappingKey: crypto.randomBytes(16).toString('base64'), kdfSalt: validSalt, kdfIterations: 600000 },
          { wrappingKey: Buffer.alloc(32, 0).toString('base64'), kdfSalt: validSalt, kdfIterations: 600000 },
          { wrappingKey: validKey, kdfSalt: crypto.randomBytes(8).toString('base64'), kdfIterations: 600000 },
          { wrappingKey: validKey, kdfSalt: Buffer.alloc(16, 0).toString('base64'), kdfIterations: 600000 },
          { wrappingKey: validKey, kdfSalt: validSalt, kdfIterations: 1000 },
          { wrappingKey: validKey, kdfSalt: validSalt, kdfIterations: 'invalid' }
        ];

        for (const payload of badPayloads) {
          const r = await ctx.apiFetch('/api/events/admin/backup-db?db=baseball', {
            method: 'POST',
            cookie: admin.cookie,
            body: payload
          });
          assert.equal(r.status, 400, `Invalid DR payload ${JSON.stringify(payload)} must be rejected with 400`);
        }
      } finally {
        ctx.close();
      }
    });

    await t.test('4. POST /api/events/admin/backup-db encrypts full DR dump and round-trips via scripts/restore-backup.js', async () => {
      const ctx = await createBackupTestEnv();
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbf_dr_backup_test_'));
      try {
        const admin = ctx.seedUser({
          name: 'Admin User',
          email: 'admin_pii@example.org',
          role: 'admin',
          isAdmin: 1,
          calendarToken: 'cal_tok_admin_secret_111'
        });
        const member = ctx.seedUser({
          name: 'Alice Private Member',
          email: 'alice_pii_member@example.org',
          role: 'member',
          isAdmin: 0,
          calendarToken: 'cal_tok_alice_secret_222'
        });
        ctx.seedRichFixtures(admin.userId, member.userId);

        const passphrase = 'correct-horse-battery-staple-dr-2026!';
        const saltB64 = crypto.randomBytes(16).toString('base64');
        const iterations = 600000;
        const wrappingKeyBuf = deriveBackupWrappingKey(passphrase, saltB64, iterations);
        const wrappingKeyB64 = wrappingKeyBuf.toString('base64');

        // 1. Export encrypted BASEBALL_DB DR backup
        const baseballDrRes = await ctx.apiFetch('/api/events/admin/backup-db?db=baseball', {
          method: 'POST',
          cookie: admin.cookie,
          body: {
            wrappingKey: wrappingKeyB64,
            kdfSalt: saltB64,
            kdfIterations: iterations
          }
        });
        assert.equal(baseballDrRes.status, 200);
        assert.equal(baseballDrRes.headers.get('cache-control'), 'no-store');
        assert.equal(baseballDrRes.headers.get('x-content-type-options'), 'nosniff');

        const bEnv = baseballDrRes.json;
        assert.ok(bEnv && typeof bEnv === 'object');
        assert.equal(bEnv.format, 'pbf-dr-backup-v1');
        assert.equal(bEnv.cipher, 'AES-256-GCM');
        assert.equal(bEnv.db, 'baseball');
        assert.equal(typeof bEnv.exportedAt, 'string');
        assert.equal(Buffer.from(bEnv.iv, 'base64').byteLength, 12);
        assert.deepEqual(bEnv.kdf, {
          algorithm: 'PBKDF2',
          hash: 'SHA-256',
          iterations,
          salt: saltB64
        });

        // Raw response text must not leak any plaintext SQL or PII
        assert.equal(baseballDrRes.text.includes('INSERT OR IGNORE'), false);
        assert.equal(baseballDrRes.text.includes('alice_pii_member@example.org'), false);

        // Round-trip decrypt via CLI (runRestoreCli) writing to --output file
        const pbfencPath = path.join(tmpDir, 'baseball_dr.pbfenc');
        const restoredSqlPath = path.join(tmpDir, 'baseball_restored.sql');
        fs.writeFileSync(pbfencPath, baseballDrRes.text, 'utf8');

        const cliSql = runRestoreCli(['--input', pbfencPath, '--passphrase', passphrase, '--output', restoredSqlPath]);
        const fileSql = fs.readFileSync(restoredSqlPath, 'utf8');
        assert.equal(cliSql, fileSql);

        // Verify DR SQL contains full recovery tables & PII
        assert.ok(fileSql.includes('-- Mode: encrypted-dr'));
        assert.ok(fileSql.includes('INSERT OR IGNORE INTO "users"'));
        assert.ok(fileSql.includes('alice_pii_member@example.org'));
        assert.ok(fileSql.includes('vip_whitelist_secret@example.org'), 'DR export preserves event allowed_emails');
        assert.ok(fileSql.includes('INSERT OR IGNORE INTO "attendees"'));
        assert.ok(fileSql.includes('Junior Private Guest'));
        assert.ok(fileSql.includes('INSERT OR IGNORE INTO "duty_assignments"'));
        assert.ok(fileSql.includes('INSERT OR IGNORE INTO "comments"'));
        assert.ok(fileSql.includes('INSERT OR IGNORE INTO "batting_practice_signups"'));
        assert.ok(fileSql.includes('INSERT OR IGNORE INTO "waivers"'));
        assert.ok(fileSql.includes('CERT-DR-TEST-1'));
        assert.ok(fileSql.includes('INSERT OR IGNORE INTO "banned_emails"'));
        assert.ok(fileSql.includes('INSERT OR IGNORE INTO "consent_records"'));
        assert.ok(fileSql.includes('INSERT OR IGNORE INTO "email_suppressions"'));

        // Verify ephemeral tables & credential columns are STILL excluded from DR backup
        const drBaseballForbidden = [
          'INSERT OR IGNORE INTO "sessions"',
          'INSERT OR IGNORE INTO "auth_codes"',
          'INSERT OR IGNORE INTO "rate_limits"',
          'cal_tok_admin_secret_111',
          'cal_tok_alice_secret_222',
          'secret_mgmt_token_hash_abc123',
          'magic_tok_secret_999',
          'rl_secret_bucket_key',
          'del_tok_secret_777',
          'up_hash_secret_888',
          'del_tok_pending_999',
          'waiver_provenance_secret',
          'SUPER_SECRET_WAIVER_HMAC_KEY_999',
          'appscript_upload_url',
          'SUPER_SECRET_APPSCRIPT',
          admin.hashedSid
        ];
        for (const forbidden of drBaseballForbidden) {
          assert.equal(
            fileSql.includes(forbidden),
            false,
            `Full DR baseball SQL must NEVER export ephemeral/secret value "${forbidden}"`
          );
        }

        // 2. Export encrypted CHAT_DB DR backup & decrypt
        const chatDrRes = await ctx.apiFetch('/api/events/admin/backup-db?db=chat', {
          method: 'POST',
          cookie: admin.cookie,
          body: {
            wrappingKey: wrappingKeyB64,
            kdfSalt: saltB64,
            kdfIterations: iterations
          }
        });
        assert.equal(chatDrRes.status, 200);
        assert.equal(chatDrRes.headers.get('cache-control'), 'no-store');
        assert.notEqual(chatDrRes.json.iv, bEnv.iv, 'Each DR encryption must use a fresh random IV');

        const chatSql = decryptDrBackupEnvelope(chatDrRes.json, passphrase);
        assert.ok(chatSql.includes('-- Mode: encrypted-dr'));
        assert.ok(chatSql.includes('Private DM Alice & Admin'), 'Chat DR backup includes DM channels');
        assert.ok(chatSql.includes('INSERT OR IGNORE INTO "channel_members"'));
        assert.ok(chatSql.includes('INSERT OR IGNORE INTO "messages"'));
        assert.ok(chatSql.includes('CIPHERTEXT_DM_PAYLOAD_XYZ'));
        assert.ok(chatSql.includes('INSERT OR IGNORE INTO "user_crypto_keys"'));
        assert.ok(chatSql.includes('{"kty":"EC","crv":"P-256","x":"pubX"}'), 'Public E2EE identity keys preserved');
        assert.ok(chatSql.includes('INSERT OR IGNORE INTO "channel_key_shares"'));
        assert.ok(chatSql.includes('WRAPPED_CHANNEL_EPOCH_KEY_SECRET'));
        assert.ok(chatSql.includes('INSERT OR IGNORE INTO "chat_reports"'));
        assert.ok(chatSql.includes('INSERT OR IGNORE INTO "user_mutes"'));
        assert.ok(chatSql.includes('INSERT OR IGNORE INTO "user_blocks"'));
        assert.ok(chatSql.includes('INSERT OR IGNORE INTO "clubhouse_opted_out"'));
        assert.ok(chatSql.includes('Private Dugout Clip'), 'DR chat backup preserves private GIFs');

        // Verify ephemeral tables & vault columns are excluded from Chat DR backup
        const drChatForbidden = [
          'INSERT OR IGNORE INTO "voice_participants"',
          'INSERT OR IGNORE INTO "rtc_signals"',
          'INSERT OR IGNORE INTO "chat_rate_limits"',
          'SECRET_ENCRYPTED_PRIVATE_VAULT_BLOB',
          'SECRET_VAULT_SALT_B64',
          'SECRET_VAULT_IV_B64',
          '198.51.100.99',
          'chat_rl_secret_bucket',
          'INLINE_GIF_BASE64_SHOULD_BE_SCRUBBED',
          'SECRET_OAUTH_UPLOAD_SESSION'
        ];
        for (const forbidden of drChatForbidden) {
          assert.equal(
            chatSql.includes(forbidden),
            false,
            `Full DR chat SQL must NEVER export ephemeral/vault value "${forbidden}"`
          );
        }

        // 3. Wrong passphrase & tampered ciphertext/IV must throw clearly
        assert.throws(
          () => decryptDrBackupEnvelope(bEnv, 'wrong-passphrase-attempt!'),
          /wrong passphrase or tampered ciphertext/i
        );
        assert.throws(
          () => runRestoreCli(['--input', pbfencPath, '--passphrase', 'wrong-passphrase-attempt!']),
          /wrong passphrase or tampered ciphertext/i
        );

        const tamperedCipherBytes = Buffer.from(bEnv.ciphertext, 'base64');
        tamperedCipherBytes[0] ^= 0xff;
        assert.throws(
          () => decryptDrBackupEnvelope({ ...bEnv, ciphertext: tamperedCipherBytes.toString('base64') }, passphrase),
          /wrong passphrase or tampered ciphertext/i
        );

        const tamperedIvBytes = Buffer.from(bEnv.iv, 'base64');
        tamperedIvBytes[0] ^= 0xff;
        assert.throws(
          () => decryptDrBackupEnvelope({ ...bEnv, iv: tamperedIvBytes.toString('base64') }, passphrase),
          /wrong passphrase or tampered ciphertext/i
        );
      } finally {
        ctx.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    await t.test('4b. Keyset pagination exports >500 rows cleanly across multiple pages without __backup_rowid leakage', async () => {
      const ctx = await createBackupTestEnv();
      try {
        const admin = ctx.seedUser({ name: 'Admin', email: 'admin@example.org', role: 'admin', isAdmin: 1 });
        const insDuty = ctx.baseballSqlite.prepare(
          'INSERT INTO default_duties (title, description, slots_needed, sort_order) VALUES (?, ?, 1, ?)'
        );
        const tx = ctx.baseballSqlite.transaction(() => {
          for (let i = 1; i <= 525; i++) {
            insDuty.run(`Keyset Duty #${String(i).padStart(3, '0')}`, 'Desc', i);
          }
        });
        tx();

        const res = await ctx.apiFetch('/api/events/admin/backup-db?db=baseball', {
          method: 'GET',
          cookie: admin.cookie
        });
        assert.equal(res.status, 200);
        const sql = res.text;
        assert.equal(sql.includes('__backup_rowid'), false, 'Internal keyset rowid column must never appear in SQL dump');
        for (let i = 1; i <= 525; i++) {
          const marker = `Keyset Duty #${String(i).padStart(3, '0')}`;
          assert.ok(sql.includes(marker), `Multi-page keyset export missing row: ${marker}`);
        }
      } finally {
        ctx.close();
      }
    });

    await t.test('5. Admin UI & 14-locale i18n parity for two-mode backup controls', () => {
      const adminHtml = fs.readFileSync(path.join(ROOT_DIR, 'public', 'admin.html'), 'utf8');
      const adminJs = fs.readFileSync(path.join(ROOT_DIR, 'public', 'js', 'admin.js'), 'utf8');
      const apiJs = fs.existsSync(path.join(ROOT_DIR, 'public', 'js', 'api', 'i18n.js'))
        ? fs.readFileSync(path.join(ROOT_DIR, 'public', 'js', 'api', 'i18n.js'), 'utf8')
        : fs.readFileSync(path.join(ROOT_DIR, 'public', 'js', 'api.js'), 'utf8');

      assert.ok(adminHtml.includes('id="btn-backup-db"'), 'admin.html must include #btn-backup-db');
      assert.ok(adminHtml.includes('id="btn-backup-dr"'), 'admin.html must include #btn-backup-dr');
      assert.ok(adminJs.includes("getElementById('btn-backup-dr')"), 'admin.js must bind #btn-backup-dr');
      assert.ok(adminJs.includes('PBFDialog.prompt'), 'admin.js must prompt for DR passphrase via PBFDialog.prompt');
      assert.ok(adminJs.includes('PBKDF2') && adminJs.includes('600000'), 'admin.js must stretch passphrase with WebCrypto PBKDF2 600,000 iterations');
      assert.ok(adminJs.includes('.pbfenc'), 'admin.js must download .pbfenc encrypted DR files');
      assert.equal(/[\w$\])]\?\./.test(adminJs), false, 'admin.js must not contain optional chaining (?.)');
      assert.equal(adminJs.includes('??'), false, 'admin.js must not contain nullish coalescing (??)');

      const requiredKeys = [
        'backup_scrubbed_btn',
        'backup_dr_btn',
        'backup_scrubbed_working',
        'backup_dr_working',
        'backup_dr_prompt_title',
        'backup_dr_prompt_msg',
        'backup_dr_prompt_placeholder',
        'backup_dr_confirm_btn',
        'backup_dr_passphrase_short',
        'backup_scrubbed_success',
        'backup_dr_success',
        'backup_failed'
      ];

      for (const key of requiredKeys) {
        assert.ok(apiJs.includes(`"${key}":`), `EN_DICT in api.js must define "${key}"`);
      }

      const i18nDir = path.join(ROOT_DIR, 'public', 'i18n');
      const localeFiles = fs.readdirSync(i18nDir).filter((f) => f.endsWith('.json') && f !== 'en.json');
      assert.equal(localeFiles.length, 14, 'Must have 14 non-English locale JSON files');

      for (const file of localeFiles) {
        const lang = file.replace('.json', '');
        const coreDict = JSON.parse(fs.readFileSync(path.join(i18nDir, file), 'utf8'));
        const adminDictPath = path.join(i18nDir, 'admin', `${lang}.json`);
        const adminDict = fs.existsSync(adminDictPath) ? JSON.parse(fs.readFileSync(adminDictPath, 'utf8')) : {};
        const dict = Object.assign({}, coreDict, adminDict);
        for (const key of requiredKeys) {
          assert.ok(typeof dict[key] === 'string' && dict[key].length > 0, `${file} must define non-empty "${key}"`);
        }
      }
    });
  });
}

module.exports = registerBackupDrTests;

if (require.main === module) {
  registerBackupDrTests();
}
