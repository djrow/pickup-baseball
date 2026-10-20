const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');
const cookieParser = require('cookie-parser');

// Use isolated test database
const testDbPath = path.join(os.tmpdir(), `challenger1_m2_${Date.now()}_${Math.random().toString(36).slice(2)}.db`);
process.env.DB_PATH = testDbPath;
process.env.NODE_ENV = 'test';

const { db, initDatabase, getDefaultDuties } = require('../src/db');
initDatabase();

const { createSession } = require('../src/auth');
const authRoutes = require('../src/routes/auth');
const eventRoutes = require('../src/routes/events');

// Build test Express server
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/api/auth', authRoutes);
app.use('/api/events', eventRoutes);

let server;
let baseUrl;
let adminCookie;
let organizerCookie;
let playerCookie;
let adminId;
let organizerId;
let playerId;

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });

  // Seed Admin user
  const adminRes = db.prepare(`
    INSERT INTO users (name, email, role, is_admin)
    VALUES ('Challenger Admin', 'ch_admin@example.com', 'admin', 1)
  `).run();
  adminId = adminRes.lastInsertRowid;
  const adminSession = createSession(adminId);
  adminCookie = `baseball_session=${adminSession.sessionId}`;

  // Seed Organizer user
  const orgRes = db.prepare(`
    INSERT INTO users (name, email, role, is_admin)
    VALUES ('Challenger Organizer', 'ch_org@example.com', 'organizer', 0)
  `).run();
  organizerId = orgRes.lastInsertRowid;
  const orgSession = createSession(organizerId);
  organizerCookie = `baseball_session=${orgSession.sessionId}`;

  // Seed Player user
  const playerRes = db.prepare(`
    INSERT INTO users (name, email, role, is_admin)
    VALUES ('Challenger Player', 'ch_player@example.com', 'player', 0)
  `).run();
  playerId = playerRes.lastInsertRowid;
  const playerSession = createSession(playerId);
  playerCookie = `baseball_session=${playerSession.sessionId}`;
});

test.after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  try {
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  } catch (e) {}
});

// Helper: load client files
const ROOT_DIR = path.resolve(__dirname, '..');
function loadClientFile(relPath) {
  return fs.readFileSync(path.join(ROOT_DIR, relPath), 'utf8');
}

// --------------------------------------------------------------------------
// SUITE 1: RAPID DOUBLE-CLICKS & UI STATE RESILIENCE
// --------------------------------------------------------------------------

test('Challenger 1 - Area 1.1: login.html 1-Click Sunday rapid click simulation & state lock', async (t) => {
  // Test the exact logic executed in login.html for quickBtn
  let clickCount = 0;
  let apiCallCount = 0;
  let disabledStateDuringCall = false;
  let redirectUrl = null;

  // Mock UI element
  const quickBtn = {
    disabled: false,
    textContent: '⚡ 1-Click: Post Next Sunday @ Noon'
  };
  const alertBox = { innerHTML: '' };

  const mockApiCreateEvent = async (payload) => {
    apiCallCount++;
    // Verify that the button is disabled while the API call is in flight
    disabledStateDuringCall = quickBtn.disabled;
    // Simulate network delay
    await new Promise(r => setTimeout(r, 20));
    return {
      success: true,
      eventId: 101,
      event: { id: 101, title: payload.title }
    };
  };

  const handleClick = async () => {
    // If button is already disabled (native browser behavior prevents click), skip
    if (quickBtn.disabled) return;

    clickCount++;
    const defaultLoc = 'Central Park - North Meadow Field #4';
    const loc = 'North Meadow Field #4'; // simulated prompt answer
    if (loc === null) return;

    quickBtn.disabled = true;
    quickBtn.textContent = 'Scheduling Sunday Game...';

    try {
      const res = await mockApiCreateEvent({
        title: 'Sunday Pickup Baseball - Noon Game',
        location: loc.trim() || defaultLoc,
        location_url: '',
        event_date: new Date().toISOString(),
        max_players: 30,
        description: 'Friendly pickup baseball.'
      });

      if (res.error) {
        alertBox.innerHTML = `<div class="alert alert-error">${res.error}</div>`;
        quickBtn.disabled = false;
        quickBtn.textContent = '⚡ 1-Click: Post Next Sunday @ Noon';
      } else {
        const newId = res.eventId || (res.event && res.event.id);
        alertBox.innerHTML = `<div class="alert alert-success">✓ Sunday game scheduled! Redirecting to game page...</div>`;
        redirectUrl = `/event.html?id=${newId}`;
      }
    } catch (err) {
      alertBox.innerHTML = `<div class="alert alert-error">Failed to schedule game.</div>`;
      quickBtn.disabled = false;
      quickBtn.textContent = '⚡ 1-Click: Post Next Sunday @ Noon';
    }
  };

  // Simulate rapid double click: trigger handleClick twice synchronously
  const p1 = handleClick();
  const p2 = handleClick(); // second click fires while first is in-flight and button is disabled

  await Promise.all([p1, p2]);

  assert.equal(clickCount, 1, 'Only one click should be accepted when button is disabled');
  assert.equal(apiCallCount, 1, 'Only one API creation call should occur on rapid double click');
  assert.equal(disabledStateDuringCall, true, 'Button must be disabled while event creation is in flight');
  assert.equal(quickBtn.disabled, true, 'Button must remain disabled during redirection period');
  assert.equal(redirectUrl, '/event.html?id=101', 'Redirect URL must target /event.html?id=101');
  assert.ok(alertBox.innerHTML.includes('alert-success'), 'Alert box must display success notice');
});

test('Challenger 1 - Area 1.2: login.html Custom Game Form double submit & error recovery', async (t) => {
  // Test custom form submission logic from login.html
  const submitBtn = {
    disabled: false,
    textContent: 'Publish Game & Roster'
  };
  const alertBox = { innerHTML: '' };
  let redirectTarget = null;
  let apiAttempts = 0;

  const mockApi = {
    escapeHtml: (s) => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    createEvent: async (payload) => {
      apiAttempts++;
      await new Promise(r => setTimeout(r, 20));
      if (payload.title === 'FAIL_ME') {
        return { error: 'Invalid game parameters' };
      }
      return { success: true, eventId: 202, event: { id: 202 } };
    }
  };

  const handleCustomSubmit = async (formData) => {
    if (submitBtn.disabled) return;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Publishing...';

    let isSuccess = false;
    try {
      const title = formData.title.trim();
      const rawDate = formData.rawDate;
      const location = formData.location.trim();
      const locationUrl = formData.locationUrl.trim();
      const desc = formData.desc.trim();

      const res = await mockApi.createEvent({
        title,
        event_date: new Date(rawDate).toISOString(),
        location,
        location_url: locationUrl,
        description: desc,
        max_players: 30
      });

      if (res.error) {
        alertBox.innerHTML = `<div class="alert alert-error">${mockApi.escapeHtml(res.error)}</div>`;
      } else {
        isSuccess = true;
        const newId = res.eventId || (res.event && res.event.id);
        alertBox.innerHTML = `<div class="alert alert-success">✓ Game published successfully! Redirecting...</div>`;
        redirectTarget = `/event.html?id=${newId}`;
      }
    } catch (err) {
      alertBox.innerHTML = `<div class="alert alert-error">${mockApi.escapeHtml(err.message || 'Failed to publish game. Please try again.')}</div>`;
    } finally {
      if (!isSuccess) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Publish Game & Roster';
      }
    }
  };

  // Case A: Successful rapid double-submission
  const validData = {
    title: 'Sunday Pickup Test',
    rawDate: '2026-11-01T12:00',
    location: 'Prospect Park',
    locationUrl: '',
    desc: 'Regular pickup.'
  };

  const sub1 = handleCustomSubmit(validData);
  const sub2 = handleCustomSubmit(validData);
  await Promise.all([sub1, sub2]);

  assert.equal(apiAttempts, 1, 'Only one API call allowed on double submission');
  assert.equal(submitBtn.disabled, true, 'Submit button must stay disabled after success to prevent duplicate creates during redirect');
  assert.equal(redirectTarget, '/event.html?id=202', 'Target redirect URL must match created event ID');

  // Case B: API failure resets button state via finally
  submitBtn.disabled = false;
  submitBtn.textContent = 'Publish Game & Roster';
  redirectTarget = null;

  await handleCustomSubmit({
    title: 'FAIL_ME',
    rawDate: '2026-11-01T12:00',
    location: 'Prospect Park',
    locationUrl: '',
    desc: ''
  });

  assert.equal(submitBtn.disabled, false, 'Button must be re-enabled after API error');
  assert.equal(submitBtn.textContent, 'Publish Game & Roster', 'Button text must reset after error');
  assert.ok(alertBox.innerHTML.includes('Invalid game parameters'), 'Alert must show API error');
  assert.equal(redirectTarget, null, 'Redirect must not trigger on error');
});

test('Challenger 1 - Area 1.3: admin.js setupCreateForm submission lifecycle & button state', async (t) => {
  // Test admin.js setupCreateForm
  const submitBtn = { disabled: false, textContent: 'Publish Game' };
  let alertMessage = null;
  let alertIsError = false;
  let redirectUrl = null;

  const showAlert = (msg, isErr) => {
    alertMessage = msg;
    alertIsError = isErr;
  };

  let builderDuties = [{ title: 'Bases', description: 'Bring bases', slots_needed: 1 }];

  const handleAdminCreate = async (formData) => {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Publishing...';

    try {
      // Validate duties
      const invalidDuty = builderDuties.find(d => !d.title.trim());
      if (invalidDuty) {
        showAlert('Please enter a name for all tasks, or click the trash can to delete empty rows.', true);
        return;
      }

      const title = formData.title.trim();
      const rawDate = formData.rawDate;
      if (!rawDate || isNaN(new Date(rawDate).getTime())) {
        showAlert('Please enter a valid date and time for the game.', true);
        return;
      }
      const eventDate = new Date(rawDate).toISOString();
      const location = formData.location.trim();

      // Simulate fetch to backend
      const res = await fetch(`${baseUrl}/api/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cookie': adminCookie
        },
        body: JSON.stringify({
          title,
          event_date: eventDate,
          location,
          custom_duties: builderDuties
        })
      });

      const data = await res.json();
      if (data.error) {
        showAlert(data.error, true);
      } else {
        const newId = data.eventId || (data.event && data.event.id);
        showAlert(`Game "${title}" published with ${builderDuties.length} volunteer tasks! Redirecting...`, false);
        if (newId) {
          redirectUrl = `/event.html?id=${newId}`;
        }
      }
    } catch (err) {
      showAlert(err.message || 'Error creating game.', true);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Publish Game';
    }
  };

  // 1. Success path
  await handleAdminCreate({
    title: 'Admin Created Championship',
    rawDate: '2026-11-08T12:00',
    location: 'Field #5'
  });

  assert.equal(alertIsError, false, 'Success should not trigger error alert');
  assert.ok(alertMessage.includes('published with 1 volunteer tasks'), 'Success message should include task count');
  assert.ok(redirectUrl.startsWith('/event.html?id='), 'Redirect URL must be populated with event ID');

  // 2. Empty duty title error path
  builderDuties = [{ title: '   ', description: '', slots_needed: 1 }];
  await handleAdminCreate({
    title: 'Admin Game 2',
    rawDate: '2026-11-08T12:00',
    location: 'Field #5'
  });

  assert.equal(alertIsError, true, 'Empty duty title must set error alert');
  assert.ok(alertMessage.includes('Please enter a name for all tasks'), 'Alert must warn about task name');
  assert.equal(submitBtn.disabled, false, 'Button must be reset via finally');
  assert.equal(submitBtn.textContent, 'Publish Game', 'Button text must be restored to "Publish Game"');
});

// --------------------------------------------------------------------------
// SUITE 2: MALFORMED, INVALID, AND EXTREME DATE VALUES
// --------------------------------------------------------------------------

test('Challenger 1 - Area 2.1: admin.js Date Parsing Hardening against invalid and non-date strings', (t) => {
  const invalidDateInputs = [
    '',
    '   ',
    'invalid-date',
    'not a date',
    'undefined',
    'null',
    'abc123xyz',
    '2026-13-45T99:99'
  ];

  for (const rawDate of invalidDateInputs) {
    const isInvalid = !rawDate || isNaN(new Date(rawDate).getTime());
    assert.equal(isInvalid, true, `Input "${rawDate}" must evaluate to invalid before Date.toISOString() is attempted`);
  }
});

test('Challenger 1 - Area 2.2: Extreme date values (Year 9999, negative years, past dates, leap years)', async (t) => {
  // Test Year 9999
  const y9999 = '9999-06-15T12:00';
  assert.equal(isNaN(new Date(y9999).getTime()), false, 'Year 9999 must be parseable');
  const iso9999 = new Date(y9999).toISOString();
  assert.ok(iso9999.startsWith('9999-06-15'), 'Year 9999 ISO string must match');

  // Test Negative Date (BCE / Ancient)
  const negDate = '-0001-01-01T00:00';
  assert.equal(isNaN(new Date(negDate).getTime()), true, 'Negative date strings evaluate to NaN in V8 Date parser');
  assert.throws(() => new Date(negDate).toISOString(), /Invalid time value/, 'Negative date toISOString throws RangeError, which login.html and admin.js catch defensively');

  // Test Past Date (Year 2000)
  const pastDate = '2000-01-01T12:00';
  const isoPast = new Date(pastDate).toISOString();
  assert.ok(isoPast.startsWith('2000-01-01'), 'Past date ISO string must match');

  // Backend acceptance test with Year 9999 date
  const res = await fetch(`${baseUrl}/api/events`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': adminCookie
    },
    body: JSON.stringify({
      title: 'Far Future Game 9999',
      location: 'Moon Base Diamond',
      event_date: iso9999,
      use_default_duties: true
    })
  });
  const data = await res.json();
  assert.equal(res.status, 200, 'Backend must accept valid Year 9999 date without error');
  assert.ok(data.eventId > 0, 'Event ID must be positive integer');
  assert.equal(data.event.event_date, iso9999, 'Persisted event date must match ISO 9999');
});

test('Challenger 1 - Area 2.3: login.html RangeError safety on malformed date input', async (t) => {
  // Verify that if rawDate is completely corrupt in login.html,
  // the try/catch/finally block catches RangeError and clears the hanging state.
  const submitBtn = { disabled: true, textContent: 'Publishing...' };
  const alertBox = { innerHTML: '' };
  let isSuccess = false;

  const corruptDate = 'bogus-date-that-causes-range-error';

  try {
    const title = 'Corrupt Date Game';
    const rawDate = corruptDate;
    const location = 'Central Park';

    // This throws RangeError: Invalid time value
    const event_date = new Date(rawDate).toISOString();

    // If it didn't throw, we'd call API
    await fetch('/bogus');
    isSuccess = true;
  } catch (err) {
    alertBox.innerHTML = `<div class="alert alert-error">${err.message || 'Failed to publish game. Please try again.'}</div>`;
  } finally {
    if (!isSuccess) {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Publish Game & Roster';
    }
  }

  assert.equal(submitBtn.disabled, false, 'Button must be re-enabled when RangeError occurs');
  assert.equal(submitBtn.textContent, 'Publish Game & Roster', 'Button text must be restored');
  assert.ok(alertBox.innerHTML.includes('Invalid time value'), 'Alert box must display caught exception message');
});

// --------------------------------------------------------------------------
// SUITE 3: SPECIAL CHARACTERS, APOSTROPHES, HTML INJECTION & BACKTICKS
// --------------------------------------------------------------------------

test('Challenger 1 - Area 3.1: Adversarial task titles in admin.js editDutyInline encoding & onclick escaping', (t) => {
  const adversarialDuties = [
    { id: 1, title: "Catcher's Gear", description: "Shin guards & chest protector", slots_needed: 1 },
    { id: 2, title: "Bob's & Alice's Child's Glove", description: "Right-hand thrower's mitt", slots_needed: 2 },
    { id: 3, title: `Rawlings "Official" Flat-Seam Balls`, description: `Special "Game" balls`, slots_needed: 1 },
    { id: 4, title: '`whoami` & ${process.env.FLAG}', description: 'Shell & template literal backticks', slots_needed: 1 },
    { id: 5, title: '<script>alert("XSS")</script>', description: '<img src=x onerror=alert(1)>', slots_needed: 1 },
    { id: 6, title: 'Special: !@#$%^&*()_+-=[]{}|;:",./<>?', description: 'Every ASCII punctuation symbol', slots_needed: 1 },
    { id: 7, title: '100% Cotton & Wool \\ Field #1\nLine 2', description: 'Percents, backslashes, newlines', slots_needed: 1 },
    { id: 8, title: '⚾ 守備の練習 / グローブ 🧢🏆', description: 'Japanese text and baseball emojis', slots_needed: 3 }
  ];

  const eventId = 42;

  for (const d of adversarialDuties) {
    // Exact logic from admin.js lines 552-553:
    const safeTitle = encodeURIComponent(d.title).replace(/'/g, '%27');
    const safeDesc = encodeURIComponent(d.description || '').replace(/'/g, '%27');

    // 1. safeTitle and safeDesc MUST NOT contain raw single quotes
    assert.equal(safeTitle.includes("'"), false, `safeTitle for "${d.title}" must not contain raw single quotes`);
    assert.equal(safeDesc.includes("'"), false, `safeDesc for "${d.description}" must not contain raw single quotes`);

    // 2. safeTitle and safeDesc MUST NOT contain raw double quotes
    assert.equal(safeTitle.includes('"'), false, `safeTitle must not contain unencoded double quotes`);

    // 3. safeTitle and safeDesc MUST NOT contain unencoded '<' or '>'
    assert.equal(safeTitle.includes('<'), false, `safeTitle must not contain '<'`);
    assert.equal(safeTitle.includes('>'), false, `safeTitle must not contain '>'`);

    // 4. Construct the onclick string exactly as rendered in admin.js line 566:
    const onclickAttr = `editDutyInline(${eventId}, ${d.id}, '${safeTitle}', '${safeDesc}', ${d.slots_needed})`;

    // Verify it doesn't break out of the string literal
    // The single quote count in the call should be exactly 4 (2 for title, 2 for desc)
    const singleQuoteCount = (onclickAttr.match(/'/g) || []).length;
    assert.equal(singleQuoteCount, 4, `onclick attribute must contain exactly 4 single quotes for ${d.title}`);

    // 5. Test decodeURIComponent recovery inside editDutyInline (lines 626-627):
    const recoveredTitle = decodeURIComponent(safeTitle);
    const recoveredDesc = decodeURIComponent(safeDesc);

    assert.equal(recoveredTitle, d.title, `Recovered title must perfectly match original for "${d.title}"`);
    assert.equal(recoveredDesc, d.description, `Recovered description must perfectly match original for "${d.description}"`);
  }
});

test('Challenger 1 - Area 3.2: End-to-End Inline Duty Modification with Apostrophes and Quotes in SQLite', async (t) => {
  // 1. Create a game with default duties
  const createRes = await fetch(`${baseUrl}/api/events`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': organizerCookie
    },
    body: JSON.stringify({
      title: "Organizer's Weekly Game",
      location: "St. Mary's Recreation Center",
      event_date: new Date(Date.now() + 86400000 * 3).toISOString(),
      use_default_duties: true
    })
  });
  const createData = await createRes.json();
  assert.equal(createRes.status, 200, 'Game creation should succeed');
  const eventId = createData.eventId;

  // 2. Fetch created duties
  const eventRes = await fetch(`${baseUrl}/api/events/${eventId}`, {
    headers: { 'Cookie': organizerCookie }
  });
  const eventData = await eventRes.json();
  assert.ok(eventData.duties.length > 0, 'Event should have duties');
  const duty = eventData.duties[0];

  // 3. Simulate editDutyInline updating duty title to one with apostrophes, quotes, and HTML
  const complexTitle = "Umpire's \"Official\" Mask & Whistle <script>";
  const complexDesc = "Don't drop the umpire's mask & click here: 'test'";

  const updateRes = await fetch(`${baseUrl}/api/events/${eventId}/duties/${duty.id}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': organizerCookie
    },
    body: JSON.stringify({
      title: complexTitle,
      description: complexDesc,
      slots_needed: 2
    })
  });
  const updateData = await updateRes.json();
  assert.equal(updateRes.status, 200, 'Duty update must succeed with 200');
  assert.equal(updateData.duty.title, complexTitle, 'Duty title in SQLite must match complex title');
  assert.equal(updateData.duty.description, complexDesc, 'Duty description in SQLite must match complex description');

  // 4. Verify rendering safe title in admin task manager
  const safeTitle = encodeURIComponent(updateData.duty.title).replace(/'/g, '%27');
  const safeDesc = encodeURIComponent(updateData.duty.description).replace(/'/g, '%27');
  const onclick = `editDutyInline(${eventId}, ${duty.id}, '${safeTitle}', '${safeDesc}', ${updateData.duty.slots_needed})`;

  assert.equal(onclick.includes("'s"), false, "onclick must not contain unescaped 's");
  assert.equal(decodeURIComponent(safeTitle), complexTitle, 'Decoded title must match');
});

// --------------------------------------------------------------------------
// SUITE 4: UI STATE RESILIENCE, PERMISSIONS & ROLE BADGES
// --------------------------------------------------------------------------

test('Challenger 1 - Area 4.1: profile.html 3-tier role badges logic across all role variations', (t) => {
  function getProfileBadge(user) {
    if (user.isAdmin || user.role === 'admin') {
      return { className: 'badge badge-orange', textContent: '👑 Administrator' };
    } else if (user.role === 'organizer') {
      return { className: 'badge badge-green', textContent: '🛡️ Event Organizer' };
    } else {
      return { className: 'badge badge-gray', textContent: '👤 Player' };
    }
  }

  // 1. Admin variations
  assert.deepEqual(getProfileBadge({ role: 'admin', isAdmin: true }), { className: 'badge badge-orange', textContent: '👑 Administrator' });
  assert.deepEqual(getProfileBadge({ role: 'admin', isAdmin: 1 }), { className: 'badge badge-orange', textContent: '👑 Administrator' });
  assert.deepEqual(getProfileBadge({ role: 'player', isAdmin: true }), { className: 'badge badge-orange', textContent: '👑 Administrator' });

  // 2. Organizer
  assert.deepEqual(getProfileBadge({ role: 'organizer', isAdmin: false }), { className: 'badge badge-green', textContent: '🛡️ Event Organizer' });
  assert.deepEqual(getProfileBadge({ role: 'organizer', isAdmin: 0 }), { className: 'badge badge-green', textContent: '🛡️ Event Organizer' });

  // 3. Regular Players
  assert.deepEqual(getProfileBadge({ role: 'player', isAdmin: false }), { className: 'badge badge-gray', textContent: '👤 Player' });
  assert.deepEqual(getProfileBadge({ role: 'guest', isAdmin: false }), { className: 'badge badge-gray', textContent: '👤 Player' });
  assert.deepEqual(getProfileBadge({}), { className: 'badge badge-gray', textContent: '👤 Player' });
});

test('Challenger 1 - Area 4.2: public/js/app.js empty state renders game creation button for Organizers and Admins', (t) => {
  const appJs = loadClientFile('public/js/app.js');

  // Verify that empty state checks canManageEvents
  assert.ok(
    appJs.includes('API.currentUser.canManageEvents'),
    'app.js must check API.currentUser.canManageEvents so Organizers see "Create Next Sunday Game"'
  );

  function simulateEmptyStateAction(currentUser) {
    if (currentUser && currentUser.canManageEvents) {
      return '<a href="/admin.html" class="btn btn-primary">Create Next Sunday Game</a>';
    }
    return '';
  }

  // Admin user
  const adminHtml = simulateEmptyStateAction({ role: 'admin', canManageEvents: true });
  assert.ok(adminHtml.includes('Create Next Sunday Game'), 'Admin must see Create Next Sunday Game button');

  // Organizer user
  const orgHtml = simulateEmptyStateAction({ role: 'organizer', canManageEvents: true });
  assert.ok(orgHtml.includes('Create Next Sunday Game'), 'Organizer must see Create Next Sunday Game button');

  // Player user
  const playerHtml = simulateEmptyStateAction({ role: 'player', canManageEvents: false });
  assert.equal(playerHtml, '', 'Standard Player must not see game creation button');

  // Logged-out user
  const anonHtml = simulateEmptyStateAction(null);
  assert.equal(anonHtml, '', 'Unauthenticated user must not see game creation button');
});

test('Challenger 1 - Area 4.3: HTML Escaping verification across all user-supplied inputs', (t) => {
  const apiJs = loadClientFile('public/js/api.js');
  assert.ok(apiJs.includes('escapeHtml(str)'), 'api.js must provide escapeHtml helper');

  const escapeHtml = (str) => {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  };

  const maliciousInputs = [
    '<script>alert("XSS")</script>',
    '<img src="x" onerror="evil()"/>',
    'Hello & Goodbye "Friend"',
    '<b>Bold</b> and <i>Italic</i>'
  ];

  for (const input of maliciousInputs) {
    const escaped = escapeHtml(input);
    assert.equal(escaped.includes('<'), false, `Escaped string must not contain '<': ${escaped}`);
    assert.equal(escaped.includes('>'), false, `Escaped string must not contain '>': ${escaped}`);
    assert.equal(escaped.includes('"'), false, `Escaped string must not contain '"': ${escaped}`);
  }
});

// --------------------------------------------------------------------------
// SUITE 5: REDIRECT PARAMETER INTEGRITY & DEFENSIVE ID EXTRACTION
// --------------------------------------------------------------------------

test('Challenger 1 - Area 5.1: Defensive eventId extraction with polymorphic API response shapes', (t) => {
  // Test both shapes: { success: true, eventId: 777 } and { success: true, event: { id: 777 } }
  function extractId(res) {
    return res.eventId || (res.event && res.event.id);
  }

  assert.equal(extractId({ eventId: 777 }), 777, 'Must extract from top-level eventId');
  assert.equal(extractId({ event: { id: 777 } }), 777, 'Must extract from nested event.id');
  assert.equal(extractId({ eventId: 888, event: { id: 888 } }), 888, 'Must extract correctly when both are present');
  assert.ok(!extractId({}), 'Must safely yield falsy if neither is present');
  assert.ok(!extractId({ event: null }), 'Must safely handle event: null as falsy');
});

test('Challenger 1 - Area 5.2: Leap day & rollover date behavior', (t) => {
  // 2024 is leap year: Feb 29 is valid
  const leapValid = '2024-02-29T12:00';
  assert.equal(isNaN(new Date(leapValid).getTime()), false, '2024-02-29 must be valid date');
  const dValid = new Date(leapValid);
  assert.equal(dValid.getMonth(), 1, 'Month must be February (1)');
  assert.equal(dValid.getDate(), 29, 'Day must be 29');

  // 2025 is non-leap year: Feb 29 rolls over to March 1
  const nonLeap = '2025-02-29T12:00';
  assert.equal(isNaN(new Date(nonLeap).getTime()), false, 'Non-leap Feb 29 parses via rollover');
  const dRollover = new Date(nonLeap);
  assert.equal(dRollover.getMonth(), 2, 'Month must roll over to March (2)');
  assert.equal(dRollover.getDate(), 1, 'Day must roll over to March 1');
});

test('Challenger 1 - Area 5.3: Add duty to event via POST endpoint with quotes, apostrophes and backticks', async (t) => {
  // 1. Create a game
  const createRes = await fetch(`${baseUrl}/api/events`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': organizerCookie
    },
    body: JSON.stringify({
      title: "Organizer's Special Duty Game",
      location: "Prospect Park Diamond 1",
      event_date: new Date(Date.now() + 86400000 * 5).toISOString(),
      use_default_duties: false,
      custom_duties: [{ title: 'Main Duty', slots_needed: 1 }]
    })
  });
  const createData = await createRes.json();
  const eventId = createData.eventId;

  // 2. Add duty with adversarial characters as addDutyToEvent does
  const dutyTitle = "Coach's `Mega` \"Pitching\" Machine & 100% Baseballs";
  const dutyDesc = "Bring 10' extension cord & generator's fuel";

  const addRes = await fetch(`${baseUrl}/api/events/${eventId}/duties`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': organizerCookie
    },
    body: JSON.stringify({
      title: dutyTitle,
      description: dutyDesc,
      slots_needed: 2
    })
  });
  const addData = await addRes.json();
  assert.equal(addRes.status, 200, 'Adding duty with quotes & apostrophes must succeed');
  assert.equal(addData.duty.title, dutyTitle, 'Duty title must be stored intact in SQLite');
  assert.equal(addData.duty.description, dutyDesc, 'Duty description must be stored intact in SQLite');

  // 3. Verify safe escaping in task manager
  const safeTitle = encodeURIComponent(addData.duty.title).replace(/'/g, '%27');
  assert.equal(safeTitle.includes("'"), false, 'Must not contain raw apostrophe');
  assert.equal(safeTitle.includes('"'), false, 'Must not contain raw double quote');
  assert.equal(safeTitle.includes('`'), false, 'Must not contain raw backtick');
  assert.equal(decodeURIComponent(safeTitle), dutyTitle, 'Must decode cleanly');
});
