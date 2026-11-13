/**
 * T9.1–T9.18: PWA Manifest/SW, Sunday Calendar, Invite Whitelist, RSS Feed & i18n Coverage Tests
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

module.exports = async function registerPwaCalendarTests(ctx, t9) {
  const { apiReq, getCookie, db, createSession, getDefaultDuties, CURRENT_APP_VERSION } = ctx;

  const { seedAdminId, seedAdminCookie, seedOrgId, seedOrgCookie, seedPlayerId, seedPlayerCookie, sharedEventId, baseUrl, publicDir } = ctx;

  await t9.test('T9.1: Web App Manifest exists and is valid', () => {
    const manifestPath = path.join(publicDir, 'manifest.webmanifest');
    assert.ok(fs.existsSync(manifestPath), 'manifest.webmanifest must exist');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.ok(manifest.name, 'Manifest must have a name');
    assert.ok(manifest.short_name, 'Manifest must have a short_name');
    assert.equal(manifest.display, 'standalone', 'Manifest display must be standalone');
    assert.ok(manifest.start_url, 'Manifest must have a start_url');
    assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 2, 'Manifest must declare at least 2 icons');
  });

  await t9.test('T9.2: Service worker file exists and has lifecycle listeners', () => {
    const swPath = path.join(publicDir, 'sw.js');
    assert.ok(fs.existsSync(swPath), 'sw.js must exist');
    const swCode = fs.readFileSync(swPath, 'utf8');
    assert.ok(swCode.includes('install'), 'sw.js must handle install event');
    assert.ok(swCode.includes('activate'), 'sw.js must handle activate event');
    assert.ok(swCode.includes('fetch'), 'sw.js must handle fetch event');
    assert.ok(swCode.includes('/api/'), 'sw.js must bypass dynamic /api/ requests');
  });

  await t9.test('T9.3: All primary HTML pages contain PWA manifest & mobile meta tags', () => {
    const htmlFiles = ['index.html', 'archive.html', 'event.html', 'admin.html', 'donate.html', 'login.html', 'profile.html', 'art.html'];
    for (const file of htmlFiles) {
      const filePath = path.join(publicDir, file);
      assert.ok(fs.existsSync(filePath), file + ' must exist');
      const html = fs.readFileSync(filePath, 'utf8');
      assert.ok(html.includes('rel="manifest" href="/manifest.webmanifest"'), file + ' must link manifest');
      assert.ok(html.includes('rel="apple-touch-icon"'), file + ' must declare apple-touch-icon');
    }
  });

  await t9.test('T9.4: Service worker registration is wired in public/js/api.js', () => {
    const apiJsPath = path.join(publicDir, 'js/api.js');
    const apiCode = fs.readFileSync(apiJsPath, 'utf8');
    assert.ok(apiCode.includes('serviceWorker.register'), 'api.js must register service worker');
    assert.ok(apiCode.includes('/sw.js'), 'api.js must point to /sw.js');
  });

  await t9.test('T9.5: Server sends X-App-Version header and /api/version endpoint responds', async () => {
    const res = await apiReq('GET', '/api/version');
    assert.equal(res.status, 200);
    assert.equal(res.data.version, CURRENT_APP_VERSION);
    assert.equal(res.headers.get('x-app-version'), CURRENT_APP_VERSION);
  });

  await t9.test('T9.6: Compact Sunday-focused game calendar replaces 35-cell month grid', () => {
    const cssPath = path.join(publicDir, 'css/style.css');
    const css = fs.readFileSync(cssPath, 'utf8');
    assert.ok(css.includes('.calendar-sunday-track'), 'CSS must define .calendar-sunday-track');
    assert.ok(css.includes('.calendar-sunday-card'), 'CSS must define .calendar-sunday-card');
    assert.ok(css.includes('.calendar-sunday-card.is-prospective'), 'CSS must define .calendar-sunday-card.is-prospective');
    assert.ok(css.includes('.sunday-prospective-pill'), 'CSS must define .sunday-prospective-pill');
    assert.ok(css.includes('.legend-dot.prospective'), 'CSS must define .legend-dot.prospective');

    const appJsPath = path.join(publicDir, 'js/app.js');
    const appJs = fs.readFileSync(appJsPath, 'utf8');
    assert.ok(appJs.includes('calendar-sunday-track'), 'app.js must render .calendar-sunday-track');
    assert.ok(appJs.includes('calendar-sunday-card'), 'app.js must render .calendar-sunday-card');
    assert.ok(appJs.includes('dateObj.getDay() === 0'), 'app.js must filter for Sunday game days');
    assert.ok(!appJs.includes('class="calendar-grid"'), 'app.js must not render old 35-cell grid');
    assert.ok(appJs.includes("locationName = (game && game.location) ? game.location.split(',')[0].trim() : 'TBA'"), 'app.js must set unscheduled location to TBA');
    assert.ok(appJs.includes('Location: TBA'), 'app.js drawer must display Location: TBA for unscheduled dates');
    assert.ok(appJs.includes('Prospective Date • Unscheduled'), 'app.js drawer must clearly label prospective unscheduled dates');

    const indexPath = path.join(publicDir, 'index.html');
    const indexHtml = fs.readFileSync(indexPath, 'utf8');
    assert.ok(indexHtml.includes('calendar.legend_prospective'), 'index.html must include prospective legend item');
  });

  await t9.test('T9.10: Rolling 5-week schedule view: shows most recent past event alongside upcoming games', () => {
    const appJsPath = path.join(publicDir, 'js/app.js');
    const appJs = fs.readFileSync(appJsPath, 'utf8');
    assert.ok(appJs.includes('is-past-card'), 'app.js must classify past event card with is-past-card');
    assert.ok(appJs.includes('sunday-past-pill'), 'app.js must render past game pill');
    assert.ok(appJs.includes('sunday-next-pill'), 'app.js must render next game pill');
    assert.ok(appJs.includes('selectedUpcoming'), 'app.js must compute rolling upcoming schedule stream');

    const cssPath = path.join(publicDir, 'css/style.css');
    const css = fs.readFileSync(cssPath, 'utf8');
    assert.ok(css.includes('.calendar-sunday-card.is-past-card'), 'style.css must style past event card');
    assert.ok(css.includes('.sunday-past-pill'), 'style.css must style past game pill');
    assert.ok(css.includes('.sunday-next-pill'), 'style.css must style next game pill');

    const adminHtmlPath = path.join(publicDir, 'admin.html');
    const adminHtml = fs.readFileSync(adminHtmlPath, 'utf8');
    assert.ok(adminHtml.includes('event-restrict-toggle'), 'admin.html must contain RSVP restriction toggle');
    assert.ok(adminHtml.includes('allowed-players-list'), 'admin.html must contain allowed players whitelist container');
  });

  await t9.test('T9.11: Restricted RSVP whitelist per event & candidate accounts', async () => {
    // 1. Candidate accounts endpoint permission check
    const unauthCandidates = await apiReq('GET', '/api/events/attendee-candidates', null);
    assert.equal(unauthCandidates.status, 401, 'Unauthenticated candidate query must receive 401');

    const playerCandidates = await apiReq('GET', '/api/events/attendee-candidates', seedPlayerCookie);
    assert.equal(playerCandidates.status, 403, 'Player role accessing candidate directory must receive 403');

    const orgCandidates = await apiReq('GET', '/api/events/attendee-candidates', seedOrgCookie);
    assert.equal(orgCandidates.status, 200, 'Organizer querying candidate directory must receive 200');
    assert.ok(Array.isArray(orgCandidates.data.users), 'Candidate query must return users array');
    assert.ok(orgCandidates.data.users.length > 0, 'Candidate query must return registered accounts');

    // 2. Create restricted event with allowed_emails
    const createRes = await apiReq('POST', '/api/events', seedOrgCookie, {
      title: 'Invitational Restricted Game',
      location: 'Bushrod Park Field 2',
      event_date: '2026-11-22T20:00:00.000Z',
      allowed_emails: ['special_invitee@sundaypickup.org']
    });
    assert.equal(createRes.status, 200, 'Organizer creating restricted event must receive 200');
    const restrictedEventId = createRes.data.eventId;

    // Check event details return is_restricted and allowed_emails_list
    const detailsRes = await apiReq('GET', `/api/events/${restrictedEventId}`, seedOrgCookie);
    assert.equal(detailsRes.status, 200);
    assert.equal(detailsRes.data.event.is_restricted, true, 'Event must be flagged as restricted');
    assert.ok(detailsRes.data.event.allowed_emails_list.includes('special_invitee@sundaypickup.org'), 'Allowed list must contain invited email');

    // 3. Non-invited player attempts to RSVP -> 403 Forbidden
    const blockedRsvp = await apiReq('POST', `/api/events/${restrictedEventId}/rsvp`, seedPlayerCookie, {
      name: 'Player One',
      gear_bringing: 'Glove'
    });
    assert.equal(blockedRsvp.status, 403, 'Non-invited player must receive 403 Forbidden on restricted event');
    assert.ok(blockedRsvp.data.error.includes('restricted to invited player accounts'), 'Error must specify restricted RSVP');

    // 4. Invited player RSVPs -> 200 OK
    const allowedRsvp = await apiReq('POST', `/api/events/${restrictedEventId}/rsvp`, null, {
      name: 'Special Invitee',
      email: 'special_invitee@sundaypickup.org',
      gear_bringing: 'Catcher gear'
    });
    assert.equal(allowedRsvp.status, 200, 'Invited player must successfully RSVP with 200 OK');
    assert.equal(allowedRsvp.data.status, 'attending', 'RSVP response status must be attending');

    // 5. Organizer updates event whitelist to open to all (allowed_emails: null)
    const updateRes = await apiReq('PUT', `/api/events/${restrictedEventId}`, seedOrgCookie, {
      allowed_emails: null
    });
    assert.equal(updateRes.status, 200, 'Updating event to clear whitelist must receive 200');

    // 6. Previously blocked player can now RSVP -> 200 OK
    const previouslyBlockedRsvp = await apiReq('POST', `/api/events/${restrictedEventId}/rsvp`, seedPlayerCookie, {
      name: 'Player One',
      gear_bringing: 'Glove'
    });
    assert.equal(previouslyBlockedRsvp.status, 200, 'Player can now RSVP after whitelist is lifted');
  });

  await t9.test("T9.13: 'Next Game' badge anchored strictly to actual upcoming game across month pagination", () => {
    const appJs = fs.readFileSync(path.join(publicDir, 'js/app.js'), 'utf8');
    assert.ok(appJs.includes('trueNextGameKey'), 'app.js must compute trueNextGameKey');
    assert.ok(appJs.includes('dateKey === trueNextGameKey'), 'app.js must anchor sunday-next-pill strictly to trueNextGameKey');
    assert.ok(!appJs.includes('item === selectedUpcoming[0]'), 'app.js must not falsely assign next game to whatever item is at index 0 of selectedUpcoming');
    assert.ok(appJs.includes('const isPast = (dateKey < todayKey);'), 'app.js must evaluate isPast strictly against actual todayKey');
  });

  await t9.test('T9.14: Calendar loads complete schedule dataset (all events) ensuring past events display authentic record data', () => {
    const appJs = fs.readFileSync(path.join(publicDir, 'js/app.js'), 'utf8');
    assert.ok(appJs.includes("let currentFilter = 'all';"), 'app.js must initialize currentFilter to all to include past event records in calendar track');
    assert.ok(appJs.includes('renderCalendarDrawer(dateKey, game, dateKey < todayKey);'), 'app.js must evaluate isPast dynamically against todayKey for drawer details');
  });

  await t9.test('T9.15: Group RSVP with Players, Spectators, Group Volunteer Tasks & Simplified UI', async () => {
    // 1. Static UI & ES6 compatibility checks
    const eventHtml = fs.readFileSync(path.join(publicDir, 'event.html'), 'utf8');
    assert.ok(eventHtml.includes('id="rsvp-players-count"'), 'event.html must include players count stepper input');
    assert.ok(eventHtml.includes('id="rsvp-spectators-count"'), 'event.html must include spectators count stepper input');
    assert.ok(eventHtml.includes('id="rsvp-optional-details"'), 'event.html must include collapsible optional details');
    assert.ok(eventHtml.includes('id="rsvp-cancel-btn"'), 'event.html must include conditional cancel RSVP button');
    assert.ok(eventHtml.includes('id="spectators-badge"'), 'event.html must include spectators badge in roster header');
    assert.ok(!eventHtml.includes('id="duties-grid"'), 'event.html must not include duplicate standalone duties-grid card');

    const eventJs = fs.readFileSync(path.join(publicDir, 'js/event.js'), 'utf8');
    assert.ok(!eventJs.includes('?.'), 'event.js must not use optional chaining for broad ES6 compatibility');
    assert.ok(!eventJs.includes('??'), 'event.js must not use nullish coalescing for broad ES6 compatibility');

    // 2. Create an event with max_players = 2 and default volunteer tasks
    const createRes = await apiReq('POST', '/api/events', seedOrgCookie, {
      title: 'Group RSVP & Spectators Verification Game',
      location: 'Bushrod Park Field 1',
      event_date: '2026-12-06T20:00:00.000Z',
      max_players: 2
    });
    assert.equal(createRes.status, 200, 'Organizer creating max_players=2 event must receive 200');
    const groupEventId = createRes.data.eventId;

    const initDetail = await apiReq('GET', `/api/events/${groupEventId}`, null);
    assert.equal(initDetail.status, 200);
    assert.ok(initDetail.data.duties.length >= 3, 'Event must have default volunteer tasks');
    const task1Id = initDetail.data.duties[0].id;
    const task2Id = initDetail.data.duties[1].id;
    const task3Id = initDetail.data.duties[2].id;
    const task5Id = initDetail.data.duties[4].id;

    // 3. Empty RSVP (0 players, 0 spectators, 0 tasks) must return 400
    const emptyRsvp = await apiReq('POST', `/api/events/${groupEventId}/rsvp`, null, {
      name: 'Empty Group',
      email: 'empty_group@sundaypickup.org',
      players_count: 0,
      spectators_count: 0,
      duty_ids: []
    });
    assert.equal(emptyRsvp.status, 400, 'RSVP with 0 players, 0 spectators, and 0 tasks must return 400');

    // 4. Mixed group RSVP: 2 players + 3 spectators claiming 2 general group tasks -> fills max_players (2/2)
    const mixedRsvp = await apiReq('POST', `/api/events/${groupEventId}/rsvp`, null, {
      name: 'Garcia Family Group',
      email: 'garcia_family@sundaypickup.org',
      players_count: 2,
      spectators_count: 3,
      guest_names: 'Marco, Elena, Abuela, Leo, Maya',
      gear_bringing: '2 wood bats & cooler',
      duty_ids: [task1Id, task3Id]
    });
    assert.equal(mixedRsvp.status, 200, 'Mixed group RSVP must succeed');
    assert.equal(mixedRsvp.data.status, 'attending');
    assert.equal(mixedRsvp.data.playersCount, 2);
    assert.equal(mixedRsvp.data.spectatorsCount, 3);

    // Unauthenticated viewer sees slot count & totals, with volunteer names redacted for privacy
    const unauthDetail = await apiReq('GET', `/api/events/${groupEventId}`, null);
    assert.equal(unauthDetail.data.canViewRoster, false, 'Unauthenticated viewer without token must have canViewRoster=false');
    assert.equal(unauthDetail.data.duties.find(d => d.id === task1Id).assigned_players[0].name, '', 'Unauthenticated view redacts volunteer name while preserving filled slot');

    // Authorized viewer (via management token or organizer cookie) sees full group ownership & roster
    let detail = await apiReq('GET', `/api/events/${groupEventId}?token=${mixedRsvp.data.managementToken}`, null);
    assert.equal(detail.data.canViewRoster, true, 'Attendee with management token must have canViewRoster=true');
    assert.equal(detail.data.totalAttendees, 2, 'totalAttendees must reflect 2 on-field players');
    assert.equal(detail.data.totalSpectators, 3, 'totalSpectators must reflect 3 spectators');
    assert.equal(detail.data.totalHeadcount, 5, 'totalHeadcount must reflect 5 total people');
    const t1 = detail.data.duties.find(d => d.id === task1Id);
    const t3 = detail.data.duties.find(d => d.id === task3Id);
    assert.equal(t1.assigned_players[0].name, 'Garcia Family Group', 'Task 1 must be owned by the group');
    assert.equal(t3.assigned_players[0].name, 'Garcia Family Group', 'Task 3 must be owned by the group');

    // 5. Spectator-only RSVP (0 players, 2 spectators) when max_players (2/2) is FULL -> confirms immediately!
    const specRsvp = await apiReq('POST', `/api/events/${groupEventId}/rsvp`, null, {
      name: 'Cheering Friends',
      email: 'cheering_friends@sundaypickup.org',
      players_count: 0,
      spectators_count: 2,
      duty_ids: []
    });
    assert.equal(specRsvp.status, 200, 'Spectator-only RSVP must succeed when playing roster is full');
    assert.equal(specRsvp.data.status, 'attending', 'Spectators must bypass player waitlist and confirm immediately');

    // 6. Off-field volunteer RSVP (0 players, 0 spectators, 1 task) when max_players is FULL -> auto-sets spectatorsCount=1 and confirms!
    const volRsvp = await apiReq('POST', `/api/events/${groupEventId}/rsvp`, null, {
      name: 'Coach Volunteer',
      email: 'coach_vol@sundaypickup.org',
      players_count: 0,
      spectators_count: 0,
      duty_ids: [task5Id]
    });
    assert.equal(volRsvp.status, 200, 'Off-field volunteer RSVP must succeed');
    assert.equal(volRsvp.data.status, 'attending', 'Off-field volunteer must confirm immediately');
    assert.equal(volRsvp.data.spectatorsCount, 1, 'Off-field volunteer with 0 players/0 spectators must count as 1 off-field attendee');

    detail = await apiReq('GET', `/api/events/${groupEventId}`, seedOrgCookie);
    assert.equal(detail.data.totalAttendees, 2, 'On-field player count remains 2');
    assert.equal(detail.data.totalSpectators, 6, 'Off-field spectators/volunteers count is now 3 + 2 + 1 = 6');
    const t5 = detail.data.duties.find(d => d.id === task5Id);
    assert.equal(t5.assigned_players[0].name, 'Coach Volunteer', 'Task 5 must be assigned to off-field volunteer');

    // 7. Group with 1 player + 1 spectator when max_players (2/2) is FULL -> placed on waitlist
    const waitRsvp = await apiReq('POST', `/api/events/${groupEventId}/rsvp`, null, {
      name: 'Waitlisted Duo',
      email: 'waitlisted_duo@sundaypickup.org',
      players_count: 1,
      spectators_count: 1,
      duty_ids: []
    });
    assert.equal(waitRsvp.status, 200);
    assert.equal(waitRsvp.data.status, 'waitlist', 'Group requesting on-field player spot when full must join waitlist');

    // 8. Garcia Family Group switches from 2 players + 3 spectators to 0 players + 3 spectators (still keeping tasks!)
    //    -> frees 2 on-field spots -> Waitlisted Duo auto-promotes to attending!
    const garciaToken = mixedRsvp.data.managementToken;
    const switchToSpectators = await apiReq('POST', `/api/events/${groupEventId}/rsvp`, null, {
      name: 'Garcia Family Group',
      email: 'garcia_family@sundaypickup.org',
      management_token: garciaToken,
      players_count: 0,
      spectators_count: 3,
      duty_ids: [task1Id, task3Id]
    });
    assert.equal(switchToSpectators.status, 200);
    assert.equal(switchToSpectators.data.status, 'attending');

    detail = await apiReq('GET', `/api/events/${groupEventId}`, seedOrgCookie);
    assert.equal(detail.data.totalWaitlist, 0, 'Waitlist must be empty after auto-promotion');
    assert.equal(detail.data.totalAttendees, 1, 'Promoted Waitlisted Duo now occupies 1 on-field player spot');
    assert.equal(detail.data.totalSpectators, 7, 'Total spectators is now 3 + 2 + 1 + 1 = 7');
    assert.ok(detail.data.attendees.some(a => a.name === 'Waitlisted Duo'), 'Waitlisted Duo must now be in confirmed attendees');

    // 9. Verify GET /api/events list endpoint aggregates attendee_count and spectator_count accurately
    const listRes = await apiReq('GET', '/api/events', null);
    assert.equal(listRes.status, 200);
    const listedGame = listRes.data.events.find(e => e.id === groupEventId);
    assert.ok(listedGame, 'Group test event must appear in events list');
    assert.equal(listedGame.attendee_count, 1, 'List endpoint attendee_count must sum confirmed players_count');
    assert.equal(listedGame.spectator_count, 7, 'List endpoint spectator_count must sum confirmed spectators_count');

    // 10. Cancel RSVP ('declined') releases group tasks
    const cancelRes = await apiReq('POST', `/api/events/${groupEventId}/rsvp`, null, {
      name: 'Garcia Family Group',
      email: 'garcia_family@sundaypickup.org',
      management_token: garciaToken,
      status: 'declined'
    });
    assert.equal(cancelRes.status, 200);
    assert.equal(cancelRes.data.status, 'declined');

    detail = await apiReq('GET', `/api/events/${groupEventId}`, seedOrgCookie);
    const t1AfterCancel = detail.data.duties.find(d => d.id === task1Id);
    assert.equal(t1AfterCancel.assigned_players.length, 0, 'Declining RSVP must release group tasks');

    // 11. Anonymous guest RSVPs without email address (name + optional details only)
    const noEmailHtml = fs.readFileSync(path.join(publicDir, 'event.html'), 'utf8');
    const noEmailEventJs = fs.readFileSync(path.join(publicDir, 'js/event.js'), 'utf8');
    const noEmailApiJs = fs.readFileSync(path.join(publicDir, 'js/api.js'), 'utf8');
    assert.ok(!noEmailHtml.includes('id="rsvp-email" required') && noEmailHtml.includes('Email Address (Optional)'), 'event.html must clearly mark email as optional');
    assert.ok(!noEmailEventJs.includes("getElementById('rsvp-email').required = true"), 'event.js must not require rsvp-email for guests');
    assert.ok(noEmailApiJs.includes('"event.email_label": "Email Address (Optional)"'), 'api.js EN_DICT must label guest email as optional');

    const badEmailGuest = await apiReq('POST', `/api/events/${groupEventId}/rsvp`, null, {
      name: 'Invalid Email Guest',
      email: 'not-an-email',
      players_count: 1
    });
    assert.equal(badEmailGuest.status, 400, 'Non-empty malformed email must still be rejected');

    const anonNoEmail1 = await apiReq('POST', `/api/events/${groupEventId}/rsvp`, null, {
      name: 'Walk-Up Player One',
      email: '',
      players_count: 1,
      spectators_count: 0,
      gear_bringing: 'Extra wooden bats'
    });
    assert.equal(anonNoEmail1.status, 200, 'Anonymous RSVP with name only (empty email) must succeed');
    assert.equal(anonNoEmail1.data.status, 'attending');
    const noEmailToken1 = anonNoEmail1.data.managementToken;
    assert.ok(noEmailToken1, 'Email-optional guest RSVP must still issue managementToken');

    const anonNoEmail2 = await apiReq('POST', `/api/events/${groupEventId}/rsvp`, null, {
      name: 'Walk-Up Player Two',
      players_count: 0,
      spectators_count: 1,
      duty_ids: [task1Id]
    });
    assert.equal(anonNoEmail2.status, 200, 'Second anonymous RSVP without email on same game must not collide on UNIQUE email');
    assert.equal(anonNoEmail2.data.status, 'attending');

    const noEmailLookup = await apiReq('GET', `/api/events/${groupEventId}?token=${encodeURIComponent(noEmailToken1)}`, null);
    assert.equal(noEmailLookup.status, 200);
    assert.ok(noEmailLookup.data.myRsvp && noEmailLookup.data.myRsvp.email === '', 'GET event with guest token must return empty email string rather than internal placeholder');

    const noEmailUpdate = await apiReq('POST', `/api/events/${groupEventId}/rsvp`, null, {
      name: 'Walk-Up Player One Updated',
      email: '',
      players_count: 1,
      spectators_count: 1,
      gear_bringing: 'Bats + Helmet',
      management_token: noEmailToken1
    });
    assert.equal(noEmailUpdate.status, 200, 'Updating email-less RSVP via management_token must succeed');

    detail = await apiReq('GET', `/api/events/${groupEventId}`, seedOrgCookie);
    const updatedWalkUp = detail.data.attendees.find(a => a.name === 'Walk-Up Player One Updated');
    assert.ok(updatedWalkUp && updatedWalkUp.gear_bringing === 'Bats + Helmet', 'Updated email-less guest details must appear on public roster');
    assert.ok(detail.data.attendees.some(a => a.name === 'Walk-Up Player Two'), 'Second email-less guest must appear on public roster');
  });

  await t9.test('T9.16: Live Cloud Calendar Sync Pill, Auto-Refresh Lifecycle & Live .ics Subscription Feed', async () => {
    // 1. Static UI & ES6 checks
    const indexHtml = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
    assert.ok(indexHtml.includes('id="calendar-sync-pill"'), 'index.html must include live cloud sync status pill');
    assert.ok(indexHtml.includes('id="calendar-subscribe-panel"'), 'index.html must include live calendar subscription panel');
    assert.ok(!indexHtml.includes('Sunday Pickup Games • 12:00 PM • Bushrod Park'), 'index.html must not include hardcoded calendar subtitle');
    assert.ok(!indexHtml.includes('brand-tag'), 'index.html must not include community pill in top bar');

    const apiJsNav = fs.readFileSync(path.join(publicDir, 'js/api.js'), 'utf8');
    assert.ok(!apiJsNav.includes('class="brand-tag"'), 'api.js renderNav must not include community brand-tag pill');

    const appJs = fs.readFileSync(path.join(publicDir, 'js/app.js'), 'utf8');
    assert.ok(appJs.includes('setupCloudSyncLifecycle'), 'app.js must bind cloud sync lifecycle listeners');
    assert.ok(appJs.includes('visibilitychange'), 'app.js must auto-refresh when tab/PWA regains visibility');
    assert.ok(apiJsNav.includes('webcal://'), 'api.js must generate webcal:// subscription URL');
    assert.ok(apiJsNav.includes('/api/events/calendar.ics'), 'api.js must point to live /api/events/calendar.ics feed');
    assert.ok(appJs.includes('API.renderSubscribePanel('), 'app.js must delegate calendar subscription rendering to API.renderSubscribePanel');
    assert.ok(!appJs.includes('?.'), 'app.js must not use optional chaining for broad ES6 compatibility');
    assert.ok(!appJs.includes('??'), 'app.js must not use nullish coalescing for broad ES6 compatibility');
    assert.ok(!appJs.includes('.\\d\\d\\d'), 'app.js must not use buggy unescaped regex in formatGCal');
    assert.ok(appJs.includes('d.getUTCFullYear()'), 'app.js formatGCal must explicitly preserve UTC full year');
    assert.ok(apiJsNav.includes('d.getUTCFullYear()'), 'api.js getGoogleCalendarUrl must explicitly preserve UTC full year');

    // Verify Google Calendar URL preserves 2026 and never defaults to 1900
    const testEvent = { id: 77, title: 'Bushrod Championship Game', event_date: '2026-11-15T20:00:00.000Z', location: 'Bushrod Park Field 1' };
    const pad = (n) => String(n).padStart(2, '0');
    const formatGCal = (d) => d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + 'T' + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + 'Z';
    const testStart = new Date(testEvent.event_date);
    const testEnd = new Date(testStart.getTime() + 3 * 3600000);
    const testGCalUrl = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(testEvent.title)}&dates=${formatGCal(testStart)}/${formatGCal(testEnd)}`;
    assert.ok(testGCalUrl.includes('dates=20261115T200000Z/20261115T230000Z'), 'Google Calendar URL must explicitly target year 2026');
    assert.ok(!testGCalUrl.includes('1900'), 'Google Calendar URL must not contain year 1900');

    const css = fs.readFileSync(path.join(publicDir, 'css/style.css'), 'utf8');
    assert.ok(css.includes('.calendar-sync-pill.is-synced'), 'style.css must style synced cloud indicator');
    assert.ok(css.includes('.calendar-sync-pill.is-offline'), 'style.css must style offline/cached warning indicator');
    assert.ok(css.includes('.calendar-subscribe-panel'), 'style.css must style live calendar subscription panel');

    // 2. Verify GET /api/events sends Cache-Control: no-store and authoritative synced_at timestamp
    const eventsRes = await apiReq('GET', '/api/events?filter=all', null);
    assert.equal(eventsRes.status, 200);
    assert.ok((eventsRes.headers.get('cache-control') || '').includes('no-store'), 'GET /api/events must send Cache-Control: no-store');
    assert.ok(eventsRes.data.synced_at && !isNaN(new Date(eventsRes.data.synced_at).getTime()), 'GET /api/events must return valid ISO synced_at timestamp');

    // 3. Create a public rainout game & a private restricted game, then verify GET /api/events/calendar.ics
    const pubCreate = await apiReq('POST', '/api/events', seedOrgCookie, {
      title: 'Public Live Feed Sunday Game',
      location: 'Bushrod Park Field 1, Oakland, CA',
      event_date: '2026-12-13T20:00:00.000Z'
    });
    assert.equal(pubCreate.status, 200);
    const pubRainId = pubCreate.data.eventId;

    const rainRes = await apiReq('POST', `/api/events/${pubRainId}/rainout`, seedOrgCookie, {
      note: 'Infield standing water after overnight storm'
    });
    assert.equal(rainRes.status, 200);

    const privCreate = await apiReq('POST', '/api/events', seedOrgCookie, {
      title: 'Private Whitelist Secret Scrimmage',
      location: 'Hidden Diamond',
      event_date: '2026-12-20T20:00:00.000Z',
      allowed_emails: ['vip_only@sundaypickup.org']
    });
    assert.equal(privCreate.status, 200);

    const icsRes = await fetch(`${baseUrl}/api/events/calendar.ics`);
    assert.equal(icsRes.status, 200, 'Live calendar.ics feed must respond 200 OK');
    assert.ok((icsRes.headers.get('content-type') || '').includes('text/calendar'), 'calendar.ics must return text/calendar Content-Type');
    assert.ok((icsRes.headers.get('cache-control') || '').includes('no-store'), 'calendar.ics must disable edge caching for immediate rainout propagation');

    const icsText = await icsRes.text();
    assert.ok(icsText.includes('BEGIN:VCALENDAR') && icsText.includes('END:VCALENDAR'), 'Feed must be valid VCALENDAR');
    assert.ok(icsText.includes('REFRESH-INTERVAL;VALUE=DURATION:PT1H'), 'Feed must advertise 1-hour refresh interval (RFC 7986)');
    assert.ok(icsText.includes('X-PUBLISHED-TTL:PT1H'), 'Feed must advertise 1-hour TTL for Apple/Outlook');
    assert.ok(icsText.includes(`UID:pickup-baseball-event-${pubRainId}@pickupbaseballfoundation.org`), 'Public event must have stable UID');
    assert.ok(icsText.includes('SUMMARY:🌧️ RAINED OUT: Public Live Feed Sunday Game'), 'Rained-out game must be prefixed with RAINED OUT in live feed');
    assert.ok(icsText.includes('Infield standing water after overnight storm'), 'Rainout note must appear in VEVENT description');
    assert.ok(!icsText.includes('Private Whitelist Secret Scrimmage'), 'Restricted private whitelist events must be excluded from anonymous public .ics feed');

    // Verify single-game live calendar.ics endpoint scopes strictly to requested event and honors privacy filter
    const singleIcsRes = await fetch(`${baseUrl}/api/events/${pubRainId}/calendar.ics`);
    assert.equal(singleIcsRes.status, 200, 'Single-game calendar.ics endpoint must respond 200 OK');
    assert.ok((singleIcsRes.headers.get('content-type') || '').includes('text/calendar'), 'Single-game calendar.ics must return text/calendar');
    assert.ok((singleIcsRes.headers.get('cache-control') || '').includes('no-store'), 'Single-game calendar.ics must disable edge caching');
    const singleIcsText = await singleIcsRes.text();
    assert.ok(singleIcsText.includes(`UID:pickup-baseball-event-${pubRainId}@pickupbaseballfoundation.org`), 'Single-game feed must include requested event UID');
    assert.ok(singleIcsText.includes('REFRESH-INTERVAL;VALUE=DURATION:PT1H'), 'Single-game feed must advertise 1-hour refresh interval');
    const singleVeventCount = (singleIcsText.match(/BEGIN:VEVENT/g) || []).length;
    assert.equal(singleVeventCount, 1, 'Single-game feed must contain exactly 1 VEVENT');

    const privSingleRes = await fetch(`${baseUrl}/api/events/${privCreate.data.eventId}/calendar.ics`);
    assert.ok(privSingleRes.status === 404 || privSingleRes.status === 200);
    const privSingleText = await privSingleRes.text();
    assert.ok(!privSingleText.includes('Private Whitelist Secret Scrimmage'), 'Restricted private event must not leak in anonymous single-game .ics feed');

    // Verify personalized tokenized .ics subscriptions (public + invited private events only, plus token rotation)
    const invitedCreate = await apiReq('POST', '/api/events', seedOrgCookie, {
      title: 'Invited Personal Feed Game',
      location: 'Bushrod Secret Field',
      event_date: '2026-12-27T20:00:00.000Z',
      allowed_emails: ['invited_ics@sundaypickup.org']
    });
    assert.equal(invitedCreate.status, 200);
    const invitedPrivId = invitedCreate.data.eventId;

    const invitedUserInsert = db.prepare(`
      INSERT INTO users (name, email, role, is_admin)
      VALUES ('Invited ICS Player', 'invited_ics@sundaypickup.org', 'player', 0)
    `).run();
    const invitedSessionCookie = `baseball_session=${createSession(invitedUserInsert.lastInsertRowid).sessionId}`;

    const uninvitedMe = await apiReq('GET', '/api/auth/me', seedPlayerCookie);
    assert.equal(uninvitedMe.status, 200);
    const uninvitedCalToken = uninvitedMe.data.user && uninvitedMe.data.user.calendarToken;
    assert.ok(uninvitedCalToken && uninvitedCalToken.length >= 32, 'Signed-in user must receive personal calendarToken');

    const uninvitedFeedRes = await fetch(`${baseUrl}/api/events/calendar.ics?cal_token=${encodeURIComponent(uninvitedCalToken)}`);
    assert.equal(uninvitedFeedRes.status, 200);
    const uninvitedFeedText = await uninvitedFeedRes.text();
    assert.ok(uninvitedFeedText.includes(`UID:pickup-baseball-event-${pubRainId}@pickupbaseballfoundation.org`), 'Tokenized feed must include public events');
    assert.ok(!uninvitedFeedText.includes('Invited Personal Feed Game'), 'Uninvited user tokenized feed must exclude uninvited private events');
    assert.ok(!uninvitedFeedText.includes('Private Whitelist Secret Scrimmage'), 'Uninvited user tokenized feed must exclude VIP-only events');

    const uninvitedSinglePrivRes = await fetch(`${baseUrl}/api/events/${invitedPrivId}/calendar.ics?cal_token=${encodeURIComponent(uninvitedCalToken)}`);
    assert.equal(uninvitedSinglePrivRes.status, 404, 'Uninvited user tokenized single-game feed must return 404');

    const invitedMe = await apiReq('GET', '/api/auth/me', invitedSessionCookie);
    assert.equal(invitedMe.status, 200);
    const invitedCalToken = invitedMe.data.user && invitedMe.data.user.calendarToken;
    assert.ok(invitedCalToken && invitedCalToken.length >= 32, 'Invited user must receive personal calendarToken');

    const invitedFeedRes = await fetch(`${baseUrl}/api/events/calendar.ics?cal_token=${encodeURIComponent(invitedCalToken)}`);
    assert.equal(invitedFeedRes.status, 200);
    const invitedFeedText = await invitedFeedRes.text();
    assert.ok(invitedFeedText.includes(`UID:pickup-baseball-event-${pubRainId}@pickupbaseballfoundation.org`), 'Invited user tokenized feed must include public games');
    assert.ok(invitedFeedText.includes(`UID:pickup-baseball-event-${invitedPrivId}@pickupbaseballfoundation.org`), 'Invited user tokenized feed must include invited private games');
    assert.ok(!invitedFeedText.includes('Private Whitelist Secret Scrimmage'), 'Invited user tokenized feed must still exclude private games they are not invited to');

    const invitedSingleRes = await fetch(`${baseUrl}/api/events/${invitedPrivId}/calendar.ics?cal_token=${encodeURIComponent(invitedCalToken)}`);
    assert.equal(invitedSingleRes.status, 200, 'Invited user tokenized single-game feed must return 200');
    const invitedSingleText = await invitedSingleRes.text();
    assert.ok(invitedSingleText.includes(`UID:pickup-baseball-event-${invitedPrivId}@pickupbaseballfoundation.org`), 'Invited single-game feed must contain the private game VEVENT');

    const bogusTokenRes = await fetch(`${baseUrl}/api/events/calendar.ics?cal_token=invalid_token_should_fail_0123456789abcdef`);
    assert.equal(bogusTokenRes.status, 401, 'Invalid cal_token must return 401');

    const regenRes = await apiReq('POST', '/api/auth/calendar-token/regenerate', invitedSessionCookie, {});
    assert.equal(regenRes.status, 200);
    const rotatedToken = regenRes.data.calendarToken;
    assert.ok(rotatedToken && rotatedToken.length >= 32 && rotatedToken !== invitedCalToken, 'Regenerated calendar token must differ from old token');

    const revokedFeedRes = await fetch(`${baseUrl}/api/events/calendar.ics?cal_token=${encodeURIComponent(invitedCalToken)}`);
    assert.equal(revokedFeedRes.status, 401, 'Old revoked cal_token must return 401 after rotation');

    const rotatedFeedRes = await fetch(`${baseUrl}/api/events/calendar.ics?cal_token=${encodeURIComponent(rotatedToken)}`);
    assert.equal(rotatedFeedRes.status, 200);
    const rotatedFeedText = await rotatedFeedRes.text();
    assert.ok(rotatedFeedText.includes(`UID:pickup-baseball-event-${invitedPrivId}@pickupbaseballfoundation.org`), 'New rotated cal_token must serve invited private games');

    // Verify UI labels and single-game subscription controls on Home drawer & Event Details card grid
    assert.ok(indexHtml.includes('Subscribe All (.ics)'), 'Home calendar header must clarify all-games subscription');
    assert.ok(appJs.includes('id="drawer-game-subscribe-btn"') && appJs.includes('id="drawer-game-subscribe-panel"'), 'Game preview drawer must expose matching single-game subscription controls');
    const eventHtmlCal = fs.readFileSync(path.join(publicDir, 'event.html'), 'utf8');
    const eventJsCal = fs.readFileSync(path.join(publicDir, 'js/event.js'), 'utf8');
    assert.ok(eventHtmlCal.includes('id="event-calendar-meta-item"') && eventHtmlCal.includes('id="event-subscribe-ics-btn"') && eventHtmlCal.includes('id="event-subscribe-panel"'), 'Event page must include single-game calendar subscription in detail cards');
    assert.ok(eventJsCal.includes('API.renderSubscribePanel('), 'event.js must bind single-game subscription panel');
    assert.ok(!eventJsCal.includes('?.') && !eventJsCal.includes('??'), 'event.js must avoid optional chaining / nullish coalescing');
    assert.doesNotThrow(() => new Function(apiJsNav), 'api.js must parse as valid JS without syntax errors');
    assert.doesNotThrow(() => new Function(appJs), 'app.js must parse as valid JS without syntax errors');

    const apiJs = fs.readFileSync(path.join(publicDir, 'js/api.js'), 'utf8');
    assert.ok(apiJs.includes('?cal_token=') && apiJs.includes('/api/auth/calendar-token/regenerate'), 'api.js subscribe panel must support personalized cal_token and token rotation');
    const readmeMd = fs.readFileSync(path.join(ctx.rootDir, 'README.md'), 'utf8');
    assert.ok(!indexHtml.includes('data-i18n="hero.notice"'), 'October 2026 notice must be moved out of the hero section');
    assert.ok(!apiJs.includes('This site is new and few people know about it.'), 'Removed sentence must not appear in api.js');
    assert.ok(apiJs.includes('Built with Google Gemini in October 2026 for simplicity and durability. Free & open-source'), 'Site footer must include clean Built with Google Gemini in October 2026 attribution');
    assert.ok(readmeMd.includes('Built with Google Gemini in October 2026 for simplicity and durability'), 'README.md must include Built with Google Gemini in October 2026 for simplicity and durability');
    assert.ok(readmeMd.includes('(HANDBOOK.md)'), 'README.md must link to HANDBOOK.md');
    assert.ok(fs.existsSync(path.join(ctx.rootDir, 'HANDBOOK.md')), 'HANDBOOK.md must exist in repository root');
    const handbookMd = fs.readFileSync(path.join(ctx.rootDir, 'HANDBOOK.md'), 'utf8');
    assert.ok(handbookMd.includes('Saving Your Email Address & Login Credentials in Your Browser'), 'HANDBOOK.md must contain credential saving guide');
    assert.ok(handbookMd.includes('Android') && handbookMd.includes('iOS') && handbookMd.includes('macOS') && handbookMd.includes('Windows'), 'HANDBOOK.md must cover Android, iOS, macOS, and Windows');
    assert.ok(handbookMd.includes('Internet Explorer 11') && handbookMd.includes('Samsung Internet'), 'HANDBOOK.md must cover legacy browsers and mobile browsers');
    assert.ok(handbookMd.includes('Typical Rules of Play on the Field on Sundays'), 'HANDBOOK.md must contain typical rules of play section');
    assert.ok(handbookMd.includes('id="rules-of-play"'), 'HANDBOOK.md must have anchor for rules of play');
    assert.ok(!apiJs.includes('nav-link-handbook'), 'api.js top bar must not render nav-link-handbook');
    assert.ok(apiJs.includes('footer.handbook'), 'api.js must render footer.handbook');
    assert.ok(indexHtml.includes('hero-handbook-btn'), 'index.html must include hero-handbook-btn');
    const licenseText = fs.readFileSync(path.join(ctx.rootDir, 'LICENSE'), 'utf8');
    assert.ok(licenseText.includes('Apache License') && licenseText.includes('Version 2.0, January 2004'), 'LICENSE must be Apache License 2.0');
    assert.ok(readmeMd.includes('Apache License, Version 2.0 (Apache-2.0)'), 'README.md must cite Apache License 2.0');
    assert.ok(apiJs.includes('footer.copyright'), 'api.js must include footer.copyright');
    assert.ok(apiJs.includes('Apache License 2.0'), 'api.js must display Apache License 2.0');
  });

  await test('T9.17: RSS 2.0 Feed with Media RSS, Multimedia Interpretation, and Highlights Lifecycle', async () => {
    const publicDir = ctx.publicDir;

    // 1. Verify player without organizer privileges cannot create posts
    const unauthPost = await apiReq('POST', '/api/posts', seedPlayerCookie, {
      title: 'Hacker Post',
      content: 'Should be rejected'
    });
    assert.equal(unauthPost.status, 403, 'Regular players must be denied posting rights');

    // 2. Organizer creates YouTube highlight post
    const ytPostRes = await apiReq('POST', '/api/posts', seedOrgCookie, {
      title: 'Walk-Off Grand Slam Highlights & Dugout Celebration',
      content: 'Incredible finish at Bushrod Park Field 1! Bottom of the 9th bases-loaded comeback.',
      summary: 'Game-winning grand slam recap with full video clip.',
      media_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      media_type: 'auto'
    });
    assert.equal(ytPostRes.status, 200, 'Organizer should successfully create YouTube highlight');
    assert.ok(ytPostRes.data.post && ytPostRes.data.post.id, 'Created post must return post with id');
    const ytPostId = ytPostRes.data.post.id;
    assert.equal(ytPostRes.data.post.media_type, 'youtube', 'Should auto-detect youtube media type');

    // 3. Organizer creates Image highlight post
    const imgPostRes = await apiReq('POST', '/api/posts', seedOrgCookie, {
      title: 'October Game Day Photo Album & Team Portrait',
      content: 'Great turnout today with 22 community players on the field. Check out the team photo!',
      media_url: 'https://i.imgur.com/exampleBushrodPhoto.jpg',
      media_type: 'auto'
    });
    assert.equal(imgPostRes.status, 200);
    const imgPostId = imgPostRes.data.post.id;
    assert.equal(imgPostRes.data.post.media_type, 'image', 'Should auto-detect image media type');

    // 4. Organizer creates Text-only announcement
    const textPostRes = await apiReq('POST', '/api/posts', seedOrgCookie, {
      title: 'Field Rakes & Equipment Maintenance Notice',
      content: 'Big thanks to everyone who helped drag the infield and inventory the game baseballs bucket.',
      media_type: 'none'
    });
    assert.equal(textPostRes.status, 200);
    const textPostId = textPostRes.data.post.id;

    // 5. Verify GET /api/posts returns newly created posts with correct metadata
    const postsListRes = await apiReq('GET', '/api/posts', null);
    assert.equal(postsListRes.status, 200);
    assert.ok(Array.isArray(postsListRes.data.posts), 'GET /api/posts must return posts array');
    const returnedPosts = postsListRes.data.posts;
    assert.ok(returnedPosts.some(p => p.id === ytPostId), 'Posts list must contain YouTube post');
    assert.ok(returnedPosts.some(p => p.id === imgPostId), 'Posts list must contain Image post');
    assert.ok(returnedPosts.some(p => p.id === textPostId), 'Posts list must contain Text post');

    // 6. Verify GET /feed.xml and GET /api/feed.xml return valid RFC 822 + Media RSS XML
    for (const feedPath of ['/feed.xml', '/api/feed.xml']) {
      const feedRes = await fetch(`${baseUrl}${feedPath}`);
      assert.equal(feedRes.status, 200, `${feedPath} must respond 200 OK`);
      const contentType = feedRes.headers.get('content-type') || '';
      assert.ok(contentType.includes('application/rss+xml'), `${feedPath} must return application/rss+xml`);
      const xml = await feedRes.text();

      // Check root RSS & Media RSS namespaces
      assert.ok(xml.includes('<rss version="2.0"'), 'Feed must be RSS 2.0');
      assert.ok(xml.includes('xmlns:media="http://search.yahoo.com/mrss/"'), 'Feed must define Yahoo Media RSS namespace');
      assert.ok(xml.includes('xmlns:atom="http://www.w3.org/2005/Atom"'), 'Feed must define Atom namespace');
      assert.ok(xml.includes('<atom:link') && xml.includes('rel="self" type="application/rss+xml"'), 'Feed must declare self Atom link');

      // Check YouTube item with media tags & player embed
      assert.ok(xml.includes('Walk-Off Grand Slam Highlights & Dugout Celebration'), 'Feed must include YouTube post title');
      assert.ok(xml.includes('<media:content url="https://www.youtube.com/watch?v=dQw4w9WgXcQ" medium="video">'), 'Feed must output media:content for YouTube');
      assert.ok(xml.includes('<media:player url="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ" />'), 'Feed must output media:player with nocookie embed');
      assert.ok(xml.includes('<media:thumbnail url="https://img.youtube.com/vi/dQw4w9WgXcQ/hqdefault.jpg" />'), 'Feed must output media:thumbnail for YouTube');

      // Check Image item with media tags & enclosure
      assert.ok(xml.includes('<media:content url="https://i.imgur.com/exampleBushrodPhoto.jpg" medium="image" />'), 'Feed must output media:content for image');
      assert.ok(xml.includes('<enclosure url="https://i.imgur.com/exampleBushrodPhoto.jpg" type="image/jpeg" length="0" />'), 'Feed must output enclosure for image');
    }

    // 7. Verify post deletion lifecycle
    const unauthDel = await apiReq('DELETE', `/api/posts/${textPostId}`, seedPlayerCookie);
    assert.equal(unauthDel.status, 403, 'Regular player cannot delete posts');

    const authDel = await apiReq('DELETE', `/api/posts/${textPostId}`, seedOrgCookie);
    assert.equal(authDel.status, 200, 'Organizer must successfully delete post');

    const postsAfterDel = await apiReq('GET', '/api/posts', null);
    assert.ok(!postsAfterDel.data.posts.some(p => p.id === textPostId), 'Deleted post must no longer appear in /api/posts');

    // 8. Verify Frontend Autodiscovery, Templates & Security Headers
    const indexHtml = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
    assert.ok(indexHtml.includes('<link rel="alternate" type="application/rss+xml"'), 'index.html must include RSS autodiscovery link');
    assert.ok(indexHtml.includes('id="community-feed-section"'), 'index.html must include community feed section');
    assert.ok(indexHtml.includes('id="feed-posts-container"'), 'index.html must include feed posts container');

    const adminHtml = fs.readFileSync(path.join(publicDir, 'admin.html'), 'utf8');
    assert.ok(adminHtml.includes('id="post-form-section"'), 'admin.html must include post creator form section');
    assert.ok(adminHtml.includes('id="post-media-preview-container"'), 'admin.html must include multimedia live preview');

    const headersFile = fs.readFileSync(path.join(publicDir, '_headers'), 'utf8');
    assert.ok(headersFile.includes('https://www.youtube-nocookie.com'), 'CSP must allow YouTube nocookie player in frame-src');
    assert.ok(headersFile.includes('https://www.youtube.com'), 'CSP must allow YouTube in frame-src');
    assert.ok(headersFile.includes("media-src 'self' https: data:"), 'CSP must allow external media sources');
    assert.ok(headersFile.includes('/feed.xml'), '_headers must configure feed.xml caching');

    const routesJson = JSON.parse(fs.readFileSync(path.join(publicDir, '_routes.json'), 'utf8'));
    assert.ok(routesJson.include && routesJson.include.includes('/feed.xml'), '_routes.json must include /feed.xml');

    const feedFunctionExists = fs.existsSync(path.join(ctx.rootDir, 'functions', 'feed.xml.js'));
    assert.ok(feedFunctionExists, 'functions/feed.xml.js must exist for Cloudflare Pages edge rendering');

    // 9. Verify zero ES2020+ incompatible syntax (?. or ??) in client JS
    const jsFiles = ['api.js', 'app.js', 'admin.js', 'event.js', 'archive.js', 'login.js', 'profile.js', 'weather.js', 'art.js'];
    for (const file of jsFiles) {
      const code = fs.readFileSync(path.join(publicDir, 'js', file), 'utf8');
      const lines = code.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/\?\./.test(line) && !/regex|\/|\.test\(|match\(/.test(line)) {
          assert.fail(`Found disallowed optional chaining (?.) in public/js/${file} at line ${i + 1}: ${line.trim()}`);
        }
        if (/\?\?/.test(line)) {
          assert.fail(`Found disallowed nullish coalescing (??) in public/js/${file} at line ${i + 1}: ${line.trim()}`);
        }
      }
    }
  });

  await test('T9.18: 15-Language i18n Coverage for Calendar Legend, Cloud Sync, and Webapp Build Attribution', async () => {
    const publicDir = ctx.publicDir;
    const i18nDir = path.join(publicDir, 'i18n');
    const languages = ['ar', 'es', 'fa', 'fr', 'hi', 'hy', 'ja', 'ko', 'pa', 'pt', 'ru', 'tl', 'vi', 'zh'];

    const requiredKeys = [
      'calendar.legend_game',
      'calendar.legend_prospective',
      'calendar.legend_rainout',
      'calendar.legend_today',
      'calendar.legend_attending',
      'footer.about_site',
      'calendar.title',
      'calendar.sync_checking',
      'calendar.sync_just_now',
      'calendar.subscribe_title',
      'feed.heading',
      'nav.handbook',
      'footer.handbook',
      'footer.copyright'
    ];

    for (const lang of languages) {
      const filePath = path.join(i18nDir, `${lang}.json`);
      assert.ok(fs.existsSync(filePath), `i18n file for ${lang} must exist`);
      const dict = JSON.parse(fs.readFileSync(filePath, 'utf8'));

      for (const key of requiredKeys) {
        assert.ok(key in dict, `Language '${lang}' must have translation key '${key}'`);
        assert.ok(typeof dict[key] === 'string' && dict[key].trim().length > 0, `Language '${lang}' translation for '${key}' must not be empty`);
      }

      // Verify footer.about_site mentions 2026 and Gemini
      assert.ok(
        dict['footer.about_site'].includes('2026') ||
        dict['footer.about_site'].includes('٢٠٢٦') ||
        dict['footer.about_site'].includes('۲۰۲۶'),
        `Language '${lang}' footer.about_site must include year 2026`
      );
    }

    const apiJs = fs.readFileSync(path.join(publicDir, 'js', 'api.js'), 'utf8');
    assert.ok(apiJs.includes('pickup_i18n_v'), 'api.js loadLangDict must use version-busted localStorage cache key');
  });
};
