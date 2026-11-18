/**
 * Wave 2.9 (#56): preference enforcement, RFC 8058 unsubscribe, 80/100 quota, 24h auto_reminders.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createD1Adapter } = require('../../src/d1-sqlite.js');
const { checkQuota } = require('../../src/app/mailer/index.js');
const {
  signUnsubscribeToken, verifyUnsubscribeToken, filterByPreference, withUnsubscribeHeaders, REMINDER_LEAD_HOURS
} = require('../../src/app/mailer/preferences.js');
const { processUpcomingEventRemindersD1 } = require('../../src/app/routes/events/helpers.js');

module.exports = function registerMailerPreferencesTests(ctx) {
  const { apiReq, db } = ctx;
  const d1 = ctx.d1 || ctx.baseballD1 || createD1Adapter(db);

  test('Ticket #56: mailer preferences, unsubscribe, quota, 24h reminders', async (t) => {
    const env = { CRON_SECRET: 'pref-test-secret', MAIL_PROVIDER: 'mock' };

    await t.test('lead window constant is 24h', () => assert.equal(REMINDER_LEAD_HOURS, 24));

    await t.test('token verifies and rejects tampering', async () => {
      const tok = await signUnsubscribeToken(env, { pref: 'notify_event_reminders', userId: 5 });
      const ok = await verifyUnsubscribeToken(env, tok);
      assert.equal(ok.userId, 5);
      assert.equal(await verifyUnsubscribeToken(env, tok.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a'))), null);
      assert.equal(await verifyUnsubscribeToken({ CRON_SECRET: 'other' }, tok), null);
      const msg = await withUnsubscribeHeaders(env, 'https://x.org', { to: 'a@b.co' }, { pref: 'notify_community_updates', email: 'a@b.co' });
      assert.equal(msg.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
      assert.match(msg.headers['List-Unsubscribe'], /^<https:\/\/x\.org\/api\/notifications\/unsubscribe\?token=/);
    });

    await t.test('filterByPreference honors member prefs, visitor notify_emails, bans', async () => {
      const u = await d1.prepare("INSERT INTO users (email, name, notify_event_reminders) VALUES ('pm1@example.org','PM1',0)").run();
      const u2 = await d1.prepare("INSERT INTO users (email, name) VALUES ('pm2@example.org','PM2')").run();
      await d1.prepare("INSERT OR IGNORE INTO banned_emails (email) VALUES ('banned-pm@example.org')").run();
      const rows = [
        { user_id: u.meta.last_row_id, email: 'pm1@example.org' },
        { user_id: u2.meta.last_row_id, email: 'pm2@example.org' },
        { user_id: null, email: 'v1@example.org', notify_emails: 1 },
        { user_id: null, email: 'v0@example.org', notify_emails: 0 },
        { user_id: null, email: 'banned-pm@example.org', notify_emails: 1 }
      ];
      const out = await filterByPreference(d1, rows, 'notify_event_reminders');
      assert.deepEqual(out.map((r) => r.email), ['pm2@example.org', 'v1@example.org']);
    });

    await t.test('unsubscribe endpoint opts out and logs consent; tamper rejected', async () => {
      const u = await d1.prepare("INSERT INTO users (email, name) VALUES ('pm3@example.org','PM3')").run();
      const id = u.meta.last_row_id;
      const tok = await signUnsubscribeToken({ CRON_SECRET: process.env.CRON_SECRET || '' }, { pref: 'notify_event_reminders', userId: id });
      const bad = await apiReq('POST', '/api/notifications/unsubscribe?token=' + encodeURIComponent(tok + 'x'));
      assert.equal(bad.status, 400);
      const g = await apiReq('GET', '/api/notifications/unsubscribe?token=' + encodeURIComponent(tok));
      if (g.status === 200) {
        const row = await d1.prepare('SELECT notify_event_reminders AS v FROM users WHERE id = ?').bind(id).first();
        assert.equal(row.v, 0);
        const c = await d1.prepare("SELECT COUNT(*) AS n FROM consent_records WHERE user_id = ? AND status = 'withdrawn'").bind(id).first();
        assert.equal(c.n, 1);
      }
    });

    await t.test('80/100 reserve: reminders pause at 80, auth continues', async () => {
      const key = 'email_daily_count_' + new Date().toISOString().slice(0, 10);
      await d1.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)').bind(key, '80').run();
      const rem = await checkQuota(d1, { RESEND_API_KEY: 're_x' }, 1, 'reminder');
      assert.equal(rem.allowed, false);
      const upd = await checkQuota(d1, { RESEND_API_KEY: 're_x' }, 1, 'community_update');
      assert.equal(upd.allowed, false);
      const auth = await checkQuota(d1, { RESEND_API_KEY: 're_x' }, 1, 'auth');
      assert.equal(auth.allowed, true);
      await d1.prepare('DELETE FROM app_settings WHERE key = ?').bind(key).run();
    });

    await t.test('auto_reminders=0 skipped; waitlist excluded; 24h window', async () => {
      const soon = new Date(Date.now() + 20 * 3600 * 1000).toISOString();
      const far = new Date(Date.now() + 30 * 3600 * 1000).toISOString();
      const mk = async (title, date, auto) => (await d1.prepare("INSERT INTO events (title, location, event_date, max_players, status, auto_reminders) VALUES (?, 'F', ?, 20, 'active', ?)").bind(title, date, auto).run()).meta.last_row_id;
      const a = await mk('R-on', soon, 1);
      const b = await mk('R-off', soon, 0);
      const f = await mk('R-far', far, 1);
      for (const id of [a, b, f]) {
        await d1.prepare("INSERT INTO attendees (event_id, name, email, status, notify_emails) VALUES (?, 'A', ?, 'attending', 1)").bind(id, 'att' + id + '@example.org').run();
      }
      await d1.prepare("INSERT INTO attendees (event_id, name, email, status, notify_emails) VALUES (?, 'W', 'wl-pm@example.org', 'waitlist', 1)").bind(a).run();
      await processUpcomingEventRemindersD1(d1, env, 'https://x.org');
      const sent = async (id, status) => (await d1.prepare('SELECT COUNT(*) AS n FROM attendees WHERE event_id = ? AND status = ? AND reminder_sent_at IS NOT NULL').bind(id, status).first()).n;
      assert.equal(await sent(a, 'attending'), 1);
      assert.equal(await sent(a, 'waitlist'), 0);
      assert.equal(await sent(b, 'attending'), 0);
      assert.equal(await sent(f, 'attending'), 0);
    });
  });
};
