const test = require('node:test');
const assert = require('node:assert/strict');
const { createWorkerdHarness } = require('./helpers');

test('Workerd D1 Concurrency & Atomicity (Promise.all races)', async (t) => {
  const harness = await createWorkerdHarness();
  t.after(async () => {
    await harness.dispose();
  });

  await harness.ensureInitialized();
  const { cookie: orgCookie } = await harness.seedUserSession({
    name: 'Concurrency Organizer',
    email: 'conc-org@example.org',
    role: 'organizer'
  });

  await t.test('Final-spot Event RSVP race: Promise.all fills last spot without overbooking or double-demotion', async () => {
    const createRes = await harness.apiFetch('/api/events', {
      method: 'POST',
      headers: { Cookie: orgCookie },
      body: {
        title: 'Final Spot Race Event',
        location: 'Bushrod Park Field 1',
        event_date: new Date(Date.now() + 7 * 86400 * 1000).toISOString(),
        max_players: 3,
        use_default_duties: true
      }
    });
    assert.equal(createRes.status, 200);
    const eventId = createRes.json.eventId;

    // Fill 2 of 3 spots sequentially so exactly 1 spot remains
    for (let i = 1; i <= 2; i++) {
      const r = await harness.apiFetch(`/api/events/${eventId}/rsvp`, {
        method: 'POST',
        body: { name: `Seeded ${i}`, email: `seeded${i}@example.org`, status: 'attending' }
      });
      assert.equal(r.status, 200);
      assert.equal(r.json.status, 'attending');
    }

    // Fire 6 concurrent RSVPs competing for the 1 remaining spot
    const racers = await Promise.all(
      Array.from({ length: 6 }, (_, idx) =>
        harness.apiFetch(`/api/events/${eventId}/rsvp`, {
          method: 'POST',
          headers: { 'CF-Connecting-IP': `198.51.100.${10 + idx}` },
          body: { name: `Racer ${idx + 1}`, email: `racer${idx + 1}@example.org`, status: 'attending' }
        })
      )
    );

    for (const r of racers) {
      assert.equal(r.status, 200, `Expected 200, got ${r.status}: ${r.text}`);
    }

    const attendingCount = racers.filter((r) => r.json.status === 'attending').length;
    const waitlistCount = racers.filter((r) => r.json.status === 'waitlist').length;
    assert.equal(attendingCount, 1, `Exactly 1 racer must claim the final spot, got ${attendingCount}`);
    assert.equal(waitlistCount, 5, `Remaining 5 racers must be waitlisted, got ${waitlistCount}`);

    // Verify D1 ground truth
    const db = await harness.mf.getD1Database('BASEBALL_DB');
    const sumRow = await db.prepare(
      "SELECT COALESCE(SUM(players_count), 0) as total FROM attendees WHERE event_id = ? AND status = 'attending'"
    ).bind(eventId).first();
    const wlRow = await db.prepare(
      "SELECT COUNT(*) as cnt FROM attendees WHERE event_id = ? AND status = 'waitlist'"
    ).bind(eventId).first();
    assert.equal(sumRow.total, 3, 'D1 attending total must equal max_players (3)');
    assert.equal(wlRow.cnt, 5, 'D1 waitlist count must equal 5');
  });

  await t.test('Concurrent cancellation + waitlist promotion race promotes exact FIFO count without overbooking', async () => {
    const createRes = await harness.apiFetch('/api/events', {
      method: 'POST',
      headers: { Cookie: orgCookie },
      body: {
        title: 'Waitlist Promotion Race Event',
        location: 'Bushrod Park Field 1',
        event_date: new Date(Date.now() + 8 * 86400 * 1000).toISOString(),
        max_players: 2
      }
    });
    assert.equal(createRes.status, 200);
    const eventId = createRes.json.eventId;

    const p1 = await harness.apiFetch(`/api/events/${eventId}/rsvp`, {
      method: 'POST',
      body: { name: 'Attending 1', email: 'att1@example.org', status: 'attending' }
    });
    const p2 = await harness.apiFetch(`/api/events/${eventId}/rsvp`, {
      method: 'POST',
      body: { name: 'Attending 2', email: 'att2@example.org', status: 'attending' }
    });
    assert.equal(p1.json.status, 'attending');
    assert.equal(p2.json.status, 'attending');

    // Waitlist 3 players in order
    for (let i = 1; i <= 3; i++) {
      const w = await harness.apiFetch(`/api/events/${eventId}/rsvp`, {
        method: 'POST',
        body: { name: `Waitlist ${i}`, email: `wl${i}@example.org`, status: 'attending' }
      });
      assert.equal(w.json.status, 'waitlist');
    }

    // Cancel both attending players concurrently
    const [c1, c2] = await Promise.all([
      harness.apiFetch(`/api/events/${eventId}/rsvp`, {
        method: 'POST',
        headers: { 'CF-Connecting-IP': '198.51.100.31' },
        body: {
          name: 'Attending 1',
          email: 'att1@example.org',
          management_token: p1.json.managementToken,
          status: 'declined'
        }
      }),
      harness.apiFetch(`/api/events/${eventId}/rsvp`, {
        method: 'POST',
        headers: { 'CF-Connecting-IP': '198.51.100.32' },
        body: {
          name: 'Attending 2',
          email: 'att2@example.org',
          management_token: p2.json.managementToken,
          status: 'declined'
        }
      })
    ]);
    assert.equal(c1.status, 200);
    assert.equal(c2.status, 200);

    const db = await harness.mf.getD1Database('BASEBALL_DB');
    const { results: rows } = await db.prepare(
      'SELECT name, status FROM attendees WHERE event_id = ? ORDER BY id ASC'
    ).bind(eventId).all();

    const attending = rows.filter((r) => r.status === 'attending').map((r) => r.name);
    const waitlisted = rows.filter((r) => r.status === 'waitlist').map((r) => r.name);
    assert.deepEqual(attending, ['Waitlist 1', 'Waitlist 2'], 'First 2 waitlisted players must be promoted');
    assert.deepEqual(waitlisted, ['Waitlist 3'], '3rd waitlisted player must remain on waitlist');
  });

  await t.test('Volunteer task claim contention: Promise.all honors slots_needed = 1 atomically', async () => {
    const createRes = await harness.apiFetch('/api/events', {
      method: 'POST',
      headers: { Cookie: orgCookie },
      body: {
        title: 'Task Contention Race Event',
        location: 'Bushrod Park Field 1',
        event_date: new Date(Date.now() + 5 * 86400 * 1000).toISOString(),
        max_players: 20,
        custom_duties: [
          { title: 'Bases', description: 'Bring 3 bases', slots_needed: 1 },
          { title: 'Water / Food', description: 'Bring water', slots_needed: 2 }
        ]
      }
    });
    assert.equal(createRes.status, 200);
    const eventId = createRes.json.eventId;

    const detail = await harness.apiFetch(`/api/events/${eventId}`, { headers: { Cookie: orgCookie } });
    const basesDuty = detail.json.duties.find((d) => d.title === 'Bases');
    assert.ok(basesDuty);

    // 6 concurrent RSVPs all trying to claim the single 1-slot "Bases" task
    const claims = await Promise.all(
      Array.from({ length: 6 }, (_, idx) =>
        harness.apiFetch(`/api/events/${eventId}/rsvp`, {
          method: 'POST',
          headers: { 'CF-Connecting-IP': `198.51.100.${50 + idx}` },
          body: {
            name: `Volunteer ${idx + 1}`,
            email: `vol${idx + 1}@example.org`,
            status: 'attending',
            duty_ids: [basesDuty.id]
          }
        })
      )
    );

    for (const r of claims) {
      assert.equal(r.status, 200, `Volunteer RSVP failed with ${r.status}: ${r.text}`);
    }

    const db = await harness.mf.getD1Database('BASEBALL_DB');
    const assignCount = await db.prepare(
      'SELECT COUNT(*) as cnt FROM duty_assignments WHERE duty_id = ?'
    ).bind(basesDuty.id).first();
    assert.equal(assignCount.cnt, 1, `1-slot volunteer task must have exactly 1 assignment, got ${assignCount.cnt}`);
  });

  await t.test('BP slot contention: Promise.all for explicit slot #1 and auto-assigned slots never 500s or double-books', async () => {
    const createRes = await harness.apiFetch('/api/events', {
      method: 'POST',
      headers: { Cookie: orgCookie },
      body: {
        title: 'BP Slot Race Event',
        location: 'Bushrod Park Field 1',
        event_date: new Date(Date.now() + 9 * 86400 * 1000).toISOString(),
        max_players: 20
      }
    });
    assert.equal(createRes.status, 200);
    const eventId = createRes.json.eventId;

    const sessions = await Promise.all(
      Array.from({ length: 5 }, (_, idx) =>
        harness.seedUserSession({
          name: `BP Batter ${idx + 1}`,
          email: `bp-batter-${idx + 1}@example.org`,
          role: 'player'
        })
      )
    );

    // Part A: 5 concurrent explicit requests for slot_number: 1
    const explicitRaces = await Promise.all(
      sessions.map((s, idx) =>
        harness.apiFetch(`/api/events/${eventId}/bp-order`, {
          method: 'POST',
          headers: {
            Cookie: s.cookie,
            'CF-Connecting-IP': `198.51.100.${80 + idx}`
          },
          body: { slot_number: 1, notes: `Race ${idx + 1}` }
        })
      )
    );

    for (const r of explicitRaces) {
      assert.notEqual(r.status, 500, `Explicit BP slot race must never return HTTP 500: ${r.text}`);
    }
    const winners = explicitRaces.filter((r) => r.status === 200);
    const losers = explicitRaces.filter((r) => r.status === 400 || r.status === 409);
    assert.equal(winners.length, 1, `Exactly 1 player must win BP slot #1, got ${winners.length}`);
    assert.equal(losers.length, 4, `Other 4 players must receive 400/409 conflict, got ${losers.length}`);

    // Part B: 4 remaining players concurrently auto-assign next open BP slot (no slot_number)
    const remainingSessions = [];
    for (let i = 0; i < sessions.length; i++) {
      if (explicitRaces[i].status !== 200) remainingSessions.push(sessions[i]);
    }
    const autoRaces = await Promise.all(
      remainingSessions.map((s, idx) =>
        harness.apiFetch(`/api/events/${eventId}/bp-order`, {
          method: 'POST',
          headers: {
            Cookie: s.cookie,
            'CF-Connecting-IP': `198.51.100.${100 + idx}`
          },
          body: { notes: `Auto ${idx + 1}` }
        })
      )
    );

    for (const r of autoRaces) {
      assert.equal(r.status, 200, `Auto-assign BP signup should succeed cleanly without 500/conflict, got ${r.status}: ${r.text}`);
    }

    const db = await harness.mf.getD1Database('BASEBALL_DB');
    const { results: bpRows } = await db.prepare(
      'SELECT id, slot_number, player_name FROM batting_practice_signups WHERE event_id = ? ORDER BY slot_number ASC'
    ).bind(eventId).all();
    assert.equal(bpRows.length, 5, 'All 5 batters must end up with distinct BP slots');
    assert.deepEqual(bpRows.map((r) => r.slot_number), [1, 2, 3, 4, 5]);

    // Part C: Two batters concurrently PUT-move to the same open slot #10 -> 1 wins (200), 1 gets 400/409 (never 500)
    const { results: fullBpRows } = await db.prepare(
      'SELECT id, user_id, slot_number FROM batting_practice_signups WHERE event_id = ? ORDER BY slot_number ASC'
    ).bind(eventId).all();
    const cookieByUserId = new Map(sessions.map((s) => [s.userId, s.cookie]));
    const [m1, m2] = await Promise.all([
      harness.apiFetch(`/api/events/${eventId}/bp-order/${fullBpRows[0].id}`, {
        method: 'PUT',
        headers: { Cookie: cookieByUserId.get(fullBpRows[0].user_id) },
        body: { slot_number: 10 }
      }),
      harness.apiFetch(`/api/events/${eventId}/bp-order/${fullBpRows[1].id}`, {
        method: 'PUT',
        headers: { Cookie: cookieByUserId.get(fullBpRows[1].user_id) },
        body: { slot_number: 10 }
      })
    ]);
    assert.notEqual(m1.status, 500);
    assert.notEqual(m2.status, 500);
    assert.equal([m1, m2].filter((r) => r.status === 200).length, 1, 'Exactly 1 concurrent PUT move must win slot #10');
    assert.equal([m1, m2].filter((r) => r.status === 400 || r.status === 409).length, 1, 'Loser of concurrent PUT move must get 400/409');
  });
});
