/**
 * De-hardcoding Branding, Admin Fallback, Seed Data & Waiver Preset Tests (Ticket #36)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const { createD1Adapter } = require('../../src/d1-sqlite');

const PINNED_PICKUP_WAIVER_SHA256 = '91e881797bd3d03bd8dc013a82aa45f33aa77472c671a280cbc6e7ef51e15371';
const SAMPLE_PNG_SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function walkJsFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkJsFiles(full));
    } else if (entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

module.exports = function registerDehardcodeTests(ctx) {
  const rootDir = (ctx && ctx.rootDir) || path.resolve(__dirname, '../..');

  test('Ticket #36: De-hardcode branding, admin fallback, demo seed data & waiver presets', async (t) => {
    const { app: honoApp } = require(path.join(rootDir, 'src', 'app', 'index.js'));
    const { ensureD1Schema } = await import('../../src/app/schema/engine.js');
    const { buildRssFeedXml, buildCalendarIcs } = await import('../../src/app/feeds.js');
    const {
      dispatchEmail,
      sendAuthCode,
      sendRainoutEmail,
      sendReopenEmail,
      sendWaiverConfirmationEmail
    } = await import('../../src/app/mailer.js');
    const {
      OFFICIAL_WAIVER_TEXT,
      WAIVER_DOC_VERSION,
      WAIVER_PARAGRAPHS
    } = await import('../../src/app/routes/waiver.js');

    await t.test('1. Static hygiene: src/ and functions/ contain zero pickupbaseballfoundation literals', () => {
      const targetFiles = [
        ...walkJsFiles(path.join(rootDir, 'src')),
        ...walkJsFiles(path.join(rootDir, 'functions'))
      ];
      for (const filePath of targetFiles) {
        const rel = path.relative(rootDir, filePath).replace(/\\/g, '/');
        const content = fs.readFileSync(filePath, 'utf8');
        assert.equal(
          content.toLowerCase().includes('pickupbaseballfoundation'),
          false,
          `${rel} must not contain hardcoded pickupbaseballfoundation references`
        );
      }

      const schemaFiles = walkJsFiles(path.join(rootDir, 'src', 'app', 'schema'));
      for (const filePath of schemaFiles) {
        const rel = path.relative(rootDir, filePath).replace(/\\/g, '/');
        const content = fs.readFileSync(filePath, 'utf8');
        assert.equal(
          content.includes('Bushrod Opening Infield Drag'),
          false,
          `${rel} must not contain demo media seeding data`
        );
      }
    });

    await t.test('2. Fresh DB creates zero demo media and promotes no hardcoded admin', async () => {
      const raw = new Database(':memory:');
      const d1 = createD1Adapter(raw);

      try {
        await ensureD1Schema(d1);

        const mediaCount = raw.prepare('SELECT COUNT(*) as c FROM media_items').get().c;
        assert.equal(mediaCount, 0, 'Fresh DB must create zero demo media_items rows');

        const adminCount = raw.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'admin' OR is_admin = 1").get().c;
        assert.equal(adminCount, 0, 'Fresh DB must promote zero hardcoded admins');

        // Even if pickupbaseballfoundation@gmail.com signs up with ADMIN_EMAIL unset, they must stay a regular member
        const sendRes = await honoApp.fetch(new Request('http://127.0.0.1/api/auth/send-code', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1' },
          body: JSON.stringify({ email: 'pickupbaseballfoundation@gmail.com', name: 'Foundation User' })
        }), { DB: d1, BASEBALL_DB: d1, NODE_ENV: 'test' });
        assert.equal(sendRes.status, 200);

        const codeRow = raw.prepare("SELECT code FROM auth_codes WHERE email = 'pickupbaseballfoundation@gmail.com' ORDER BY id DESC LIMIT 1").get();
        const verifyRes = await honoApp.fetch(new Request('http://127.0.0.1/api/auth/verify-code', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1' },
          body: JSON.stringify({ email: 'pickupbaseballfoundation@gmail.com', code: codeRow.code })
        }), { DB: d1, BASEBALL_DB: d1, NODE_ENV: 'test' });
        assert.equal(verifyRes.status, 200);
        const verifyJson = await verifyRes.json();
        assert.equal(verifyJson.user.isAdmin, false);
        const fndRow = raw.prepare("SELECT role, is_admin FROM users WHERE email = 'pickupbaseballfoundation@gmail.com'").get();
        assert.equal(fndRow.role, 'member');
        assert.equal(fndRow.is_admin, 0);

        // Configured ADMIN_EMAIL receives admin privileges on signup
        const sendAdminRes = await honoApp.fetch(new Request('http://127.0.0.1/api/auth/send-code', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1' },
          body: JSON.stringify({ email: 'custom-admin@example.org', name: 'Custom Admin' })
        }), { DB: d1, BASEBALL_DB: d1, NODE_ENV: 'test', ADMIN_EMAIL: 'custom-admin@example.org' });
        assert.equal(sendAdminRes.status, 200);

        const adminCodeRow = raw.prepare("SELECT code FROM auth_codes WHERE email = 'custom-admin@example.org' ORDER BY id DESC LIMIT 1").get();
        const verifyAdminRes = await honoApp.fetch(new Request('http://127.0.0.1/api/auth/verify-code', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1' },
          body: JSON.stringify({ email: 'custom-admin@example.org', code: adminCodeRow.code })
        }), { DB: d1, BASEBALL_DB: d1, NODE_ENV: 'test', ADMIN_EMAIL: 'custom-admin@example.org' });
        assert.equal(verifyAdminRes.status, 200);
        const verifyAdminJson = await verifyAdminRes.json();
        assert.equal(verifyAdminJson.user.isAdmin, true);
        const admRow = raw.prepare("SELECT role, is_admin FROM users WHERE email = 'custom-admin@example.org'").get();
        assert.equal(admRow.role, 'admin');
        assert.equal(admRow.is_admin, 1);
      } finally {
        raw.close();
      }
    });

    await t.test('3. Mailer uses resolveConfig(env) for COMMUNITY_NAME, FROM_EMAIL, and REPLY_TO_EMAIL with zero hardcoded Foundation fallback', async () => {
      const sentPayloads = [];
      const origFetch = global.fetch;
      global.fetch = async (url, opts) => {
        if (typeof url === 'string' && url.includes('api.resend.com')) {
          sentPayloads.push(JSON.parse(opts.body));
          return {
            ok: true,
            status: 200,
            json: async () => ({ id: `mock-${sentPayloads.length}` })
          };
        }
        return origFetch(url, opts);
      };

      try {
        const genericEnv = {
          COMMUNITY_PRESET: 'generic-community',
          COMMUNITY_NAME: 'Oakridge Makers',
          FROM_EMAIL: 'Oakridge Makers <hello@oakridge.example>',
          REPLY_TO_EMAIL: 'reply@oakridge.example',
          RESEND_API_KEY: 'test-resend-key'
        };

        await dispatchEmail(genericEnv, {
          to: 'member@oakridge.example',
          subject: 'Hello',
          text: 'Body',
          html: '<p>Body</p>'
        });
        await sendAuthCode(genericEnv, 'https://oakridge.example', {
          email: 'member@oakridge.example',
          name: 'Alex',
          code: '123456',
          token: 'tok-abc'
        });
        await sendRainoutEmail(genericEnv, 'https://oakridge.example', {
          email: 'member@oakridge.example',
          name: 'Alex',
          event: { id: 1, title: 'Saturday Meetup', event_date: '2026-12-06T20:00:00Z', location: 'Workshop B' },
          note: 'Rescheduled',
          managementToken: 'mgmt-1'
        });
        await sendReopenEmail(genericEnv, 'https://oakridge.example', {
          email: 'member@oakridge.example',
          name: 'Alex',
          event: { id: 1, title: 'Saturday Meetup', event_date: '2026-12-06T20:00:00Z', location: 'Workshop B' },
          note: 'Back on',
          managementToken: 'mgmt-1'
        });
        await sendWaiverConfirmationEmail(genericEnv, 'https://oakridge.example', {
          email: 'member@oakridge.example',
          printedName: 'Alex',
          signedDate: '2026-11-15',
          certificateId: 'WVR-20261115-ABCD',
          documentSha256: '0'.repeat(64)
        });

        assert.equal(sentPayloads.length, 5);
        for (const payload of sentPayloads) {
          assert.equal(payload.from, 'Oakridge Makers <hello@oakridge.example>');
          assert.equal(payload.reply_to, 'reply@oakridge.example');
          const serialized = JSON.stringify(payload).toLowerCase();
          assert.equal(serialized.includes('pickupbaseballfoundation'), false, 'Mailer payload must not contain pickupbaseballfoundation');
          assert.equal(serialized.includes('sunday pickup baseball'), false, 'Mailer payload must not contain Sunday Pickup Baseball');
        }

        const waiverEmail = sentPayloads[4];
        assert.ok(waiverEmail.subject.includes('Oakridge Makers'));
        assert.equal(waiverEmail.text.includes('41335'), false, 'Generic waiver email must not cite Foundation Form 41335');
        assert.equal(waiverEmail.text.includes('Pickup Baseball Foundation'), false);

        // Unset FROM_EMAIL / REPLY_TO_EMAIL never falls back to Foundation email
        sentPayloads.length = 0;
        await dispatchEmail({ RESEND_API_KEY: 'test-resend-key', COMMUNITY_NAME: 'Minimal Hub' }, {
          to: 'member@example.org',
          subject: 'Test',
          text: 'Hi',
          html: '<p>Hi</p>'
        });
        assert.equal(sentPayloads.length, 1);
        assert.equal(sentPayloads[0].from.includes('Minimal Hub'), true);
        assert.equal(sentPayloads[0].from.toLowerCase().includes('pickupbaseballfoundation'), false);
        assert.equal(sentPayloads[0].reply_to, undefined, 'Unset REPLY_TO_EMAIL must omit reply_to instead of using Foundation email');
      } finally {
        global.fetch = origFetch;
      }
    });

    await t.test('4. RSS & ICS feeds use configured COMMUNITY_NAME and PUBLIC_ORIGIN with zero hardcoded Foundation defaults', () => {
      const genericEnv = {
        COMMUNITY_PRESET: 'generic-community',
        COMMUNITY_NAME: 'Oakridge Makers',
        PUBLIC_ORIGIN: 'https://makers.example.org',
        REPLY_TO_EMAIL: 'info@makers.example.org'
      };

      const rssXml = buildRssFeedXml([
        {
          id: 42,
          title: 'Laser Cutter Orientation',
          content: 'Saturday session recap.',
          created_at: '2026-11-15T12:00:00Z'
        }
      ], 'https://makers.example.org', { env: genericEnv });

      assert.ok(rssXml.includes('<title>Oakridge Makers — Highlights &amp; Updates</title>'));
      assert.ok(rssXml.includes('<author>info@makers.example.org (Oakridge Makers)</author>'));
      assert.ok(rssXml.includes('@makers.example.org</guid>'));
      assert.equal(rssXml.toLowerCase().includes('pickupbaseballfoundation'), false);
      assert.equal(rssXml.toLowerCase().includes('sunday pickup baseball'), false);
      assert.equal(rssXml.toLowerCase().includes('bushrod'), false);

      const icsText = buildCalendarIcs([
        {
          id: 7,
          title: '',
          location: '',
          event_date: '2026-12-06T18:00:00Z',
          status: 'active'
        }
      ], 'https://makers.example.org', { env: genericEnv });

      assert.ok(icsText.includes('X-WR-CALNAME:Oakridge Makers'));
      assert.ok(icsText.includes('PRODID:-//Oakridge Makers//'));
      assert.ok(icsText.includes('SUMMARY:Oakridge Makers'));
      assert.ok(icsText.includes('UID:event-7@makers.example.org'));
      assert.ok(icsText.includes('LOCATION:TBA'));
      assert.equal(icsText.toLowerCase().includes('pickupbaseballfoundation'), false);
      assert.equal(icsText.toLowerCase().includes('sunday pickup baseball'), false);
      assert.equal(icsText.toLowerCase().includes('bushrod'), false);
    });

    await t.test('5. Waiver preset parity: pickup-baseball keeps exact byte-identical SHA-256 while generic-community is neutral', async () => {
      // Exact byte-identical OFFICIAL_WAIVER_TEXT SHA-256 check
      const actualHash = crypto.createHash('sha256').update(OFFICIAL_WAIVER_TEXT).digest('hex');
      assert.equal(actualHash, PINNED_PICKUP_WAIVER_SHA256, 'OFFICIAL_WAIVER_TEXT must remain byte-identical');
      assert.equal(WAIVER_DOC_VERSION, '41335\\14760738.1');
      assert.equal(WAIVER_PARAGRAPHS.length, 4);

      const raw = new Database(':memory:');
      const d1 = createD1Adapter(raw);

      try {
        await ensureD1Schema(d1);

        // Create a user & session directly
        const uRes = raw.prepare("INSERT INTO users (name, email, role, is_admin) VALUES ('Signer One', 'signer@example.org', 'member', 0)").run();
        const userId = uRes.lastInsertRowid;
        const sessId = crypto.randomBytes(24).toString('hex');
        const hashedSessId = `sha256:${crypto.createHash('sha256').update(sessId).digest('hex')}`;
        raw.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, '2099-01-01T00:00:00Z')").run(hashedSessId, userId);
        const cookie = `baseball_session=${sessId}`;

        // A. pickup-baseball preset
        const pbfEnv = {
          DB: d1,
          BASEBALL_DB: d1,
          NODE_ENV: 'test',
          COMMUNITY_PRESET: 'pickup-baseball',
          COMMUNITY_NAME: 'Sunday Pickup Baseball',
          WAIVER_SIGNING_SECRET: 'test-waiver-secret'
        };

        const pbfStatusRes = await honoApp.fetch(new Request('http://127.0.0.1/api/waiver/status'), pbfEnv);
        assert.equal(pbfStatusRes.status, 200);
        const pbfStatus = await pbfStatusRes.json();
        assert.equal(pbfStatus.document_version, '41335\\14760738.1');
        assert.equal(pbfStatus.waiver_text_sha256, PINNED_PICKUP_WAIVER_SHA256);

        const pbfSignRes = await honoApp.fetch(new Request('http://127.0.0.1/api/waiver/sign', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1', Cookie: cookie },
          body: JSON.stringify({
            printed_name: 'Signer One',
            signed_date: '2026-11-15',
            signature_type: 'drawn',
            signature_data: SAMPLE_PNG_SIG,
            electronic_consent: true
          })
        }), pbfEnv);
        assert.equal(pbfSignRes.status, 201);
        const pbfSignJson = await pbfSignRes.json();
        assert.ok(pbfSignJson.waiver.certificate_id.startsWith('PBF-WVR-'));
        assert.equal(pbfSignJson.waiver.waiver_text_sha256, PINNED_PICKUP_WAIVER_SHA256);

        const pbfCertRes = await honoApp.fetch(
          new Request(`http://127.0.0.1/api/waiver/certificate/${pbfSignJson.waiver.certificate_id}`),
          pbfEnv
        );
        assert.equal(pbfCertRes.status, 200);
        const pbfCertJson = await pbfCertRes.json();
        assert.equal(pbfCertJson.waiver.integrity_verified, true);

        // B. generic-community preset
        const genEnv = {
          DB: d1,
          BASEBALL_DB: d1,
          NODE_ENV: 'test',
          COMMUNITY_PRESET: 'generic-community',
          COMMUNITY_NAME: 'Oakridge Makers',
          WAIVER_SIGNING_SECRET: 'test-waiver-secret'
        };

        const genStatusRes = await honoApp.fetch(new Request('http://127.0.0.1/api/waiver/status'), genEnv);
        assert.equal(genStatusRes.status, 200);
        const genStatus = await genStatusRes.json();
        assert.equal(genStatus.document_version, 'community-waiver-v1');
        assert.notEqual(genStatus.waiver_text_sha256, PINNED_PICKUP_WAIVER_SHA256);
        const genParagraphText = genStatus.paragraphs.join('\n');
        assert.ok(genParagraphText.includes('Oakridge Makers'), 'Generic waiver must include configured COMMUNITY_NAME');
        assert.equal(genParagraphText.toLowerCase().includes('baseball'), false, 'Generic waiver must not mention baseball');
        assert.equal(genParagraphText.toLowerCase().includes('pickup baseball foundation'), false);

        const genSignRes = await honoApp.fetch(new Request('http://127.0.0.1/api/waiver/sign', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1', Cookie: cookie },
          body: JSON.stringify({
            printed_name: 'Signer One',
            signed_date: '2026-11-15',
            signature_type: 'drawn',
            signature_data: SAMPLE_PNG_SIG,
            electronic_consent: true
          })
        }), genEnv);
        assert.equal(genSignRes.status, 201);
        const genSignJson = await genSignRes.json();
        assert.ok(genSignJson.waiver.certificate_id.startsWith('WVR-'));
        assert.equal(genSignJson.waiver.document_version, 'community-waiver-v1');

        const genCertHtmlRes = await honoApp.fetch(
          new Request(`http://127.0.0.1/api/waiver/certificate/${genSignJson.waiver.certificate_id}?format=html`),
          genEnv
        );
        assert.equal(genCertHtmlRes.status, 200);
        const genCertHtml = await genCertHtmlRes.text();
        assert.ok(genCertHtml.includes('Oakridge Makers'));
        assert.ok(genCertHtml.includes('Cryptographic Seal Verified'));
        assert.equal(genCertHtml.toLowerCase().includes('pickup baseball foundation'), false);
        assert.equal(genCertHtml.toLowerCase().includes('baseball'), false);

        // Historical pickup-baseball certificate MUST STILL verify even if queried later
        const historicalVerifyRes = await honoApp.fetch(
          new Request(`http://127.0.0.1/api/waiver/certificate/${pbfSignJson.waiver.certificate_id}?format=html`),
          pbfEnv
        );
        assert.equal(historicalVerifyRes.status, 200);
        const historicalHtml = await historicalVerifyRes.text();
        assert.ok(historicalHtml.includes('Cryptographic Seal Verified'));
        assert.ok(historicalHtml.includes('Pickup Baseball Foundation'));
      } finally {
        raw.close();
      }
    });
  });
};

if (require.main === module) {
  module.exports();
}
