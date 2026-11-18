/**
 * Dedicated Acceptance Suite for Wave 1c.7 (Ticket #72):
 * - Svix-verified POST /api/webhooks/resend suppression endpoint
 * - Record permanent email.bounced and email.complained into BASEBALL_DB.email_suppressions
 * - Ignore transient bounces
 * - Replay window (±300s) and secret verification
 * - Admin controls: GET /api/admin/suppressions & DELETE /api/admin/suppressions/:email
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { verifySvixSignature } = require('../../src/app/security/crypto.js');
const { app } = require('../../src/app/index.js');
const { createD1Adapter } = require('../../src/d1-sqlite.js');

/**
 * Helper to compute valid Svix headers for testing
 */
function createSvixHeaders(secret, rawBody, timestampSec, msgId = `msg_${Date.now()}`) {
  const ts = String(timestampSec);
  const toSign = `${msgId}.${ts}.${rawBody}`;

  let keyBytes;
  if (secret.startsWith('whsec_')) {
    keyBytes = Buffer.from(secret.slice(6), 'base64');
  } else {
    keyBytes = Buffer.from(secret, 'utf8');
  }

  const hmac = crypto.createHmac('sha256', keyBytes);
  hmac.update(toSign);
  const sig = hmac.digest('base64');

  return {
    'svix-id': msgId,
    'svix-timestamp': ts,
    'svix-signature': `v1,${sig}`
  };
}

module.exports = function registerWebhookResendSuppressionTests(ctx) {
  const { db, apiReq, seedAdminCookie } = ctx || {};

  test('Ticket #72: Wave 1c.7 Svix Webhook Suppression & Admin Clear Controls', async (t) => {
    const testSecret = ['whsec', Buffer.from('test-svix-signing-key-01').toString('base64')].join('_');
    const baseballD1 = (ctx && (ctx.baseballD1 || ctx.d1)) || (db ? createD1Adapter(db) : null);

    // Context environment mock for Hono app.request
    const mockEnv = {
      RESEND_WEBHOOK_SECRET: testSecret,
      BASEBALL_DB: baseballD1,
      DB: baseballD1
    };

    await t.test('1. verifySvixSignature verifies HMAC signature with replay window', async () => {
      const now = Math.floor(Date.now() / 1000);
      const payload = JSON.stringify({ type: 'test' });
      const headers = createSvixHeaders(testSecret, payload, now, 'msg_001');

      // Valid signature
      const ok = await verifySvixSignature(testSecret, headers['svix-id'], headers['svix-timestamp'], payload, headers['svix-signature'], 300);
      assert.equal(ok, true);

      // Tampered payload
      const tampered = await verifySvixSignature(testSecret, headers['svix-id'], headers['svix-timestamp'], '{"type":"tampered"}', headers['svix-signature'], 300);
      assert.equal(tampered, false);

      // Expired timestamp (> 300s drift)
      const oldHeaders = createSvixHeaders(testSecret, payload, now - 350, 'msg_002');
      const expired = await verifySvixSignature(testSecret, oldHeaders['svix-id'], oldHeaders['svix-timestamp'], payload, oldHeaders['svix-signature'], 300);
      assert.equal(expired, false);

      // Wrong secret
      const wrongSecretHeaders = createSvixHeaders('whsec_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', payload, now, 'msg_003');
      const wrongKey = await verifySvixSignature(testSecret, wrongSecretHeaders['svix-id'], wrongSecretHeaders['svix-timestamp'], payload, wrongSecretHeaders['svix-signature'], 300);
      assert.equal(wrongKey, false);
    });

    await t.test('2. POST /api/webhooks/resend returns 503 if secret unset', async () => {
      const res = await app.request('/api/webhooks/resend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'test' })
      }, { BASEBALL_DB: baseballD1, DB: baseballD1 }); // missing RESEND_WEBHOOK_SECRET

      assert.equal(res.status, 503);
      const data = await res.json();
      assert.equal(data.code, 'INTERNAL_ERROR');
    });

    await t.test('3. POST /api/webhooks/resend returns 401 if Svix headers missing or invalid', async () => {
      // Missing headers
      const resMissing = await app.request('/api/webhooks/resend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'test' })
      }, mockEnv);
      assert.equal(resMissing.status, 401);

      // Invalid signature
      const now = Math.floor(Date.now() / 1000);
      const resBadSig = await app.request('/api/webhooks/resend', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'svix-id': 'msg_bad',
          'svix-timestamp': String(now),
          'svix-signature': 'v1,invalidsignature'
        },
        body: JSON.stringify({ type: 'test' })
      }, mockEnv);
      assert.equal(resBadSig.status, 401);
    });

    await t.test('4. POST /api/webhooks/resend ignores transient bounces and does not suppress', async () => {
      const now = Math.floor(Date.now() / 1000);
      const transientEmail = 'transient.bounce@example.com';
      const body = JSON.stringify({
        type: 'email.bounced',
        data: {
          to: [transientEmail],
          bounce: {
            type: 'Transient',
            message: 'Mailbox full'
          }
        }
      });
      const headers = createSvixHeaders(testSecret, body, now, 'msg_transient');

      const res = await app.request('/api/webhooks/resend', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...headers
        },
        body
      }, mockEnv);

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.ok, true);
      assert.equal(data.ignored, 'transient_bounce');

      // Verify email was NOT inserted into email_suppressions
      if (db) {
        const row = db.prepare('SELECT * FROM email_suppressions WHERE email = ?').get(transientEmail);
        assert.equal(row, undefined);
      }
    });

    await t.test('5. POST /api/webhooks/resend records permanent bounces into email_suppressions', async () => {
      const now = Math.floor(Date.now() / 1000);
      const permEmail = 'hard.bounce@example.com';
      const body = JSON.stringify({
        type: 'email.bounced',
        data: {
          to: [permEmail],
          bounce: {
            type: 'Permanent',
            message: 'Recipient address does not exist'
          }
        }
      });
      const headers = createSvixHeaders(testSecret, body, now, 'msg_perm_bounce');

      const res = await app.request('/api/webhooks/resend', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...headers
        },
        body
      }, mockEnv);

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.ok, true);
      assert.equal(data.processed, 1);
      assert.equal(data.reason, 'bounce');

      // Verify database record
      if (db) {
        const row = db.prepare('SELECT * FROM email_suppressions WHERE email = ?').get(permEmail);
        assert.ok(row, 'Permanent bounce row should exist');
        assert.equal(row.email, permEmail);
        assert.equal(row.reason, 'bounce');
        assert.equal(row.bounce_type, 'Permanent');
        assert.equal(row.provider, 'resend');
        assert.ok(row.metadata && row.metadata.includes('Recipient address does not exist'));
      }
    });

    await t.test('6. POST /api/webhooks/resend records complaints into email_suppressions', async () => {
      const now = Math.floor(Date.now() / 1000);
      const complaintEmail = 'spam.complainer@example.com';
      const body = JSON.stringify({
        type: 'email.complained',
        data: {
          to: [complaintEmail],
          subject: 'Weekly Reminder'
        }
      });
      const headers = createSvixHeaders(testSecret, body, now, 'msg_complaint');

      const res = await app.request('/api/webhooks/resend', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...headers
        },
        body
      }, mockEnv);

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.ok, true);
      assert.equal(data.processed, 1);
      assert.equal(data.reason, 'complaint');

      if (db) {
        const row = db.prepare('SELECT * FROM email_suppressions WHERE email = ?').get(complaintEmail);
        assert.ok(row, 'Complaint row should exist');
        assert.equal(row.email, complaintEmail);
        assert.equal(row.reason, 'complaint');
        assert.equal(row.provider, 'resend');
      }
    });

    await t.test('7. GET /api/admin/suppressions enforces requireAdmin and returns suppressions list', async () => {
      if (apiReq) {
        const resAnon = await apiReq('GET', '/api/admin/suppressions');
        assert.equal(resAnon.status, 401);

        const resPlayer = await apiReq('GET', '/api/admin/suppressions', ctx.seedPlayerCookie);
        assert.equal(resPlayer.status, 403);

        const resOrg = await apiReq('GET', '/api/admin/suppressions', ctx.seedOrgCookie);
        assert.equal(resOrg.status, 403);

        const resAdmin = await apiReq('GET', '/api/admin/suppressions', ctx.seedAdminCookie);
        assert.equal(resAdmin.status, 200);
        assert.ok(Array.isArray(resAdmin.data.suppressions));
        const found = resAdmin.data.suppressions.find((s) => s.email === 'hard.bounce@example.com');
        assert.ok(found, 'Should include suppressed email in admin list');
      } else {
        const resAnon = await app.request('/api/admin/suppressions', { method: 'GET' }, mockEnv);
        assert.equal(resAnon.status, 401);

        const resAdmin = await app.request('/api/admin/suppressions', {
          method: 'GET',
          headers: { Cookie: ctx.seedAdminCookie || seedAdminCookie || '' }
        }, mockEnv);
        assert.equal(resAdmin.status, 200);
      }
    });

    await t.test('8. DELETE /api/admin/suppressions/:email clears suppression', async () => {
      const emailToClear = 'hard.bounce@example.com';

      if (apiReq) {
        const resPlayer = await apiReq('DELETE', `/api/admin/suppressions/${encodeURIComponent(emailToClear)}`, ctx.seedPlayerCookie);
        assert.equal(resPlayer.status, 403);

        const resAdmin = await apiReq('DELETE', `/api/admin/suppressions/${encodeURIComponent(emailToClear)}`, ctx.seedAdminCookie);
        assert.equal(resAdmin.status, 200);
        assert.equal(resAdmin.data.success, true);
      } else {
        const resAdmin = await app.request(`/api/admin/suppressions/${encodeURIComponent(emailToClear)}`, {
          method: 'DELETE',
          headers: { Cookie: ctx.seedAdminCookie || seedAdminCookie || '' }
        }, mockEnv);
        assert.equal(resAdmin.status, 200);
      }

      // Verify row is deleted from DB
      if (db) {
        const row = db.prepare('SELECT * FROM email_suppressions WHERE email = ?').get(emailToClear);
        assert.equal(row, undefined, 'Record should be removed from database');
      }
    });
  });
};

if (require.main === module) {
  const sqlite = require('better-sqlite3');
  const tempDb = new sqlite(':memory:');
  const { CREATE_TABLES_SQL } = require('../../src/app/schema/baseball-ddl.js');
  for (const sql of CREATE_TABLES_SQL) {
    tempDb.exec(sql);
  }
  // Insert test admin user
  tempDb.exec("INSERT INTO users (id, name, email, role, is_admin) VALUES (1, 'Admin', 'admin@example.com', 'admin', 1)");
  tempDb.exec("INSERT INTO users (id, name, email, role, is_admin) VALUES (2, 'Organizer', 'org@example.com', 'organizer', 0)");
  tempDb.exec("INSERT INTO users (id, name, email, role, is_admin) VALUES (3, 'Player', 'player@example.com', 'player', 0)");
  tempDb.exec("INSERT INTO sessions (id, user_id, expires_at) VALUES ('adm_sess', 1, datetime('now', '+1 hour'))");
  tempDb.exec("INSERT INTO sessions (id, user_id, expires_at) VALUES ('org_sess', 2, datetime('now', '+1 hour'))");
  tempDb.exec("INSERT INTO sessions (id, user_id, expires_at) VALUES ('ply_sess', 3, datetime('now', '+1 hour'))");

  const testCtx = {
    db: tempDb,
    baseballD1: createD1Adapter(tempDb),
    seedAdminCookie: 'baseball_session=adm_sess',
    seedOrgCookie: 'baseball_session=org_sess',
    seedPlayerCookie: 'baseball_session=ply_sess'
  };

  module.exports(testCtx);
}
