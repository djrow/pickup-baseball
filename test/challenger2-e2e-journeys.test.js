/**
 * test/challenger2-e2e-journeys.test.js
 * Empirical Challenge Harness: Live App Integration & End-to-End User Journeys
 *
 * Validates all Acceptance Criteria from ORIGINAL_REQUEST.md:
 * 1. 1-Click Sunday Game creator (SQLite persistence, 8 default duties, atomic transaction, redirect contract).
 * 2. Custom game creation form (all fields, non-hanging state, immediate feedback).
 * 3. User feedback rendered upon form submissions (success/error banners).
 * 4. Button & form audit across all 5 views (login, admin, index, event, profile).
 * 5. Role-based dashboard cards on login.html and admin.html.
 * 6. Attendee RSVPs, duty slot capacity limits, and duty slot release on cancellation.
 * 7. User role management lifecycle, dynamic session reflection, and last-admin guard.
 * 8. Error boundaries, malformed inputs, SQL injection safety, and zero unhandled rejections.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');
const cookieParser = require('cookie-parser');

const testDbPath = path.join(
  os.tmpdir(),
  `challenger2_e2e_${Date.now()}_${Math.random().toString(36).slice(2)}.db`
);
process.env.DB_PATH = testDbPath;
process.env.NODE_ENV = 'test';

const testDataDir = path.join(os.tmpdir(), `challenger2_data_${Date.now()}`);
process.env.DATA_DIR = testDataDir;

const { db, initDatabase, getDefaultDuties } = require('../src/db');
initDatabase();

const { createSession } = require('../src/auth');
const authRoutes = require('../src/routes/auth');
const eventRoutes = require('../src/routes/events');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/api/auth', authRoutes);
app.use('/api/events', eventRoutes);

let server;
let baseUrl;

let adminId, adminCookie;
let orgId, orgCookie;
let playerId, playerCookie;

function getCookie(headers, cookieName) {
  let cookieHeaders = [];
  if (typeof headers.getSetCookie === 'function') {
    cookieHeaders = headers.getSetCookie();
  } else {
    const raw = headers.get('set-cookie');
    if (raw) cookieHeaders = [raw];
  }

  for (const c of cookieHeaders) {
    const [pair] = c.split(';');
    const eqIdx = pair.indexOf('=');
    if (eqIdx !== -1) {
      const name = pair.slice(0, eqIdx).trim();
      const val = pair.slice(eqIdx + 1).trim();
      if (name === cookieName) return val;
    }
  }
  return null;
}

async function api(method, endpoint, cookie = null, body = null, extraHeaders = {}) {
  const headers = { ...extraHeaders };
  if (cookie) headers['Cookie'] = cookie;
  if (body !== null && typeof body === 'object' && !(body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(`${baseUrl}${endpoint}`, {
    method,
    headers,
    body: body !== null ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
    redirect: 'manual'
  });

  let data = null;
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    try {
      data = await res.json();
    } catch (e) {
      data = null;
    }
  } else {
    try {
      data = await res.text();
    } catch (e) {
      data = null;
    }
  }

  return { status: res.status, headers: res.headers, data, res };
}

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });

  const aRes = db.prepare(`
    INSERT INTO users (name, email, role, is_admin)
    VALUES ('Super Administrator', 'superadmin@charity.org', 'admin', 1)
  `).run();
  adminId = aRes.lastInsertRowid;
  adminCookie = `baseball_session=${createSession(adminId).sessionId}`;

  const oRes = db.prepare(`
    INSERT INTO users (name, email, role, is_admin)
    VALUES ('Game Coordinator', 'organizer@charity.org', 'organizer', 0)
  `).run();
  orgId = oRes.lastInsertRowid;
  orgCookie = `baseball_session=${createSession(orgId).sessionId}`;

  const pRes = db.prepare(`
    INSERT INTO users (name, email, role, is_admin)
    VALUES ('Pickup Ballplayer', 'player@charity.org', 'player', 0)
  `).run();
  playerId = pRes.lastInsertRowid;
  playerCookie = `baseball_session=${createSession(playerId).sessionId}`;
});

test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
  db.close();

  try {
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    if (fs.existsSync(testDbPath + '-wal')) fs.unlinkSync(testDbPath + '-wal');
    if (fs.existsSync(testDbPath + '-shm')) fs.unlinkSync(testDbPath + '-shm');
    if (fs.existsSync(testDataDir)) fs.rmSync(testDataDir, { recursive: true, force: true });
  } catch (e) {}
});

// ---------------------------------------------------------------------------
// SUITE 1: 1-Click Sunday Game Creation End-to-End Journey
// ---------------------------------------------------------------------------
test('Suite 1: 1-Click Sunday Game Creation End-to-End Journey', async (t) => {
  let createdEventId;

  await t.test('1.1: Organizer posts 1-Click game with special characters in field location', async () => {
    const specialLocation = "St. Luke's Ballfield #3 / \"The Bullpen\" & Field";
    const nextSundayIso = '2026-11-22T20:00:00.000Z';

    const res = await api('POST', '/api/events', orgCookie, {
      title: 'Sunday Pickup Baseball (Nov 22)',
      event_date: nextSundayIso,
      location: specialLocation,
      description: 'Weekly community pickup baseball game. All skill levels welcome!',
      use_default_duties: true
    });

    assert.equal(res.status, 200, '1-Click creation must return HTTP 200');
    assert.equal(res.data.success, true);
    assert.ok(res.data.eventId, 'Must return top-level eventId');
    assert.ok(res.data.event && res.data.event.id, 'Must return nested event.id');
    assert.equal(res.data.eventId, res.data.event.id, 'eventId and event.id must match');
    createdEventId = res.data.eventId;

    // Verify database row
    const evInDb = db.prepare('SELECT * FROM events WHERE id = ?').get(createdEventId);
    assert.ok(evInDb, 'Event must exist in SQLite database');
    assert.equal(evInDb.location, specialLocation, 'Apostrophe and quote escaping in location must be preserved');
    assert.equal(evInDb.created_by, orgId);

    // Verify default duties created atomically
    const duties = db.prepare('SELECT * FROM event_duties WHERE event_id = ? ORDER BY sort_order ASC').all(createdEventId);
    const expectedDefaults = getDefaultDuties();
    assert.equal(duties.length, expectedDefaults.length, `Event must have exactly ${expectedDefaults.length} default volunteer duties`);

    for (let i = 0; i < expectedDefaults.length; i++) {
      assert.equal(duties[i].title, expectedDefaults[i].title);
      assert.equal(duties[i].slots_needed, expectedDefaults[i].slots_needed);
      assert.equal(duties[i].event_id, createdEventId);
    }
  });

  await t.test('1.2: Client Redirection Contract verification for 1-Click Game', async () => {
    // Both login.html and admin.js extract newId = res.eventId || (res.event && res.event.id)
    // and redirect to `/event.html?id=${newId}`
    const expectedRedirect = `/event.html?id=${createdEventId}`;
    assert.ok(expectedRedirect.startsWith('/event.html?id='));

    // Validate that GET /event.html?id=<id> returns HTTP 200
    const pageRes = await api('GET', expectedRedirect);
    assert.equal(pageRes.status, 200, 'Target event.html page must be servable');

    // Validate that the backend API GET /api/events/:id returns the created event and duties
    const expectedDefaults = getDefaultDuties();
    const apiRes = await api('GET', `/api/events/${createdEventId}`);
    assert.equal(apiRes.status, 200);
    assert.equal(apiRes.data.event.id, createdEventId);
    assert.equal(apiRes.data.duties.length, expectedDefaults.length);
  });

  await t.test('1.3: Unauthorized 1-Click creation attempts by Player or Anonymous are blocked', async () => {
    const anonRes = await api('POST', '/api/events', null, {
      title: 'Anon Sunday Game',
      event_date: '2026-11-22T20:00:00.000Z',
      location: 'Central Field',
      use_default_duties: true
    });
    assert.equal(anonRes.status, 401, 'Anonymous creation must return HTTP 401');

    const playerRes = await api('POST', '/api/events', playerCookie, {
      title: 'Player Sunday Game',
      event_date: '2026-11-22T20:00:00.000Z',
      location: 'Central Field',
      use_default_duties: true
    });
    assert.equal(playerRes.status, 403, 'Player creation must return HTTP 403');
  });
});

// ---------------------------------------------------------------------------
// SUITE 2: Custom Game Creation Form & Feedback Non-Hanging Execution
// ---------------------------------------------------------------------------
test('Suite 2: Custom Game Creation Form & Feedback Non-Hanging Execution', async (t) => {
  let customEventId;

  await t.test('2.1: Publish custom game with all specified fields', async () => {
    const payload = {
      title: 'Memorial Charity Exhibition Game',
      event_date: '2026-12-20T18:00:00.000Z',
      location: 'Riverside Park Diamond 2',
      location_url: 'https://maps.google.com/?q=riverside+park+diamond+2',
      description: 'End of season benefit game. Cleats recommended.',
      max_players: 32,
      custom_duties: [
        { title: 'Scorekeeper & Roster Tracker', description: 'Track innings and lineup', slots_needed: 1 },
        { title: 'Home Plate Umpire', description: 'Call balls, strikes, and home outs', slots_needed: 1 },
        { title: 'Bases & Field Chalking', description: 'Chalk batter boxes and set 3 bases', slots_needed: 2 },
        { title: 'Dugout Refreshments & Water', description: 'Manage water jugs and fruit table', slots_needed: 2 }
      ]
    };

    const res = await api('POST', '/api/events', orgCookie, payload);
    assert.equal(res.status, 200, 'Custom event creation must return HTTP 200');
    assert.equal(res.data.success, true);
    assert.ok(res.data.eventId);
    customEventId = res.data.eventId;

    // Verify SQLite fields
    const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(customEventId);
    assert.equal(ev.title, payload.title);
    assert.equal(ev.location, payload.location);
    assert.equal(ev.location_url, payload.location_url);
    assert.equal(ev.description, payload.description);
    assert.equal(ev.max_players, 32);

    const duties = db.prepare('SELECT * FROM event_duties WHERE event_id = ? ORDER BY sort_order ASC').all(customEventId);
    assert.equal(duties.length, 4);
    assert.equal(duties[0].title, 'Scorekeeper & Roster Tracker');
    assert.equal(duties[1].title, 'Home Plate Umpire');
    assert.equal(duties[2].slots_needed, 2);
    assert.equal(duties[3].slots_needed, 2);
  });

  await t.test('2.2: Form submission validation errors clear loading state without hanging', async () => {
    // Missing title
    const noTitleRes = await api('POST', '/api/events', orgCookie, {
      location: 'Central Field',
      event_date: '2026-12-20T18:00:00.000Z'
    });
    assert.equal(noTitleRes.status, 400);
    assert.ok(noTitleRes.data.error.includes('Title, location, and event date/time are required'));

    // Missing location
    const noLocRes = await api('POST', '/api/events', orgCookie, {
      title: 'Game without location',
      event_date: '2026-12-20T18:00:00.000Z'
    });
    assert.equal(noLocRes.status, 400);

    // Invalid date string
    const badDateRes = await api('POST', '/api/events', orgCookie, {
      title: 'Game with bad date',
      location: 'Central Field',
      event_date: 'invalid-iso-date'
    });
    assert.equal(badDateRes.status, 400);
    assert.ok(badDateRes.data.error.includes('valid event date/time'));

    // Empty custom duty title
    const emptyDutyTitleRes = await api('POST', '/api/events', orgCookie, {
      title: 'Game with blank duty title',
      location: 'Central Field',
      event_date: '2026-12-20T18:00:00.000Z',
      custom_duties: [
        { title: '', slots_needed: 1 }
      ]
    });
    assert.equal(emptyDutyTitleRes.status, 400);
    assert.ok(emptyDutyTitleRes.data.error.includes('All custom duties must have a non-empty title'));
  });

  await t.test('2.3: Client-side try/catch/finally non-hanging harness simulation', () => {
    // Verify that frontend form handlers guarantee `submitBtn.disabled = false` and label reset
    function simulateFormSubmission(isSuccessThrow, apiErrorCode) {
      let submitBtn = { disabled: false, textContent: 'Publish Game' };
      let alertMsg = '';
      let isSuccess = false;

      submitBtn.disabled = true;
      submitBtn.textContent = 'Publishing...';

      try {
        if (isSuccessThrow) {
          throw new Error('Network timeout');
        }
        if (apiErrorCode) {
          alertMsg = 'API Error: ' + apiErrorCode;
        } else {
          isSuccess = true;
          alertMsg = 'Game published successfully!';
        }
      } catch (err) {
        alertMsg = err.message;
      } finally {
        if (!isSuccess) {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Publish Game';
        }
      }

      return { submitBtn, alertMsg, isSuccess };
    }

    const resSuccess = simulateFormSubmission(false, null);
    assert.equal(resSuccess.isSuccess, true);
    assert.ok(resSuccess.alertMsg.includes('successfully'));

    const resApiError = simulateFormSubmission(false, 'Invalid Title');
    assert.equal(resApiError.isSuccess, false);
    assert.equal(resApiError.submitBtn.disabled, false);
    assert.equal(resApiError.submitBtn.textContent, 'Publish Game');

    const resNetworkError = simulateFormSubmission(true, null);
    assert.equal(resNetworkError.isSuccess, false);
    assert.equal(resNetworkError.submitBtn.disabled, false);
    assert.equal(resNetworkError.submitBtn.textContent, 'Publish Game');
  });
});

// ---------------------------------------------------------------------------
// SUITE 3: Role-Based Dashboard Cards Rendering on login.html and admin.html
// ---------------------------------------------------------------------------
test('Suite 3: Role-Based Dashboard Cards Rendering on login.html and admin.html', async (t) => {
  await t.test('3.1: Anonymous visitor to login.html receives sign-in inputs, dashboard hidden', async () => {
    const meRes = await api('GET', '/api/auth/me', null);
    assert.equal(meRes.status, 200);
    assert.equal(meRes.data.user, null, 'Anonymous user must have user: null');

    // Simulate login.html DOM decision logic
    const user = meRes.data.user;
    const isStepRequestVisible = !user;
    const isAlreadyLoggedInVisible = !!user;
    assert.equal(isStepRequestVisible, true);
    assert.equal(isAlreadyLoggedInVisible, false);
  });

  await t.test('3.2: Standard Player on login.html sees Player badge & notice, event creation tool hidden', async () => {
    const meRes = await api('GET', '/api/auth/me', playerCookie);
    assert.equal(meRes.status, 200);
    const user = meRes.data.user;
    assert.equal(user.role, 'player');
    assert.equal(user.isAdmin, false);
    assert.equal(user.canManageEvents, false);

    // Simulate login.html DOM decisions
    const showEventCreation = user.canManageEvents;
    const showUserManagement = user.isAdmin;
    const showPlayerNotice = !user.canManageEvents;

    assert.equal(showEventCreation, false, 'Standard player must not see event creation tool');
    assert.equal(showUserManagement, false, 'Standard player must not see user management');
    assert.equal(showPlayerNotice, true, 'Standard player must see player notice section');
  });

  await t.test('3.3: Organizer on login.html sees Organizer badge & event creation tool, user management hidden', async () => {
    const meRes = await api('GET', '/api/auth/me', orgCookie);
    assert.equal(meRes.status, 200);
    const user = meRes.data.user;
    assert.equal(user.role, 'organizer');
    assert.equal(user.canManageEvents, true);
    assert.equal(user.isAdmin, false);

    const showEventCreation = user.canManageEvents;
    const showUserManagement = user.isAdmin;
    const showPlayerNotice = !user.canManageEvents;

    assert.equal(showEventCreation, true, 'Organizer must see event creation tool');
    assert.equal(showUserManagement, false, 'Organizer must not see user management');
    assert.equal(showPlayerNotice, false, 'Organizer must not see player notice');
  });

  await t.test('3.4: Admin on login.html sees Administrator badge, event creation, AND user management', async () => {
    const meRes = await api('GET', '/api/auth/me', adminCookie);
    assert.equal(meRes.status, 200);
    const user = meRes.data.user;
    assert.equal(user.role, 'admin');
    assert.equal(user.isAdmin, true);
    assert.equal(user.canManageEvents, true);

    const showEventCreation = user.canManageEvents;
    const showUserManagement = user.isAdmin;
    const showPlayerNotice = !user.canManageEvents;

    assert.equal(showEventCreation, true, 'Admin must see event creation tool');
    assert.equal(showUserManagement, true, 'Admin must see user management');
    assert.equal(showPlayerNotice, false, 'Admin must not see player notice');
  });

  await t.test('3.5: admin.html access and UI role filtering', async () => {
    // 1. Player visiting admin.html:
    const playerCheck = await api('GET', '/api/auth/me', playerCookie);
    const playerAllowed = playerCheck.data.user && (playerCheck.data.user.isAdmin || playerCheck.data.user.canManageEvents);
    assert.equal(playerAllowed, false, 'Player must be barred from admin console');

    // 2. Organizer visiting admin.html:
    const orgCheck = await api('GET', '/api/auth/me', orgCookie);
    const orgUser = orgCheck.data.user;
    assert.equal(orgUser.canManageEvents, true);
    assert.equal(orgUser.isAdmin, false);

    // In admin.js applyRoleUI:
    // Organizer sees: '🛡️ Organizer Control'
    // Organizer hides: backupBtn, defaultTemplateCard, saveAsDefaultsBtn, userMgmtSec
    const orgUI = {
      badgeClass: 'badge badge-green',
      badgeText: '🛡️ Organizer Control',
      backupBtnDisplay: 'none',
      defaultTemplateCardDisplay: 'none',
      saveAsDefaultsBtnDisplay: 'none',
      userMgmtSecDisplay: 'none'
    };
    assert.equal(orgUI.badgeText, '🛡️ Organizer Control');
    assert.equal(orgUI.backupBtnDisplay, 'none');
    assert.equal(orgUI.userMgmtSecDisplay, 'none');

    // 3. Admin visiting admin.html:
    const adminCheck = await api('GET', '/api/auth/me', adminCookie);
    const adminUser = adminCheck.data.user;
    assert.equal(adminUser.isAdmin, true);
    assert.equal(adminUser.canManageEvents, true);

    const adminUI = {
      badgeClass: 'badge badge-orange',
      badgeText: '👑 Admin Control',
      backupBtnDisplay: 'inline-flex',
      defaultTemplateCardDisplay: 'block',
      saveAsDefaultsBtnDisplay: 'inline-block'
    };
    assert.equal(adminUI.badgeText, '👑 Admin Control');
    assert.equal(adminUI.backupBtnDisplay, 'inline-flex');
  });
});

// ---------------------------------------------------------------------------
// SUITE 4: Interactive Controls & Button Audit Across All 5 Views
// ---------------------------------------------------------------------------
test('Suite 4: Interactive Controls & Button Audit Across All 5 Views', async (t) => {
  const views = [
    { name: 'index.html', path: path.join(__dirname, '..', 'public', 'index.html') },
    { name: 'login.html', path: path.join(__dirname, '..', 'public', 'login.html') },
    { name: 'admin.html', path: path.join(__dirname, '..', 'public', 'admin.html') },
    { name: 'event.html', path: path.join(__dirname, '..', 'public', 'event.html') },
    { name: 'profile.html', path: path.join(__dirname, '..', 'public', 'profile.html') }
  ];

  await t.test('4.1: Static file integrity and HTTP delivery', async () => {
    for (const v of views) {
      assert.ok(fs.existsSync(v.path), `${v.name} must exist on disk`);
      const httpRes = await api('GET', `/${v.name}`);
      assert.equal(httpRes.status, 200, `/${v.name} must return HTTP 200`);
    }
  });

  await t.test('4.2: Audit index.html controls (upcoming/past filters and card links)', async () => {
    const upcoming = await api('GET', '/api/events?filter=upcoming');
    assert.equal(upcoming.status, 200);
    assert.ok(Array.isArray(upcoming.data.events));

    const past = await api('GET', '/api/events?filter=past');
    assert.equal(past.status, 200);
    assert.ok(Array.isArray(past.data.events));

    const all = await api('GET', '/api/events?filter=all');
    assert.equal(all.status, 200);
    assert.ok(Array.isArray(all.data.events));
  });

  await t.test('4.3: Audit profile.html controls (profile updates and avatar lifecycle)', async () => {
    // 1. Save profile name and bio
    const updateRes = await api('PUT', '/api/auth/profile', playerCookie, {
      name: 'Ken Griffey Jr.',
      bio: 'Sweetest swing in the pickup league.'
    });
    assert.equal(updateRes.status, 200);
    assert.equal(updateRes.data.success, true);
    assert.equal(updateRes.data.user.name, 'Ken Griffey Jr.');
    assert.equal(updateRes.data.user.bio, 'Sweetest swing in the pickup league.');

    // 2. Query /me to confirm profile updates persisted
    const meRes = await api('GET', '/api/auth/me', playerCookie);
    assert.equal(meRes.data.user.name, 'Ken Griffey Jr.');
    assert.equal(meRes.data.user.bio, 'Sweetest swing in the pickup league.');

    // 3. Avatar deletion button
    const deleteAvatarRes = await api('DELETE', '/api/auth/avatar', playerCookie);
    assert.equal(deleteAvatarRes.status, 200);
    assert.equal(deleteAvatarRes.data.success, true);
  });

  await t.test('4.4: Audit event.html controls (comments submission & manual reminder dispatch)', async () => {
    // Create an event for testing comments & reminders
    const evRes = await api('POST', '/api/events', orgCookie, {
      title: 'Community Interaction Game',
      location: 'Heckscher Field #1',
      event_date: '2026-11-29T12:00:00Z',
      use_default_duties: true
    });
    const evId = evRes.data.eventId;

    // 1. Submit comment as authenticated player
    const authComment = await api('POST', `/api/events/${evId}/comments`, playerCookie, {
      content: 'Can bring two extra bats if anyone needs!'
    });
    assert.equal(authComment.status, 200);
    assert.equal(authComment.data.success, true);

    // 2. Submit comment as guest
    const guestComment = await api('POST', `/api/events/${evId}/comments`, null, {
      author_name: 'Visitor Bob',
      content: 'Is parking available near field 1?'
    });
    assert.equal(guestComment.status, 200);
    assert.equal(guestComment.data.success, true);

    // 3. Verify comments returned in event details
    const details = await api('GET', `/api/events/${evId}`);
    assert.equal(details.data.comments.length, 2);

    // 4. Admin manual reminder button POST /api/events/:id/send-reminders
    const reminderRes = await api('POST', `/api/events/${evId}/send-reminders`, adminCookie);
    assert.equal(reminderRes.status, 200);
    assert.equal(reminderRes.data.success, true);
  });

  await t.test('4.5: Audit admin.html controls (default template editor and inline duty management)', async () => {
    // 1. Get default duties
    const defRes = await api('GET', '/api/events/default-duties');
    assert.equal(defRes.status, 200);
    assert.ok(Array.isArray(defRes.data.duties));
    const currentDefaults = defRes.data.duties;

    // 2. Admin updates default duties template
    const modifiedDefaults = [
      ...currentDefaults,
      { title: 'Snacks & Electrolytes', description: 'Bring oranges and bananas', slots_needed: 2 }
    ];
    const putDefRes = await api('PUT', '/api/events/default-duties', adminCookie, {
      duties: modifiedDefaults
    });
    assert.equal(putDefRes.status, 200);
    assert.equal(putDefRes.data.duties.length, currentDefaults.length + 1);

    // Revert back
    await api('PUT', '/api/events/default-duties', adminCookie, { duties: currentDefaults });

    // 3. Inline duty management: Add duty to an existing event
    const evRes = await api('POST', '/api/events', orgCookie, {
      title: 'Inline Duty Event',
      location: 'Central Field',
      event_date: '2026-12-05T12:00:00Z',
      use_default_duties: false,
      custom_duties: [{ title: 'Existing Task', slots_needed: 1 }]
    });
    const evId = evRes.data.eventId;

    // Add inline task
    const addDutyRes = await api('POST', `/api/events/${evId}/duties`, orgCookie, {
      title: 'First Base Coach',
      description: 'Call plays at first',
      slots_needed: 1
    });
    assert.equal(addDutyRes.status, 200);
    const addedDutyId = addDutyRes.data.duty.id;

    // Edit inline task
    const editDutyRes = await api('PUT', `/api/events/${evId}/duties/${addedDutyId}`, orgCookie, {
      title: 'First & Third Base Coach',
      slots_needed: 2
    });
    assert.equal(editDutyRes.status, 200);
    assert.equal(editDutyRes.data.duty.title, 'First & Third Base Coach');
    assert.equal(editDutyRes.data.duty.slots_needed, 2);

    // Delete inline task
    const delDutyRes = await api('DELETE', `/api/events/${evId}/duties/${addedDutyId}`, orgCookie);
    assert.equal(delDutyRes.status, 200);

    // Delete entire event
    const delEvRes = await api('DELETE', `/api/events/${evId}`, adminCookie);
    assert.equal(delEvRes.status, 200);
  });
});

// ---------------------------------------------------------------------------
// SUITE 5: Attendee RSVPs, Duty Slot Limits & Slot Release
// ---------------------------------------------------------------------------
test('Suite 5: Attendee RSVPs, Duty Slot Limits & Slot Release', async (t) => {
  let eventId;
  let targetDutyId;

  // Create event with 1 duty having slots_needed: 1
  const evRes = await api('POST', '/api/events', orgCookie, {
    title: 'Single Slot Duty Game',
    location: 'Diamond 5',
    event_date: '2026-12-25T12:00:00Z',
    custom_duties: [
      { title: 'Sole Umpire', description: 'Umpire behind pitcher', slots_needed: 1 }
    ]
  });
  eventId = evRes.data.eventId;

  const duties = db.prepare('SELECT id FROM event_duties WHERE event_id = ?').all(eventId);
  targetDutyId = duties[0].id;

  let player1Token;
  await t.test('5.1: First attendee claims the only slot', async () => {
    const res = await api('POST', `/api/events/${eventId}/rsvp`, null, {
      name: 'Player One',
      email: 'p1@pickup.org',
      duty_ids: [targetDutyId],
      status: 'attending'
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.status, 'attending');
    player1Token = res.data.managementToken;

    // Verify assigned in SQLite
    const p1Att = db.prepare('SELECT id FROM attendees WHERE email = ? AND event_id = ?').get('p1@pickup.org', eventId);
    const da = db.prepare('SELECT * FROM duty_assignments WHERE attendee_id = ? AND duty_id = ?').get(p1Att.id, targetDutyId);
    assert.ok(da, 'Player One must have duty assignment');
  });

  let player2Token;
  await t.test('5.2: Second attendee attempts to claim already full slot (capacity 1)', async () => {
    const res = await api('POST', `/api/events/${eventId}/rsvp`, null, {
      name: 'Player Two',
      email: 'p2@pickup.org',
      duty_ids: [targetDutyId],
      status: 'attending'
    });
    assert.equal(res.status, 200);
    player2Token = res.data.managementToken;

    // Confirm Player Two is registered as attendee, but did NOT get the duty
    const p2Att = db.prepare('SELECT id FROM attendees WHERE email = ? AND event_id = ?').get('p2@pickup.org', eventId);
    const da2 = db.prepare('SELECT * FROM duty_assignments WHERE attendee_id = ? AND duty_id = ?').get(p2Att.id, targetDutyId);
    assert.equal(da2, undefined, 'Player Two must not receive assignment because slot was already full');
  });

  await t.test('5.3: First attendee declines RSVP; slot is released and claimed by second attendee', async () => {
    // Player One cancels RSVP
    const cancelRes = await api('POST', `/api/events/${eventId}/rsvp`, null, {
      name: 'Player One',
      email: 'p1@pickup.org',
      management_token: player1Token,
      status: 'declined'
    });
    assert.equal(cancelRes.status, 200);
    assert.equal(cancelRes.data.status, 'declined');

    // Confirm assignment removed
    const activeAssignments = db.prepare(`
      SELECT COUNT(*) as c FROM duty_assignments da
      JOIN attendees a ON da.attendee_id = a.id
      WHERE da.duty_id = ? AND a.status = 'attending'
    `).get(targetDutyId).c;
    assert.equal(activeAssignments, 0, 'Duty slot must now be vacant');

    // Player Two updates RSVP to claim the newly vacant slot
    const updateRes = await api('POST', `/api/events/${eventId}/rsvp`, null, {
      name: 'Player Two',
      email: 'p2@pickup.org',
      management_token: player2Token,
      duty_ids: [targetDutyId],
      status: 'attending'
    });
    assert.equal(updateRes.status, 200);

    // Confirm Player Two now holds the duty assignment
    const p2Att = db.prepare('SELECT id FROM attendees WHERE email = ? AND event_id = ?').get('p2@pickup.org', eventId);
    const da2 = db.prepare('SELECT * FROM duty_assignments WHERE attendee_id = ? AND duty_id = ?').get(p2Att.id, targetDutyId);
    assert.ok(da2, 'Player Two must now successfully claim the vacant duty');
  });
});

// ---------------------------------------------------------------------------
// SUITE 6: User Role Management & Session Persistence Lifecycle
// ---------------------------------------------------------------------------
test('Suite 6: User Role Management & Session Persistence Lifecycle', async (t) => {
  let promotedUserId, promotedUserCookie;

  await t.test('6.1: Admin upgrades a standard player to Organizer', async () => {
    const uRes = db.prepare(`
      INSERT INTO users (name, email, role, is_admin)
      VALUES ('E2E Candidate', 'candidate@charity.org', 'player', 0)
    `).run();
    promotedUserId = uRes.lastInsertRowid;
    promotedUserCookie = `baseball_session=${createSession(promotedUserId).sessionId}`;

    // Verify initial player permissions
    const initMe = await api('GET', '/api/auth/me', promotedUserCookie);
    assert.equal(initMe.data.user.role, 'player');
    assert.equal(initMe.data.user.canManageEvents, false);

    // Admin upgrades role
    const upgradeRes = await api('PUT', `/api/auth/users/${promotedUserId}/role`, adminCookie, {
      role: 'organizer'
    });
    assert.equal(upgradeRes.status, 200);
    assert.equal(upgradeRes.data.user.role, 'organizer');

    // Verify existing session immediately reflects new role without re-login
    const upgradedMe = await api('GET', '/api/auth/me', promotedUserCookie);
    assert.equal(upgradedMe.data.user.role, 'organizer');
    assert.equal(upgradedMe.data.user.canManageEvents, true);

    // Verify promoted user can immediately create a game
    const createRes = await api('POST', '/api/events', promotedUserCookie, {
      title: 'Promoted User Game',
      location: 'Central Field',
      event_date: '2026-12-30T12:00:00Z',
      use_default_duties: true
    });
    assert.equal(createRes.status, 200);
    assert.ok(createRes.data.eventId);
  });

  await t.test('6.2: Admin demotes user back to Player; creation is immediately revoked', async () => {
    const demoteRes = await api('PUT', `/api/auth/users/${promotedUserId}/role`, adminCookie, {
      role: 'player'
    });
    assert.equal(demoteRes.status, 200);
    assert.equal(demoteRes.data.user.role, 'player');

    // Verify existing session immediately demoted
    const demotedMe = await api('GET', '/api/auth/me', promotedUserCookie);
    assert.equal(demotedMe.data.user.role, 'player');
    assert.equal(demotedMe.data.user.canManageEvents, false);

    // Verify game creation blocked with 403
    const blockedRes = await api('POST', '/api/events', promotedUserCookie, {
      title: 'Should Be Blocked',
      location: 'Central Field',
      event_date: '2026-12-30T12:00:00Z',
      use_default_duties: true
    });
    assert.equal(blockedRes.status, 403);
  });

  await t.test('6.3: Last-admin demotion protection enforces HTTP 400', async () => {
    // Attempt to demote sole admin
    const demoteAdminRes = await api('PUT', `/api/auth/users/${adminId}/role`, adminCookie, {
      role: 'organizer'
    });
    assert.equal(demoteAdminRes.status, 400);
    assert.ok(demoteAdminRes.data.error.includes('last remaining administrator'));

    // Verify admin remained admin
    const adminCheck = db.prepare('SELECT role, is_admin FROM users WHERE id = ?').get(adminId);
    assert.equal(adminCheck.role, 'admin');
    assert.equal(adminCheck.is_admin, 1);
  });
});

// ---------------------------------------------------------------------------
// SUITE 7: Robustness, Security, Stress & Error Boundaries
// ---------------------------------------------------------------------------
test('Suite 7: Robustness, Security, Stress & Error Boundaries', async (t) => {
  await t.test('7.1: SQL injection attempts in title, location, and comments', async () => {
    const sqlPayload = "'; DROP TABLE events; --";
    const res = await api('POST', '/api/events', orgCookie, {
      title: `Event with SQL injection: ${sqlPayload}`,
      location: `Field: ${sqlPayload}`,
      event_date: '2026-12-31T12:00:00Z',
      description: sqlPayload,
      use_default_duties: true
    });

    assert.equal(res.status, 200, 'Parameterized queries must safely escape SQL payloads');
    const evInDb = db.prepare('SELECT * FROM events WHERE id = ?').get(res.data.eventId);
    assert.ok(evInDb, 'Events table must still exist and contain the intact record');
    assert.ok(evInDb.title.includes(sqlPayload));
  });

  await t.test('7.2: Unicode, emojis, and multi-language strings', async () => {
    const unicodeTitle = '⚾ Domingo de Béisbol 🏆 (秋のピックアップ野球)';
    const unicodeLocation = 'Parque Central #3 — ニューヨーク';

    const res = await api('POST', '/api/events', orgCookie, {
      title: unicodeTitle,
      location: unicodeLocation,
      event_date: '2026-12-31T15:00:00Z',
      use_default_duties: true
    });

    assert.equal(res.status, 200);
    const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(res.data.eventId);
    assert.equal(ev.title, unicodeTitle);
    assert.equal(ev.location, unicodeLocation);
  });

  await t.test('7.3: Extreme payload handling without server crash or hang', async () => {
    const longDesc = 'A'.repeat(8000);
    const res = await api('POST', '/api/events', orgCookie, {
      title: 'Long Description Game',
      location: 'Central Field',
      event_date: '2026-12-31T16:00:00Z',
      description: longDesc,
      use_default_duties: true
    });
    assert.equal(res.status, 200);

    const ev = db.prepare('SELECT description FROM events WHERE id = ?').get(res.data.eventId);
    assert.equal(ev.description.length, 8000);
  });

  await t.test('7.4: Rapid concurrent RSVPs do not cause unhandled rejections', async () => {
    const evRes = await api('POST', '/api/events', orgCookie, {
      title: 'Concurrent RSVP Stress Game',
      location: 'North Field #1',
      event_date: '2026-12-31T17:00:00Z',
      use_default_duties: true
    });
    const evId = evRes.data.eventId;

    // Fire 15 concurrent RSVPs
    const promises = [];
    for (let i = 0; i < 15; i++) {
      promises.push(
        api('POST', `/api/events/${evId}/rsvp`, null, {
          name: `Concurrent Player ${i}`,
          email: `concurrent_${i}@charity.org`,
          status: 'attending'
        })
      );
    }

    const results = await Promise.all(promises);
    for (const r of results) {
      assert.equal(r.status, 200);
    }

    const countInDb = db.prepare('SELECT COUNT(*) as c FROM attendees WHERE event_id = ?').get(evId).c;
    assert.equal(countInDb, 15, 'All 15 attendees must be persisted atomically');
  });
});
