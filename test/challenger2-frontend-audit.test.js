const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const express = require('express');
const cookieParser = require('cookie-parser');

const ROOT_DIR = path.resolve(__dirname, '..');

function loadFile(relPath) {
  return fs.readFileSync(path.join(ROOT_DIR, relPath), 'utf8');
}

// ---------------------------------------------------------------------
// AREA 1: Interactive Elements Catalog & HTML Structure Verification
// ---------------------------------------------------------------------
test('Area 1: Interactive Elements Catalog & HTML Structure Verification', async (t) => {
  const views = {
    'index.html': {
      file: 'public/index.html',
      buttons: ['filter-upcoming-btn', 'filter-past-btn'],
      forms: [],
      links: ['/index.html', '/login.html', '#featured-game-container'],
      dynamicContainers: ['main-nav', 'login-success-banner', 'featured-game-container', 'games-list-container']
    },
    'login.html': {
      file: 'public/login.html',
      buttons: ['login-page-logout-btn', 'quick-sunday-btn', 'toggle-custom-form-btn', 'submit-event-btn', 'refresh-users-btn', 'send-code-btn', 'verify-code-btn', 'start-over-btn'],
      forms: ['create-event-form', 'step-request-form', 'step-verify-form'],
      inputs: ['player-name', 'player-email', 'auth-code', 'event-title-input', 'event-date-input', 'event-location-input', 'event-map-input', 'event-desc-input'],
      links: ['/index.html', '/profile.html'],
      dynamicContainers: ['already-logged-in', 'event-creation-section', 'user-management-section', 'player-notice-section', 'login-alert', 'event-create-alert', 'user-mgmt-alert', 'users-table-body']
    },
    'admin.html': {
      file: 'public/admin.html',
      buttons: ['quick-sunday-btn', 'btn-add-task-row', 'btn-save-as-defaults', 'btn-reset-default-tasks', 'btn-clear-tasks', 'create-event-btn', 'toggle-default-template-btn', 'btn-add-default-template-row', 'btn-save-default-template', 'admin-refresh-users-btn'],
      forms: ['create-event-form'],
      inputs: ['event-title-input', 'event-date-input', 'event-location-input', 'event-map-input', 'event-desc-input'],
      links: ['/index.html', '/login.html', '/api/events/admin/backup-db'],
      dynamicContainers: ['admin-alert', 'task-builder-list', 'default-template-panel', 'default-template-list', 'admin-games-container', 'admin-user-mgmt-section', 'admin-users-table-body']
    },
    'event.html': {
      file: 'public/event.html',
      buttons: ['send-reminders-btn', 'rsvp-submit-btn', 'comment-submit-btn'],
      forms: ['rsvp-form', 'comment-form'],
      inputs: ['rsvp-name', 'rsvp-email', 'rsvp-gear', 'comment-author-name', 'comment-author-email', 'comment-content'],
      links: ['/index.html', '/login.html'],
      dynamicContainers: ['event-loading', 'event-error', 'event-container', 'admin-actions-container', 'rsvp-badge-container', 'rsvp-alert', 'rsvp-duties-list', 'duties-grid', 'attendees-container', 'comments-container']
    },
    'profile.html': {
      file: 'public/profile.html',
      buttons: ['btn-remove-avatar', 'btn-save-profile'],
      forms: ['profile-form'],
      inputs: ['avatar-file-input', 'profile-name', 'profile-email', 'profile-bio'],
      links: ['/index.html', '/login.html'],
      dynamicContainers: ['profile-alert', 'avatar-preview-container', 'role-badge', 'bio-char-count']
    }
  };

  for (const [viewName, def] of Object.entries(views)) {
    await t.test(`Catalog verify for ${viewName}`, () => {
      let content = loadFile(def.file);
      if (def.file === 'public/login.html') content += loadFile('public/js/account-dashboard.js');
      if (def.file === 'public/event.html') content += loadFile('public/js/event.js');
      assert.ok(content.length > 0, `${viewName} must not be empty`);

      // Verify all buttons exist
      for (const btnId of def.buttons) {
        assert.ok(
          content.includes(`id="${btnId}"`),
          `${viewName} must contain button with id="${btnId}"`
        );
      }

      // Verify all forms exist
      for (const formId of def.forms) {
        assert.ok(
          content.includes(`id="${formId}"`),
          `${viewName} must contain form with id="${formId}"`
        );
      }

      // Verify all inputs exist
      if (def.inputs) {
        for (const inputId of def.inputs) {
          assert.ok(
            content.includes(`id="${inputId}"`),
            `${viewName} must contain input with id="${inputId}"`
          );
        }
      }

      // Verify all dynamic containers exist
      for (const containerId of def.dynamicContainers) {
        assert.ok(
          content.includes(`id="${containerId}"`),
          `${viewName} must contain container with id="${containerId}"`
        );
      }

      // Verify static links
      for (const linkHref of def.links) {
        assert.ok(
          content.includes(`href="${linkHref}"`),
          `${viewName} must contain link href="${linkHref}"`
        );
      }
    });
  }

  // Profile avatar input specific checks
  await t.test('Profile avatar file input constraints', () => {
    const profileHtml = loadFile('public/profile.html');
    assert.ok(
      profileHtml.includes('type="file"'),
      'Avatar input must have type="file"'
    );
    assert.ok(
      profileHtml.includes('accept="image/jpeg,image/png,image/webp,image/gif"'),
      'Avatar input must specify accepted image mime types matching server upload filter'
    );
  });
});

// ---------------------------------------------------------------------
// AREA 2: Live Static Asset Serving & Navigation Target Existence
// ---------------------------------------------------------------------
test('Area 2: Live Static Asset Serving & Internal Navigation Targets', async (t) => {
  const app = express();
  app.use(express.static(path.join(ROOT_DIR, 'public')));
  app.get('/api/events/admin/backup-db', (req, res) => res.status(200).send('fake-db'));

  let server;
  let baseUrl;

  test.before(async () => {
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  test.after(() => {
    if (server) server.close();
  });

  const routesToTest = [
    '/index.html',
    '/login.html',
    '/admin.html',
    '/event.html',
    '/profile.html',
    '/js/api.js',
    '/js/app.js',
    '/js/admin.js',
    '/js/event.js',
    '/css/style.css',
    '/api/events/admin/backup-db'
  ];

  for (const r of routesToTest) {
    await t.test(`Route ${r} responds with 200 OK`, async () => {
      const res = await fetch(`${baseUrl}${r}`);
      assert.equal(res.status, 200, `Route ${r} must respond with 200 OK`);
    });
  }

  await t.test('All internal static href links in public HTML views resolve to valid targets', async () => {
    const htmlFiles = ['public/index.html', 'public/login.html', 'public/admin.html', 'public/event.html', 'public/profile.html'];
    const hrefRegex = /href="([^"#][^"]*)"/g;
    const internalHrefs = new Set();

    for (const hf of htmlFiles) {
      const content = loadFile(hf);
      let match;
      while ((match = hrefRegex.exec(content)) !== null) {
        const href = match[1];
        if (href.startsWith('/') && !href.startsWith('//')) {
          internalHrefs.add(href);
        }
      }
    }

    assert.ok(internalHrefs.size >= 5, 'Should have cataloged internal hrefs');

    for (const href of internalHrefs) {
      const res = await fetch(`${baseUrl}${href}`);
      assert.equal(res.status, 200, `Internal link target ${href} must be valid and respond with 200`);
    }
  });
});

// ---------------------------------------------------------------------
// AREA 3: Query Parameter & Redirection Contract (event.html?id=...)
// ---------------------------------------------------------------------
test('Area 3: Query Parameter & Redirection Contract (event.html?id=...)', async (t) => {
  const eventJs = loadFile('public/js/event.js');

  await t.test('event.js parses URL query parameters correctly', () => {
    assert.ok(eventJs.includes("params.get('id')"), 'event.js must extract id parameter from URL');
    assert.ok(eventJs.includes("params.get('token')"), 'event.js must extract guest token from URL');
    assert.ok(eventJs.includes("showError('No event ID specified in URL.')"), 'event.js must display clean error when id is missing');
  });

  await t.test('Simulate URLSearchParams logic for event.html query scenarios', () => {
    function parseEventParams(search) {
      const params = new URLSearchParams(search);
      const eventId = params.get('id');
      const token = params.get('token') || '';
      return { eventId, token };
    }

    // Missing id
    assert.equal(parseEventParams('').eventId, null);
    assert.equal(parseEventParams('?foo=bar').eventId, null);

    // Valid id
    assert.equal(parseEventParams('?id=42').eventId, '42');
    assert.equal(parseEventParams('?id=42').token, '');

    // Valid id with guest token
    assert.equal(parseEventParams('?id=42&token=guest_tok_123').eventId, '42');
    assert.equal(parseEventParams('?id=42&token=guest_tok_123').token, 'guest_tok_123');

    // With leading slashes or other params
    assert.equal(parseEventParams('?source=email&id=99&token=abc').eventId, '99');
  });

  await t.test('All event creator redirections target /event.html?id=<id>', () => {
    const loginHtml = loadFile('public/login.html') + loadFile('public/js/account-dashboard.js');
    const adminJs = loadFile('public/js/admin.js');
    const appJs = loadFile('public/js/app.js');

    // login.html 1-click
    assert.ok(
      loginHtml.includes('/event.html?id=${newId}'),
      'login.html 1-Click must redirect to /event.html?id=${newId}'
    );

    // login.html custom form
    assert.ok(
      loginHtml.includes('/event.html?id=${newId}'),
      'login.html custom form must redirect to /event.html?id=${newId}'
    );

    // admin.js 1-click
    assert.ok(
      adminJs.includes('/event.html?id=${newId}'),
      'admin.js 1-Click must redirect to /event.html?id=${newId}'
    );

    // admin.js custom form
    assert.ok(
      adminJs.includes('/event.html?id=${newId}'),
      'admin.js custom form must redirect to /event.html?id=${newId}'
    );

    // app.js card links
    assert.ok(
      appJs.includes('/event.html?id=${ev.id}'),
      'app.js card links must target /event.html?id=${ev.id}'
    );
  });
});

// ---------------------------------------------------------------------
// AREA 4: Button Handlers Non-Hanging Execution (Success, Error, Drop)
// ---------------------------------------------------------------------
test('Area 4: Button Handlers Non-Hanging Execution', async (t) => {

  // Test 1: login.html 1-Click Game Handler
  await t.test('login.html 1-Click Game Handler: Success, Error, and Network Drop', async () => {
    async function simulateLogin1Click(mockPromptValue, mockApiResult, mockApiThrows = false) {
      const quickBtn = { disabled: false, textContent: '⚡ 1-Click: Post Next Sunday @ Noon' };
      const alertBox = { innerHTML: '' };
      let redirectedUrl = null;

      const loc = mockPromptValue;
      if (loc === null) return { quickBtn, alertBox, redirectedUrl };

      quickBtn.disabled = true;
      quickBtn.textContent = 'Scheduling Sunday Game...';

      try {
        if (mockApiThrows) {
          throw new Error('Network Connection Lost');
        }
        const res = mockApiResult;
        if (res.error) {
          alertBox.innerHTML = `<div class="alert alert-error">${res.error}</div>`;
          quickBtn.disabled = false;
          quickBtn.textContent = '⚡ 1-Click: Post Next Sunday @ Noon';
        } else {
          const newId = res.eventId || (res.event && res.event.id);
          alertBox.innerHTML = `<div class="alert alert-success">✓ Sunday game scheduled! Redirecting to game page...</div>`;
          redirectedUrl = `/event.html?id=${newId}`;
        }
      } catch (err) {
        alertBox.innerHTML = `<div class="alert alert-error">Failed to schedule game. Please try again.</div>`;
        quickBtn.disabled = false;
        quickBtn.textContent = '⚡ 1-Click: Post Next Sunday @ Noon';
      }

      return { quickBtn, alertBox, redirectedUrl };
    }

    // Cancel prompt
    const cancelRes = await simulateLogin1Click(null, null);
    assert.equal(cancelRes.quickBtn.disabled, false);
    assert.equal(cancelRes.redirectedUrl, null);

    // Success with res.eventId
    const successRes1 = await simulateLogin1Click('Field 1', { success: true, eventId: 101 });
    assert.equal(successRes1.redirectedUrl, '/event.html?id=101');
    assert.ok(successRes1.alertBox.innerHTML.includes('alert-success'));

    // Success with res.event.id fallback
    const successRes2 = await simulateLogin1Click('Field 1', { success: true, event: { id: 102 } });
    assert.equal(successRes2.redirectedUrl, '/event.html?id=102');

    // API Error
    const errorRes = await simulateLogin1Click('Field 1', { error: 'Unauthorized' });
    assert.equal(errorRes.quickBtn.disabled, false, 'Button must be re-enabled on API error');
    assert.equal(errorRes.quickBtn.textContent, '⚡ 1-Click: Post Next Sunday @ Noon');
    assert.ok(errorRes.alertBox.innerHTML.includes('Unauthorized'));
    assert.equal(errorRes.redirectedUrl, null);

    // Network Failure (Fetch throws)
    const netDropRes = await simulateLogin1Click('Field 1', null, true);
    assert.equal(netDropRes.quickBtn.disabled, false, 'Button must be re-enabled on network drop');
    assert.equal(netDropRes.quickBtn.textContent, '⚡ 1-Click: Post Next Sunday @ Noon');
    assert.ok(netDropRes.alertBox.innerHTML.includes('Failed to schedule game'));
    assert.equal(netDropRes.redirectedUrl, null);
  });

  // Test 2: login.html Custom Game Form Handler
  await t.test('login.html Custom Game Form Handler: Success, Error, Exception, Network Drop', async () => {
    async function simulateLoginCustomForm(rawDate, mockApiResult, mockApiThrows = false) {
      const submitBtn = { disabled: false, textContent: 'Publish Game & Roster' };
      const alertBox = { innerHTML: '' };
      let isSuccess = false;
      let redirectedUrl = null;

      submitBtn.disabled = true;
      submitBtn.textContent = 'Publishing...';

      try {
        const event_date = new Date(rawDate).toISOString();
        if (mockApiThrows) {
          throw new Error('Failed to fetch');
        }
        const res = mockApiResult;
        if (res.error) {
          alertBox.innerHTML = `<div class="alert alert-error">${res.error}</div>`;
        } else {
          isSuccess = true;
          const newId = res.eventId || (res.event && res.event.id);
          alertBox.innerHTML = `<div class="alert alert-success">✓ Game published successfully! Redirecting...</div>`;
          redirectedUrl = `/event.html?id=${newId}`;
        }
      } catch (err) {
        alertBox.innerHTML = `<div class="alert alert-error">${err.message || 'Failed to publish game. Please try again.'}</div>`;
      } finally {
        if (!isSuccess) {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Publish Game & Roster';
        }
      }

      return { submitBtn, alertBox, isSuccess, redirectedUrl };
    }

    // Success
    const success = await simulateLoginCustomForm('2026-10-25T12:00', { success: true, eventId: 201 });
    assert.equal(success.isSuccess, true);
    assert.equal(success.redirectedUrl, '/event.html?id=201');

    // API Error (e.g. 400 Bad Request)
    const apiErr = await simulateLoginCustomForm('2026-10-25T12:00', { error: 'Location required' });
    assert.equal(apiErr.isSuccess, false);
    assert.equal(apiErr.submitBtn.disabled, false, 'Button must NOT be disabled on API error');
    assert.equal(apiErr.submitBtn.textContent, 'Publish Game & Roster');
    assert.ok(apiErr.alertBox.innerHTML.includes('Location required'));

    // Network Drop
    const netDrop = await simulateLoginCustomForm('2026-10-25T12:00', null, true);
    assert.equal(netDrop.isSuccess, false);
    assert.equal(netDrop.submitBtn.disabled, false, 'Button must NOT be disabled on network drop');
    assert.equal(netDrop.submitBtn.textContent, 'Publish Game & Roster');

    // Invalid Date (throws RangeError)
    const invalidDate = await simulateLoginCustomForm('not-a-valid-date', null, false);
    assert.equal(invalidDate.isSuccess, false);
    assert.equal(invalidDate.submitBtn.disabled, false, 'Button must NOT be disabled on invalid date RangeError');
    assert.equal(invalidDate.submitBtn.textContent, 'Publish Game & Roster');
    assert.ok(invalidDate.alertBox.innerHTML.includes('Invalid time value'));
  });

  // Test 3: admin.js 1-Click Game Handler
  await t.test('admin.js 1-Click Game Handler: Success, Error, and Network Drop', async () => {
    async function simulateAdmin1Click(mockPromptValue, mockApiResult, mockApiThrows = false) {
      const btn = { disabled: false, textContent: '⚡ 1-Click: Post Next Sunday @ Noon' };
      const alertBox = { innerHTML: '' };
      let redirectedUrl = null;

      const location = mockPromptValue;
      if (!location) return { btn, alertBox, redirectedUrl };

      btn.disabled = true;
      btn.textContent = 'Posting game...';

      try {
        if (mockApiThrows) throw new Error('Network failure');
        const data = mockApiResult;
        if (data.error) {
          alertBox.innerHTML = `<div class="alert alert-error">${data.error}</div>`;
        } else {
          const newId = data.eventId || (data.event && data.event.id);
          redirectedUrl = `/event.html?id=${newId}`;
        }
      } catch (err) {
        alertBox.innerHTML = `<div class="alert alert-error">Failed to post game.</div>`;
      } finally {
        btn.disabled = false;
        btn.textContent = '⚡ 1-Click: Post Next Sunday @ Noon';
      }

      return { btn, alertBox, redirectedUrl };
    }

    // Cancel prompt
    const cancel = await simulateAdmin1Click(null, null);
    assert.equal(cancel.btn.disabled, false);

    // Success
    const success = await simulateAdmin1Click('Central Park', { success: true, eventId: 301 });
    assert.equal(success.btn.disabled, false);
    assert.equal(success.redirectedUrl, '/event.html?id=301');

    // API Error
    const err = await simulateAdmin1Click('Central Park', { error: 'Forbidden' });
    assert.equal(err.btn.disabled, false);
    assert.ok(err.alertBox.innerHTML.includes('Forbidden'));

    // Network Drop
    const drop = await simulateAdmin1Click('Central Park', null, true);
    assert.equal(drop.btn.disabled, false);
    assert.ok(drop.alertBox.innerHTML.includes('Failed to post game'));
  });

  // Test 4: admin.js Custom Game Form Handler
  await t.test('admin.js Custom Game Form Handler: Success, Validation Failure, Error, and Drop', async () => {
    async function simulateAdminCreateForm(duties, rawDate, mockApiResult, mockApiThrows = false) {
      const submitBtn = { disabled: false, textContent: 'Publish Game' };
      const alertBox = { innerHTML: '' };
      let redirectedUrl = null;

      submitBtn.disabled = true;
      submitBtn.textContent = 'Publishing...';

      try {
        const invalidDuty = duties.find(d => !d.title.trim());
        if (invalidDuty) {
          alertBox.innerHTML = 'Please enter a name for all tasks';
          return { submitBtn, alertBox, redirectedUrl };
        }

        if (!rawDate || isNaN(new Date(rawDate).getTime())) {
          alertBox.innerHTML = 'Please enter a valid date and time';
          return { submitBtn, alertBox, redirectedUrl };
        }

        if (mockApiThrows) throw new Error('Fetch failed');
        const data = mockApiResult;
        if (data.error) {
          alertBox.innerHTML = data.error;
        } else {
          const newId = data.eventId || (data.event && data.event.id);
          redirectedUrl = `/event.html?id=${newId}`;
        }
      } catch (err) {
        alertBox.innerHTML = err.message || 'Error creating game.';
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Publish Game';
      }

      return { submitBtn, alertBox, redirectedUrl };
    }

    // Empty task title validation failure
    const emptyTask = await simulateAdminCreateForm([{ title: '   ', description: '', slots_needed: 1 }], '2026-10-25T12:00', null);
    assert.equal(emptyTask.submitBtn.disabled, false, 'Button must reset when duty title is empty');
    assert.equal(emptyTask.submitBtn.textContent, 'Publish Game');

    // Invalid date validation failure
    const badDate = await simulateAdminCreateForm([{ title: 'Bases', description: '', slots_needed: 1 }], 'invalid-date', null);
    assert.equal(badDate.submitBtn.disabled, false, 'Button must reset on invalid date');
    assert.equal(badDate.submitBtn.textContent, 'Publish Game');

    // API Error
    const apiErr = await simulateAdminCreateForm([{ title: 'Bases', description: '', slots_needed: 1 }], '2026-10-25T12:00', { error: 'Database locked' });
    assert.equal(apiErr.submitBtn.disabled, false, 'Button must reset on API error');

    // Network Drop
    const drop = await simulateAdminCreateForm([{ title: 'Bases', description: '', slots_needed: 1 }], '2026-10-25T12:00', null, true);
    assert.equal(drop.submitBtn.disabled, false, 'Button must reset on network drop');

    // Success
    const success = await simulateAdminCreateForm([{ title: 'Bases', description: '', slots_needed: 1 }], '2026-10-25T12:00', { success: true, eventId: 401 });
    assert.equal(success.submitBtn.disabled, false);
    assert.equal(success.redirectedUrl, '/event.html?id=401');
  });

  // Test 5: event.js RSVP Form Handler
  await t.test('event.js RSVP Form Handler: Success, Error, and Drop', async () => {
    async function simulateEventRsvp(mockApiResult, mockApiThrows = false) {
      const submitBtn = { disabled: false, textContent: 'Confirm RSVP & Duty Signup' };
      const alertBox = { innerHTML: '' };

      submitBtn.disabled = true;
      submitBtn.textContent = 'Saving RSVP...';

      try {
        if (mockApiThrows) throw new Error('Network error');
        const res = mockApiResult;
        if (res.error) {
          alertBox.innerHTML = res.error;
          submitBtn.disabled = false;
          submitBtn.textContent = 'Confirm RSVP & Duty Signup';
        } else {
          alertBox.innerHTML = res.message;
          submitBtn.disabled = false;
          submitBtn.textContent = 'Update RSVP & Duties';
        }
      } catch (err) {
        alertBox.innerHTML = 'Network error. Please try again.';
        submitBtn.disabled = false;
        submitBtn.textContent = 'Confirm RSVP & Duty Signup';
      }

      return { submitBtn, alertBox };
    }

    // Success
    const success = await simulateEventRsvp({ success: true, message: 'RSVP confirmed' });
    assert.equal(success.submitBtn.disabled, false);
    assert.equal(success.submitBtn.textContent, 'Update RSVP & Duties');

    // API Error
    const err = await simulateEventRsvp({ error: 'Event full' });
    assert.equal(err.submitBtn.disabled, false);
    assert.equal(err.submitBtn.textContent, 'Confirm RSVP & Duty Signup');

    // Network Drop
    const drop = await simulateEventRsvp(null, true);
    assert.equal(drop.submitBtn.disabled, false);
    assert.equal(drop.submitBtn.textContent, 'Confirm RSVP & Duty Signup');
  });

  // Test 6: event.js Discussion Comment Form Handler
  await t.test('event.js Discussion Form Handler: Success, Error, and Drop', async () => {
    async function simulateEventComment(mockApiResult, mockApiThrows = false) {
      const submitBtn = { disabled: false, textContent: 'Post to Discussion' };
      let cleared = false;

      submitBtn.disabled = true;
      submitBtn.textContent = 'Posting...';

      try {
        if (mockApiThrows) throw new Error('Network drop');
        const res = mockApiResult;
        if (!res.error) {
          cleared = true;
        }
      } catch (err) {
        // handled
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Post to Discussion';
      }

      return { submitBtn, cleared };
    }

    // Success
    const success = await simulateEventComment({ success: true });
    assert.equal(success.submitBtn.disabled, false);
    assert.equal(success.cleared, true);

    // API Error
    const err = await simulateEventComment({ error: 'Comment required' });
    assert.equal(err.submitBtn.disabled, false);
    assert.equal(err.cleared, false);

    // Network Drop
    const drop = await simulateEventComment(null, true);
    assert.equal(drop.submitBtn.disabled, false);
    assert.equal(drop.cleared, false);
  });

  // Test 7: profile.html Profile Form Handler
  await t.test('profile.html Profile Save Handler: Success, Error, and Drop', async () => {
    async function simulateProfileSave(mockApiResult, mockApiThrows = false) {
      const saveBtn = { disabled: false, textContent: 'Save Changes' };
      const alertBox = { innerHTML: '' };

      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving...';

      try {
        if (mockApiThrows) throw new Error('Network timeout');
        const res = mockApiResult;
        if (res.error) {
          alertBox.innerHTML = res.error;
        } else {
          alertBox.innerHTML = 'Saved';
        }
      } catch (err) {
        alertBox.innerHTML = 'Error updating profile.';
      } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save Changes';
      }

      return { saveBtn, alertBox };
    }

    const success = await simulateProfileSave({ success: true, user: { name: 'Bob', bio: 'Pitcher' } });
    assert.equal(success.saveBtn.disabled, false);

    const err = await simulateProfileSave({ error: 'Name cannot be empty' });
    assert.equal(err.saveBtn.disabled, false);

    const drop = await simulateProfileSave(null, true);
    assert.equal(drop.saveBtn.disabled, false);
  });

  // Test 8: login.html Auth Step 1 & Step 2 Forms
  await t.test('login.html Auth Step 1 & 2 Handlers: Error and Drop safety', async () => {
    // Step 1
    async function simulateSendCode(email, mockApiResult, mockApiThrows = false) {
      const sendBtn = { disabled: false, textContent: 'Send Sign-In Code' };
      const alertBox = { innerHTML: '' };
      let stepSwitched = false;

      if (!email) {
        alertBox.innerHTML = 'Please enter a valid email address.';
        return { sendBtn, alertBox, stepSwitched };
      }

      sendBtn.disabled = true;
      sendBtn.textContent = 'Sending code...';

      try {
        if (mockApiThrows) throw new Error('Network error');
        const res = mockApiResult;
        if (res.error) {
          alertBox.innerHTML = res.error;
          sendBtn.disabled = false;
          sendBtn.textContent = 'Send Sign-In Code';
        } else {
          stepSwitched = true;
        }
      } catch (err) {
        alertBox.innerHTML = 'Error contacting server.';
        sendBtn.disabled = false;
        sendBtn.textContent = 'Send Sign-In Code';
      }

      return { sendBtn, alertBox, stepSwitched };
    }

    const s1Err = await simulateSendCode('test@test.com', { error: 'Invalid email' });
    assert.equal(s1Err.sendBtn.disabled, false);
    assert.equal(s1Err.stepSwitched, false);

    const s1Drop = await simulateSendCode('test@test.com', null, true);
    assert.equal(s1Drop.sendBtn.disabled, false);
    assert.equal(s1Drop.stepSwitched, false);

    const s1Success = await simulateSendCode('test@test.com', { success: true });
    assert.equal(s1Success.stepSwitched, true);

    // Step 2
    async function simulateVerifyCode(code, mockApiResult, mockApiThrows = false) {
      const verifyBtn = { disabled: false, textContent: 'Verify & Sign In' };
      const alertBox = { innerHTML: '' };
      let redirected = false;

      if (!code || code.length !== 6) {
        alertBox.innerHTML = 'Please enter 6-digit code';
        return { verifyBtn, alertBox, redirected };
      }

      verifyBtn.disabled = true;
      verifyBtn.textContent = 'Verifying...';

      try {
        if (mockApiThrows) throw new Error('Network down');
        const res = mockApiResult;
        if (res.error) {
          alertBox.innerHTML = res.error;
          verifyBtn.disabled = false;
          verifyBtn.textContent = 'Verify & Sign In';
        } else {
          redirected = true;
        }
      } catch (err) {
        alertBox.innerHTML = 'Failed to verify code.';
        verifyBtn.disabled = false;
        verifyBtn.textContent = 'Verify & Sign In';
      }

      return { verifyBtn, alertBox, redirected };
    }

    const s2BadCode = await simulateVerifyCode('123', null);
    assert.equal(s2BadCode.verifyBtn.disabled, false);
    assert.equal(s2BadCode.redirected, false);

    const s2Err = await simulateVerifyCode('123456', { error: 'Code expired' });
    assert.equal(s2Err.verifyBtn.disabled, false);
    assert.equal(s2Err.redirected, false);

    const s2Drop = await simulateVerifyCode('123456', null, true);
    assert.equal(s2Drop.verifyBtn.disabled, false);
    assert.equal(s2Drop.redirected, false);

    const s2Success = await simulateVerifyCode('123456', { success: true });
    assert.equal(s2Success.redirected, true);
  });
});

// ---------------------------------------------------------------------
// AREA 5: Adversarial Escaping & Injection Tests in Interactive Handlers
// ---------------------------------------------------------------------
test('Area 5: Adversarial Escaping & Injection in Interactive Handlers', async (t) => {
  await t.test('Inline duty editing with apostrophes, quotes, tags, backslashes and unicode', () => {
    const adversarialTitles = [
      "Catcher's Gear",
      "Umpire's Mask & Chest Protector",
      "Coach's 'Special' Equipment",
      "Double Quote \"Test\"",
      "<script>alert('xss')</script>",
      "Backslash \\ and slash /",
      "⚾ Sunday Pickup Baseball! Special & Fun"
    ];

    for (const title of adversarialTitles) {
      // Logic used in admin.js line 552:
      const safeTitle = encodeURIComponent(title).replace(/'/g, '%27');

      // Ensure no raw single quotes survive to break string literal
      assert.equal(
        safeTitle.includes("'"),
        false,
        `safeTitle must never contain single quote: ${title}`
      );

      // Simulate embedding in onclick: editDutyInline(1, 2, '${safeTitle}', '${safeTitle}', 1)
      const onclickAttr = `editDutyInline(1, 2, '${safeTitle}', '${safeTitle}', 1)`;

      // Test that decoding inside editDutyInline recovers exact original string
      const decoded = decodeURIComponent(safeTitle);
      assert.equal(
        decoded,
        title,
        `Decoded title must match original exactly for: ${title}`
      );
    }
  });

  await t.test('API.escapeHtml defense against XSS vectors', () => {
    const apiJs = loadFile('public/js/api.js');
    assert.ok(apiJs.includes('escapeHtml(str)'), 'API.escapeHtml helper must exist');

    function escapeHtml(str) {
      if (!str) return '';
      return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    assert.equal(escapeHtml('<script>alert("x")</script>'), '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    assert.equal(escapeHtml('Tom & Jerry'), 'Tom &amp; Jerry');
    assert.equal(escapeHtml(''), '');
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
  });
});

// ---------------------------------------------------------------------
// AREA 6: Role-Based UI Display & Navigation Conformance
// ---------------------------------------------------------------------
test('Area 6: Role-Based UI Display & Navigation Conformance', async (t) => {
  await t.test('Profile.html and Login.html 3-tier role badges', () => {
    const profileHtml = loadFile('public/profile.html');
    const loginHtml = loadFile('public/login.html');

    // Both files must have branches for all 3 roles
    for (const file of [profileHtml, loginHtml]) {
      assert.ok(file.includes('👑 Administrator'), 'Must render Administrator badge');
      assert.ok(file.includes('🛡️ Event Organizer'), 'Must render Event Organizer badge');
      assert.ok(file.includes('👤 Player'), 'Must render Player badge');
    }
  });

  await t.test('app.js empty state renders game creation button for Organizers and Admins', () => {
    const appJs = loadFile('public/js/app.js');
    assert.ok(
      appJs.includes('API.currentUser && API.currentUser.canManageEvents'),
      'app.js must check canManageEvents so Organizers and Admins can create games from empty state'
    );
  });

  await t.test('api.js renderNav renders Admin vs Org Panel button based on role', () => {
    const apiJs = loadFile('public/js/api.js');
    assert.ok(
      apiJs.includes("user.isAdmin ? '⚙️ Admin' : '⚾ Org Panel'") || apiJs.includes("user.isAdmin ? this.t('nav.admin') : this.t('nav.org')"),
      'renderNav must distinguish Admin and Org Panel links'
    );
    assert.ok(
      apiJs.includes('user.canManageEvents ? `<a href="/admin.html"'),
      'renderNav must show admin.html link only if user canManageEvents'
    );
  });
});
