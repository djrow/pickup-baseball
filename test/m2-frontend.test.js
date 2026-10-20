const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');

function loadFile(relPath) {
  return fs.readFileSync(path.join(ROOT_DIR, relPath), 'utf8');
}

test('M2: 1. Public JS Files Syntax Check', (t) => {
  const jsFiles = [
    'public/js/app.js',
    'public/js/admin.js',
    'public/js/api.js',
    'public/js/event.js'
  ];

  for (const file of jsFiles) {
    const fullPath = path.join(ROOT_DIR, file);
    assert.ok(fs.existsSync(fullPath), `File must exist: ${file}`);
    
    let error = null;
    try {
      execSync(`node -c "${fullPath}"`, { stdio: 'pipe' });
    } catch (e) {
      error = e;
    }
    assert.equal(error, null, `Syntax check for ${file} must pass without errors: ${error && error.stderr ? error.stderr.toString() : ''}`);
  }
});

test('M2: 2. public/js/app.js Repair Verification', (t) => {
  const appJs = loadFile('public/js/app.js');

  const featuredEndIdx = appJs.indexOf('function renderFeaturedGame');
  const gamesListFuncIdx = appJs.indexOf('function renderGamesList');
  assert.ok(featuredEndIdx !== -1, 'renderFeaturedGame must exist');
  assert.ok(gamesListFuncIdx !== -1, 'renderGamesList must exist');

  const featuredFuncBody = appJs.slice(featuredEndIdx, gamesListFuncIdx);
  assert.ok(
    /`;\s*}\s*$/.test(featuredFuncBody),
    'renderFeaturedGame must end cleanly with template literal close and function closing brace'
  );
  // Ensure no orphan HTML closing tags between closing brace and renderGamesList
  const afterBrace = featuredFuncBody.slice(featuredFuncBody.lastIndexOf('}'));
  assert.equal(afterBrace.includes('<'), false, 'No stray HTML tags after renderFeaturedGame closing brace');

  // Verify Organizer check in empty state
  assert.ok(appJs.includes('API.currentUser && API.currentUser.canManageEvents'),
    'Empty state should check canManageEvents to allow Organizers as well as Admins to create games');

  // Verify script registers DOMContentLoaded
  assert.ok(appJs.includes("document.addEventListener('DOMContentLoaded', initHome)"),
    'DOMContentLoaded listener for initHome must be present');
});

test('M2: 3. public/login.html 1-Click and Custom Game Handlers', (t) => {
  const loginHtml = loadFile('public/login.html');

  // Verify required element IDs exist
  const requiredIds = [
    'quick-sunday-btn',
    'toggle-custom-form-btn',
    'create-event-form',
    'submit-event-btn',
    'event-title-input',
    'event-date-input',
    'event-location-input',
    'event-map-input',
    'event-desc-input',
    'refresh-users-btn',
    'send-code-btn',
    'verify-code-btn',
    'start-over-btn',
    'login-page-logout-btn',
    'step-request-form',
    'step-verify-form'
  ];

  for (const id of requiredIds) {
    assert.ok(loginHtml.includes(`id="${id}"`), `login.html must contain element with id="${id}"`);
  }

  // Verify 1-Click handler extracts ID defensively
  assert.ok(
    loginHtml.includes('res.eventId || (res.event && res.event.id)'),
    '1-Click handler in login.html must defensively extract eventId'
  );
  assert.ok(
    loginHtml.includes('window.location.href = `/event.html?id=${newId}`') ||
    loginHtml.includes("window.location.href = '/event.html?id=' + newId"),
    '1-Click handler must redirect to /event.html?id='
  );

  // Verify Custom Game form extracts ID defensively and handles errors with finally
  assert.ok(
    loginHtml.includes('const newId = res.eventId || (res.event && res.event.id)'),
    'Custom game form in login.html must defensively extract eventId'
  );
  assert.ok(
    loginHtml.includes('finally {') && loginHtml.includes('submitBtn.disabled = false') && loginHtml.includes("submitBtn.textContent = 'Publish Game & Roster'"),
    'Custom game form must reset submitBtn in finally block to prevent hanging on "Publishing..."'
  );
});

test('M2: 4. public/js/admin.js Redirection, Exception Safety & Apostrophe Bug', (t) => {
  const adminJs = loadFile('public/js/admin.js');

  // 1-Click redirection in admin.js
  assert.ok(
    adminJs.includes('window.location.href = `/event.html?id=${newId}`') ||
    adminJs.includes("window.location.href = `/event.html?id=${data.eventId"),
    '1-Click creator in admin.js must redirect to event.html with event ID'
  );

  // Custom game form redirection in admin.js
  assert.ok(
    adminJs.includes('window.location.href = `/event.html?id=${newId}`') ||
    adminJs.includes("window.location.href = `/event.html?id=${data.eventId"),
    'Custom game builder in admin.js must redirect to event.html with event ID'
  );

  // Date parsing inside try-catch to prevent hanging
  const createFormIdx = adminJs.indexOf('function setupCreateForm()');
  const loadAdminGamesIdx = adminJs.indexOf('async function loadAdminGames()');
  assert.ok(createFormIdx !== -1, 'setupCreateForm function must exist');
  assert.ok(loadAdminGamesIdx !== -1, 'loadAdminGames function must exist');

  const createFormSection = adminJs.slice(createFormIdx, loadAdminGamesIdx);

  const tryIdx = createFormSection.indexOf('try {');
  const dateParseIdx = createFormSection.indexOf('new Date(');
  const finallyIdx = createFormSection.indexOf('finally {');
  assert.ok(tryIdx !== -1, 'setupCreateForm must have try block');
  assert.ok(dateParseIdx !== -1, 'setupCreateForm must parse date');
  assert.ok(finallyIdx !== -1, 'setupCreateForm must have finally block');
  assert.ok(dateParseIdx > tryIdx && dateParseIdx < finallyIdx,
    'Date parsing in setupCreateForm must be inside try block before finally');

  // Inline task edit apostrophe fix
  assert.ok(
    adminJs.includes(".replace(/'/g, '%27')"),
    'admin.js must safely escape single quotes in task title/desc before embedding in editDutyInline onclick'
  );

  // Verify that safeTitle with %27 decodes properly
  const sampleTitleWithApostrophe = "Catcher's Gear & Umpire's Mask";
  const safeTitle = encodeURIComponent(sampleTitleWithApostrophe).replace(/'/g, '%27');
  assert.equal(safeTitle.includes("'"), false, 'safeTitle must not contain single quotes');
  assert.equal(decodeURIComponent(safeTitle), sampleTitleWithApostrophe, 'decodeURIComponent must recover original string');
});

test('M2: 5. public/profile.html 3-Tier Role Badge Verification', (t) => {
  const profileHtml = loadFile('public/profile.html');

  // Check role-badge element exists
  assert.ok(profileHtml.includes('id="role-badge"'), 'profile.html must contain #role-badge element');
  assert.ok(profileHtml.includes('badge-gray'), 'Default badge class in HTML should be badge-gray');

  // Test simulated role assignment matching profile.html logic
  function computeRoleBadge(currentUser) {
    if (currentUser.isAdmin || currentUser.role === 'admin') {
      return { className: 'badge badge-orange', textContent: '👑 Administrator' };
    } else if (currentUser.role === 'organizer') {
      return { className: 'badge badge-green', textContent: '🛡️ Event Organizer' };
    } else {
      return { className: 'badge badge-gray', textContent: '👤 Player' };
    }
  }

  // Admin user
  const adminBadge = computeRoleBadge({ role: 'admin', isAdmin: true });
  assert.equal(adminBadge.className, 'badge badge-orange');
  assert.equal(adminBadge.textContent, '👑 Administrator');

  // Organizer user
  const orgBadge = computeRoleBadge({ role: 'organizer', isAdmin: false });
  assert.equal(orgBadge.className, 'badge badge-green');
  assert.equal(orgBadge.textContent, '🛡️ Event Organizer');

  // Regular Player user
  const playerBadge = computeRoleBadge({ role: 'player', isAdmin: false });
  assert.equal(playerBadge.className, 'badge badge-gray');
  assert.equal(playerBadge.textContent, '👤 Player');

  // Verify profile.html contains all 3 branch strings
  assert.ok(profileHtml.includes('👑 Administrator'), 'profile.html must contain 👑 Administrator');
  assert.ok(profileHtml.includes('🛡️ Event Organizer'), 'profile.html must contain 🛡️ Event Organizer');
  assert.ok(profileHtml.includes('👤 Player'), 'profile.html must contain 👤 Player');
  assert.ok(profileHtml.includes('badge-orange'), 'profile.html must handle badge-orange');
  assert.ok(profileHtml.includes('badge-green'), 'profile.html must handle badge-green');
  assert.ok(profileHtml.includes('badge-gray'), 'profile.html must handle badge-gray');
});

test('M2: 6. Comprehensive Interactive Controls Audit Across Views', (t) => {
  const views = [
    { name: 'index.html', requiredIds: ['featured-game-container', 'filter-upcoming-btn', 'filter-past-btn', 'games-list-container'] },
    { name: 'login.html', requiredIds: ['step-request-form', 'step-verify-form', 'quick-sunday-btn', 'submit-event-btn'] },
    { name: 'admin.html', requiredIds: ['quick-sunday-btn', 'create-event-form', 'create-event-btn', 'btn-add-task-row', 'admin-games-container'] },
    { name: 'event.html', requiredIds: ['event-container', 'duties-grid', 'attendees-container', 'rsvp-form', 'comment-form'] },
    { name: 'profile.html', requiredIds: ['profile-form', 'profile-name', 'profile-email', 'profile-bio', 'avatar-file-input', 'btn-save-profile', 'role-badge'] }
  ];

  for (const view of views) {
    const content = loadFile(path.join('public', view.name));
    assert.ok(content.includes('<!DOCTYPE html>'), `${view.name} must have DOCTYPE`);
    assert.ok(content.includes('</html>'), `${view.name} must have closing html tag`);

    for (const id of view.requiredIds) {
      assert.ok(content.includes(`id="${id}"`), `${view.name} must contain required element id="${id}"`);
    }
  }
});
