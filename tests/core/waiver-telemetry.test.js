/**
 * Ticket #48: Waiver Telemetry Minimization, 18+ Attestation & Isolated WAIVER_SIGNING_SECRET Tests
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const { createD1Adapter } = require('../../src/d1-sqlite');
const { ensureD1Schema } = require('../../src/app/schema.js');

const SAMPLE_PNG_SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function sha256HexSync(input) {
  return crypto.createHash('sha256').update(String(input || ''), 'utf8').digest('hex');
}

function hmacSha256HexSync(key, payload) {
  return crypto.createHmac('sha256', String(key)).update(String(payload || ''), 'utf8').digest('hex');
}

function registerWaiverTelemetryTests() {
  test('Ticket #48: Waiver telemetry minimization, 18+ attestation, isolated secret & 30-day scrub', async (t) => {
    const rootDir = path.join(__dirname, '..', '..');
    const { app: honoApp } = await import('../../src/app/index.js');
    const {
      buildCanonicalWaiverPayload,
      computeProvenanceSeal,
      verifyWaiverProvenanceSeal,
      scrubExpiredWaiverTelemetry,
      renderSignedWaiverCertificateHtml,
      getWaiverSpec
    } = await import('../../src/app/routes/waiver.js');

    const tmpDbPath = path.join(os.tmpdir(), `waiver_t48_${Date.now()}_${Math.random().toString(36).slice(2)}.db`);
    const rawDb = new Database(tmpDbPath);
    rawDb.pragma('foreign_keys = ON');
    const d1 = createD1Adapter(rawDb);

    await ensureD1Schema(d1, true, { COMMUNITY_PRESET: 'generic-community' });

    const userRes = rawDb.prepare(`
      INSERT INTO users (name, email, role, waiver_status)
      VALUES ('Waiver Tester', 'waiver.t48@example.org', 'player', 'none')
    `).run();
    const userId = Number(userRes.lastInsertRowid);
    const rawToken = 't48-session-token-' + crypto.randomBytes(16).toString('hex');
    const hashedToken = `sha256:${sha256HexSync(rawToken)}`;
    rawDb.prepare(`
      INSERT INTO sessions (id, user_id, expires_at)
      VALUES (?, ?, datetime('now', '+7 days'))
    `).run(hashedToken, userId);
    const userCookie = `baseball_session=${rawToken}`;

    const baseEnv = {
      DB: d1,
      BASEBALL_DB: d1,
      NODE_ENV: 'test',
      COMMUNITY_PRESET: 'generic-community',
      COMMUNITY_NAME: 'Oakridge Sandlot',
      SESSION_SECRET: 'session-secret-v1',
      WAIVER_SIGNING_SECRET: 'isolated-waiver-secret-v1',
      WAIVER_RETENTION_YEARS: '5'
    };

    try {
      await t.test('1. 18+ / legal guardian attestation is required on POST /api/waiver/sign and present in waiver.html/waiver.js', async () => {
        const missingAgeRes = await honoApp.fetch(new Request('http://127.0.0.1/api/waiver/sign', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: 'http://127.0.0.1',
            Cookie: userCookie
          },
          body: JSON.stringify({
            printed_name: 'Waiver Tester',
            signed_date: '2026-11-16',
            signature_type: 'drawn',
            signature_data: SAMPLE_PNG_SIG,
            electronic_consent: true
          })
        }), baseEnv);
        assert.equal(missingAgeRes.status, 400, 'Missing age_attestation must be rejected with 400');

        const falseAgeRes = await honoApp.fetch(new Request('http://127.0.0.1/api/waiver/sign', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: 'http://127.0.0.1',
            Cookie: userCookie
          },
          body: JSON.stringify({
            printed_name: 'Waiver Tester',
            signed_date: '2026-11-16',
            signature_type: 'drawn',
            signature_data: SAMPLE_PNG_SIG,
            age_attestation: false,
            electronic_consent: true
          })
        }), baseEnv);
        assert.equal(falseAgeRes.status, 400, 'age_attestation: false must be rejected with 400');

        const countAfterReject = rawDb.prepare('SELECT COUNT(*) AS c FROM waivers WHERE user_id = ?').get(userId).c;
        assert.equal(countAfterReject, 0, 'Rejected submissions must not insert waiver rows');

        const waiverHtml = fs.readFileSync(path.join(rootDir, 'public', 'waiver.html'), 'utf8');
        assert.ok(waiverHtml.includes('id="waiver-age-attestation"'), 'waiver.html must include #waiver-age-attestation checkbox');
        assert.ok(waiverHtml.includes('data-i18n="waiver.age_attestation_label"'), 'waiver.html must expose i18n label for 18+ attestation');

        const waiverJs = fs.readFileSync(path.join(rootDir, 'public', 'js', 'waiver.js'), 'utf8');
        assert.ok(waiverJs.includes('waiver-age-attestation'), 'waiver.js must read and validate #waiver-age-attestation');
        assert.ok(waiverJs.includes('age_attestation'), 'waiver.js must send age_attestation in signWaiver payload');
        assert.equal(waiverJs.includes('?.'), false, 'waiver.js must not use optional chaining');
        assert.equal(waiverJs.includes('??'), false, 'waiver.js must not use nullish coalescing');
      });

      await t.test('2. Archived GDrive HTML and certificate HTML omit raw signer_ip & user_agent while retaining 30d D1 telemetry and retention_until', async () => {
        const directHtml = renderSignedWaiverCertificateHtml({
          certificate_id: 'WVR-20261116-DIRECT',
          printed_name: 'Waiver Tester',
          email: 'waiver.t48@example.org',
          signed_date: '2026-11-16',
          signed_at: '2026-11-16T12:00:00.000Z',
          document_version: 'community-waiver-v1',
          waiver_text_sha256: 'a'.repeat(64),
          document_sha256: 'b'.repeat(64),
          provenance_seal: 'c'.repeat(64),
          signer_ip: '203.0.113.77',
          user_agent: 'CustomSecretAgent/9.9',
          signature_data: SAMPLE_PNG_SIG
        }, true, true, baseEnv);

        assert.equal(directHtml.includes('203.0.113.77'), false, 'Certificate HTML must never render signer_ip');
        assert.equal(directHtml.includes('CustomSecretAgent/9.9'), false, 'Certificate HTML must never render user_agent');
        assert.ok(directHtml.includes('Redacted (30-day anti-fraud window)'), 'Certificate HTML must display redacted 30-day window notice');

        const uploadedPayloads = [];
        const originalFetch = global.fetch;
        global.fetch = async (url, init) => {
          const urlStr = String(url);
          if (urlStr.includes('oauth2.googleapis.com/token')) {
            return new Response(JSON.stringify({ access_token: 'mock-gdrive-token', expires_in: 3600 }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' }
            });
          }
          if (urlStr.includes('googleapis.com/upload/drive/v3/files')) {
            return new Response(JSON.stringify({ id: 'gdrive-waiver-file-123' }), {
              status: 200,
              headers: {
                'Content-Type': 'application/json',
                Location: 'https://upload.example.org/gdrive-session-123'
              }
            });
          }
          if (urlStr === 'https://upload.example.org/gdrive-session-123') {
            const rawBody = init && init.body;
            const decoded = rawBody instanceof Uint8Array
              ? new TextDecoder().decode(rawBody)
              : String(rawBody || '');
            uploadedPayloads.push(decoded);
            return new Response(JSON.stringify({ id: 'gdrive-waiver-file-123' }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' }
            });
          }
          return originalFetch(url, init);
        };

        let certId;
        try {
          const gdriveEnv = {
            ...baseEnv,
            GDRIVE_CLIENT_ID: 'client-id',
            GDRIVE_CLIENT_SECRET: 'client-secret',
            GDRIVE_REFRESH_TOKEN: 'refresh-token',
            GDRIVE_FOLDER_ID: 'folder-id'
          };
          const signRes = await honoApp.fetch(new Request('http://127.0.0.1/api/waiver/sign', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Origin: 'http://127.0.0.1',
              Cookie: userCookie,
              'CF-Connecting-IP': '198.51.100.42',
              'User-Agent': 'TelemetrySpyBrowser/4.2'
            },
            body: JSON.stringify({
              printed_name: 'Waiver Tester',
              signed_date: '2026-11-16',
              signature_type: 'drawn',
              signature_data: SAMPLE_PNG_SIG,
              age_attestation: true,
              electronic_consent: true
            })
          }), gdriveEnv);
          assert.equal(signRes.status, 201);
          const signJson = await signRes.json();
          certId = signJson.waiver.certificate_id;
        } finally {
          global.fetch = originalFetch;
        }

        assert.equal(uploadedPayloads.length, 1, 'Google Drive archival upload must have been invoked');
        const archivedHtml = uploadedPayloads[0];
        assert.equal(archivedHtml.includes('198.51.100.42'), false, 'Archived GDrive HTML must contain zero raw signer_ip');
        assert.equal(archivedHtml.includes('TelemetrySpyBrowser/4.2'), false, 'Archived GDrive HTML must contain zero raw user_agent');
        assert.ok(archivedHtml.includes('Redacted (30-day anti-fraud window)'), 'Archived GDrive HTML must state redacted 30-day window');

        const storedRow = rawDb.prepare('SELECT * FROM waivers WHERE certificate_id = ?').get(certId);
        assert.equal(storedRow.signer_ip, '198.51.100.42', 'D1 keeps signer_ip during 30-day anti-fraud window');
        assert.equal(storedRow.user_agent, 'TelemetrySpyBrowser/4.2', 'D1 keeps user_agent during 30-day anti-fraud window');
        assert.equal(storedRow.signer_ip_scrubbed_at, null);
        assert.ok(storedRow.retention_until, 'D1 waiver row must store retention_until');
        const signedYear = new Date(storedRow.signed_at).getUTCFullYear();
        const retentionYear = new Date(storedRow.retention_until).getUTCFullYear();
        assert.equal(retentionYear - signedYear, 5, 'retention_until must respect WAIVER_RETENTION_YEARS=5');

        const certHtmlRes = await honoApp.fetch(
          new Request(`http://127.0.0.1/api/waiver/certificate/${certId}?format=html`, {
            headers: { Cookie: userCookie }
          }),
          baseEnv
        );
        assert.equal(certHtmlRes.status, 200);
        const certHtml = await certHtmlRes.text();
        assert.equal(certHtml.includes('198.51.100.42'), false, 'Owner HTML certificate view must not expose signer_ip');
        assert.equal(certHtml.includes('TelemetrySpyBrowser/4.2'), false, 'Owner HTML certificate view must not expose user_agent');
      });

      await t.test('3. Isolated WAIVER_SIGNING_SECRET survives SESSION_SECRET rotation while verifying legacy SESSION_SECRET-sealed waivers', async () => {
        // A. Sign under WAIVER_SIGNING_SECRET + SESSION_SECRET=v1, then rotate SESSION_SECRET=v2
        const signRes = await honoApp.fetch(new Request('http://127.0.0.1/api/waiver/sign', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: 'http://127.0.0.1',
            Cookie: userCookie
          },
          body: JSON.stringify({
            printed_name: 'Isolated Secret Signer',
            signed_date: '2026-11-16',
            signature_type: 'typed',
            signature_data: SAMPLE_PNG_SIG,
            attested_18_plus: true,
            electronic_consent: true
          })
        }), baseEnv);
        assert.equal(signRes.status, 201);
        const certId = (await signRes.json()).waiver.certificate_id;

        // Rotate SESSION_SECRET and verify seal still passes
        const rotatedSessionEnv = { ...baseEnv, SESSION_SECRET: 'completely-different-session-secret-v2' };
        const certResAfterRotation = await honoApp.fetch(
          new Request(`http://127.0.0.1/api/waiver/certificate/${certId}`, { headers: { Cookie: userCookie } }),
          rotatedSessionEnv
        );
        assert.equal(certResAfterRotation.status, 200);
        const certJson = await certResAfterRotation.json();
        assert.equal(certJson.waiver.integrity_verified, true, 'Waiver sealed with WAIVER_SIGNING_SECRET must survive SESSION_SECRET rotation');

        // Also ensure rotating WAIVER_SIGNING_SECRET alone fails verification for that waiver
        const wrongWaiverSecretEnv = { ...baseEnv, WAIVER_SIGNING_SECRET: 'wrong-waiver-secret' };
        const wrongSecretRes = await honoApp.fetch(
          new Request(`http://127.0.0.1/api/waiver/certificate/${certId}`, { headers: { Cookie: userCookie } }),
          wrongWaiverSecretEnv
        );
        assert.equal((await wrongSecretRes.json()).waiver.integrity_verified, false, 'Mismatched WAIVER_SIGNING_SECRET must fail verification');

        // B. Signing when WAIVER_SIGNING_SECRET is unset must NOT use SESSION_SECRET (uses DB waiver_provenance_secret)
        const noWaiverSecretEnv1 = { ...baseEnv, WAIVER_SIGNING_SECRET: '', SESSION_SECRET: 'session-alpha' };
        const noWaiverSecretEnv2 = { ...baseEnv, WAIVER_SIGNING_SECRET: '', SESSION_SECRET: 'session-beta' };
        const dbSeal1 = await computeProvenanceSeal(noWaiverSecretEnv1, 'WVR-TEST:abc', d1);
        const dbSeal2 = await computeProvenanceSeal(noWaiverSecretEnv2, 'WVR-TEST:abc', d1);
        assert.equal(dbSeal1, dbSeal2, 'When WAIVER_SIGNING_SECRET is unset, provenance seal must not depend on SESSION_SECRET');

        // C. Legacy waiver pre-cutover sealed with HMAC(SESSION_SECRET, 'pickup-waiver-provenance-key-v1') verifies via GET /certificate/:id
        const spec = getWaiverSpec(baseEnv);
        const waiverTextSha = sha256HexSync(spec.officialText);
        const sigSha = sha256HexSync(SAMPLE_PNG_SIG);
        const legacyPayload = buildCanonicalWaiverPayload({
          document_version: spec.documentVersion,
          waiver_text_sha256: waiverTextSha,
          email: 'waiver.t48@example.org',
          printed_name: 'Legacy Signer',
          signed_date: '2025-05-01',
          signature_type: 'drawn',
          signature_sha256: sigSha,
          electronic_consent: true
        });
        const legacyDocSha = sha256HexSync(legacyPayload);
        const legacyCertId = 'WVR-20250501-LEGACY01';
        const legacyDerivedKey = hmacSha256HexSync(baseEnv.SESSION_SECRET, 'pickup-waiver-provenance-key-v1');
        const legacySeal = hmacSha256HexSync(legacyDerivedKey, `${legacyCertId}:${legacyDocSha}`);

        rawDb.prepare(`
          INSERT INTO waivers (
            certificate_id, user_id, email, printed_name, signed_date,
            signature_type, signature_data, document_version,
            waiver_text_sha256, document_sha256, provenance_seal,
            signer_ip, user_agent, electronic_consent, signed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
        `).run(
          legacyCertId,
          userId,
          'waiver.t48@example.org',
          'Legacy Signer',
          '2025-05-01',
          'drawn',
          SAMPLE_PNG_SIG,
          spec.documentVersion,
          waiverTextSha,
          legacyDocSha,
          legacySeal,
          '192.0.2.55',
          'LegacyBrowser/1.0',
          '2025-05-01T10:00:00.000Z'
        );

        assert.equal(
          await verifyWaiverProvenanceSeal(baseEnv, `${legacyCertId}:${legacyDocSha}`, legacySeal, d1),
          true,
          'verifyWaiverProvenanceSeal must validate legacy SESSION_SECRET-derived seals'
        );

        const legacyCertRes = await honoApp.fetch(
          new Request(`http://127.0.0.1/api/waiver/certificate/${legacyCertId}`, { headers: { Cookie: userCookie } }),
          baseEnv
        );
        assert.equal(legacyCertRes.status, 200);
        const legacyCertJson = await legacyCertRes.json();
        assert.equal(legacyCertJson.waiver.integrity_verified, true, 'GET /certificate/:id must verify legacy SESSION_SECRET-sealed waiver');
      });

      await t.test('4. scrubExpiredWaiverTelemetry(db) scrubs >30d IP/UA idempotently without invalidating integrity_verified', async () => {
        const spec = getWaiverSpec(baseEnv);
        const waiverTextSha = sha256HexSync(spec.officialText);
        const sigSha = sha256HexSync(SAMPLE_PNG_SIG);

        // Create >30 day old waiver sealed with WAIVER_SIGNING_SECRET
        const oldSignedIso = new Date(Date.now() - 31 * 86400 * 1000).toISOString();
        const oldDateStr = oldSignedIso.slice(0, 10);
        const oldPayload = buildCanonicalWaiverPayload({
          document_version: spec.documentVersion,
          waiver_text_sha256: waiverTextSha,
          email: 'waiver.t48@example.org',
          printed_name: 'Old Telemetry Signer',
          signed_date: oldDateStr,
          signature_type: 'drawn',
          signature_sha256: sigSha,
          electronic_consent: true
        });
        const oldDocSha = sha256HexSync(oldPayload);
        const oldCertId = 'WVR-OLD-31D-001';
        const oldSeal = await computeProvenanceSeal(baseEnv, `${oldCertId}:${oldDocSha}`, d1);

        rawDb.prepare(`
          INSERT INTO waivers (
            certificate_id, user_id, email, printed_name, signed_date,
            signature_type, signature_data, document_version,
            waiver_text_sha256, document_sha256, provenance_seal,
            signer_ip, user_agent, electronic_consent, signed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
        `).run(
          oldCertId, userId, 'waiver.t48@example.org', 'Old Telemetry Signer', oldDateStr,
          'drawn', SAMPLE_PNG_SIG, spec.documentVersion,
          waiverTextSha, oldDocSha, oldSeal,
          '198.51.100.88', 'OldScrubTarget/1.0', oldSignedIso
        );

        // Create <=30 day recent waiver (5 days old)
        const recentSignedIso = new Date(Date.now() - 5 * 86400 * 1000).toISOString();
        const recentDateStr = recentSignedIso.slice(0, 10);
        const recentPayload = buildCanonicalWaiverPayload({
          document_version: spec.documentVersion,
          waiver_text_sha256: waiverTextSha,
          email: 'waiver.t48@example.org',
          printed_name: 'Recent Telemetry Signer',
          signed_date: recentDateStr,
          signature_type: 'drawn',
          signature_sha256: sigSha,
          electronic_consent: true
        });
        const recentDocSha = sha256HexSync(recentPayload);
        const recentCertId = 'WVR-RECENT-5D-001';
        const recentSeal = await computeProvenanceSeal(baseEnv, `${recentCertId}:${recentDocSha}`, d1);

        rawDb.prepare(`
          INSERT INTO waivers (
            certificate_id, user_id, email, printed_name, signed_date,
            signature_type, signature_data, document_version,
            waiver_text_sha256, document_sha256, provenance_seal,
            signer_ip, user_agent, electronic_consent, signed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
        `).run(
          recentCertId, userId, 'waiver.t48@example.org', 'Recent Telemetry Signer', recentDateStr,
          'drawn', SAMPLE_PNG_SIG, spec.documentVersion,
          waiverTextSha, recentDocSha, recentSeal,
          '198.51.100.99', 'RecentKept/2.0', recentSignedIso
        );

        // Scrub old 31d row (legacy 2025 row was already opportunistically scrubbed during GET /certificate/:id)
        const firstScrubCount = await scrubExpiredWaiverTelemetry(d1);
        assert.equal(firstScrubCount, 1, `Expected 1 aged waiver row scrubbed, got ${firstScrubCount}`);

        const oldAfter = rawDb.prepare('SELECT signer_ip, user_agent, signer_ip_scrubbed_at, document_sha256, provenance_seal FROM waivers WHERE certificate_id = ?').get(oldCertId);
        assert.equal(oldAfter.signer_ip, null, 'Old waiver (>30d) signer_ip must be scrubbed to NULL');
        assert.equal(oldAfter.user_agent, null, 'Old waiver (>30d) user_agent must be scrubbed to NULL');
        assert.ok(oldAfter.signer_ip_scrubbed_at, 'Old waiver (>30d) signer_ip_scrubbed_at must be stamped');
        assert.equal(oldAfter.document_sha256, oldDocSha, 'document_sha256 must remain untouched');
        assert.equal(oldAfter.provenance_seal, oldSeal, 'provenance_seal must remain untouched');

        const recentAfter = rawDb.prepare('SELECT signer_ip, user_agent, signer_ip_scrubbed_at FROM waivers WHERE certificate_id = ?').get(recentCertId);
        assert.equal(recentAfter.signer_ip, '198.51.100.99', 'Recent waiver (<30d) signer_ip must be preserved');
        assert.equal(recentAfter.user_agent, 'RecentKept/2.0', 'Recent waiver (<30d) user_agent must be preserved');
        assert.equal(recentAfter.signer_ip_scrubbed_at, null, 'Recent waiver (<30d) must not be marked scrubbed');

        // Idempotent second call
        const secondScrubCount = await scrubExpiredWaiverTelemetry(d1);
        assert.equal(secondScrubCount, 0, 'Second scrub call must be idempotent (0 changes)');

        // Cryptographic verification remains intact after scrub
        const oldCertRes = await honoApp.fetch(
          new Request(`http://127.0.0.1/api/waiver/certificate/${oldCertId}`, { headers: { Cookie: userCookie } }),
          baseEnv
        );
        assert.equal(oldCertRes.status, 200);
        assert.equal((await oldCertRes.json()).waiver.integrity_verified, true, 'Scrubbed waiver must remain integrity_verified: true');

        // Opportunistic scrub triggered via waiver route
        const oppCertId = 'WVR-OPP-40D-001';
        const oppSignedIso = new Date(Date.now() - 40 * 86400 * 1000).toISOString();
        rawDb.prepare(`
          INSERT INTO waivers (
            certificate_id, user_id, email, printed_name, signed_date,
            signature_type, signature_data, document_version,
            waiver_text_sha256, document_sha256, provenance_seal,
            signer_ip, user_agent, electronic_consent, signed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
        `).run(
          oppCertId, userId, 'waiver.t48@example.org', 'Opp Signer', oppSignedIso.slice(0, 10),
          'drawn', SAMPLE_PNG_SIG, spec.documentVersion,
          waiverTextSha, oldDocSha, oldSeal,
          '203.0.113.200', 'OppBrowser/1.0', oppSignedIso
        );

        const oppSignRes = await honoApp.fetch(new Request('http://127.0.0.1/api/waiver/sign', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1', Cookie: userCookie },
          body: JSON.stringify({
            printed_name: 'Opportunistic Trigger',
            signed_date: '2026-11-16',
            signature_type: 'drawn',
            signature_data: SAMPLE_PNG_SIG,
            age_attestation: true,
            electronic_consent: true
          })
        }), baseEnv);
        assert.equal(oppSignRes.status, 201);

        const oppAfter = rawDb.prepare('SELECT signer_ip, user_agent, signer_ip_scrubbed_at FROM waivers WHERE certificate_id = ?').get(oppCertId);
        assert.equal(oppAfter.signer_ip, null, 'Opportunistic scrub on /api/waiver/sign must clear aged signer_ip');
        assert.equal(oppAfter.user_agent, null, 'Opportunistic scrub on /api/waiver/sign must clear aged user_agent');
        assert.ok(oppAfter.signer_ip_scrubbed_at, 'Opportunistic scrub must set signer_ip_scrubbed_at');
      });
    } finally {
      rawDb.close();
      try { fs.unlinkSync(tmpDbPath); } catch (e) { /* ignore */ }
      try { fs.unlinkSync(tmpDbPath + '-wal'); } catch (e) { /* ignore */ }
      try { fs.unlinkSync(tmpDbPath + '-shm'); } catch (e) { /* ignore */ }
    }
  });
}

module.exports = registerWaiverTelemetryTests;

if (require.main === module) {
  registerWaiverTelemetryTests();
}
