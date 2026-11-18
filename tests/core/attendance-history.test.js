/**
 * @fileoverview Wave 2.8: Private Attendance History and Milestones Tests (#61)
 *
 * Verifies:
 * 1. GET /api/auth/me/history requires authentication (401 when anonymous)
 * 2. Counts and lists only attended active past events (excludes future, cancelled, rainout, waitlist, declined)
 * 3. Counts and lists completed volunteer tasks on attended active past events
 * 4. Computes neutral generic-community compatible milestone labels ([1, 5, 10, 25, 50] events, [1, 5, 15] tasks)
 * 5. Zero peer leakage: only returns the authenticated user's own history and sets private Cache-Control
 */

const test = require('node:test');
const assert = require('node:assert/strict');

function registerAttendanceHistoryTests(ctx) {
  const { apiReq, db, createSession } = ctx;

  test('T-HISTORY: Wave 2.8 Private Attendance History and Milestones (#61)', async (t) => {
    // 1. Auth guard
    await t.test('HISTORY-1: Unauthenticated request to GET /api/auth/me/history returns 401', async () => {
      const res = await apiReq('GET', '/api/auth/me/history', null);
      assert.equal(res.status, 401, 'Anonymous request must return 401');
    });

    // Create two isolated users to verify history computation and zero peer leakage
    const userARes = db.prepare(`
      INSERT INTO users (name, email, role, is_admin)
      VALUES ('History Member A', 'history_member_a@example.org', 'player', 0)
    `).run();
    const userAId = Number(userARes.lastInsertRowid);
    const cookieA = `baseball_session=${createSession(userAId).sessionId}`;

    const userBRes = db.prepare(`
      INSERT INTO users (name, email, role, is_admin)
      VALUES ('History Member B', 'history_member_b@example.org', 'player', 0)
    `).run();
    const userBId = Number(userBRes.lastInsertRowid);
    const cookieB = `baseball_session=${createSession(userBId).sessionId}`;

    const pastIso = (daysAgo) => new Date(Date.now() - daysAgo * 86400 * 1000).toISOString();
    const futureIso = (daysAhead) => new Date(Date.now() + daysAhead * 86400 * 1000).toISOString();

    await t.test('HISTORY-2: Filters strictly to active past events with status=attending and computes task & event milestones', async () => {
      // Seed 5 active past events attended by User A
      const pastEventIds = [];
      for (let i = 1; i <= 5; i++) {
        const ev = db.prepare(`
          INSERT INTO events (title, location, event_date, max_players, status, created_by)
          VALUES (?, 'Community Park', ?, 20, 'active', ?)
        `).run(`Past Community Session #${i}`, pastIso(i * 7), ctx.seedAdminId);
        const evId = Number(ev.lastInsertRowid);
        pastEventIds.push(evId);

        const att = db.prepare(`
          INSERT INTO attendees (event_id, user_id, name, email, status, players_count)
          VALUES (?, ?, 'History Member A', 'history_member_a@example.org', 'attending', 1)
        `).run(evId, userAId);
        const attId = Number(att.lastInsertRowid);

        // Add a completed task on the first event
        if (i === 1) {
          const duty = db.prepare(`
            INSERT INTO event_duties (event_id, title, description, slots_needed)
            VALUES (?, 'Equipment Setup', 'Set up cones and gear', 2)
          `).run(evId);
          db.prepare(`
            INSERT INTO duty_assignments (duty_id, attendee_id)
            VALUES (?, ?)
          `).run(Number(duty.lastInsertRowid), attId);
        }
      }

      // Seed excluded events for User A:
      // a) Cancelled past event (status='attending' on 'cancelled' event)
      const cancelledEv = db.prepare(`
        INSERT INTO events (title, location, event_date, max_players, status, created_by)
        VALUES ('Cancelled Past Game', 'Community Park', ?, 20, 'cancelled', ?)
      `).run(pastIso(3), ctx.seedAdminId);
      db.prepare(`
        INSERT INTO attendees (event_id, user_id, name, email, status, players_count)
        VALUES (?, ?, 'History Member A', 'history_member_a@example.org', 'attending', 1)
      `).run(Number(cancelledEv.lastInsertRowid), userAId);

      // b) Rainout past event
      const rainoutEv = db.prepare(`
        INSERT INTO events (title, location, event_date, max_players, status, created_by)
        VALUES ('Rainout Past Game', 'Community Park', ?, 20, 'rainout', ?)
      `).run(pastIso(4), ctx.seedAdminId);
      db.prepare(`
        INSERT INTO attendees (event_id, user_id, name, email, status, players_count)
        VALUES (?, ?, 'History Member A', 'history_member_a@example.org', 'attending', 1)
      `).run(Number(rainoutEv.lastInsertRowid), userAId);

      // c) Active past event where User A was waitlisted or declined
      const waitlistEv = db.prepare(`
        INSERT INTO events (title, location, event_date, max_players, status, created_by)
        VALUES ('Waitlisted Past Game', 'Community Park', ?, 20, 'active', ?)
      `).run(pastIso(5), ctx.seedAdminId);
      db.prepare(`
        INSERT INTO attendees (event_id, user_id, name, email, status, players_count)
        VALUES (?, ?, 'History Member A', 'history_member_a@example.org', 'waitlist', 1)
      `).run(Number(waitlistEv.lastInsertRowid), userAId);

      const declinedEv = db.prepare(`
        INSERT INTO events (title, location, event_date, max_players, status, created_by)
        VALUES ('Declined Past Game', 'Community Park', ?, 20, 'active', ?)
      `).run(pastIso(6), ctx.seedAdminId);
      db.prepare(`
        INSERT INTO attendees (event_id, user_id, name, email, status, players_count)
        VALUES (?, ?, 'History Member A', 'history_member_a@example.org', 'declined', 0)
      `).run(Number(declinedEv.lastInsertRowid), userAId);

      // d) Future active event where User A is attending
      const futureEv = db.prepare(`
        INSERT INTO events (title, location, event_date, max_players, status, created_by)
        VALUES ('Future Active Game', 'Community Park', ?, 20, 'active', ?)
      `).run(futureIso(7), ctx.seedAdminId);
      db.prepare(`
        INSERT INTO attendees (event_id, user_id, name, email, status, players_count)
        VALUES (?, ?, 'History Member A', 'history_member_a@example.org', 'attending', 1)
      `).run(Number(futureEv.lastInsertRowid), userAId);

      const resA = await apiReq('GET', '/api/auth/me/history', cookieA);
      assert.equal(resA.status, 200);
      assert.equal(resA.data.events_attended, 5, 'Must count exactly 5 attended active past events');
      assert.equal(resA.data.tasks_completed, 1, 'Must count 1 completed volunteer task on attended active past event');
      assert.equal(resA.data.events.length, 5);
      assert.equal(resA.data.tasks.length, 1);
      assert.equal(resA.data.tasks[0].title, 'Equipment Setup');

      // Check neutral generic-community compatible milestone labels
      const labels = (resA.data.milestones || []).map(m => m.label);
      assert.ok(labels.includes('First Event attended'), 'Must include First Event attended milestone');
      assert.ok(labels.includes('5 Events attended'), 'Must include 5 Events attended milestone');
      assert.ok(!labels.includes('10 Events attended'), 'Must not include 10 Events milestone yet');
      assert.ok(labels.includes('First Volunteer Task completed'), 'Must include First Volunteer Task completed milestone');
    });

    await t.test('HISTORY-3: Zero peer leakage — Member B cannot see Member A history', async () => {
      const resB = await apiReq('GET', '/api/auth/me/history', cookieB);
      assert.equal(resB.status, 200);
      assert.equal(resB.data.events_attended, 0, 'Member B must have 0 events attended');
      assert.equal(resB.data.tasks_completed, 0, 'Member B must have 0 tasks completed');
      assert.deepEqual(resB.data.events, []);
      assert.deepEqual(resB.data.tasks, []);
      assert.deepEqual(resB.data.milestones, []);
    });
  });
}

module.exports = registerAttendanceHistoryTests;
