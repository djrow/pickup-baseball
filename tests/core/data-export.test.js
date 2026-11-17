/**
 * Wave 1b.15 (Ticket #52 / ADR-0005 §5): Scoped Data Portability Export Tests
 * Covers:
 * 1. Unauthenticated access rejection (401) on GET /api/auth/export
 * 2. Strict caller-scoped BASEBALL_DB and CHAT_DB export with zero peer PII,
 *    zero internal tokens/secrets (calendar_token, management_token, allowed_emails, etc.),
 *    and zero moderator internal notes (reviewed_by, resolution_note, hidden_by, original_content)
 * 3. Rate limiting (429 + Retry-After) on GET /api/auth/export
 * 4. Client-side WebCrypto decryption of exported E2EE messages via ClubhouseCrypto.decryptExportBundle
 *    both when vault is already unlocked and when unlocking via passphrase
 * 5. Profile UI wiring, strict ES6 compliance, and 14-locale i18n key parity
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const { createD1Adapter } = require('../../src/d1-sqlite');
const { app: honoApp } = require('../../src/app/index.js');
const {
  generateIdentityKeyPair,
  encryptVault,
  generateChannelKey,
  deriveEcdhSharedKey,
  wrapChannelKey,
  encryptPayload
} = require('../helpers/crypto-test-utils');

const ROOT_DIR = path.join(__dirname, '..', '..');

async function createExportTestEnv(envOverrides = {}) {
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

  async function apiFetch(pathname, { method = 'GET', cookie = null, body = null, envOverride = null } = {}) {
    const headers = new Headers();
    const url = `https://community.example.org${pathname}`;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) {
      headers.set('Origin', 'https://community.example.org');
    }
    if (cookie) {
      headers.set('Cookie', cookie);
    }
    let reqBody;
    if (body !== null && body !== undefined) {
      headers.set('Content-Type', 'application/json');
      reqBody = JSON.stringify(body);
    }
    const res = await honoApp.fetch(new Request(url, { method, headers, body: reqBody }), envOverride || env);
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // non-JSON
    }
    return { status: res.status, headers: res.headers, json, text };
  }

  function seedUser({
    name,
    email,
    bio = '',
    role = 'member',
    isAdmin = 0,
    isModerator = 0,
    calendarToken = null,
    machineBadge = 0,
    fieldBadge = 0,
    heroCredits = 0,
    clubhouseOptedIn = 1,
    rosterVisibility = 0,
    profileSharing = 0
  }) {
    const res = baseballSqlite.prepare(`
      INSERT INTO users (
        name, email, bio, role, is_admin, is_moderator, calendar_token,
        machine_badge, field_badge, hero_credits, clubhouse_opted_in,
        roster_visibility, profile_sharing
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      name,
      email,
      bio,
      role,
      isAdmin,
      isModerator,
      calendarToken,
      machineBadge,
      fieldBadge,
      heroCredits,
      clubhouseOptedIn,
      rosterVisibility,
      profileSharing
    );
    const userId = Number(res.lastInsertRowid);
    const rawSid = crypto.randomBytes(24).toString('hex');
    const hashedSid = `sha256:${crypto.createHash('sha256').update(rawSid).digest('hex')}`;
    const expiresAt = new Date(Date.now() + 86400 * 1000).toISOString();
    baseballSqlite.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(hashedSid, userId, expiresAt);
    return { userId, name, email, cookie: `baseball_session=${rawSid}` };
  }

  function close() {
    baseballSqlite.close();
    chatSqlite.close();
  }

  return { baseballSqlite, chatSqlite, baseballD1, chatD1, env, apiFetch, seedUser, close };
}

function registerDataExportTests() {
  test('Wave 1b.15 (Ticket #52): Scoped Data Portability Export (GET /api/auth/export)', async (t) => {
    await t.test('1. Unauthenticated request to GET /api/auth/export returns 401', async () => {
      const ctx = await createExportTestEnv();
      try {
        const res = await ctx.apiFetch('/api/auth/export');
        assert.equal(res.status, 401);
      } finally {
        ctx.close();
      }
    });

    await t.test('2. Export returns complete caller-scoped BASEBALL_DB + CHAT_DB bundle with zero peer PII, internal tokens, or moderator notes', async () => {
      const ctx = await createExportTestEnv();
      try {
        const mod = ctx.seedUser({
          name: 'Moderator Coach',
          email: 'mod_secret@example.org',
          role: 'admin',
          isAdmin: 1,
          isModerator: 1,
          calendarToken: 'cal_tok_mod_secret'
        });
        const alice = ctx.seedUser({
          name: 'Alice Batter',
          email: 'alice_export@example.org',
          bio: 'Plays shortstop every Sunday',
          calendarToken: 'cal_tok_alice_secret',
          machineBadge: 1,
          fieldBadge: 0,
          heroCredits: 3,
          clubhouseOptedIn: 1,
          rosterVisibility: 1,
          profileSharing: 1
        });
        const bob = ctx.seedUser({
          name: 'Bob Peer',
          email: 'bob_peer_secret@example.org',
          bio: 'Bob private bio secret',
          calendarToken: 'cal_tok_bob_secret',
          machineBadge: 0,
          fieldBadge: 1,
          heroCredits: 9
        });

        // Mark Alice chat_muted_by Mod to verify chat_muted_by is excluded
        ctx.baseballSqlite.prepare(
          "UPDATE users SET chat_muted = 1, chat_muted_reason = 'Cool down', chat_muted_by = ?, chat_muted_at = '2026-11-10T00:00:00Z' WHERE id = ?"
        ).run(mod.userId, alice.userId);

        // Consent records (Alice member + Alice prior visitor stage + Bob member + Bob visitor)
        const aliceEmailHash = crypto.createHash('sha256').update('alice_export@example.org', 'utf8').digest('hex');
        const bobEmailHash = crypto.createHash('sha256').update('bob_peer_secret@example.org', 'utf8').digest('hex');
        ctx.baseballSqlite.prepare(`
          INSERT INTO consent_records (subject_type, user_id, subject_email_hash, consent_type, policy_version, policy_sha256, status, granted_at)
          VALUES ('visitor', NULL, ?, 'roster_consent', 'v1', 'sha_policy_visitor', 'granted', '2026-10-15T00:00:00Z')
        `).run(aliceEmailHash);
        ctx.baseballSqlite.prepare(`
          INSERT INTO consent_records (subject_type, user_id, consent_type, policy_version, policy_sha256, status, granted_at)
          VALUES ('member', ?, 'roster_visibility', 'v1', 'sha_policy_1', 'granted', '2026-11-01T00:00:00Z')
        `).run(alice.userId);
        ctx.baseballSqlite.prepare(`
          INSERT INTO consent_records (subject_type, user_id, subject_email_hash, consent_type, policy_version, policy_sha256, status, granted_at)
          VALUES ('visitor', NULL, ?, 'roster_consent', 'v1', 'sha_policy_bob_visitor', 'granted', '2026-10-15T00:00:00Z')
        `).run(bobEmailHash);
        ctx.baseballSqlite.prepare(`
          INSERT INTO consent_records (subject_type, user_id, consent_type, policy_version, policy_sha256, status, granted_at)
          VALUES ('member', ?, 'profile_sharing', 'v1', 'sha_policy_bob', 'granted', '2026-11-01T00:00:00Z')
        `).run(bob.userId);

        // Invite-only event with allowed_emails whitelist
        const evRes = ctx.baseballSqlite.prepare(`
          INSERT INTO events (title, description, location, event_date, allowed_emails, created_by)
          VALUES ('Sunday Bushrod Pickup', 'Bring wood bats', 'Bushrod Park', '2026-11-22T20:00:00Z', 'alice_export@example.org,vip_peer_secret@example.org', ?)
        `).run(mod.userId);
        const eventId = Number(evRes.lastInsertRowid);

        const duty1 = Number(ctx.baseballSqlite.prepare(
          "INSERT INTO event_duties (event_id, title, description, slots_needed) VALUES (?, 'Bases', 'Bring bases', 1)"
        ).run(eventId).lastInsertRowid);
        const duty2 = Number(ctx.baseballSqlite.prepare(
          "INSERT INTO event_duties (event_id, title, description, slots_needed) VALUES (?, 'Water', 'Bring water', 1)"
        ).run(eventId).lastInsertRowid);

        // Attendees + management tokens + duty assignments
        const aliceAttId = Number(ctx.baseballSqlite.prepare(`
          INSERT INTO attendees (event_id, user_id, name, email, status, gear_bringing, notes, players_count, management_token, paper_waiver_by)
          VALUES (?, ?, 'Alice Batter', 'alice_export@example.org', 'attending', 'Wood bat', 'Arriving 12:15', 1, 'sha256:alice_mgmt_secret', ?)
        `).run(eventId, alice.userId, mod.userId).lastInsertRowid);

        const bobAttId = Number(ctx.baseballSqlite.prepare(`
          INSERT INTO attendees (event_id, user_id, name, email, status, gear_bringing, notes, players_count, guest_names, management_token)
          VALUES (?, ?, 'Bob Peer', 'bob_peer_secret@example.org', 'attending', 'Catcher mask', 'Bob secret note', 2, 'Bob Companion Secret', 'sha256:bob_mgmt_secret')
        `).run(eventId, bob.userId).lastInsertRowid);

        ctx.baseballSqlite.prepare('INSERT INTO duty_assignments (duty_id, attendee_id) VALUES (?, ?)').run(duty1, aliceAttId);
        ctx.baseballSqlite.prepare('INSERT INTO duty_assignments (duty_id, attendee_id) VALUES (?, ?)').run(duty2, bobAttId);

        // Batting practice signups
        ctx.baseballSqlite.prepare(
          "INSERT INTO batting_practice_signups (event_id, user_id, attendee_id, slot_number, player_name, notes) VALUES (?, ?, ?, 1, 'Alice Batter', 'Machine pitch')"
        ).run(eventId, alice.userId, aliceAttId);
        ctx.baseballSqlite.prepare(
          "INSERT INTO batting_practice_signups (event_id, user_id, attendee_id, slot_number, player_name, notes) VALUES (?, ?, ?, 2, 'Bob BP Secret', 'Lefty')"
        ).run(eventId, bob.userId, bobAttId);

        // Comments
        ctx.baseballSqlite.prepare(
          "INSERT INTO comments (event_id, user_id, author_name, author_email, content) VALUES (?, ?, 'Alice Batter', 'alice_export@example.org', 'Bringing extra batting tees')"
        ).run(eventId, alice.userId);
        ctx.baseballSqlite.prepare(
          "INSERT INTO comments (event_id, user_id, author_name, author_email, content) VALUES (?, ?, 'Bob Peer', 'bob_peer_secret@example.org', 'Bob private comment secret')"
        ).run(eventId, bob.userId);

        // Posts
        ctx.baseballSqlite.prepare(
          "INSERT INTO posts (title, content, summary, author_id, author_name, event_id) VALUES ('Alice Recap', 'Great game today!', 'Great game', ?, 'Alice Batter', ?)"
        ).run(alice.userId, eventId);
        ctx.baseballSqlite.prepare(
          "INSERT INTO posts (title, content, summary, author_id, author_name, event_id) VALUES ('Bob Post Secret', 'Bob content secret', 'Summary', ?, 'Bob Peer', ?)"
        ).run(bob.userId, eventId);

        // Media items
        ctx.baseballSqlite.prepare(`
          INSERT INTO media_items (title, caption, media_type, file_url, album, date_taken, contributor_name, contributor_id, event_id, is_approved, approved_by, delete_token, upload_token_hash)
          VALUES ('Alice Swing Photo', 'Line drive', 'photo', 'https://example.org/alice.jpg', 'Bushrod', '2026-11-15', 'Alice Batter', ?, ?, 1, ?, 'alice_delete_tok_secret', 'alice_upload_hash_secret')
        `).run(alice.userId, eventId, mod.userId);
        ctx.baseballSqlite.prepare(`
          INSERT INTO media_items (title, caption, media_type, file_url, album, date_taken, contributor_name, contributor_id, event_id, is_approved, delete_token)
          VALUES ('Bob Photo Secret', 'Bob caption', 'photo', 'https://example.org/bob.jpg', 'Bushrod', '2026-11-15', 'Bob Peer', ?, ?, 1, 'bob_delete_tok_secret')
        `).run(bob.userId, eventId);

        // Waivers
        ctx.baseballSqlite.prepare(`
          INSERT INTO waivers (
            certificate_id, user_id, email, printed_name, signed_date, signature_type, signature_data,
            document_version, waiver_text_sha256, document_sha256, provenance_seal, signer_ip, user_agent, gdrive_file_id, status
          ) VALUES (
            'PBF-ALICE-001', ?, 'alice_export@example.org', 'Alice Batter', '2026-11-01', 'drawn', 'data:image/png;base64,AAA',
            '41335\\14760738.1', 'text_sha_a', 'doc_sha_a', 'seal_a', '203.0.113.10', 'AliceUA/1.0', 'gdrive_alice_secret', 'active'
          )
        `).run(alice.userId);
        ctx.baseballSqlite.prepare(`
          INSERT INTO waivers (
            certificate_id, user_id, email, printed_name, signed_date, signature_type, signature_data,
            document_version, waiver_text_sha256, document_sha256, provenance_seal, signer_ip, user_agent, status
          ) VALUES (
            'PBF-BOB-001', ?, 'bob_peer_secret@example.org', 'Bob Signer Secret', '2026-11-01', 'drawn', 'data:image/png;base64,BBB',
            '41335\\14760738.1', 'text_sha_b', 'doc_sha_b', 'seal_b', '198.51.100.22', 'BobUA/1.0', 'active'
          )
        `).run(bob.userId);

        // CHAT_DB fixtures
        const aliceKeys = await generateIdentityKeyPair();
        const bobKeys = await generateIdentityKeyPair();
        const aliceVault = await encryptVault('alice-vault-pass', {
          ecdhPriv: aliceKeys.ecdhPrivateJwk,
          ecdsaPriv: aliceKeys.ecdsaPrivateJwk,
          ecdhPub: aliceKeys.ecdhPublicJwk,
          ecdsaPub: aliceKeys.ecdsaPublicJwk
        });
        ctx.chatSqlite.prepare(`
          INSERT INTO user_crypto_keys (user_id, ecdh_public_key_jwk, ecdsa_public_key_jwk, encrypted_private_vault, vault_salt, vault_iv, status_text)
          VALUES (?, ?, ?, ?, ?, ?, 'Ready to hit')
        `).run(
          alice.userId,
          JSON.stringify(aliceKeys.ecdhPublicJwk),
          JSON.stringify(aliceKeys.ecdsaPublicJwk),
          aliceVault.encryptedVaultB64,
          aliceVault.saltB64,
          aliceVault.ivB64
        );
        ctx.chatSqlite.prepare(`
          INSERT INTO user_crypto_keys (user_id, ecdh_public_key_jwk, ecdsa_public_key_jwk, encrypted_private_vault, vault_salt, vault_iv)
          VALUES (?, ?, ?, 'bob_vault_secret', 'bob_salt_secret', 'bob_iv_secret')
        `).run(bob.userId, JSON.stringify(bobKeys.ecdhPublicJwk), JSON.stringify(bobKeys.ecdsaPublicJwk));

        const generalCh = ctx.chatSqlite.prepare("SELECT id FROM channels WHERE slug = 'general'").get();
        const dmSlug = `dm-${Math.min(alice.userId, bob.userId)}-${Math.max(alice.userId, bob.userId)}`;
        const dmChId = Number(ctx.chatSqlite.prepare(`
          INSERT INTO channels (slug, name, category, channel_type, is_encrypted, is_private, created_by)
          VALUES (?, 'DM: Alice & Bob', 'Direct Messages', 'dm', 1, 1, ?)
        `).run(dmSlug, bob.userId).lastInsertRowid);
        const bobModDmId = Number(ctx.chatSqlite.prepare(`
          INSERT INTO channels (slug, name, category, channel_type, is_encrypted, is_private, created_by)
          VALUES ('dm-bob-mod-secret', 'DM: Bob & Mod', 'Direct Messages', 'dm', 1, 1, ?)
        `).run(bob.userId).lastInsertRowid);

        ctx.chatSqlite.prepare('INSERT INTO channel_members (channel_id, user_id, role) VALUES (?, ?, ?)').run(generalCh.id, alice.userId, 'member');
        ctx.chatSqlite.prepare('INSERT INTO channel_members (channel_id, user_id, role) VALUES (?, ?, ?)').run(dmChId, alice.userId, 'member');
        ctx.chatSqlite.prepare('INSERT INTO channel_members (channel_id, user_id, role) VALUES (?, ?, ?)').run(dmChId, bob.userId, 'member');
        ctx.chatSqlite.prepare('INSERT INTO channel_members (channel_id, user_id, role) VALUES (?, ?, ?)').run(bobModDmId, bob.userId, 'member');

        // Channel key shares: Bob wraps DM key for Alice and for Bob
        const dmChannelKey = await generateChannelKey();
        const sharedBobAlice = await deriveEcdhSharedKey(bobKeys.ecdhPair.privateKey, aliceKeys.ecdhPair.publicKey);
        const wrappedForAlice = await wrapChannelKey(dmChannelKey, sharedBobAlice);
        const sharedBobSelf = await deriveEcdhSharedKey(bobKeys.ecdhPair.privateKey, bobKeys.ecdhPair.publicKey);
        const wrappedForBob = await wrapChannelKey(dmChannelKey, sharedBobSelf);

        ctx.chatSqlite.prepare(`
          INSERT INTO channel_key_shares (channel_id, key_epoch, recipient_user_id, sender_user_id, wrapped_key_base64, wrap_iv)
          VALUES (?, 1, ?, ?, ?, ?)
        `).run(dmChId, alice.userId, bob.userId, wrappedForAlice.wrappedKeyBase64, wrappedForAlice.wrapIv);
        ctx.chatSqlite.prepare(`
          INSERT INTO channel_key_shares (channel_id, key_epoch, recipient_user_id, sender_user_id, wrapped_key_base64, wrap_iv)
          VALUES (?, 1, ?, ?, 'bob_wrapped_key_secret', ?)
        `).run(dmChId, bob.userId, bob.userId, wrappedForBob.wrapIv);
        ctx.chatSqlite.prepare(`
          INSERT INTO channel_key_shares (channel_id, key_epoch, recipient_user_id, sender_user_id, wrapped_key_base64, wrap_iv)
          VALUES (?, 1, ?, ?, 'bob_mod_wrapped_secret', 'iv123')
        `).run(bobModDmId, bob.userId, mod.userId);

        // Messages
        const alicePlainMsgId = Number(ctx.chatSqlite.prepare(`
          INSERT INTO messages (channel_id, author_id, author_name, content)
          VALUES (?, ?, 'Alice Batter', 'Anyone need a ride from Rockridge?')
        `).run(generalCh.id, alice.userId).lastInsertRowid);

        const encMsg = await encryptPayload(dmChannelKey, 'Meet at Bushrod dugout at 11:30');
        ctx.chatSqlite.prepare(`
          INSERT INTO messages (channel_id, author_id, author_name, content, iv, key_epoch)
          VALUES (?, ?, 'Alice Batter', ?, ?, 1)
        `).run(dmChId, alice.userId, encMsg.ciphertextB64, encMsg.ivB64);

        // Hidden message by Alice — moderator fields must NOT leak
        ctx.chatSqlite.prepare(`
          INSERT INTO messages (
            channel_id, author_id, author_name, content, hidden_at, hidden_by, hidden_by_name, hidden_reason, original_content, original_iv
          ) VALUES (?, ?, 'Alice Batter', '[Message hidden by moderator]', '2026-11-12T00:00:00Z', ?, 'Mod Secret Name', 'Internal mod note secret', 'Hidden original content secret', 'orig_iv_secret')
        `).run(generalCh.id, alice.userId, mod.userId);

        // Third-party messages by Bob — MUST NOT appear
        const bobMsgId = Number(ctx.chatSqlite.prepare(`
          INSERT INTO messages (channel_id, author_id, author_name, content)
          VALUES (?, ?, 'Bob Peer', 'Bob general message secret')
        `).run(generalCh.id, bob.userId).lastInsertRowid);
        ctx.chatSqlite.prepare(`
          INSERT INTO messages (channel_id, author_id, author_name, content, iv, key_epoch)
          VALUES (?, ?, 'Bob Peer', 'Bob DM message secret', 'iv_bob', 1)
        `).run(dmChId, bob.userId);

        // Reactions
        ctx.chatSqlite.prepare(
          "INSERT INTO message_reactions (message_id, channel_id, user_id, user_name, emoji) VALUES (?, ?, ?, 'Alice Batter', '⚾')"
        ).run(alicePlainMsgId, generalCh.id, alice.userId);
        ctx.chatSqlite.prepare(
          "INSERT INTO message_reactions (message_id, channel_id, user_id, user_name, emoji) VALUES (?, ?, ?, 'Bob Reactor Secret', '🤡')"
        ).run(bobMsgId, generalCh.id, bob.userId);

        // Attachments
        ctx.chatSqlite.prepare(`
          INSERT INTO chat_attachments (id, channel_id, message_id, uploader_id, file_name, mime_type, file_size, storage_provider, drive_file_id, resumable_session_uri, r2_key, upload_status)
          VALUES ('att_alice_1', ?, ?, ?, 'lineup.png', 'image/png', 1024, 'gdrive', 'alice_drive_att_secret', 'https://upload.example.com/secret_session', 'r2_alice_secret', 'ready')
        `).run(generalCh.id, alicePlainMsgId, alice.userId);
        ctx.chatSqlite.prepare(`
          INSERT INTO chat_attachments (id, channel_id, message_id, uploader_id, file_name, mime_type, file_size, storage_provider, upload_status)
          VALUES ('att_bob_1', ?, ?, ?, 'bob_att_secret.png', 'image/png', 2048, 'gdrive', 'ready')
        `).run(generalCh.id, bobMsgId, bob.userId);

        // Chat reports: one filed by Alice (must omit reviewed_by/reviewed_by_name/resolution_note), one filed by Bob against Alice (must be excluded)
        ctx.chatSqlite.prepare(`
          INSERT INTO chat_reports (
            reporter_id, reporter_name, target_type, target_user_id, target_user_name, target_message_id, channel_id,
            reason, status, reviewed_by, reviewed_by_name, resolution_note, reviewed_at
          ) VALUES (
            ?, 'Alice Batter', 'message', ?, 'Bob Peer', ?, ?,
            'Spam link posted', 'resolved', ?, 'Mod Reviewer Secret', 'Internal resolution note secret', '2026-11-13T00:00:00Z'
          )
        `).run(alice.userId, bob.userId, bobMsgId, generalCh.id, mod.userId);
        ctx.chatSqlite.prepare(`
          INSERT INTO chat_reports (
            reporter_id, reporter_name, target_type, target_user_id, target_user_name, channel_id, reason, status
          ) VALUES (?, 'Bob Peer', 'user', ?, 'Alice Batter', ?, 'Bob report against Alice secret', 'open')
        `).run(bob.userId, alice.userId, generalCh.id);

        // Execute export as Alice
        const res = await ctx.apiFetch('/api/auth/export', { cookie: alice.cookie });
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
        assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
        assert.ok(res.json && res.json.baseball && res.json.chat, 'Export must contain baseball and chat bundles');

        const exp = res.json;
        assert.equal(exp.user_id, alice.userId);
        assert.equal(exp.baseball.profile.email, 'alice_export@example.org');
        assert.equal(exp.baseball.profile.calendar_token, undefined);
        assert.equal(exp.baseball.profile.chat_muted_by, undefined);
        assert.deepEqual(exp.baseball.badges, {
          machine_badge: true,
          field_badge: false,
          hero_credits: 3
        });

        assert.equal(exp.baseball.consent_records.length, 2);
        assert.deepEqual(
          exp.baseball.consent_records.map((r) => [r.subject_type, r.consent_type]),
          [
            ['visitor', 'roster_consent'],
            ['member', 'roster_visibility']
          ]
        );

        assert.equal(exp.baseball.attendees.length, 1);
        assert.equal(exp.baseball.attendees[0].gear_bringing, 'Wood bat');
        assert.equal(exp.baseball.attendees[0].management_token, undefined);
        assert.equal(exp.baseball.attendees[0].allowed_emails, undefined);

        assert.equal(exp.baseball.duty_assignments.length, 1);
        assert.equal(exp.baseball.duty_assignments[0].duty_title, 'Bases');

        assert.equal(exp.baseball.batting_practice_signups.length, 1);
        assert.equal(exp.baseball.batting_practice_signups[0].slot_number, 1);

        assert.equal(exp.baseball.comments.length, 1);
        assert.equal(exp.baseball.comments[0].content, 'Bringing extra batting tees');

        assert.equal(exp.baseball.posts.length, 1);
        assert.equal(exp.baseball.posts[0].title, 'Alice Recap');

        assert.equal(exp.baseball.media_items.length, 1);
        assert.equal(exp.baseball.media_items[0].title, 'Alice Swing Photo');
        assert.equal(exp.baseball.media_items[0].delete_token, undefined);
        assert.equal(exp.baseball.media_items[0].upload_token_hash, undefined);
        assert.equal(exp.baseball.media_items[0].approved_by, undefined);

        assert.equal(exp.baseball.waivers.length, 1);
        assert.equal(exp.baseball.waivers[0].certificate_id, 'PBF-ALICE-001');
        assert.equal(exp.baseball.waivers[0].signer_ip, undefined);
        assert.equal(exp.baseball.waivers[0].user_agent, undefined);
        assert.equal(exp.baseball.waivers[0].gdrive_file_id, undefined);

        assert.ok(exp.chat.user_crypto_keys);
        assert.equal(exp.chat.user_crypto_keys.encrypted_private_vault, aliceVault.encryptedVaultB64);
        assert.equal(exp.chat.channel_members.length, 2);
        assert.equal(exp.chat.channel_key_shares.length, 1);
        assert.equal(exp.chat.channel_key_shares[0].recipient_user_id, alice.userId);
        assert.equal(exp.chat.messages.length, 3);
        assert.equal(exp.chat.message_reactions.length, 1);
        assert.equal(exp.chat.chat_attachments.length, 1);
        assert.equal(exp.chat.chat_attachments[0].drive_file_id, undefined);
        assert.equal(exp.chat.chat_attachments[0].resumable_session_uri, undefined);
        assert.equal(exp.chat.chat_attachments[0].r2_key, undefined);
        assert.equal(exp.chat.chat_reports.length, 1);
        assert.equal(exp.chat.chat_reports[0].reason, 'Spam link posted');
        assert.equal(exp.chat.chat_reports[0].reviewed_by, undefined);
        assert.equal(exp.chat.chat_reports[0].reviewed_by_name, undefined);
        assert.equal(exp.chat.chat_reports[0].resolution_note, undefined);

        // Exhaustive leakage check over serialized JSON
        const serialized = JSON.stringify(exp);
        const forbiddenSubstrings = [
          'cal_tok_alice_secret',
          'cal_tok_bob_secret',
          'cal_tok_mod_secret',
          'calendar_token',
          'vip_peer_secret@example.org',
          'allowed_emails',
          'alice_mgmt_secret',
          'bob_mgmt_secret',
          'management_token',
          'alice_delete_tok_secret',
          'alice_upload_hash_secret',
          'delete_token',
          'upload_token_hash',
          'gdrive_alice_secret',
          'alice_drive_att_secret',
          'resumable_session_uri',
          'r2_alice_secret',
          '203.0.113.10',
          'AliceUA/1.0',
          'bob_peer_secret@example.org',
          'Bob private bio secret',
          'Bob Companion Secret',
          'Bob secret note',
          'Bob BP Secret',
          'Bob private comment secret',
          'Bob Post Secret',
          'Bob Photo Secret',
          'PBF-BOB-001',
          'Bob Signer Secret',
          'bob_vault_secret',
          'bob_wrapped_key_secret',
          'bob_mod_wrapped_secret',
          'dm-bob-mod-secret',
          'Bob general message secret',
          'Bob DM message secret',
          'Bob Reactor Secret',
          'bob_att_secret.png',
          'Mod Secret Name',
          'Internal mod note secret',
          'Hidden original content secret',
          'orig_iv_secret',
          'hidden_by',
          'hidden_reason',
          'original_content',
          'Mod Reviewer Secret',
          'Internal resolution note secret',
          'reviewed_by',
          'resolution_note',
          'Bob report against Alice secret'
        ];
        for (const needle of forbiddenSubstrings) {
          assert.equal(serialized.includes(needle), false, `Export JSON must NOT contain forbidden string: ${needle}`);
        }
      } finally {
        ctx.close();
      }
    });

    await t.test('3. Rate-limiting enforces cap on GET /api/auth/export (429 + Retry-After)', async () => {
      const ctx = await createExportTestEnv();
      try {
        const alice = ctx.seedUser({ name: 'Rate Test Alice', email: 'alice_rl@example.org' });
        const prodEnv = { ...ctx.env, NODE_ENV: 'production' };

        let saw429 = false;
        let retryAfter = null;
        for (let i = 0; i < 12; i++) {
          const res = await ctx.apiFetch('/api/auth/export', { cookie: alice.cookie, envOverride: prodEnv });
          if (res.status === 429) {
            saw429 = true;
            retryAfter = res.headers.get('Retry-After');
            break;
          }
          assert.equal(res.status, 200);
        }
        assert.equal(saw429, true, 'Repeated GET /api/auth/export requests must hit 429 rate limit');
        assert.ok(retryAfter, '429 response must include Retry-After header');
      } finally {
        ctx.close();
      }
    });

    await t.test('4. Client-side WebCrypto decrypts exported E2EE messages both with unlocked local vault and with passphrase unlock', async () => {
      const ctx = await createExportTestEnv();
      const prevIndexedDB = globalThis.indexedDB;
      try {
        delete require.cache[require.resolve('../../public/js/crypto.js')];
        globalThis.indexedDB = null;
        const ClubhouseCrypto = require('../../public/js/crypto.js');

        const alice = ctx.seedUser({ name: 'Alice Crypto', email: 'alice_crypto@example.org' });
        const bob = ctx.seedUser({ name: 'Bob Crypto', email: 'bob_crypto@example.org' });

        const aliceKeys = await generateIdentityKeyPair();
        const bobKeys = await generateIdentityKeyPair();
        const aliceVault = await encryptVault('strong-export-passphrase', {
          ecdhPriv: aliceKeys.ecdhPrivateJwk,
          ecdsaPriv: aliceKeys.ecdsaPrivateJwk,
          ecdhPub: aliceKeys.ecdhPublicJwk,
          ecdsaPub: aliceKeys.ecdsaPublicJwk
        });

        ctx.chatSqlite.prepare(`
          INSERT INTO user_crypto_keys (user_id, ecdh_public_key_jwk, ecdsa_public_key_jwk, encrypted_private_vault, vault_salt, vault_iv)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          alice.userId,
          JSON.stringify(aliceKeys.ecdhPublicJwk),
          JSON.stringify(aliceKeys.ecdsaPublicJwk),
          aliceVault.encryptedVaultB64,
          aliceVault.saltB64,
          aliceVault.ivB64
        );
        ctx.chatSqlite.prepare(`
          INSERT INTO user_crypto_keys (user_id, ecdh_public_key_jwk, ecdsa_public_key_jwk)
          VALUES (?, ?, ?)
        `).run(bob.userId, JSON.stringify(bobKeys.ecdhPublicJwk), JSON.stringify(bobKeys.ecdsaPublicJwk));

        const dmChId = Number(ctx.chatSqlite.prepare(`
          INSERT INTO channels (slug, name, category, channel_type, is_encrypted, is_private, created_by)
          VALUES ('dm-crypto-test', 'DM: Crypto', 'Direct Messages', 'dm', 1, 1, ?)
        `).run(bob.userId).lastInsertRowid);
        ctx.chatSqlite.prepare('INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?)').run(dmChId, alice.userId);
        ctx.chatSqlite.prepare('INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?)').run(dmChId, bob.userId);

        const dmKey = await generateChannelKey();
        const sharedKey = await deriveEcdhSharedKey(bobKeys.ecdhPair.privateKey, aliceKeys.ecdhPair.publicKey);
        const wrapped = await wrapChannelKey(dmKey, sharedKey);
        ctx.chatSqlite.prepare(`
          INSERT INTO channel_key_shares (channel_id, key_epoch, recipient_user_id, sender_user_id, wrapped_key_base64, wrap_iv)
          VALUES (?, 1, ?, ?, ?, ?)
        `).run(dmChId, alice.userId, bob.userId, wrapped.wrappedKeyBase64, wrapped.wrapIv);

        const secretText = 'Bring the backup catcher mitt on Sunday!';
        const enc = await encryptPayload(dmKey, secretText);
        ctx.chatSqlite.prepare(`
          INSERT INTO messages (channel_id, author_id, author_name, content, iv, key_epoch)
          VALUES (?, ?, 'Alice Crypto', ?, ?, 1)
        `).run(dmChId, alice.userId, enc.ciphertextB64, enc.ivB64);

        const res = await ctx.apiFetch('/api/auth/export', { cookie: alice.cookie });
        assert.equal(res.status, 200);
        const rawBundle = res.json;
        assert.equal(rawBundle.chat.messages.length, 1);
        assert.equal(rawBundle.chat.messages[0].content, enc.ciphertextB64);

        // 4a. Wrong passphrase must reject cleanly
        ClubhouseCrypto.clearMemoryKeys();
        await assert.rejects(
          () => ClubhouseCrypto.decryptExportBundle(rawBundle, { passphrase: 'wrong-passphrase' })
        );

        // 4b. Locked vault -> unlock with passphrase decrypts exported messages
        const decryptedViaPass = await ClubhouseCrypto.decryptExportBundle(rawBundle, {
          passphrase: 'strong-export-passphrase'
        });
        assert.equal(decryptedViaPass.chat.messages[0].decrypted_content, secretText);
        assert.equal(decryptedViaPass.chat.messages[0].e2ee_decrypted, true);
        assert.equal(decryptedViaPass.chat.decryption_summary.decrypted, 1);
        assert.equal(decryptedViaPass.chat.decryption_summary.failed, 0);

        // 4c. Unlocked vault -> decrypts without needing passphrase again
        const decryptedUnlocked = await ClubhouseCrypto.decryptExportBundle(rawBundle);
        assert.equal(decryptedUnlocked.chat.messages[0].decrypted_content, secretText);
        assert.equal(decryptedUnlocked.chat.messages[0].e2ee_decrypted, true);
      } finally {
        globalThis.indexedDB = prevIndexedDB;
        delete require.cache[require.resolve('../../public/js/crypto.js')];
        ctx.close();
      }
    });

    await t.test('5. Profile UI markup, strict ES6 rules, and 14-locale i18n parity', () => {
      const profileHtml = fs.readFileSync(path.join(ROOT_DIR, 'public', 'profile.html'), 'utf8');
      assert.ok(profileHtml.includes('/js/crypto.js'), 'profile.html must load /js/crypto.js for E2EE export decryption');
      assert.ok(profileHtml.includes('id="btn-export-my-data"'), 'profile.html must include export download button');
      assert.ok(profileHtml.includes('id="export-decrypt-e2ee-checkbox"'), 'profile.html must include E2EE decryption checkbox');
      assert.equal(/\son[a-z]+\s*=/i.test(profileHtml), false, 'profile.html must not contain inline event handlers');

      for (const rel of [
        'public/js/profile.js',
        'public/js/crypto.js',
        'public/js/api.js',
        'public/js/api/i18n.js',
        'public/js/api/ui.js',
        'public/js/api/endpoints.js'
      ]) {
        if (!fs.existsSync(path.join(ROOT_DIR, rel))) continue;
        const src = fs.readFileSync(path.join(ROOT_DIR, rel), 'utf8');
        assert.equal(/[\w$\])]\?\./.test(src), false, `${rel} must not use optional chaining (?.)`);
        assert.equal(src.includes('??'), false, `${rel} must not use nullish coalescing (??)`);
      }

      const apiSrc = fs.existsSync(path.join(ROOT_DIR, 'public', 'js', 'api', 'i18n.js'))
        ? fs.readFileSync(path.join(ROOT_DIR, 'public', 'js', 'api', 'i18n.js'), 'utf8')
        : fs.readFileSync(path.join(ROOT_DIR, 'public', 'js', 'api.js'), 'utf8');
      assert.ok(apiSrc.includes('profile.export_btn'), 'EN_DICT must include profile.export_btn');
      const requiredKeys = [
        'profile.export_title',
        'profile.export_desc',
        'profile.export_btn',
        'profile.export_decrypt_label',
        'profile.export_working',
        'profile.export_success',
        'profile.export_success_decrypted',
        'profile.export_failed',
        'profile.export_passphrase_title',
        'profile.export_passphrase_msg',
        'profile.export_passphrase_placeholder',
        'profile.export_passphrase_confirm',
        'profile.export_wrong_passphrase'
      ];
      const i18nDir = path.join(ROOT_DIR, 'public', 'i18n');
      const localeFiles = fs.readdirSync(i18nDir).filter((f) => f.endsWith('.json'));
      assert.equal(localeFiles.length, 14, 'Expected 14 non-English locale files');
      for (const file of localeFiles) {
        const dict = JSON.parse(fs.readFileSync(path.join(i18nDir, file), 'utf8'));
        for (const k of requiredKeys) {
          assert.ok(k in dict, `${file} missing key ${k}`);
        }
      }
    });
  });
}

module.exports = registerDataExportTests;

if (require.main === module) {
  registerDataExportTests();
}
