/**
 * Checks 8.2–8.5: Clubhouse Frontend, Native Waiver Provenance, Resource Frugality & Parity Tests
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

module.exports = function registerClubhouseWaiverTests(ctx) {
  const { apiReq, getCookie, db, createSession, getDefaultDuties, CURRENT_APP_VERSION } = ctx;

test('Clubhouse Frontend & Native Waiver Verification', async (t) => {
  const { seedAdminId, seedAdminCookie, seedOrgId, seedOrgCookie, seedPlayerId, seedPlayerCookie, sharedEventId, baseUrl } = ctx;
  await t.test('Check 8.2: Discord Clubhouse 4-Column UI & WP-5/WP-6 Frontend Modules', () => {
    const publicDir = ctx.publicDir;
    const requiredFiles = [
      'clubhouse.html',
      'css/clubhouse.css',
      'js/crypto.js',
      'js/store.js',
      'js/rtc.js',
      'js/clubhouse.js'
    ];
    for (const rel of requiredFiles) {
      const fullPath = path.join(publicDir, rel);
      assert.ok(fs.existsSync(fullPath), `Clubhouse frontend asset ${rel} must exist`);
    }

    const clubhouseHtml = fs.readFileSync(path.join(publicDir, 'clubhouse.html'), 'utf8');
    assert.ok(clubhouseHtml.includes('id="clubhouse-app"'), 'clubhouse.html must render #clubhouse-app');
    assert.ok(!clubhouseHtml.includes('class="ch-rail"'), 'clubhouse.html must not render left-edge .ch-rail strip');
    assert.ok(!clubhouseHtml.includes('id="rail-home-btn"'), 'clubhouse.html must remove left rail Clubhouse button');
    assert.ok(!clubhouseHtml.includes('href="/gallery.html"'), 'clubhouse.html must remove left rail gallery button');
    assert.ok(!clubhouseHtml.includes('HANDBOOK.md'), 'clubhouse.html must remove left rail handbook button');
    assert.ok(clubhouseHtml.includes('id="btn-user-calendar"') && clubhouseHtml.includes('href="/index.html"'), 'clubhouse.html must place calendar button in user card');
    assert.ok(clubhouseHtml.includes('id="btn-user-vault"'), 'clubhouse.html must place Security Vault button in user card');
    assert.ok(clubhouseHtml.includes('id="ch-channel-list"'), 'clubhouse.html must include channel sidebar');
    assert.ok(clubhouseHtml.includes('id="ch-message-stream"'), 'clubhouse.html must include message stream');
    assert.ok(clubhouseHtml.includes('id="ch-bp-grid"'), 'clubhouse.html must include 28-slot BP grid');
    assert.ok(clubhouseHtml.includes('id="ch-privacy-relay-toggle"'), 'clubhouse.html must include Privacy Relay toggle');

    for (const jsRel of ['js/crypto.js', 'js/store.js', 'js/rtc.js', 'js/clubhouse.js', 'js/waiver.js']) {
      const code = fs.readFileSync(path.join(publicDir, jsRel), 'utf8');
      assert.ok(!code.includes('?.'), `${jsRel} must not use optional chaining (?.)`);
      assert.ok(!code.includes('??'), `${jsRel} must not use nullish coalescing (??)`);
    }
  });

  await t.test('Check 8.3: Native Digital & Paper Waiver Provenance & Admin Status Control', async () => {
    // 1. Check anonymous waiver status returns official Form 41335\14760738.1 text and SHA-256
    const anonStatus = await apiReq('GET', '/api/waiver/status');
    assert.equal(anonStatus.status, 200);
    assert.equal(anonStatus.data.document_version, '41335\\14760738.1');
    assert.equal(anonStatus.data.waiver_text_sha256.length, 64);
    assert.equal(anonStatus.data.paragraphs.length, 4);

    // 2. Admin marks player account as 'paper' waiver on file
    const paperRes = await apiReq('PUT', `/api/auth/users/${seedPlayerId}/badges`, seedAdminCookie, {
      waiver_status: 'paper'
    });
    assert.equal(paperRes.status, 200);
    assert.equal(paperRes.data.user.waiver_status, 'paper');

    const playerStatusPaper = await apiReq('GET', '/api/waiver/status', seedPlayerCookie);
    assert.equal(playerStatusPaper.status, 200);
    assert.equal(playerStatusPaper.data.waiver_status, 'paper');
    assert.equal(playerStatusPaper.data.waiver_signed, true);

    // 3. Player executes digital signature on Form 41335\14760738.1
    const samplePngSig = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const signRes = await apiReq('POST', '/api/waiver/sign', seedPlayerCookie, {
      printed_name: 'Alex Johnson',
      signed_date: '2026-11-11',
      signature_type: 'drawn',
      signature_data: samplePngSig,
      electronic_consent: true
    });
    assert.equal(signRes.status, 201);
    assert.equal(signRes.data.waiver_status, 'digital');
    assert.ok(signRes.data.waiver.certificate_id.startsWith('PBF-WVR-20261111-'));
    assert.equal(signRes.data.waiver.document_sha256.length, 64);
    assert.equal(signRes.data.waiver.provenance_seal.length, 64);

    // 4. Verify certificate JSON & HTML integrity check
    const certId = signRes.data.waiver.certificate_id;
    const certJson = await apiReq('GET', `/api/waiver/certificate/${certId}`, seedPlayerCookie);
    assert.equal(certJson.status, 200);
    assert.equal(certJson.data.waiver.integrity_verified, true);
    assert.equal(certJson.data.waiver.printed_name, 'Alex Johnson');

    const certHtmlRes = await fetch(`${baseUrl}/api/waiver/certificate/${certId}?format=html`);
    assert.equal(certHtmlRes.status, 200);
    const certCsp = certHtmlRes.headers.get('content-security-policy') || '';
    assert.ok(!/script-src[^;]*'unsafe-inline'/i.test(certCsp), 'Waiver certificate CSP script-src must not allow unsafe-inline');
    const certHtml = await certHtmlRes.text();
    assert.ok(certHtml.includes('CONSENT, WAIVER AND INDEMNITY'));
    assert.ok(certHtml.includes('Cryptographic Seal Verified'));
    assert.ok(certHtml.includes('41335\\14760738.1'));
    assert.ok(!certHtml.includes(samplePngSig), 'Anonymous HTML certificate must redact raw signature image data');

    const anonCertJson = await apiReq('GET', `/api/waiver/certificate/${certId}`, null);
    assert.equal(anonCertJson.status, 200);
    assert.equal(anonCertJson.data.waiver.signature_data, null, 'Anonymous JSON certificate must redact signature_data');
    assert.equal(anonCertJson.data.waiver.printed_name, null, 'Anonymous JSON certificate must redact printed_name');
    assert.equal(anonCertJson.data.waiver.user_id, null, 'Anonymous JSON certificate must redact user_id');
    assert.equal(anonCertJson.data.waiver.signed_at, null, 'Anonymous JSON certificate must redact signed_at');
    assert.equal(anonCertJson.data.waiver.gdrive_file_id, null, 'Anonymous JSON certificate must redact gdrive_file_id');

    // 5. Security hardening checks: reminders auth & oversized local attachment rejection
    const anonRem = await apiReq('GET', '/api/events/reminders/check', null);
    assert.equal(anonRem.status, 401, 'Anonymous reminders check must be rejected with 401');
    const playerRem = await apiReq('GET', '/api/events/reminders/check', seedPlayerCookie);
    assert.equal(playerRem.status, 403, 'Non-organizer reminders check must be rejected with 403');
    const orgRem = await apiReq('POST', '/api/events/reminders/check', seedOrgCookie);
    assert.equal(orgRem.status, 200, 'Organizer reminders check must succeed');

    const oversizedAtt = await apiReq('POST', '/api/attachments/init', seedPlayerCookie, {
      channel_id: 'general',
      file_name: 'huge.mp4',
      mime_type: 'video/mp4',
      file_size: 25 * 1024 * 1024
    });
    assert.equal(oversizedAtt.status, 400, 'Local D1 attachment fallback must reject files over 10 MB');
  });

  await t.test('Check 8.4: Free-tier resource savings (RSVP email dedupe, voice heartbeat dedupe, edge cache & polling intervals)', async () => {
    // 1. RSVP update on already-attending user skips duplicate Resend email unless resend_confirmation is true
    const evRes = await apiReq('POST', '/api/events', seedOrgCookie, {
      title: 'Free-Tier Optimization Test Game',
      location: 'Bushrod Park Field 1',
      event_date: '2026-12-27T20:00:00.000Z',
      max_players: 20
    });
    assert.equal(evRes.status, 200);
    const optEventId = evRes.data.eventId;

    const firstRsvp = await apiReq('POST', `/api/events/${optEventId}/rsvp`, null, {
      name: 'Quota Saver',
      email: 'quota_saver@test.org',
      status: 'attending',
      players_count: 1,
      spectators_count: 0
    });
    assert.equal(firstRsvp.status, 200);
    assert.ok(firstRsvp.data.message.includes('confirmation email has been sent'), 'Initial RSVP should confirm email dispatch');

    const editRsvp = await apiReq('POST', `/api/events/${optEventId}/rsvp`, null, {
      name: 'Quota Saver',
      email: 'quota_saver@test.org',
      management_token: firstRsvp.data.managementToken,
      status: 'attending',
      players_count: 1,
      spectators_count: 1,
      gear_bringing: 'Extra bats'
    });
    assert.equal(editRsvp.status, 200);
    assert.ok(editRsvp.data.message.includes('RSVP updated'), 'Editing an already-attending RSVP should report updated status');
    assert.ok(!editRsvp.data.message.includes('Confirmation sent to'), 'Editing an already-attending RSVP should skip duplicate Resend email');

    const resendRsvp = await apiReq('POST', `/api/events/${optEventId}/rsvp`, null, {
      name: 'Quota Saver',
      email: 'quota_saver@test.org',
      management_token: firstRsvp.data.managementToken,
      status: 'attending',
      players_count: 1,
      spectators_count: 1,
      resend_confirmation: true
    });
    assert.equal(resendRsvp.status, 200);
    assert.ok(resendRsvp.data.message.includes('Confirmation sent to'), 'Explicit resend_confirmation: true should still dispatch confirmation email');

    // 2. Edge caching headers on public blog/RSS feeds vs strict no-store on live .ics/events
    const postsHdrRes = await fetch(`${baseUrl}/api/posts`);
    assert.equal(postsHdrRes.status, 200);
    assert.ok((postsHdrRes.headers.get('cache-control') || '').includes('s-maxage=300'), '/api/posts should expose short CDN s-maxage caching');
    const rssHdrRes = await fetch(`${baseUrl}/feed.xml`);
    assert.equal(rssHdrRes.status, 200);
    assert.ok((rssHdrRes.headers.get('cache-control') || '').includes('s-maxage=300'), '/feed.xml should expose short CDN s-maxage caching');

    // 3. Frontend polling intervals, localStorage weather cache & ES6 safety checks
    const publicDir = ctx.publicDir;
    const rtcJs = fs.readFileSync(path.join(publicDir, 'js/rtc.js'), 'utf8');
    const storeJs = fs.readFileSync(path.join(publicDir, 'js/store.js'), 'utf8');
    const homeAppJs = fs.readFileSync(path.join(publicDir, 'js/app.js'), 'utf8');
    const weatherJs = fs.readFileSync(path.join(publicDir, 'js/weather.js'), 'utf8');

    assert.ok(rtcJs.includes('HEARTBEAT_INTERVAL_MS = 16000'), 'rtc.js must use 16s voice heartbeat interval');
    assert.ok(storeJs.includes('VISIBLE_IDLE_SYNC_MS = 8000'), 'store.js must preserve 8s idle visible poll interval');
    assert.ok(storeJs.includes('maybeOptimizeChatImage'), 'store.js must include optional client-side chat photo compression');
    assert.ok(homeAppJs.includes('900000'), 'app.js must relax background calendar auto-resync to 15 minutes');
    assert.ok(weatherJs.includes('localStorage'), 'weather.js must persist forecast cache across tabs via localStorage');

    // 4. Compact game detail card consolidation checks
    const eventHtmlComp = fs.readFileSync(path.join(publicDir, 'event.html'), 'utf8');
    const styleCssComp = fs.readFileSync(path.join(publicDir, 'css/style.css'), 'utf8');
    assert.ok(eventHtmlComp.includes('event-detail-main') && eventHtmlComp.includes('organizer-controls-grid'), 'event.html must group organizer controls cleanly');
    assert.ok(eventHtmlComp.includes('id="roster-bp-card"') && eventHtmlComp.includes('roster-bp-divider'), 'event.html must combine Expected Attendees and BP Order in one card');
    assert.ok(styleCssComp.includes('.weather-kpi-grid') && styleCssComp.includes('.event-detail-main .bp-slot-card'), 'style.css must style compact detail page cards');

    for (const [fname, src] of [['rtc.js', rtcJs], ['store.js', storeJs], ['app.js', homeAppJs], ['weather.js', weatherJs]]) {
      assert.ok(!src.includes('?.') && !src.includes('??'), `${fname} must stay ES6 compatible without ?. or ??`);
    }
  });

  await t.test('Check 8.5: Archive Header Structure, i18n Key Parity, Post Edit & Comment Author Self-Delete', async () => {
    const publicDir = ctx.publicDir;

    // 1. archive.html must close <header> before <main> so API.renderNav() never wipes body content
    const archiveHtml = fs.readFileSync(path.join(publicDir, 'archive.html'), 'utf8');
    const hdrCloseIdx = archiveHtml.indexOf('</header>');
    const mainOpenIdx = archiveHtml.indexOf('<main');
    assert.ok(hdrCloseIdx !== -1 && mainOpenIdx !== -1 && hdrCloseIdx < mainOpenIdx, 'archive.html must close </header> before <main>');

    // 2. All 14 i18n JSON files must have 100% key parity with EN_DICT
    const apiJsSrc = fs.readFileSync(path.join(publicDir, 'js', 'api.js'), 'utf8');
    const m = apiJsSrc.match(/const EN_DICT = \{([\s\S]*?)\n\};/);
    assert.ok(m, 'api.js must define EN_DICT');
    const enObj = Function('return {' + m[1] + '}')();
    const enKeys = Object.keys(enObj);
    const i18nDir = path.join(publicDir, 'i18n');
    for (const lang of ['ar', 'es', 'fa', 'fr', 'hi', 'hy', 'ja', 'ko', 'pa', 'pt', 'ru', 'tl', 'vi', 'zh']) {
      const dict = JSON.parse(fs.readFileSync(path.join(i18nDir, `${lang}.json`), 'utf8'));
      const missing = enKeys.filter((k) => !(k in dict));
      assert.deepEqual(missing, [], `${lang}.json must contain all EN_DICT keys`);
    }

    // 3. PUT /api/posts/:id updates existing post cleanly
    const postCreate = await apiReq('POST', '/api/posts', seedOrgCookie, {
      title: 'Editable Recap Post',
      content: 'Original recap content'
    });
    assert.equal(postCreate.status, 200);
    const createdPostId = postCreate.data.post.id;

    const postUpdate = await apiReq('PUT', `/api/posts/${createdPostId}`, seedOrgCookie, {
      title: 'Updated Recap Post Title',
      content: 'Updated recap story content'
    });
    assert.equal(postUpdate.status, 200);
    assert.equal(postUpdate.data.post.title, 'Updated Recap Post Title');

    const postDelete = await apiReq('DELETE', `/api/posts/${createdPostId}`, seedOrgCookie);
    assert.equal(postDelete.status, 200);

    // 4. Comment author can self-delete their own comment, while another player gets 403
    const evCreate = await apiReq('POST', '/api/events', seedOrgCookie, {
      title: 'Comment Self-Delete Check',
      location: 'Bushrod Park Field 1',
      event_date: '2026-12-28T20:00:00.000Z',
      max_players: 20
    });
    assert.equal(evCreate.status, 200);
    const evId = evCreate.data.eventId;

    const cmtRes = await apiReq('POST', `/api/events/${evId}/comments`, seedPlayerCookie, {
      content: 'Bringing extra batting helmets!'
    });
    assert.equal(cmtRes.status, 200);
    const evDetail = await apiReq('GET', `/api/events/${evId}`, seedPlayerCookie);
    const playerComment = (evDetail.data.comments || []).find((c) => c.content === 'Bringing extra batting helmets!');
    assert.ok(playerComment, 'Created comment should be returned on event detail');

    const delOwn = await apiReq('DELETE', `/api/events/${evId}/comments/${playerComment.id}`, seedPlayerCookie);
    assert.equal(delOwn.status, 200, 'Comment author must be able to delete their own comment');
  });
});
};
