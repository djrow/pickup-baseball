/**
 * T9.19–T9.27: Weather Engine, Fair-Share Duties, Art Studio, Gallery, ZAP Hardening & BP Order Tests
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

module.exports = async function registerWeatherGalleryTests(ctx, t9) {
  const { apiReq, getCookie, db, createSession, getDefaultDuties, CURRENT_APP_VERSION } = ctx;

  const { seedAdminId, seedAdminCookie, seedOrgId, seedOrgCookie, seedPlayerId, seedPlayerCookie, sharedEventId, baseUrl, publicDir } = ctx;

  await t9.test('T9.19: Client-Side Weather Engine, Temperature/Emoji Pills & Smart Rainout Assistant Drainage Heuristic', async () => {
    // 1. Verify public/js/weather.js exists and is syntactically valid ES6
    const weatherJsPath = path.join(publicDir, 'js', 'weather.js');
    assert.ok(fs.existsSync(weatherJsPath), 'public/js/weather.js must exist');
    const weatherJsCode = fs.readFileSync(weatherJsPath, 'utf8');
    assert.ok(!weatherJsCode.includes('?.'), 'weather.js must not contain optional chaining (?.)');
    assert.ok(!weatherJsCode.includes('??'), 'weather.js must not contain nullish coalescing (??)');

    // 2. Execute weather.js in an isolated Node vm context to verify exports & heuristic execution
    const vm = require('vm');
    const mockWidgetContainer = { innerHTML: '' };
    const sandbox = {
      window: {},
      document: {
        getElementById: (id) => (id === 'smart-rainout-widget' ? mockWidgetContainer : null),
        querySelectorAll: () => []
      },
      console: console,
      fetch: globalThis.fetch,
      Intl: Intl,
      Date: Date,
      Math: Math,
      JSON: JSON,
      parseInt: parseInt,
      isNaN: isNaN,
      Array: Array,
      Object: Object,
      String: String,
      Number: Number,
      Set: Set
    };
    vm.createContext(sandbox);
    vm.runInContext(weatherJsCode, sandbox);
    const ws = sandbox.window.WeatherService;
    assert.ok(ws, 'WeatherService must be mounted to window');
    assert.equal(typeof ws.calculateFieldDrainage, 'function');
    assert.equal(typeof ws.renderAssistantWidget, 'function');
    assert.equal(typeof ws.populateCardWeatherBadges, 'function');
    assert.equal(ws.HEURISTIC_CONFIG.DRAINAGE_DECAY_HOURS, 8.0, 'Drainage decay half-life must be 8 hours');

    // 3. Test Drainage Heuristic: Scenario 1 - 0.00" Rain (Dry & Firm)
    const times = [];
    const precipDry = [];
    const precipSatRain = [];
    const precipSunMorningRain = [];
    const temps = [];
    const codes = [];

    for (let i = 0; i < 48; i++) {
      const h = String(i % 24).padStart(2, '0');
      const day = i < 24 ? '2026-11-07' : '2026-11-08';
      times.push(`${day}T${h}:00`);
      precipDry.push(0);
      // Heavy rain on Saturday 12-3 PM (20 hours before Sunday warmups)
      precipSatRain.push(i >= 12 && i <= 15 ? 0.20 : 0);
      // Rain on Sunday morning 9-11 AM (1-3 hours before Sunday warmups)
      precipSunMorningRain.push(i >= 33 && i <= 35 ? 0.20 : 0);
      temps.push(66);
      codes.push(2);
    }

    const rDry = ws.calculateFieldDrainage({
      time: times,
      precipitation: precipDry,
      temperature_2m: temps,
      weathercode: codes
    }, '2026-11-08T12:00');
    assert.equal(rDry.status, 'good', 'Dry weather must result in status good');
    assert.equal(rDry.totalRain24h, 0);
    assert.equal(rDry.effectiveMoisture, 0);
    assert.equal(rDry.rainfall5Day, 0, 'Dry weather must result in 0.00" 5-day rainfall');
    assert.equal(rDry.rainfall5DayFormatted, '0.00"');
    assert.ok(Array.isArray(rDry.dailyForecast), 'calculateFieldDrainage must return dailyForecast array');
    assert.ok(rDry.dailyForecast.length > 0, 'dailyForecast array must contain entries');
    assert.ok(rDry.prognosis.includes('No standing puddles'));
    assert.ok(Array.isArray(rDry.hourlyBreakdown), 'rDry must contain hourlyBreakdown');
    const lastHourlyItem = rDry.hourlyBreakdown[rDry.hourlyBreakdown.length - 1];
    assert.ok(lastHourlyItem.time.endsWith('T18:00'), 'hourlyBreakdown must extend through 6:00 PM (18:00) on event day');
    assert.ok(rDry.hourlyBreakdown.some(h => h.isGameTime), 'hourlyBreakdown must flag game window hours');

    // Test Drainage Heuristic: Scenario 2 - 0.80" Rain Saturday afternoon (Adequate time to drain)
    const rSat = ws.calculateFieldDrainage({
      time: times,
      precipitation: precipSatRain,
      temperature_2m: temps,
      weathercode: codes
    }, '2026-11-08T12:00');
    assert.equal(rSat.status, 'moderate', 'Rain that fell 20h ago and drained must be moderate/playable');
    assert.equal(rSat.totalRain24h, 0.80);
    assert.equal(rSat.rainfall5Day, 0.80, '5-day rainfall must sum precipitation correctly');
    assert.equal(rSat.rainfall5DayFormatted, '0.80"');
    assert.ok(Array.isArray(rSat.dailyForecast), 'rSat must contain dailyForecast array');
    assert.ok(rSat.effectiveMoisture < 0.10, 'Effective moisture must decay below 0.10" after 20 hours');
    assert.ok(rSat.recommendation.includes('Playable'));
    assert.ok(rSat.maxSurfaceWater > rSat.maxHourlyRain, 'Cumulative surface water must exceed single-hour rainfall peak during multi-hour rain');
    const rSatNoon = rSat.hourlyBreakdown.find(h => h.time === '2026-11-08T12:00');
    assert.ok(rSatNoon && Math.abs(rSatNoon.surfaceWater - rSat.effectiveMoisture) < 1e-6, 'Noon hourly surfaceWater must match effectiveMoisture when noon is dry');
    const rSatSat4pm = rSat.hourlyBreakdown.find(h => h.time === '2026-11-07T16:00');
    const rSatSat5pm = rSat.hourlyBreakdown.find(h => h.time === '2026-11-07T17:00');
    assert.ok(rSatSat4pm && rSatSat5pm && rSatSat4pm.rain === 0 && rSatSat4pm.surfaceWater > 0.30, 'Surface water must remain above 0.30" immediately after heavy Saturday rain stops');
    assert.ok(rSatSat5pm.surfaceWater < rSatSat4pm.surfaceWater, 'Expected surface water must visibly decay during consecutive dry hours');

    // Test Drainage Heuristic: Scenario 3 - Event day and 4 previous days window (5-day window)
    const sampleDates = [
      '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01',
      '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06',
      '2026-11-07', '2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11'
    ];
    const samplePrecip = [0, 0, 0.05, 0.10, 0, 0, 0.20, 0.10, 0.25, 0, 0, 0.15, 0.90, 0.80, 0];
    const rEventWindow = ws.calculateFieldDrainage({
      time: times,
      precipitation: precipDry,
      temperature_2m: temps,
      weathercode: codes
    }, '2026-11-08T12:00', {
      time: sampleDates,
      precipitation_sum: samplePrecip
    });
    assert.equal(rEventWindow.dailyForecast.length, 5, 'dailyForecast must have exactly 5 days ending on event day');
    assert.equal(rEventWindow.dailyForecast[4].date, '2026-11-08', 'Last daily breakdown item must be the event day');
    assert.equal(rEventWindow.dailyForecast[4].isGameDay, true, 'Event day must have isGameDay=true');
    assert.equal(rEventWindow.dailyForecast[0].date, '2026-11-04', 'First item must be 4 days prior to event');
    assert.ok(!rEventWindow.dailyForecast.some(d => d.date > '2026-11-08'), 'dailyForecast must not include any days after event');
    assert.ok(!rEventWindow.dailyForecast.some(d => d.date < '2026-11-04'), 'dailyForecast must not include days more than 4 days prior to event');
    assert.equal(rEventWindow.rainfall5Day, 0.50, '5-day rainfall must sum 4 previous days + event day (0.10+0.25+0.15 = 0.50)');
    assert.equal(rEventWindow.rainfall5DayFormatted, '0.50"');

    // Verify Today's rainfall prediction marking in 5-day daily breakdown
    const todayTestList = ws.buildDailyForecast({
      time: sampleDates,
      precipitation_sum: samplePrecip,
      weathercode: sampleDates.map((_, idx) => idx === 8 ? 61 : (idx === 11 ? 0 : 2)),
      temperature_2m_max: sampleDates.map((_, idx) => idx === 11 ? 70 : 65),
      temperature_2m_min: sampleDates.map((_, idx) => idx === 11 ? 53 : 50),
      precipitation_probability_max: sampleDates.map((_, idx) => idx === 8 ? 70 : 10)
    }, null, '2026-11-08', '2026-11-06');
    const todayItem = todayTestList.find(d => d.date === '2026-11-06');
    assert.ok(todayItem, 'Today must be present in 5-day forecast');
    assert.equal(todayItem.isToday, true, 'Today item must have isToday=true');
    const trackHtml = ws.renderDailyRainTrackHtml(todayTestList);
    assert.ok(trackHtml.includes('is-today'), 'renderDailyRainTrackHtml must apply .is-today class');
    assert.ok(trackHtml.includes('today-pill'), 'renderDailyRainTrackHtml must render .today-pill');
    assert.ok(trackHtml.includes('game-day-pill') && trackHtml.includes('Game Day'), 'renderDailyRainTrackHtml must render .game-day-pill');
    assert.ok(trackHtml.includes('class="day-temp"') && trackHtml.includes('70° / 53°'), 'renderDailyRainTrackHtml must render .day-temp high/low temperatures');
    assert.ok(trackHtml.includes('class="day-condition"'), 'renderDailyRainTrackHtml must render .day-condition label');
    assert.ok(trackHtml.includes('class="day-prob"') && trackHtml.includes('70%'), 'renderDailyRainTrackHtml must render .day-prob precipitation probability');

    // Test Drainage Heuristic: Scenario 4 - 0.60" Rain Sunday morning (Recent rain, puddles formed)
    const rSun = ws.calculateFieldDrainage({
      time: times,
      precipitation: precipSunMorningRain,
      temperature_2m: temps,
      weathercode: codes
    }, '2026-11-08T12:00');
    assert.equal(rSun.status, 'rainout_risk', 'Rain 1-3h before warmups must trigger rainout risk due to standing puddles');
    assert.ok(rSun.effectiveMoisture >= 0.40, 'Surface moisture must remain high without drying time');

    // Test Drainage Heuristic: Scenario 5 - Dry noon-2 PM, rain starting at 2 PM (Cut short rather than full rainout)
    const precipLateStart = precipDry.map((_, idx) => (idx === 38 ? 0.15 : (idx === 39 ? 0.23 : 0)));
    const rCutShort = ws.calculateFieldDrainage({
      time: times,
      precipitation: precipLateStart,
      temperature_2m: temps,
      weathercode: codes
    }, '2026-11-08T12:00');
    assert.equal(rCutShort.status, 'alert', 'Rain starting 2+ hours into a dry event must warn as alert instead of full rainout');
    assert.equal(rCutShort.badgeClass, 'badge-orange');
    assert.equal(rCutShort.statusLabel, 'Cut Short by 2 PM Rain');
    assert.ok(rCutShort.prognosis.includes('12 PM – 2 PM') && rCutShort.prognosis.includes('cut short'), 'Prognosis must note dry early window before 2 PM rain');

    // Test Drainage Heuristic: Scenario 6 - Rain starting right at noon (Full rainout)
    const precipEarlyGameRain = precipDry.map((_, idx) => (idx === 36 || idx === 37 ? 0.15 : 0));
    const rEarlyRain = ws.calculateFieldDrainage({
      time: times,
      precipitation: precipEarlyGameRain,
      temperature_2m: temps,
      weathercode: codes
    }, '2026-11-08T12:00');
    assert.equal(rEarlyRain.status, 'rainout_risk', 'Rain starting at 12 PM must trigger rainout_risk');
    assert.equal(rEarlyRain.statusLabel, 'Rainout Expected (Game-Time Rain)');

    // Test Drainage Heuristic: Scenario 7 - Rain only after 4 PM wrap-up (Playable 12-4 PM)
    const precipPostEventRain = precipDry.map((_, idx) => (idx === 41 || idx === 42 ? 0.20 : 0));
    const rPostEvent = ws.calculateFieldDrainage({
      time: times,
      precipitation: precipPostEventRain,
      temperature_2m: temps,
      weathercode: codes
    }, '2026-11-08T12:00');
    assert.equal(rPostEvent.status, 'good', 'Rain starting only at 5-6 PM must not trigger a rainout for the 12-4 PM event');
    assert.ok(rPostEvent.prognosis.includes('after 4:00 PM wrap-up'), 'Prognosis should mention late rain after 4:00 PM');

    // Verify rendered widget clearly distinguishes Hourly Rainfall vs Expected Surface Water
    ws.renderAssistantWidget('smart-rainout-widget', rSat, { locationName: 'Bushrod Park Field 1' });
    const widgetHtml = mockWidgetContainer.innerHTML;
    assert.ok(widgetHtml.includes('Hourly Rainfall vs. Expected Surface Water'), 'Widget must title the dual hourly chart');
    assert.ok(widgetHtml.includes('Hourly Rainfall (in/hr)'), 'Widget legend must label Hourly Rainfall (in/hr)');
    assert.ok(widgetHtml.includes('Expected Surface Water (in)'), 'Widget legend must label Expected Surface Water (in)');
    assert.ok(widgetHtml.includes('drainage-bar-rain') && widgetHtml.includes('drainage-bar-surface'), 'Widget must render separate bars for rainfall and expected surface water');
    assert.ok(widgetHtml.includes('💧 Rain') && widgetHtml.includes('🌊 Water'), 'Widget must label separate numeric rows for Rain and Water');
    assert.ok(widgetHtml.includes('Noon Warmup Water:'), 'Widget must call out Noon Warmup Water summary chip');

    // 4. Verify UI Card & Page Integrations
    const appJs = fs.readFileSync(path.join(publicDir, 'js', 'app.js'), 'utf8');
    assert.ok(appJs.includes('sunday-weather-badge'), 'app.js must render .sunday-weather-badge container on calendar cards');
    assert.ok(appJs.includes('drawer-weather-'), 'app.js must render drawer weather element');
    assert.ok(appJs.includes('drawer-5day-weather-'), 'app.js must render 5-day rainfall daily strip container in drawer');
    assert.ok(appJs.includes('5-Day Rainfall Prediction'), 'app.js detail card drawer must display 5-day rainfall prediction');
    assert.ok(appJs.includes('populateCardWeatherBadges'), 'app.js must trigger WeatherService.populateCardWeatherBadges()');

    const eventHtml = fs.readFileSync(path.join(publicDir, 'event.html'), 'utf8');
    assert.ok(eventHtml.includes('id="smart-rainout-widget"'), 'event.html must contain #smart-rainout-widget');
    assert.ok(eventHtml.includes('id="event-weather-meta-item"'), 'event.html must contain #event-weather-meta-item');
    assert.ok(eventHtml.includes('/js/weather.js'), 'event.html must script-load weather.js');

    const eventJs = fs.readFileSync(path.join(publicDir, 'js', 'event.js'), 'utf8');
    assert.ok(eventJs.includes('renderAssistantWidget'), 'event.js must call WeatherService.renderAssistantWidget');
    assert.ok(eventJs.includes('10-day forecast activates closer to game'), 'event.js must specify 10-day forecast activation window');

    const headersFile = fs.readFileSync(path.join(publicDir, '_headers'), 'utf8');
    assert.ok(headersFile.includes('https://api.open-meteo.com'), '_headers CSP connect-src must allow https://api.open-meteo.com');
    assert.ok(headersFile.includes('https://geocoding-api.open-meteo.com'), '_headers CSP connect-src must allow https://geocoding-api.open-meteo.com');

    // Test Dynamic Location & Coordinate Extraction
    assert.equal(typeof ws.extractCoordinates, 'function', 'extractCoordinates must be a function');
    assert.equal(typeof ws.resolveCoordsForLocation, 'function', 'resolveCoordsForLocation must be a function');
    const coordDirect = ws.extractCoordinates('Bushrod Diamond 2 (37.8427, -122.2699)');
    assert.ok(coordDirect, 'Direct coordinates should be parsed');
    assert.equal(Math.round(coordDirect.latitude * 1000) / 1000, 37.843);
    assert.equal(Math.round(coordDirect.longitude * 1000) / 1000, -122.270);

    const coordMapUrl = ws.getCoordsForLocation('https://maps.google.com/?q=37.7749,-122.4194');
    assert.equal(Math.round(coordMapUrl.latitude * 1000) / 1000, 37.775);

    const bushrodCoords = ws.getCoordsForLocation('Bushrod Park Field 1');
    assert.equal(Math.round(bushrodCoords.latitude * 1000) / 1000, 37.843);

    const sanPabloCoords = ws.getCoordsForLocation('San Pablo Park Field 2, Berkeley');
    assert.equal(Math.round(sanPabloCoords.latitude * 1000) / 1000, 37.856);

    const bigRecCoords = ws.getCoordsForLocation('Big Rec Field, San Francisco');
    assert.equal(Math.round(bigRecCoords.latitude * 1000) / 1000, 37.769);

    const washingtonCoords = ws.getCoordsForLocation('Washington Park, Alameda');
    assert.equal(Math.round(washingtonCoords.latitude * 1000) / 1000, 37.772);

    const unknownCoords = ws.getCoordsForLocation('Unknown Unscheduled Field 999');
    assert.equal(Math.round(unknownCoords.latitude * 1000) / 1000, 37.843, 'Unknown location safely defaults to Bushrod');

    assert.ok(appJs.includes('data-weather-location'), 'app.js must pass data-weather-location to calendar card badge');

    assert.ok(weatherJsCode.includes('forecast_days=10'), 'weather.js must query 10-day forecast horizon');
    assert.ok(weatherJsCode.includes('renderDailyRainTrackHtml'), 'weather.js must define renderDailyRainTrackHtml');
    assert.ok(weatherJsCode.includes('five-day-rain-track'), 'weather.js must render .five-day-rain-track');
    assert.ok(weatherJsCode.includes('10-day weather forecasts'), 'weather.js must describe 10-day forecast in assistant widget');
    assert.ok(weatherJsCode.includes('10-day weather forecasts'), 'weather.js must describe 10-day forecast in assistant widget');

    const adminHtml = fs.readFileSync(path.join(publicDir, 'admin.html'), 'utf8');
    assert.ok(adminHtml.includes('/js/weather.js'), 'admin.html must script-load weather.js');

    const adminJs = fs.readFileSync(path.join(publicDir, 'js', 'admin.js'), 'utf8');
    assert.ok(adminJs.includes('toggleAdminWeatherPanel'), 'admin.js must define toggleAdminWeatherPanel');

    const indexHtml = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
    assert.ok(indexHtml.includes('/js/weather.js'), 'index.html must script-load weather.js');
    assert.ok(!indexHtml.includes('sunday-rules-accordion'), 'index.html must have rules accordion removed');
    assert.ok(indexHtml.includes('sunday-routine-section'), 'index.html must contain sunday-routine-section');
    assert.ok(indexHtml.includes('Sunday Afternoon Routine (12:00 PM – 4:00 PM)'), 'index.html must display Sunday Afternoon Routine');
    assert.ok(!weatherJsCode.includes('Sunday Afternoon Routine'), 'weather.js must not contain Sunday Afternoon Routine');

    const swJs = fs.readFileSync(path.join(publicDir, 'sw.js'), 'utf8');
    assert.ok(swJs.includes('/js/weather.js'), 'sw.js must cache /js/weather.js for offline use');

    // 5. Verify Handbook documentation
    const handbookMd = fs.readFileSync(path.join(ctx.rootDir, 'HANDBOOK.md'), 'utf8');
    assert.ok(handbookMd.includes('Sunday Afternoon Routine (12:00 PM – 4:00 PM)'), 'HANDBOOK.md must document authentic 12 PM - 4 PM routine');
    assert.ok(handbookMd.includes('Smart Rainout Assistant & 24-Hour Surface Accumulation Drainage Tracker'), 'HANDBOOK.md must document Smart Rainout Assistant');
    assert.ok(handbookMd.includes('Dynamic Field Location Awareness'), 'HANDBOOK.md must document Dynamic Field Location Awareness');
    assert.ok(handbookMd.includes('10-day weather forecast'), 'HANDBOOK.md must document 10-day weather forecast');
    assert.ok(handbookMd.includes('12:00 PM – 12:30 PM (Warm-ups & Throwing)'), 'HANDBOOK.md must document warmups and throwing');
    assert.ok(handbookMd.includes('12:30 PM – 1:30 PM (Batting Practice)'), 'HANDBOOK.md must document 1 hour of BP');
    assert.ok(handbookMd.includes('3:15 PM – 4:00 PM (Fielding Drills & Field Care)'), 'HANDBOOK.md must document drills and dragging until 4pm');
  });

  await t9.test('T9.20: Paid Operations & Fair-Share Task Scheduling Policy (12-Week Unlock, Badges, Rolling Cap, and Hero Credits)', async () => {
    // 1. Create a future event >12 weeks away (e.g. 16 weeks ahead)
    const farDate = new Date(Date.now() + 16 * 7 * 24 * 3600 * 1000).toISOString();
    const farRes = await apiReq('POST', '/api/events', seedOrgCookie, {
      title: 'Far Future Game (Locked Tasks)',
      location: 'Bushrod Park Field 1',
      event_date: farDate
    });
    assert.equal(farRes.status, 200);
    const farId = farRes.data.eventId;

    // Check GET details
    const farDetail = await apiReq('GET', `/api/events/${farId}`, null);
    assert.equal(farDetail.status, 200);
    assert.equal(farDetail.data.event.is_tasks_unlocked, false, 'Far future event tasks must be locked');
    assert.equal(farDetail.data.event.task_tier, 'locked', 'Task tier must be locked');

    // Attempting to select task when locked must return 400
    const farDutyId = farDetail.data.duties[0].id;
    const lockAttempt = await apiReq('POST', `/api/events/${farId}/rsvp`, null, {
      name: 'Early Bird',
      email: 'early_bird@sundaypickup.org',
      players_count: 1,
      duty_ids: [farDutyId]
    });
    assert.equal(lockAttempt.status, 400);
    assert.ok(lockAttempt.data.error.includes('locked until'), 'Error must specify tasks are locked');

    // 2. Create an event in Tier 1 (e.g. 8 weeks away)
    const tier1Date = new Date(Date.now() + 8 * 7 * 24 * 3600 * 1000).toISOString();
    const t1Res = await apiReq('POST', '/api/events', seedOrgCookie, {
      title: 'Tier 1 Scheduling Game',
      location: 'Bushrod Park Field 1',
      event_date: tier1Date
    });
    assert.equal(t1Res.status, 200);
    const t1Id = t1Res.data.eventId;

    const t1Detail = await apiReq('GET', `/api/events/${t1Id}`, null);
    assert.equal(t1Detail.data.event.is_tasks_unlocked, true, 'Tier 1 event tasks must be unlocked');
    assert.equal(t1Detail.data.event.task_tier, 'tier1', 'Task tier must be tier1');

    const machineDuty = t1Detail.data.duties.find(d => d.title.toLowerCase().includes('machine'));
    const fieldDuty = t1Detail.data.duties.find(d => d.title.toLowerCase().includes('drag'));
    assert.ok(machineDuty, 'Must have pitching machine duty');
    assert.ok(fieldDuty, 'Must have field dragging duty');
    assert.equal(machineDuty.is_eligible, false, 'Logged-out visitor must not be eligible for certified task');
    assert.equal(machineDuty.ineligibility_reason, 'To select this task you must first complete training');
    assert.equal(fieldDuty.ineligibility_reason, 'To select this task you must first complete training');

    // Unauthenticated or unbadged player claiming machine duty -> 400
    const unbadgedAttempt = await apiReq('POST', `/api/events/${t1Id}/rsvp`, null, {
      name: 'Uncertified Worker',
      email: 'uncertified@sundaypickup.org',
      players_count: 1,
      duty_ids: [machineDuty.id]
    });
    assert.equal(unbadgedAttempt.status, 400);
    assert.ok(unbadgedAttempt.data.error.includes('complete training'));
    assert.ok(unbadgedAttempt.data.error.includes('Pitching Machine Badge'));

    // Register a certified worker
    const workerUser = db.prepare("INSERT INTO users (name, email, role, machine_badge, field_badge, hero_credits) VALUES (?, ?, 'player', 1, 1, 0)").run(
      'Certified Pro', 'certified_pro@sundaypickup.org'
    );
    const workerId = workerUser.lastInsertRowid;
    const workerSession = createSession(workerId).sessionId;
    const workerCookie = `baseball_session=${workerSession}`;

    // Badged player claiming machine duty -> 200
    const badgedRsvp = await apiReq('POST', `/api/events/${t1Id}/rsvp`, workerCookie, {
      players_count: 1,
      duty_ids: [machineDuty.id]
    });
    assert.equal(badgedRsvp.status, 200, 'Certified badged worker must be permitted to claim machine duty');

    // 3. Test Admin badge and hero credits update endpoint
    const updateBadgeRes = await apiReq('PUT', `/api/auth/users/${workerId}/badges`, seedAdminCookie, {
      hero_credits: 2
    });
    assert.equal(updateBadgeRes.status, 200);
    assert.equal(updateBadgeRes.data.user.hero_credits, 2);

    // Verify GET /api/auth/users includes machine_badge, field_badge, and hero_credits
    const usersListRes = await apiReq('GET', '/api/auth/users', seedAdminCookie);
    assert.equal(usersListRes.status, 200);
    const listedWorker = usersListRes.data.users.find(u => u.id === workerId);
    assert.equal(listedWorker.machine_badge, 1);
    assert.equal(listedWorker.field_badge, 1);
    assert.equal(listedWorker.hero_credits, 2);

    // 4. Test Tier 3 urgent cover (<48h)
    const urgentDate = new Date(Date.now() + 24 * 3600 * 1000).toISOString(); // 24 hours from now
    const urgentEventRes = await apiReq('POST', '/api/events', seedOrgCookie, {
      title: 'Urgent Cover Game Tomorrow',
      location: 'Bushrod Park Field 1',
      event_date: urgentDate
    });
    const urgentId = urgentEventRes.data.eventId;
    const urgentDetail = await apiReq('GET', `/api/events/${urgentId}`, workerCookie);
    assert.equal(urgentDetail.data.event.task_tier, 'tier3');
    const urgentMachineDuty = urgentDetail.data.duties.find(d => d.title.toLowerCase().includes('machine'));

    // Claim urgent shift -> awards +1 hero credit
    const beforeCredits = db.prepare('SELECT hero_credits FROM users WHERE id = ?').get(workerId).hero_credits;
    const urgentClaim = await apiReq('POST', `/api/events/${urgentId}/rsvp`, workerCookie, {
      players_count: 1,
      duty_ids: [urgentMachineDuty.id]
    });
    assert.equal(urgentClaim.status, 200);
    const afterCredits = db.prepare('SELECT hero_credits FROM users WHERE id = ?').get(workerId).hero_credits;
    assert.equal(afterCredits, beforeCredits + 1, 'Claiming urgent cover (<48h) must award +1 Backup Hero Credit');

    // 5. Verify Handbook Section 2.5 documentation
    const handbookMd = fs.readFileSync(path.join(ctx.rootDir, 'HANDBOOK.md'), 'utf8');
    assert.ok(handbookMd.includes('Paid Operations & Fair-Share Task Scheduling Policy'), 'HANDBOOK.md must document Paid Operations Policy');
    assert.ok(handbookMd.includes('5:00 AM on Monday, 12 weeks prior to game day'), 'HANDBOOK.md must document Monday 5:00 AM release trigger');
    assert.ok(handbookMd.includes('Backup Hero Credit'), 'HANDBOOK.md must document Backup Hero Credits');
  });

  await t9.test('T9.22: Unified Backend Parity (Settings, Banned Emails, Comment Deletion, SQL Backup) & Version Sync', async () => {
    // 1. Settings toggle & anonymous guest policy enforcement
    const s0 = await apiReq('GET', '/api/settings');
    assert.equal(s0.status, 200);
    const s1 = await apiReq('PUT', '/api/settings', seedAdminCookie, { require_login_to_rsvp: true });
    assert.equal(s1.status, 200);
    assert.equal(s1.data.require_login_to_rsvp, true);
    const anonBlocked = await apiReq('POST', `/api/events/${sharedEventId}/rsvp`, null, {
      name: 'Blocked Anon',
      email: 'anon-blocked@example.com'
    });
    assert.equal(anonBlocked.status, 401, 'Anonymous RSVP must be blocked when require_login_to_rsvp is enabled');
    await apiReq('PUT', '/api/settings', seedAdminCookie, { require_login_to_rsvp: false });

    // Test appscript_upload_url setting persistence for Google Drive storage
    const appscriptSet = await apiReq('PUT', '/api/settings', seedAdminCookie, {
      appscript_upload_url: 'https://script.google.com/macros/s/test_fake_appscript_id/exec'
    });
    assert.equal(appscriptSet.status, 200, 'Setting appscript_upload_url must return 200');
    assert.equal(appscriptSet.data.appscript_upload_url, 'https://script.google.com/macros/s/test_fake_appscript_id/exec');

    const appscriptGetAnon = await apiReq('GET', '/api/settings');
    assert.equal(appscriptGetAnon.data.appscript_upload_url, undefined, 'Unauthenticated GET /api/settings must not leak appscript_upload_url');
    assert.equal(appscriptGetAnon.data.appscript_configured, true);

    const appscriptGetAdmin = await apiReq('GET', '/api/settings', seedAdminCookie);
    assert.equal(appscriptGetAdmin.data.appscript_upload_url, 'https://script.google.com/macros/s/test_fake_appscript_id/exec');

    // Test POST /api/settings/test-appscript endpoint validation
    const testAppscriptNoAuth = await apiReq('POST', '/api/settings/test-appscript', null, { url: 'https://invalid.com' });
    assert.equal(testAppscriptNoAuth.status, 401, 'Unauthenticated test-appscript call must return 401');

    const testAppscriptInvalidUrl = await apiReq('POST', '/api/settings/test-appscript', seedAdminCookie, { url: 'https://invalid-domain.com/something' });
    assert.equal(testAppscriptInvalidUrl.status, 400, 'Invalid URL format must return 400');
    assert.ok(testAppscriptInvalidUrl.data.error.includes('Expected format'), 'Should return clear URL format error');

    // Reset appscript setting
    await apiReq('PUT', '/api/settings', seedAdminCookie, { appscript_upload_url: '' });

    // 2. Banned emails lifecycle
    const banRes = await apiReq('POST', '/api/auth/banned-emails', seedAdminCookie, {
      email: 'banned-test@example.com',
      reason: 'Automated test ban'
    });
    assert.equal(banRes.status, 200);
    const listBan = await apiReq('GET', '/api/auth/banned-emails', seedAdminCookie);
    assert.equal(listBan.status, 200);
    const foundBan = listBan.data.bannedEmails.find(b => b.email === 'banned-test@example.com');
    assert.ok(foundBan, 'Banned email must appear in list');
    const codeBlocked = await apiReq('POST', '/api/auth/send-code', null, { email: 'banned-test@example.com' });
    assert.equal(codeBlocked.status, 403, 'Banned email must be blocked from requesting login codes');
    const unbanRes = await apiReq('DELETE', `/api/auth/banned-emails/${foundBan.id}`, seedAdminCookie);
    assert.equal(unbanRes.status, 200);

    // 3. Comment creation & organizer/admin deletion
    const cmtRes = await apiReq('POST', `/api/events/${sharedEventId}/comments`, seedPlayerCookie, {
      content: 'Temporary comment for deletion test'
    });
    assert.equal(cmtRes.status, 200);
    const delCmt = await apiReq('DELETE', `/api/events/${sharedEventId}/comments/${cmtRes.data.comment.id}`, seedAdminCookie);
    assert.equal(delCmt.status, 200);

    // 4. SQL database backup export (both BASEBALL_DB and CHAT_DB)
    const backupRes = await fetch(`${baseUrl}/api/events/admin/backup-db`, {
      headers: { Cookie: seedAdminCookie }
    });
    assert.equal(backupRes.status, 200);
    const sqlDump = await backupRes.text();
    assert.ok(sqlDump.includes('-- Sunday Pickup Baseball Database Backup') && sqlDump.includes('INSERT OR IGNORE INTO "users"'), 'Backup dump must contain backup header and user rows');

    const chatBackupRes = await fetch(`${baseUrl}/api/events/admin/backup-db?db=chat`, {
      headers: { Cookie: seedAdminCookie }
    });
    assert.equal(chatBackupRes.status, 200);
    const chatSqlDump = await chatBackupRes.text();
    assert.ok(chatSqlDump.includes('-- Sunday Pickup Baseball Clubhouse (CHAT_DB) Database Backup') && chatSqlDump.includes('INSERT OR IGNORE INTO "channels"'), 'Chat backup dump must contain CHAT_DB header and channels rows');

    const badBackupRes = await apiReq('GET', '/api/events/admin/backup-db?db=invalid', seedAdminCookie);
    assert.equal(badBackupRes.status, 400, 'Unknown backup db target must return 400');

    // 5. Atomic version stamp synchronization across backend, SW, API client, and HTML assets
    const swSrc = fs.readFileSync(path.join(publicDir, 'sw.js'), 'utf8');
    assert.ok(swSrc.includes(`CACHE_NAME = 'pbf-cache-v${CURRENT_APP_VERSION}'`), 'sw.js CACHE_NAME must match CURRENT_APP_VERSION');
    const apiSrc = fs.readFileSync(path.join(publicDir, 'js', 'api.js'), 'utf8');
    assert.ok(apiSrc.includes(`CLIENT_VERSION: '${CURRENT_APP_VERSION}'`), 'api.js CLIENT_VERSION must match CURRENT_APP_VERSION');
    for (const entry of fs.readdirSync(publicDir)) {
      if (!entry.endsWith('.html')) continue;
      const html = fs.readFileSync(path.join(publicDir, entry), 'utf8');
      const versions = [...html.matchAll(/\?v=(\d+)/g)].map(m => m[1]);
      assert.ok(versions.length > 0, `${entry} must include ?v= asset cache-busting query strings`);
      for (const v of versions) {
        assert.equal(v, CURRENT_APP_VERSION, `${entry} asset ?v=${v} must match CURRENT_APP_VERSION (${CURRENT_APP_VERSION})`);
      }
    }
  });

  await t9.test('T9.23: Community Art Studio (Pixel Diamond, Equipment Trunk & Dugout Chalkboard)', async () => {
    // 1. Verify art.html exists and contains the three shared art spaces
    const artHtmlPath = path.join(publicDir, 'art.html');
    assert.ok(fs.existsSync(artHtmlPath), 'public/art.html must exist');
    const artHtml = fs.readFileSync(artHtmlPath, 'utf8');
    assert.ok(artHtml.includes('id="pixel-diamond-canvas"'), 'art.html must contain #pixel-diamond-canvas');
    assert.ok(artHtml.includes('id="trunk-canvas-stage"'), 'art.html must contain #trunk-canvas-stage');
    assert.ok(artHtml.includes('id="chalkboard-canvas"'), 'art.html must contain #chalkboard-canvas');
    assert.ok(artHtml.includes('id="art-admin-banner"'), 'art.html must contain #art-admin-banner');
    assert.ok(artHtml.includes('art-admin-only'), 'art.html must contain art-admin-only controls');
    assert.ok(artHtml.includes('/js/art.js'), 'art.html must script-load /js/art.js');
    assert.ok(artHtml.includes('/js/api.js'), 'art.html must script-load /js/api.js');

    // 2. Verify public/js/art.js exists and is valid strict ES6
    const artJsPath = path.join(publicDir, 'js', 'art.js');
    assert.ok(fs.existsSync(artJsPath), 'public/js/art.js must exist');
    const artJsCode = fs.readFileSync(artJsPath, 'utf8');
    assert.ok(!artJsCode.includes('?.'), 'art.js must not contain optional chaining (?.)');
    assert.ok(!artJsCode.includes('??'), 'art.js must not contain nullish coalescing (??)');
    assert.ok(artJsCode.includes('initPixelDiamond'), 'art.js must implement initPixelDiamond');
    assert.ok(artJsCode.includes('initEquipmentTrunk'), 'art.js must implement initEquipmentTrunk');
    assert.ok(artJsCode.includes('initDugoutChalkboard'), 'art.js must implement initDugoutChalkboard');
    assert.ok(artJsCode.includes('setUser'), 'art.js must implement admin setUser');
    assert.ok(artJsCode.includes('window.ArtStudio'), 'art.js must mount window.ArtStudio');

    // 3. Verify Community Art Studio retired from gallery.html & archived in docs
    const galleryHtml = fs.readFileSync(path.join(publicDir, 'gallery.html'), 'utf8');
    assert.ok(!galleryHtml.includes('id="community-art-section"'), 'gallery.html must have retired #community-art-section');
    assert.ok(!galleryHtml.includes('id="pixel-diamond-canvas"'), 'gallery.html must not house #pixel-diamond-canvas');
    assert.ok(!galleryHtml.includes('id="trunk-canvas-stage"'), 'gallery.html must not house #trunk-canvas-stage');

    const archiveDocPath = path.join(ctx.rootDir, 'docs', 'COMMUNITY_ART_STUDIO_ARCHIVE.md');
    assert.ok(fs.existsSync(archiveDocPath), 'docs/COMMUNITY_ART_STUDIO_ARCHIVE.md must exist');
    const archiveDoc = fs.readFileSync(archiveDocPath, 'utf8');
    assert.ok(archiveDoc.includes('Pixel Diamond'), 'archive doc must detail Pixel Diamond');
    assert.ok(archiveDoc.includes('Dugout Chalkboard'), 'archive doc must detail Chalkboard & Sticker Wall');

    const apiJs = fs.readFileSync(path.join(publicDir, 'js', 'api.js'), 'utf8');
    assert.ok(apiJs.includes('nav-link-gallery'), 'api.js must render .nav-link-gallery in API.renderNav()');
    assert.ok(apiJs.includes('/gallery.html'), 'api.js must link to /gallery.html');

    const indexHtml = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
    assert.ok(indexHtml.includes('href="/gallery.html"'), 'index.html must include link to /gallery.html');

    // 4. Verify Service Worker and CSS styling
    const swJs = fs.readFileSync(path.join(publicDir, 'sw.js'), 'utf8');
    assert.ok(swJs.includes('/art.html') || swJs.includes('/gallery.html'), 'sw.js must cache art / gallery assets');
    assert.ok(swJs.includes('/js/art.js'), 'sw.js must cache /js/art.js');

    const styleCss = fs.readFileSync(path.join(publicDir, 'css', 'style.css'), 'utf8');
    assert.ok(styleCss.includes('.pixel-canvas-frame'), 'style.css must define .pixel-canvas-frame');
    assert.ok(styleCss.includes('.trunk-outer-box'), 'style.css must define .trunk-outer-box');
    assert.ok(styleCss.includes('.chalkboard-frame'), 'style.css must define .chalkboard-frame');
  });

  await t9.test('T9.24: Community Photo & Video Gallery (Zero-Login Drop, Remote Image Copy, Chronological Order & Album Bookmarks)', async () => {
    // 1. Verify gallery.html structure & components
    const galleryHtmlPath = path.join(publicDir, 'gallery.html');
    assert.ok(fs.existsSync(galleryHtmlPath), 'public/gallery.html must exist');
    const galleryHtml = fs.readFileSync(galleryHtmlPath, 'utf8');
    assert.ok(galleryHtml.includes('id="album-bookmarks-bar"'), 'gallery.html must contain #album-bookmarks-bar for album bookmarks');
    assert.ok(galleryHtml.includes('id="videos-grid-container"'), 'gallery.html must contain #videos-grid-container');
    assert.ok(galleryHtml.includes('id="photos-albums-container"'), 'gallery.html must contain #photos-albums-container');
    assert.ok(galleryHtml.includes('id="photos-time-ribbon"'), 'gallery.html must contain photo carousel time guidance ribbon');
    assert.ok(galleryHtml.includes('id="videos-time-ribbon"'), 'gallery.html must contain video carousel time guidance ribbon');
    assert.ok(galleryHtml.includes('id="photos-edge-left"'), 'gallery.html must contain left graphical edge hint for earlier/later photos');
    assert.ok(galleryHtml.includes('id="photos-edge-right"'), 'gallery.html must contain right graphical edge hint for earlier/later photos');
    assert.ok(galleryHtml.includes('id="photos-paddle-prev"'), 'gallery.html must contain left paddle for photo carousel');
    assert.ok(galleryHtml.includes('id="photos-paddle-next"'), 'gallery.html must contain right paddle for photo carousel');
    assert.ok(galleryHtml.includes('id="videos-paddle-prev"'), 'gallery.html must contain left paddle for video carousel');
    assert.ok(galleryHtml.includes('id="videos-paddle-next"'), 'gallery.html must contain right paddle for video carousel');
    assert.ok(galleryHtml.includes('id="media-moderation-queue"'), 'gallery.html must contain #media-moderation-queue for admin approval');
    assert.ok(galleryHtml.includes('id="submit-media-section"'), 'gallery.html must contain #submit-media-section');
    assert.ok(galleryHtml.includes('id="media-submit-form"'), 'gallery.html must contain #media-submit-form');
    assert.ok(galleryHtml.includes('id="media-date-input"'), 'gallery.html must ask for approximate date taken');
    assert.ok(galleryHtml.includes('id="gallery-lightbox"'), 'gallery.html must contain #gallery-lightbox modal');
    assert.ok(galleryHtml.includes('Once uploaded, David will approve it then it will be displayed in the webapp'), 'gallery.html must notify user that David will approve uploads before display');
    assert.ok(galleryHtml.includes('/js/gallery.js'), 'gallery.html must load /js/gallery.js');
    assert.ok(galleryHtml.includes('/js/api.js'), 'gallery.html must load /js/api.js');

    // 2. Verify public/js/gallery.js strict ES6 compliance
    const galleryJsPath = path.join(publicDir, 'js', 'gallery.js');
    assert.ok(fs.existsSync(galleryJsPath), 'public/js/gallery.js must exist');
    const galleryJsCode = fs.readFileSync(galleryJsPath, 'utf8');
    assert.ok(!galleryJsCode.includes('?.'), 'gallery.js must not contain optional chaining (?.)');
    assert.ok(!galleryJsCode.includes('??'), 'gallery.js must not contain nullish coalescing (??)');
    assert.ok(galleryJsCode.includes('initGallery'), 'gallery.js must implement initGallery');
    assert.ok(galleryJsCode.includes('renderPendingQueue'), 'gallery.js must implement renderPendingQueue');
    assert.ok(galleryJsCode.includes('renderAlbumBookmarks'), 'gallery.js must implement renderAlbumBookmarks');
    assert.ok(galleryJsCode.includes('renderVideos'), 'gallery.js must implement renderVideos');
    assert.ok(galleryJsCode.includes('renderPhotos'), 'gallery.js must implement renderPhotos');
    assert.ok(galleryJsCode.includes('jumpToAlbum'), 'gallery.js must implement jumpToAlbum');
    assert.ok(galleryJsCode.includes('setupCarouselPaddles'), 'gallery.js must implement setupCarouselPaddles');
    assert.ok(galleryJsCode.includes('updateCarouselEdgeHints'), 'gallery.js must implement updateCarouselEdgeHints');

    // 3. Verify top navigation links & Service Worker
    const apiJs = fs.readFileSync(path.join(publicDir, 'js', 'api.js'), 'utf8');
    assert.ok(apiJs.includes('nav-link-gallery'), 'api.js must render .nav-link-gallery in API.renderNav()');
    assert.ok(apiJs.includes('/gallery.html'), 'api.js must link to /gallery.html');

    const indexHtml = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
    assert.ok(indexHtml.includes('href="/gallery.html"'), 'index.html must include static fallback link to /gallery.html');

    const swJs = fs.readFileSync(path.join(publicDir, 'sw.js'), 'utf8');
    assert.ok(swJs.includes('/gallery.html'), 'sw.js must cache /gallery.html');
    assert.ok(swJs.includes('/js/gallery.js'), 'sw.js must cache /js/gallery.js');

    const styleCss = fs.readFileSync(path.join(publicDir, 'css', 'style.css'), 'utf8');
    assert.ok(styleCss.includes('.nav-link-gallery'), 'style.css must define .nav-link-gallery');
    assert.ok(styleCss.includes('.album-bookmarks-scroll'), 'style.css must define .album-bookmarks-scroll');
    assert.ok(styleCss.includes('.album-bookmark-pill'), 'style.css must define .album-bookmark-pill');
    assert.ok(styleCss.includes('.carousel-stage-wrap'), 'style.css must define .carousel-stage-wrap');
    assert.ok(styleCss.includes('.carousel-track'), 'style.css must define .carousel-track');
    assert.ok(styleCss.includes('.carousel-paddle'), 'style.css must define .carousel-paddle');
    assert.ok(styleCss.includes('.carousel-edge-hint'), 'style.css must define .carousel-edge-hint');
    assert.ok(styleCss.includes('.photo-jump-focus'), 'style.css must define .photo-jump-focus');
    assert.ok(styleCss.includes('.photo-card'), 'style.css must define .photo-card');
    assert.ok(styleCss.includes('.video-facade-container'), 'style.css must define .video-facade-container');

    // 4. API Acceptance: Query GET /api/media
    const getRes = await fetch(`${baseUrl}/api/media`);
    assert.equal(getRes.status, 200, 'GET /api/media must return 200');
    const initialData = await getRes.json();
    assert.ok(Array.isArray(initialData.media), 'GET /api/media must return media array');
    assert.ok(Array.isArray(initialData.albums), 'GET /api/media must return albums array');
    assert.ok(initialData.media.length >= 3, 'GET /api/media must contain seeded media items');

    // 5. Zero-Login Submission with YouTube link (leave YouTube links as links)
    const ytSubmitRes = await fetch(`${baseUrl}/api/media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        title: 'Championship 9th Inning Rally',
        date_taken: '2026-10-26',
        album: 'Fall 2026 Season',
        contributor_name: 'Marcus Rivera'
      })
    });
    assert.equal(ytSubmitRes.status, 200, 'Zero-login YouTube submission must return 200');
    const ytData = await ytSubmitRes.json();
    assert.equal(ytData.item.media_type, 'youtube', 'YouTube submissions must be marked media_type: youtube');
    assert.ok(ytData.item.file_url.includes('youtube.com'), 'YouTube link must be preserved as streaming link');
    assert.equal(ytData.item.date_taken, '2026-10-26', 'Approximate date taken must be saved');
    assert.equal(ytData.item.is_approved, 0, 'Public YouTube submission must require admin approval (is_approved=0)');

    // 6. Zero-Login Submission copying remote/Facebook-hosted image ("copy it all")
    const remoteImgUrl = `${baseUrl}/icons/favicon-32x32.png`;
    const copyImgRes = await fetch(`${baseUrl}/api/media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: remoteImgUrl,
        title: 'Copied Community Mascot Photo',
        date_taken: '2026-10-12',
        album: 'Bushrod Field Opening',
        contributor_name: 'Sarah Chen'
      })
    });
    assert.equal(copyImgRes.status, 200, 'Copying remote image must return 200');
    const copyData = await copyImgRes.json();
    assert.equal(copyData.item.media_type, 'photo', 'Copied image must be marked media_type: photo');
    assert.ok(copyData.item.file_url.startsWith('/api/media/'), 'Copied image must be served from local /api/media/:id/file route');
    assert.equal(copyData.item.original_url, remoteImgUrl, 'Original external image URL must be preserved');
    assert.equal(copyData.item.is_approved, 0, 'Public photo submission must require admin approval (is_approved=0)');

    // Verify unapproved media is hidden from public gallery and unapproved file is 404 for unauthenticated public
    const unapprovedCheck = await fetch(`${baseUrl}/api/media`);
    const unapprovedData = await unapprovedCheck.json();
    assert.ok(!unapprovedData.media.some(m => m.id === copyData.item.id), 'Unapproved media must NOT be displayed in public gallery');

    // Moderation security check: unauthenticated public request to unapproved file returns 404
    const unapprovedFileCheck = await fetch(`${baseUrl}${copyData.item.file_url}`);
    assert.equal(unapprovedFileCheck.status, 404, 'Unapproved media file must return 404 to unauthenticated users');

    // Organizer manager preview can access unapproved media file
    const managerFilePreview = await fetch(`${baseUrl}${copyData.item.file_url}`, {
      headers: { 'Cookie': seedOrgCookie }
    });
    assert.equal(managerFilePreview.status, 200, 'Organizer preview of unapproved file must return 200');

    // 8. Admin Approval Workflow: Organizer approves media item via PUT /api/media/:id/approve
    const approveRes = await apiReq('PUT', `/api/media/${copyData.item.id}/approve`, seedOrgCookie);
    assert.equal(approveRes.status, 200, 'Organizer must be able to approve pending media item');

    // 7. Verify serving the copied image binary via GET /api/media/:id/file once approved
    const serveImgRes = await fetch(`${baseUrl}${copyData.item.file_url}`);
    assert.equal(serveImgRes.status, 200, 'Serving approved copied image must return 200');
    assert.ok(serveImgRes.headers.get('content-type').includes('image/'), 'Content-Type must be image');
    const imgBuf = await serveImgRes.arrayBuffer();
    assert.ok(imgBuf.byteLength > 0, 'Copied image binary must have non-zero size');

    // Once approved, it appears in public gallery
    const approvedCheck = await fetch(`${baseUrl}/api/media`);
    const approvedData = await approvedCheck.json();
    assert.ok(approvedData.media.some(m => m.id === copyData.item.id), 'Approved media item must now appear in public gallery');

    // 9. Verify Chronological Ordering (desc vs asc)
    const descRes = await fetch(`${baseUrl}/api/media?order=desc`);
    const descData = await descRes.json();
    for (let i = 0; i < descData.media.length - 1; i++) {
      assert.ok(descData.media[i].date_taken >= descData.media[i + 1].date_taken, 'order=desc must sort dates newest first');
    }

    const ascRes = await fetch(`${baseUrl}/api/media?order=asc`);
    const ascData = await ascRes.json();
    for (let i = 0; i < ascData.media.length - 1; i++) {
      assert.ok(ascData.media[i].date_taken <= ascData.media[i + 1].date_taken, 'order=asc must sort dates oldest first');
    }

    // 10. Organizer/Admin Edit of media item (PUT /api/media/:id)
    const updateRes = await apiReq('PUT', `/api/media/${copyData.item.id}`, seedOrgCookie, {
      title: 'Updated Championship Photo Title',
      caption: 'Updated dramatic dugout celebration caption.',
      album: 'Tournament Highlights',
      date_taken: '2026-10-25',
      contributor_name: 'David Rowland',
      is_approved: 1
    });
    assert.equal(updateRes.status, 200, 'Organizer must be able to update media item metadata via PUT');
    assert.equal(updateRes.data.item.title, 'Updated Championship Photo Title', 'Updated title must be reflected in response');
    assert.equal(updateRes.data.item.album, 'Tournament Highlights', 'Updated album must be reflected in response');

    // Verify GET /api/media?status=all returns all items for managers
    const allMediaRes = await apiReq('GET', '/api/media?status=all', seedOrgCookie);
    assert.equal(allMediaRes.status, 200, 'GET /api/media?status=all must return 200 for manager');
    assert.ok(Array.isArray(allMediaRes.data.media), 'media array must be present');
    assert.ok(allMediaRes.data.media.some(m => m.id === copyData.item.id), 'Updated media item must be in all media list');

    // 11. Organizer/Admin Deletion of media item from carousels (DELETE & POST /api/media/:id/delete)
    const delRes = await apiReq('DELETE', `/api/media/${copyData.item.id}`, seedOrgCookie);
    assert.equal(delRes.status, 200, 'Organizer must be able to delete media item via DELETE');

    // Confirm item is removed from public carousels
    const afterDelRes = await fetch(`${baseUrl}/api/media`);
    const afterDelData = await afterDelRes.json();
    assert.ok(!afterDelData.media.some(m => m.id === copyData.item.id), 'Deleted photo must no longer be present in gallery carousels');

    // 12. Uploader Takedown Workflow:
    // Verify zero-login submission returns delete_token
    assert.ok(ytData.delete_token, 'Zero-login submission must return delete_token');

    // Unauthenticated attempt to delete without token -> 403
    const unauthDelRes = await fetch(`${baseUrl}/api/media/${ytData.item.id}`, { method: 'DELETE' });
    assert.equal(unauthDelRes.status, 403, 'Unauthorized delete attempt without token must return 403');

    // Zero-login uploader takedown using delete token in X-Delete-Token header -> 200
    const tokenDelRes = await fetch(`${baseUrl}/api/media/${ytData.item.id}`, {
      method: 'DELETE',
      headers: { 'X-Delete-Token': ytData.delete_token }
    });
    assert.equal(tokenDelRes.status, 200, 'Uploader must be able to take down submission using delete_token');

    // Authenticated non-admin player submits photo and takes it down via session ownership
    const playerUploadRes = await fetch(`${baseUrl}/api/media`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': seedPlayerCookie
      },
      body: JSON.stringify({
        url: remoteImgUrl,
        title: 'Player Uploaded Game Photo',
        date_taken: '2026-10-18',
        album: 'General Community Moments',
        contributor_name: 'Player Contributor'
      })
    });
    assert.equal(playerUploadRes.status, 200, 'Player upload must return 200');
    const playerData = await playerUploadRes.json();
    assert.ok(playerData.item && playerData.item.id, 'Player upload must return created item');

    // Player takes down their own submission via DELETE without requiring organizer/admin role
    const playerTakedownRes = await fetch(`${baseUrl}/api/media/${playerData.item.id}`, {
      method: 'DELETE',
      headers: { 'Cookie': seedPlayerCookie }
    });
    assert.equal(playerTakedownRes.status, 200, 'Signed-in player must be able to take down their own submission');

    // Verify UI components for admin carousel photo and video editing & removal
    const adminHtml = fs.readFileSync(path.join(publicDir, 'admin.html'), 'utf8');
    assert.ok(adminHtml.includes('id="admin-media-carousel-section"'), 'admin.html must contain #admin-media-carousel-section');
    assert.ok(adminHtml.includes('id="admin-media-grid"'), 'admin.html must contain #admin-media-grid');
    assert.ok(adminHtml.includes('admin-media-status-btn'), 'admin.html must include status filter buttons');
    assert.ok(adminHtml.includes('setting-appscript-url'), 'admin.html must contain #setting-appscript-url for Google Drive');

    const adminJs = fs.readFileSync(path.join(publicDir, 'js', 'admin.js'), 'utf8');
    assert.ok(adminJs.includes('setupMediaCarouselsAdmin'), 'admin.js must implement setupMediaCarouselsAdmin');
    assert.ok(adminJs.includes('appscript_upload_url'), 'admin.js must handle appscript_upload_url');
    assert.ok(adminJs.includes('btn-admin-remove-media'), 'admin.js must provide btn-admin-remove-media to remove items from carousels');
    assert.ok(adminJs.includes('btn-admin-edit-media'), 'admin.js must provide btn-admin-edit-media to edit items');
    assert.ok(adminJs.includes('admin-media-edit-form'), 'admin.js must provide media edit form');
    assert.ok(adminJs.includes('updateMedia'), 'admin.js must call updateMedia');

    assert.ok(galleryHtml.includes('id="lightbox-delete-btn"'), 'gallery.html must provide #lightbox-delete-btn in lightbox modal');
    assert.ok(galleryHtml.includes('id="user-submissions-container"'), 'gallery.html must provide #user-submissions-container');
    assert.ok(galleryJsCode.includes('btn-delete-photo'), 'gallery.js must wire .btn-delete-photo');
    assert.ok(galleryJsCode.includes('btn-delete-video'), 'gallery.js must wire .btn-delete-video');
    assert.ok(galleryJsCode.includes('canUserDeleteMedia'), 'gallery.js must wire canUserDeleteMedia');
    assert.ok(galleryJsCode.includes('getMySubmissions'), 'gallery.js must wire getMySubmissions');
  });

  await t9.test('T9.25: Rainout and Reopen Email Notifications Relative Date Accuracy', async () => {
    const { sendRainoutEmail, sendReopenEmail } = await import('../../src/app/mailer.js');

    let sentPayload = null;
    const mockEnv = {
      APP_NAME: 'Sunday Pickup Baseball Test',
      RESEND_API_KEY: 'mock-key'
    };

    const origFetch = global.fetch;
    global.fetch = async (url, opts) => {
      if (typeof url === 'string' && url.includes('api.resend.com')) {
        sentPayload = JSON.parse(opts.body);
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: 'mock-msg-id' })
        };
      }
      return origFetch(url, opts);
    };

    try {
      const mockEvent = {
        id: 999,
        title: 'Bushrod Sunday Pickup Baseball',
        event_date: '2026-11-15T12:00:00.000Z',
        location: 'Bushrod Park - Field 1'
      };

      // Test sendRainoutEmail
      await sendRainoutEmail(mockEnv, 'https://pickupbaseballfoundation.org', {
        email: 'player@example.com',
        name: 'Alex Rivera',
        event: mockEvent,
        note: 'Forecast calls for 0.8 inches of rain',
        managementToken: 'test-token'
      });

      assert.ok(sentPayload, 'sendRainoutEmail must dispatch email payload');
      assert.ok(!sentPayload.text.includes("Today's pickup baseball game"), 'Rainout email text must not assume event is today');
      assert.ok(!sentPayload.html.includes("Today's pickup baseball game"), 'Rainout email HTML must not assume event is today');
      assert.ok(sentPayload.text.includes('The pickup baseball game scheduled for'), 'Rainout text must state the game is scheduled for that day');
      assert.ok(sentPayload.html.includes('The pickup baseball game scheduled for'), 'Rainout HTML must state the game is scheduled for that day');
      assert.ok(sentPayload.text.includes('commitments you made for this game are excused'), 'Task commitments must refer to this game, not today');
      assert.ok(sentPayload.html.includes('commitments are excused for this game'), 'HTML commitments must refer to this game, not today');

      // Test sendReopenEmail
      sentPayload = null;
      await sendReopenEmail(mockEnv, 'https://pickupbaseballfoundation.org', {
        email: 'player@example.com',
        name: 'Alex Rivera',
        event: mockEvent,
        note: 'Clouds passed, infield is chalked and ready',
        managementToken: 'test-token'
      });

      assert.ok(sentPayload, 'sendReopenEmail must dispatch email payload');
      assert.ok(!sentPayload.text.includes("today's pickup baseball game is BACK ON"), 'Reopen email text must not assume event is today');
      assert.ok(!sentPayload.html.includes("today's game"), 'Reopen email HTML must not assume event is today');
      assert.ok(sentPayload.text.includes('the pickup baseball game scheduled for'), 'Reopen text must refer to scheduled date');
      assert.ok(sentPayload.html.includes('the pickup baseball game scheduled for'), 'Reopen HTML must refer to scheduled date');
    } finally {
      global.fetch = origFetch;
    }
  });

  await t9.test('T9.26: ZAP DAST Security Hardening (Global Headers, 0-Byte Redirects & Cross-Domain Policy)', async () => {
    // 1. Verify crossdomain.xml & clientaccesspolicy.xml exist and restrict access
    const crossdomainPath = path.join(publicDir, 'crossdomain.xml');
    const clientaccessPath = path.join(publicDir, 'clientaccesspolicy.xml');
    assert.ok(fs.existsSync(crossdomainPath), 'crossdomain.xml must exist');
    assert.ok(fs.existsSync(clientaccessPath), 'clientaccesspolicy.xml must exist');

    const crossdomainContent = fs.readFileSync(crossdomainPath, 'utf8');
    assert.ok(crossdomainContent.includes('permitted-cross-domain-policies="none"'), 'crossdomain.xml must forbid cross-domain policies');

    // 2. Verify security headers on standard API response
    const apiRes = await fetch(`${baseUrl}/api/version`);
    assert.equal(apiRes.status, 200);
    assert.equal(apiRes.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(apiRes.headers.get('x-frame-options'), 'DENY');
    assert.ok(apiRes.headers.get('strict-transport-security'), 'HSTS header must be set');
    assert.ok(apiRes.headers.get('content-security-policy'), 'CSP header must be set');
    assert.ok(apiRes.headers.get('content-security-policy').includes("object-src 'none'"), 'CSP must restrict object-src to none');

    // 3. Verify security headers on 404 API response
    const notFoundRes = await fetch(`${baseUrl}/api/non-existent-endpoint`);
    assert.equal(notFoundRes.status, 404);
    assert.equal(notFoundRes.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(notFoundRes.headers.get('x-frame-options'), 'DENY');
    assert.ok(notFoundRes.headers.get('strict-transport-security'), 'HSTS header must be set on 404');
    assert.ok(notFoundRes.headers.get('content-security-policy'), 'CSP header must be set on 404');
    assert.ok(notFoundRes.headers.get('content-security-policy').includes("object-src 'none'"), '404 CSP must restrict object-src to none');

    // 4. Verify 301 redirects return 0 content-length / empty body
    const redirectRes = await fetch(`${baseUrl}/handbook`, { redirect: 'manual' });
    assert.equal(redirectRes.status, 301);
    assert.equal(redirectRes.headers.get('location'), '/handbook.html');
    assert.equal(redirectRes.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(redirectRes.headers.get('x-frame-options'), 'DENY');
    const redirectBody = await redirectRes.text();
    assert.equal(redirectBody.length, 0, 'Redirect response must have 0-byte body to avoid information leak flags');

    // 5. Verify Cookie Disclaimer, security.txt, and object-src in public assets
    const headersFile = fs.readFileSync(path.join(publicDir, '_headers'), 'utf8');
    assert.ok(headersFile.includes("object-src 'none'"), '_headers CSP must contain object-src none');
    assert.ok(headersFile.includes('/.well-known/security.txt'), '_headers must configure /.well-known/security.txt');
    const securityTxtPath = path.join(publicDir, '.well-known', 'security.txt');
    assert.ok(fs.existsSync(securityTxtPath), 'public/.well-known/security.txt must exist');
    const securityTxt = fs.readFileSync(securityTxtPath, 'utf8');
    assert.ok(securityTxt.includes('Contact: mailto:'), 'security.txt must specify a Contact address');
    assert.ok(securityTxt.includes('Expires:'), 'security.txt must specify an Expires timestamp');
    assert.ok(fs.existsSync(path.resolve(ctx.rootDir, 'SECURITY.md')), 'SECURITY.md must exist');
    const apiSrc = fs.readFileSync(path.join(publicDir, 'js', 'api.js'), 'utf8');
    assert.ok(apiSrc.includes('footer-security-badges'), 'api.js footer must render security verification badges');
    assert.ok(apiSrc.includes('ssllabs.com/ssltest/analyze.html'), 'api.js footer must link to SSL Labs report');
    assert.ok(apiSrc.includes('developer.mozilla.org/en-US/observatory/analyze'), 'api.js footer must link to Mozilla HTTP Observatory');
    assert.ok(apiSrc.includes('securityheaders.com') && apiSrc.includes('<span>📋 Security Headers</span><span class="footer-security-grade">A+</span>'), 'api.js footer Security Headers badge must show A+ grade');
    assert.ok(apiSrc.includes('<span>✅ CodeQL &amp; Policy</span><span class="footer-security-grade">0 Advisories</span>'), 'api.js footer CodeQL & Policy badge must show status pill');
    assert.ok(apiSrc.includes('<span>security.txt</span><span class="footer-security-grade">Valid</span>'), 'api.js footer security.txt badge must show Valid pill');
    assert.ok(headersFile.includes('upgrade-insecure-requests;'), '_headers CSP must contain upgrade-insecure-requests');

    const apiJs = fs.readFileSync(path.join(publicDir, 'js', 'api.js'), 'utf8');
    assert.ok(apiJs.includes('renderCookieNotice'), 'api.js must provide renderCookieNotice');
    assert.ok(apiJs.includes('cookie-notice-banner'), 'api.js must render cookie-notice-banner');
  });

  await t9.test('T9.27: Batting Practice (BP) Order Signup Sheet Lifecycle & Permissions', async () => {
    // 1. Verify static HTML & JS integration
    const eventHtml = fs.readFileSync(path.join(publicDir, 'event.html'), 'utf8');
    assert.ok(eventHtml.includes('id="bp-order-section"'), 'event.html must include bp-order-section');
    assert.ok(eventHtml.includes('id="bp-slots-grid"'), 'event.html must include bp-slots-grid');
    assert.ok(eventHtml.includes('id="bp-signup-modal"'), 'event.html must include bp-signup-modal');
    assert.ok(eventHtml.includes('id="rsvp-bp-signup"'), 'event.html must include rsvp-bp-signup checkbox');

    const eventJs = fs.readFileSync(path.join(publicDir, 'js', 'event.js'), 'utf8');
    assert.ok(eventJs.includes('function renderBpOrder'), 'event.js must define renderBpOrder');
    assert.ok(eventJs.includes('function openBpModal'), 'event.js must define openBpModal');
    assert.ok(eventJs.includes('function setupBpOrderUi'), 'event.js must define setupBpOrderUi');

    const apiJs = fs.readFileSync(path.join(publicDir, 'js', 'api.js'), 'utf8');
    assert.ok(apiJs.includes('getBpOrder'), 'api.js must provide getBpOrder');
    assert.ok(apiJs.includes('postBpSignup'), 'api.js must provide postBpSignup');
    assert.ok(apiJs.includes('updateBpSignup'), 'api.js must provide updateBpSignup');
    assert.ok(apiJs.includes('deleteBpSignup'), 'api.js must provide deleteBpSignup');
    assert.ok(apiJs.includes('clearBpOrder'), 'api.js must provide clearBpOrder');

    // 2. Create a test event for BP order testing using organizer session
    const createEvRes = await fetch(`${baseUrl}/api/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cookie': seedOrgCookie },
      body: JSON.stringify({
        title: 'BP Order Test Game',
        location: 'Bushrod Park Field 1',
        event_date: new Date(Date.now() + 86400000 * 5).toISOString(),
        use_default_duties: true
      })
    });
    assert.equal(createEvRes.status, 200);
    const { event: bpEvent } = await createEvRes.json();
    assert.ok(bpEvent && bpEvent.id);

    // 3. GET event details (anonymous) - verify bp_signups is empty and canViewBpOrder is false
    const getEvRes = await fetch(`${baseUrl}/api/events/${bpEvent.id}`);
    assert.equal(getEvRes.status, 200);
    const evData = await getEvRes.json();
    assert.ok(Array.isArray(evData.bp_signups), 'bp_signups must be an array');
    assert.equal(evData.bp_signups.length, 0);
    assert.equal(evData.canViewBpOrder, false, 'Anonymous viewer must have canViewBpOrder = false');

    // 4. Standalone GET /api/events/:id/bp-order must require authentication (401)
    const anonBpRes = await fetch(`${baseUrl}/api/events/${bpEvent.id}/bp-order`);
    assert.equal(anonBpRes.status, 401, 'Anonymous GET /bp-order must return 401');

    const getBpRes = await fetch(`${baseUrl}/api/events/${bpEvent.id}/bp-order`, {
      headers: { 'Cookie': seedPlayerCookie }
    });
    assert.equal(getBpRes.status, 200);
    const bpData = await getBpRes.json();
    assert.equal(bpData.event_id, bpEvent.id);
    assert.deepEqual(bpData.bp_signups, []);

    // 5. Player 1 claims Slot #1
    const p1ClaimRes = await fetch(`${baseUrl}/api/events/${bpEvent.id}/bp-order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cookie': seedPlayerCookie },
      body: JSON.stringify({
        slot_number: 1,
        notes: 'Lefty pull hitter'
      })
    });
    assert.equal(p1ClaimRes.status, 200);
    const p1Claim = await p1ClaimRes.json();
    assert.equal(p1Claim.success, true);
    assert.equal(p1Claim.slot_number, 1);
    const p1SignupId = p1Claim.signup_id;
    assert.ok(p1SignupId);

    // 6. Player 2 attempt to claim Slot #1 -> 400 slot already claimed
    const p2DoubleRes = await fetch(`${baseUrl}/api/events/${bpEvent.id}/bp-order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        player_name: 'Jordan Guest',
        slot_number: 1
      })
    });
    assert.equal(p2DoubleRes.status, 400);
    const p2DoubleErr = await p2DoubleRes.json();
    assert.ok(p2DoubleErr.error.includes('already claimed'));

    // 7. Player 2 claims open Slot #2
    const p2ClaimRes = await fetch(`${baseUrl}/api/events/${bpEvent.id}/bp-order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        player_name: 'Jordan Guest',
        slot_number: 2,
        notes: 'Round 1 warmup'
      })
    });
    assert.equal(p2ClaimRes.status, 200);
    const p2Claim = await p2ClaimRes.json();
    assert.equal(p2Claim.success, true);
    assert.equal(p2Claim.slot_number, 2);
    const p2SignupId = p2Claim.signup_id;

    // 8. Player 1 moves to Slot #5 via POST
    const p1MoveRes = await fetch(`${baseUrl}/api/events/${bpEvent.id}/bp-order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cookie': seedPlayerCookie },
      body: JSON.stringify({
        slot_number: 5,
        notes: 'Moved to round 1 anchor'
      })
    });
    assert.equal(p1MoveRes.status, 200);
    const p1Move = await p1MoveRes.json();
    assert.equal(p1Move.slot_number, 5);

    // Verify Slot #1 is now open and Slot #5 is occupied (signed-in sees it; anonymous must NOT)
    const anonCheckOrderRes = await fetch(`${baseUrl}/api/events/${bpEvent.id}/bp-order`);
    assert.equal(anonCheckOrderRes.status, 401, 'Anonymous user must be blocked from GET /bp-order');
    const anonEvAfterClaim = await (await fetch(`${baseUrl}/api/events/${bpEvent.id}`)).json();
    assert.equal(anonEvAfterClaim.bp_signups.length, 0, 'Anonymous GET /events/:id must NOT leak bp_signups');
    assert.equal(anonEvAfterClaim.bpCount, 2, 'Aggregate bpCount may reflect count without exposing player names');

    const checkOrderRes = await fetch(`${baseUrl}/api/events/${bpEvent.id}/bp-order`, {
      headers: { 'Cookie': seedPlayerCookie }
    });
    assert.equal(checkOrderRes.status, 200);
    const { bp_signups: currentSignups } = await checkOrderRes.json();
    assert.equal(currentSignups.length, 2);
    assert.equal(currentSignups.some(s => s.slot_number === 1), false, 'Slot 1 must now be open');
    assert.equal(currentSignups.some(s => s.slot_number === 5), true, 'Slot 5 must be claimed by Player 1');

    // 9. Update notes via PUT
    const updateRes = await fetch(`${baseUrl}/api/events/${bpEvent.id}/bp-order/${p1SignupId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Cookie': seedPlayerCookie },
      body: JSON.stringify({
        notes: 'Hits righty, prefers fastballs'
      })
    });
    assert.equal(updateRes.status, 200);

    // 10. Unauthorized user attempt to edit Player 1 slot -> 403
    const unauthPut = await fetch(`${baseUrl}/api/events/${bpEvent.id}/bp-order/${p1SignupId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        player_name: 'Hijacker',
        notes: 'Unauthorized edit'
      })
    });
    assert.equal(unauthPut.status, 403);

    // 11. RSVP with bp_signup: true auto-claims next open slot (Slot #1)
    const rsvpWithBpRes = await fetch(`${baseUrl}/api/events/${bpEvent.id}/rsvp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Alex Slugger',
        email: 'slugger_alex_test@example.com',
        players_count: 1,
        bp_signup: true
      })
    });
    assert.equal(rsvpWithBpRes.status, 200);
    const rsvpBpData = await rsvpWithBpRes.json();
    assert.ok(rsvpBpData.message.includes('Batting Practice slot #1'));

    // Verify 3 signups exist now when signed in (still hidden from anonymous callers)
    const orderAfterRsvp = await (await fetch(`${baseUrl}/api/events/${bpEvent.id}/bp-order`, {
      headers: { 'Cookie': seedPlayerCookie }
    })).json();
    assert.equal(orderAfterRsvp.bp_signups.length, 3);
    const slot1Occupant = orderAfterRsvp.bp_signups.find(s => s.slot_number === 1);
    assert.ok(slot1Occupant && slot1Occupant.player_name.includes('Alex Slugger'));

    // Verify invite-only event batting order blocks uninvited signed-in users (403) and allows invited/organizer (200)
    const privBpCreate = await apiReq('POST', '/api/events', seedOrgCookie, {
      title: 'Private Invite-Only BP Game',
      location: 'Secret Diamond',
      event_date: new Date(Date.now() + 86400000 * 6).toISOString(),
      allowed_emails: ['vip_bp_only@sundaypickup.org']
    });
    assert.equal(privBpCreate.status, 200);
    const privBpId = privBpCreate.data.eventId;
    const privBpUninvited = await fetch(`${baseUrl}/api/events/${privBpId}/bp-order`, {
      headers: { 'Cookie': seedPlayerCookie }
    });
    assert.equal(privBpUninvited.status, 403, 'Uninvited signed-in user must get 403 on invite-only /bp-order');
    const privBpOrg = await fetch(`${baseUrl}/api/events/${privBpId}/bp-order`, {
      headers: { 'Cookie': seedOrgCookie }
    });
    assert.equal(privBpOrg.status, 200, 'Organizer/invited user must get 200 on invite-only /bp-order');

    // Verify Attendee Roster terminology & BP privacy gate in UI files
    assert.ok(eventHtml.includes('Attendee Roster'), 'event.html must label roster as Attendee Roster');
    assert.ok(eventJs.includes('Attendee Roster is Private') && eventJs.includes('Non-Playing'), 'event.js must use Attendee Roster and Non-Playing guest labels');
    assert.ok(eventJs.includes('Batting Practice Order is Private'), 'event.js must hide BP grid behind login privacy gate when signed out');
    assert.ok(apiJs.includes('"event.roster_private_title": "Attendee Roster is Private"'), 'api.js EN_DICT must label private roster as Attendee Roster');

    // 12. Delete / withdraw from BP slot
    const deleteRes = await fetch(`${baseUrl}/api/events/${bpEvent.id}/bp-order/${p1SignupId}`, {
      method: 'DELETE',
      headers: { 'Cookie': seedPlayerCookie }
    });
    assert.equal(deleteRes.status, 200);

    // 13. Organizer clear order
    const clearRes = await fetch(`${baseUrl}/api/events/${bpEvent.id}/bp-order/clear`, {
      method: 'POST',
      headers: { 'Cookie': seedOrgCookie }
    });
    assert.equal(clearRes.status, 200);
    const clearedOrder = await (await fetch(`${baseUrl}/api/events/${bpEvent.id}/bp-order`, {
      headers: { 'Cookie': seedOrgCookie }
    })).json();
    assert.equal(clearedOrder.bp_signups.length, 0);

    // 14. Call rainout and verify BP signup returns 400
    await fetch(`${baseUrl}/api/events/${bpEvent.id}/rainout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cookie': seedOrgCookie },
      body: JSON.stringify({ rainout_note: 'Standing water on diamond.' })
    });
    const rainoutBpRes = await fetch(`${baseUrl}/api/events/${bpEvent.id}/bp-order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cookie': seedPlayerCookie },
      body: JSON.stringify({ slot_number: 1 })
    });
    assert.equal(rainoutBpRes.status, 400);
    const rainoutBpErr = await rainoutBpRes.json();
    assert.ok(rainoutBpErr.error.includes('rain'));

    // Cleanup test event
    await fetch(`${baseUrl}/api/events/${bpEvent.id}`, {
      method: 'DELETE',
      headers: { 'Cookie': seedAdminCookie }
    });
  });
};
