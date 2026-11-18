const test = require('node:test');
const assert = require('node:assert/strict');
const { createWorkerdHarness } = require('./helpers');

test('GET /api/auth/me/history is private and counts only attended past active events', async (t) => {
  const harness = await createWorkerdHarness({});
  t.after(async () => { await harness.dispose(); });

  const anon = await harness.apiFetch('/api/auth/me/history');
  assert.equal(anon.status, 401);

  const { cookie, userId } = await harness.seedUserSession({ name: 'Hist Player', email: 'hist@example.org' });
  const other = await harness.seedUserSession({ name: 'Other', email: 'hist-other@example.org' });
  const db = await harness.mf.getD1Database('BASEBALL_DB');
  const uid = userId || (await db.prepare('SELECT id FROM users WHERE email = ?').bind('hist@example.org').first()).id;
  const oid = other.userId || (await db.prepare('SELECT id FROM users WHERE email = ?').bind('hist-other@example.org').first()).id;
  const past = new Date(Date.now() - 86400000).toISOString();
  const future = new Date(Date.now() + 86400000).toISOString();
  async function mkEvent(title, date, status) {
    const r = await db.prepare('INSERT INTO events (title, location, event_date, status) VALUES (?, ?, ?, ?)')
      .bind(title, 'Park', date, status).run();
    return r.meta.last_row_id;
  }
  async function rsvp(eid, id, email, status) {
    const r = await db.prepare('INSERT INTO attendees (event_id, user_id, name, email, status) VALUES (?, ?, ?, ?, ?)')
      .bind(eid, id, 'N', email, status).run();
    return r.meta.last_row_id;
  }
  const e1 = await mkEvent('Past Active', past, 'active');
  const e2 = await mkEvent('Past Cancelled', past, 'cancelled');
  const e3 = await mkEvent('Past Waitlist', past, 'active');
  const e4 = await mkEvent('Future', future, 'active');
  const a1 = await rsvp(e1, uid, 'hist@example.org', 'attending');
  await rsvp(e2, uid, 'hist@example.org', 'attending');
  await rsvp(e3, uid, 'hist@example.org', 'waitlist');
  await rsvp(e4, uid, 'hist@example.org', 'attending');
  await rsvp(e1, oid, 'hist-other@example.org', 'attending');
  const d = await db.prepare('INSERT INTO event_duties (event_id, title) VALUES (?, ?)').bind(e1, 'Bring Bases').run();
  await db.prepare('INSERT INTO duty_assignments (duty_id, attendee_id) VALUES (?, ?)').bind(d.meta.last_row_id, a1).run();

  const res = await harness.apiFetch('/api/auth/me/history', { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  assert.equal(res.json.events_attended, 1);
  assert.equal(res.json.tasks_completed, 1);
  assert.deepEqual(res.json.milestones.map((m) => m.threshold), [1, 1]);
  assert.match(res.json.milestones[0].label, /First Event/);
});
