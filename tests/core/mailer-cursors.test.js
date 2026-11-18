/**
 * Dedicated Acceptance Suite for Wave 1c.6 (Ticket #69):
 * - Unified MAIL_PROVIDER adapter (resend batch, brevo, mock)
 * - Local recipient pre-validation & email_suppressions filtering
 * - 429 daily_quota_exceeded & opt-in Brevo spillover
 * - Per-RSVP cursors (reminder_sent_at, last_notice_key, last_notice_sent_at)
 * - POST /api/events/:id/notifications/resume (requireOrganizer)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveMailProvider,
  isValidRecipientEmail,
  sendSingle,
  sendBatch
} = require('../../src/app/mailer/index.js');
const {
  sendRemindersForEventD1,
  notifyConfirmedAttendees
} = require('../../src/app/routes/events/helpers.js');
const { sendRainoutEmail } = require('../../src/app/mailer.js');
const { createD1Adapter } = require('../../src/d1-sqlite.js');

module.exports = function registerMailerCursorsTests(ctx) {
  const { apiReq, db } = ctx;
  const d1 = ctx.d1 || (ctx.baseballD1) || createD1Adapter(db);

  test('Ticket #69: Wave 1c.6 Unified MAIL_PROVIDER & Per-RSVP Cursors', async (t) => {
    const origFetch = global.fetch;
    const seedOrgCookie = ctx.seedOrgCookie;

    t.afterEach(() => {
      global.fetch = origFetch;
    });

    await t.test('1. resolveMailProvider selects configured or detected provider', () => {
      assert.equal(resolveMailProvider({ MAIL_PROVIDER: 'resend' }), 'resend');
      assert.equal(resolveMailProvider({ MAIL_PROVIDER: 'brevo' }), 'brevo');
      assert.equal(resolveMailProvider({ MAIL_PROVIDER: 'mock' }), 'mock');
      assert.equal(resolveMailProvider({ RESEND_API_KEY: 're_123' }), 'resend');
      assert.equal(resolveMailProvider({ BREVO_API_KEY: 'xkeysib-123' }), 'brevo');
      assert.equal(resolveMailProvider({}), 'mock');
    });

    await t.test('2. isValidRecipientEmail pre-validates addresses locally and rejects placeholders', () => {
      assert.equal(isValidRecipientEmail('valid.user@example.com'), true);
      assert.equal(isValidRecipientEmail('player+1@gmail.com'), true);
      assert.equal(isValidRecipientEmail(''), false);
      assert.equal(isValidRecipientEmail('invalid-email'), false);
      assert.equal(isValidRecipientEmail('guest_no_email_123@guest.pickupbaseball.internal'), false);
      assert.equal(isValidRecipientEmail('someone@noemail.invalid'), false);
      assert.equal(isValidRecipientEmail('user@test.invalid'), false);
    });

    await t.test('3. Suppression filtering and malformed address rejection in sendBatch', async () => {
      await d1.prepare("INSERT OR REPLACE INTO email_suppressions (email, reason, bounce_type) VALUES ('bounced@example.org', 'hard_bounce', 'Permanent')").run();

      const messages = [
        { to: 'valid1@example.org', subject: 'Test 1', text: 'Hello 1', html: '<p>1</p>' },
        { to: 'bounced@example.org', subject: 'Test 2', text: 'Hello 2', html: '<p>2</p>' },
        { to: 'malformed-email', subject: 'Test 3', text: 'Hello 3', html: '<p>3</p>' },
        { to: 'valid2@example.org', subject: 'Test 4', text: 'Hello 4', html: '<p>4</p>' }
      ];

      const env = { MAIL_PROVIDER: 'mock' };
      const res = await sendBatch(env, d1, messages, { priority: 'reminder' });

      assert.equal(res.sent.length, 2, 'Only the 2 valid unsuppressed emails should be sent');
      assert.deepEqual(res.skippedSuppressed, ['bounced@example.org']);
      assert.equal(res.failed.length, 1);
      assert.equal(res.failed[0].to, 'malformed-email');
    });

    await t.test('4. Resend batch chunking into <= 100 messages and 429 short retry', async () => {
      let callCount = 0;
      const dispatchedBatches = [];

      global.fetch = async (url, opts) => {
        callCount++;
        if (callCount === 1) {
          // Return short 429 on first try with Retry-After: 0.05
          return new Response(JSON.stringify({ message: 'Rate limit' }), {
            status: 429,
            headers: { 'Retry-After': '0.05', 'Content-Type': 'application/json' }
          });
        }
        const body = JSON.parse(opts.body);
        dispatchedBatches.push(body);
        return new Response(JSON.stringify({ data: body.map((_, i) => ({ id: `resend-${callCount}-${i}` })) }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      };

      const messages = [];
      for (let i = 0; i < 150; i++) {
        messages.push({
          to: `batchuser${i}@example.org`,
          subject: `Notice ${i}`,
          text: `Body ${i}`,
          html: `<p>${i}</p>`
        });
      }

      const env = { RESEND_API_KEY: 're_test_key' };
      const res = await sendBatch(env, null, messages);

      assert.equal(res.sent.length, 150);
      assert.equal(dispatchedBatches.length, 2, 'Should chunk 150 messages into 2 batches');
      assert.equal(dispatchedBatches[0].length, 100);
      assert.equal(dispatchedBatches[1].length, 50);
    });

    await t.test('5. 429 daily_quota_exceeded on pure Resend halts cleanly with quotaPaused: true', async () => {
      global.fetch = async () => {
        return new Response(JSON.stringify({ name: 'daily_quota_exceeded', message: 'Quota exceeded' }), {
          status: 429,
          headers: { 'Retry-After': '60', 'Content-Type': 'application/json' }
        });
      };

      const env = { RESEND_API_KEY: 're_test_key' }; // No BREVO_API_KEY
      const messages = [
        { to: 'pureuser@example.org', subject: 'Notice 1', text: 'Body 1', html: '<p>1</p>' }
      ];

      const res = await sendBatch(env, null, messages);
      assert.equal(res.quotaPaused, true);
      assert.equal(res.sent.length, 0);

      const singleRes = await sendSingle(env, null, messages[0]);
      assert.equal(singleRes.ok, false);
      assert.equal(singleRes.quotaPaused, true);
    });

    await t.test('6. 429 daily_quota_exceeded spills over to Brevo when BREVO_API_KEY is configured', async () => {
      const resendCalls = [];
      const brevoCalls = [];

      global.fetch = async (url, opts) => {
        const u = String(url);
        if (u.includes('resend.com')) {
          resendCalls.push(opts);
          return new Response(JSON.stringify({ name: 'daily_quota_exceeded', message: 'Quota exceeded' }), {
            status: 429,
            headers: { 'Retry-After': '60', 'Content-Type': 'application/json' }
          });
        }
        if (u.includes('brevo.com')) {
          brevoCalls.push(JSON.parse(opts.body));
          return new Response(JSON.stringify({ messageIds: ['brevo-id-1', 'brevo-id-2'] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          });
        }
        return origFetch(url, opts);
      };

      const env = {
        RESEND_API_KEY: 're_test_key',
        BREVO_API_KEY: 'xkeysib-brevo-test-key'
      };

      const messages = [
        { to: 'spill1@example.org', subject: 'Notice 1', text: 'Body 1', html: '<p>1</p>' },
        { to: 'spill2@example.org', subject: 'Notice 2', text: 'Body 2', html: '<p>2</p>' }
      ];

      const batchRes = await sendBatch(env, null, messages);
      assert.equal(resendCalls.length, 1, 'Attempted Resend first');
      assert.equal(brevoCalls.length, 1, 'Spilled over to Brevo');
      assert.equal(batchRes.sent.length, 2);
      assert.equal(batchRes.providerUsed, 'brevo');
    });

    await t.test('7. notifyConfirmedAttendees stamps notice_key and resume route continues idempotently', async () => {
      const origin = 'https://www.pickupbaseballfoundation.org';

      const evIns = await d1.prepare(
        "INSERT INTO events (title, location, event_date, max_players, status, invite_version) VALUES (?, ?, ?, 20, 'rainout', 3)"
      ).bind('Notice Key Game', 'Bushrod Park Field 1', new Date().toISOString()).run();
      const eventId = evIns.meta.last_row_id;
      const eventRow = await d1.prepare('SELECT * FROM events WHERE id = ?').bind(eventId).first();

      await d1.batch([
        d1.prepare("INSERT INTO attendees (event_id, name, email, status, notify_emails) VALUES (?, 'Att 1', 'notice1@example.org', 'attending', 1)").bind(eventId),
        d1.prepare("INSERT INTO attendees (event_id, name, email, status, notify_emails) VALUES (?, 'Att 2', 'notice2@example.org', 'attending', 1)").bind(eventId)
      ]);

      const mockContext = {
        env: { DB: d1, MAIL_PROVIDER: 'mock' },
        req: { url: `${origin}/api/events/${eventId}/rainout` }
      };

      const res1 = await notifyConfirmedAttendees(mockContext, eventRow, 'Field flooded', sendRainoutEmail, {
        actionType: 'rainout'
      });
      assert.equal(res1.sent, 2);
      assert.equal(res1.remaining, 0);

      const atts = await d1.prepare('SELECT email, last_notice_key, last_notice_sent_at FROM attendees WHERE event_id = ?').bind(eventId).all();
      for (const a of atts.results) {
        assert.equal(a.last_notice_key, 'rainout:3');
        assert.ok(a.last_notice_sent_at);
      }

      // Resume route POST /api/events/:id/notifications/resume
      const resumeRes = await apiReq('POST', `/api/events/${eventId}/notifications/resume`, seedOrgCookie, {
        actionType: 'rainout'
      });
      assert.equal(resumeRes.status, 200);
      assert.equal(resumeRes.data.sent, 0, 'No remaining unsent attendees for this notice_key');
      assert.equal(resumeRes.data.remaining, 0);
    });

    await t.test('8. sendRemindersForEventD1 tracks reminder_sent_at and event_date update resets cursors', async () => {
      const origin = 'https://www.pickupbaseballfoundation.org';
      const initialDate = new Date(Date.now() + 24 * 3600 * 1000).toISOString();

      const evIns = await d1.prepare(
        "INSERT INTO events (title, location, event_date, max_players, status, reminder_sent) VALUES (?, ?, ?, 20, 'active', 0)"
      ).bind('Reminder Progression Game', 'Bushrod Park Field 1', initialDate).run();
      const eventId = evIns.meta.last_row_id;
      let eventRow = await d1.prepare('SELECT * FROM events WHERE id = ?').bind(eventId).first();

      await d1.batch([
        d1.prepare("INSERT INTO attendees (event_id, name, email, status, notify_emails) VALUES (?, 'Att 1', 'prog1@example.org', 'attending', 1)").bind(eventId),
        d1.prepare("INSERT INTO attendees (event_id, name, email, status, notify_emails) VALUES (?, 'Att 2', 'prog2@example.org', 'attending', 1)").bind(eventId)
      ]);

      const env = { DB: d1, MAIL_PROVIDER: 'mock' };

      // Pass 1 with limit = 1
      const pass1 = await sendRemindersForEventD1(d1, env, origin, eventRow, { limit: 1 });
      assert.equal(pass1.sent, 1);
      assert.equal(pass1.remaining, 1);

      let evCheck = await d1.prepare('SELECT reminder_sent FROM events WHERE id = ?').bind(eventId).first();
      assert.equal(evCheck.reminder_sent, 0);

      // Pass 2 with limit = 100
      const pass2 = await sendRemindersForEventD1(d1, env, origin, eventRow, { limit: 100 });
      assert.equal(pass2.sent, 1);
      assert.equal(pass2.remaining, 0);

      evCheck = await d1.prepare('SELECT reminder_sent FROM events WHERE id = ?').bind(eventId).first();
      assert.equal(evCheck.reminder_sent, 1);

      const atts = await d1.prepare('SELECT reminder_sent_at FROM attendees WHERE event_id = ?').bind(eventId).all();
      for (const a of atts.results) {
        assert.ok(a.reminder_sent_at);
      }

      // Updating event_date via PUT /api/events/:id should reset reminder_sent and reminder_sent_at
      const newDate = new Date(Date.now() + 48 * 3600 * 1000).toISOString();
      const updateRes = await apiReq('PUT', `/api/events/${eventId}`, seedOrgCookie, {
        event_date: newDate
      });
      assert.equal(updateRes.status, 200);

      evCheck = await d1.prepare('SELECT reminder_sent FROM events WHERE id = ?').bind(eventId).first();
      assert.equal(evCheck.reminder_sent, 0, 'reminder_sent must reset to 0 when event_date changes');

      const attsReset = await d1.prepare('SELECT reminder_sent_at FROM attendees WHERE event_id = ?').bind(eventId).all();
      for (const a of attsReset.results) {
        assert.equal(a.reminder_sent_at, null, 'attendees.reminder_sent_at must reset to NULL when event_date changes');
      }
    });
  });
};
