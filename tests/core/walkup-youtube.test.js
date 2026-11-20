/**
 * tests/core/walkup-youtube.test.js
 * Backend persistence + VM UI verification for Walk-Up Song YouTube embeds
 * and timestamp playback on Profile (`profile.js`) and Clubhouse Batting Practice DJ (`clubhouse/panels.js`).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT_DIR = path.join(__dirname, '../..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');

function createClassList(initial = []) {
  const set = new Set(initial);
  return {
    add(cls) { set.add(cls); },
    remove(cls) { set.delete(cls); },
    toggle(cls, force) {
      if (force === undefined) {
        if (set.has(cls)) { set.delete(cls); return false; }
        set.add(cls);
        return true;
      }
      if (force) { set.add(cls); return true; }
      set.delete(cls);
      return false;
    },
    contains(cls) { return set.has(cls); }
  };
}

function createEl(id = '', tag = 'div', byId = null) {
  const listeners = Object.create(null);
  const attrs = Object.create(null);
  const postedMessages = [];
  const el = {
    id,
    tagName: tag.toUpperCase(),
    type: '',
    value: '',
    min: '',
    max: '',
    step: '',
    src: '',
    href: '',
    title: '',
    allow: '',
    allowFullscreen: false,
    referrerPolicy: '',
    placeholder: '',
    disabled: false,
    checked: false,
    textContent: '',
    className: '',
    dataset: {},
    style: { cssText: '', display: '' },
    classList: createClassList(),
    children: [],
    parentNode: null,
    contentWindow: tag.toLowerCase() === 'iframe'
      ? { postMessage(msg, target) { postedMessages.push({ msg, target }); } }
      : null,
    _postedMessages: postedMessages,
    get innerHTML() { return el._innerHTML || ''; },
    set innerHTML(v) {
      el._innerHTML = String(v);
      if (v === '') el.children = [];
    },
    setAttribute(k, v) { attrs[k] = String(v); },
    getAttribute(k) { return k in attrs ? attrs[k] : null; },
    removeAttribute(k) { delete attrs[k]; },
    addEventListener(type, fn) {
      if (!listeners[type]) listeners[type] = [];
      listeners[type].push(fn);
    },
    dispatchEvent(ev) {
      const list = listeners[ev.type] || [];
      for (const fn of list) fn.call(el, ev);
    },
    appendChild(child) {
      if (child) {
        child.parentNode = el;
        el.children.push(child);
        if (byId && child.id) byId[child.id] = child;
      }
      return child;
    },
    contains(node) {
      if (node === el) return true;
      return el.children.some((c) => c === node || (c.contains && c.contains(node)));
    },
    querySelector() { return null; },
    querySelectorAll() { return []; }
  };
  if (byId && id) byId[id] = el;
  return el;
}

function createDomVm(options = {}) {
  const byId = Object.create(null);
  const windowListeners = Object.create(null);
  const docListeners = Object.create(null);
  const timers = [];

  const documentObj = {
    body: createEl('body', 'body', byId),
    documentElement: createEl('html', 'html', byId),
    getElementById(id) { return byId[id] || null; },
    createElement(tag) { return createEl('', tag, byId); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener(type, fn) {
      if (!docListeners[type]) docListeners[type] = [];
      docListeners[type].push(fn);
    }
  };

  const windowObj = {
    location: { origin: 'https://pickupbaseball.org', href: 'https://pickupbaseball.org/profile.html', pathname: '/profile.html' },
    document: documentObj,
    addEventListener(type, fn) {
      if (!windowListeners[type]) windowListeners[type] = [];
      windowListeners[type].push(fn);
    },
    removeEventListener(type, fn) {
      if (!windowListeners[type]) return;
      windowListeners[type] = windowListeners[type].filter((f) => f !== fn);
    },
    dispatchWindowEvent(type, ev) {
      for (const fn of (windowListeners[type] || []).slice()) fn(ev);
    },
    scrollTo() {},
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    navigator: {}
  };

  const sandbox = {
    window: windowObj,
    globalThis: windowObj,
    self: windowObj,
    document: documentObj,
    URL,
    URLSearchParams,
    console,
    setTimeout(fn, ms) {
      const handle = { fn, ms, cleared: false };
      timers.push(handle);
      return handle;
    },
    clearTimeout(handle) {
      if (handle) handle.cleared = true;
    },
    fetch: options.fetch || (async () => ({ ok: true, json: async () => ({}) })),
    Audio: function MockAudio() {
      this.paused = true;
      this.src = '';
      this.currentTime = 0;
      this.preload = '';
      this.load = () => { if (typeof this.onloadedmetadata === 'function') this.onloadedmetadata(); };
      this.play = () => { this.paused = false; return Promise.resolve(); };
      this.pause = () => { this.paused = true; };
    },
    FormData: function MockFormData() { this.append = () => {}; },
    Image: function MockImage() {}
  };

  windowObj.API = {};
  sandbox.API = windowObj.API;
  const ctx = vm.createContext(sandbox);
  const endpointsSrc = fs.readFileSync(path.join(PUBLIC_DIR, 'js/api/endpoints.js'), 'utf8');
  vm.runInContext(endpointsSrc, ctx, { filename: 'public/js/api/endpoints.js' });

  return { ctx, windowObj, documentObj, byId, docListeners, timers };
}

function registerWalkupYoutubeTests(ctx) {
  test('Walk-Up Song YouTube Embed & Timestamp Playback Suite', async (t) => {
    await t.test('1. Backend preserves walkup_song on GET /api/auth/me and sanitizes JSON payload on PUT /api/auth/profile', async () => {
      if (!ctx || !ctx.apiReq || !ctx.createSession) return;
      const email = `walkup_yt_${Date.now()}@sundaypickup.org`;
      const userRes = ctx.db.prepare(
        "INSERT INTO users (name, email, role, is_admin, clubhouse_opted_in) VALUES (?, ?, 'member', 0, 1)"
      ).run('Walkup Batter', email);
      const userId = Number(userRes.lastInsertRowid);
      const sess = ctx.createSession(userId);
      const sessionId = typeof sess === 'string' ? sess : sess.sessionId;
      const cookie = `baseball_session=${sessionId}`;

      const walkupPayload = JSON.stringify({
        label: 'In the Rain — The Dramatics',
        trackName: 'In the Rain',
        artistName: 'The Dramatics',
        albumName: 'Whatcha See Is Whatcha Get',
        releaseYear: '1971',
        artworkUrl: 'https://e-cdns-images.dzcdn.net/images/cover/abc/250x250-000000-80-0-0.jpg',
        deezerId: '3135556',
        durationSec: 308,
        clipStart: 75,
        youtubeId: 'M7lc1UVf-VE',
        youtubeTitle: 'The Dramatics - In The Rain (Official Audio)',
        clipUrl: ''
      });

      const putRes = await ctx.apiReq('PUT', '/api/auth/profile', cookie, {
        name: 'Walkup Batter',
        bio: 'Switch hitter',
        walkup_song: walkupPayload
      });
      assert.equal(putRes.status, 200, 'PUT /api/auth/profile must succeed');
      assert.ok(putRes.data.user && putRes.data.user.walkup_song, 'PUT response must include walkup_song');

      // Reload profile via GET /api/auth/me (simulates browser page refresh)
      const meRes = await ctx.apiReq('GET', '/api/auth/me', cookie);
      assert.equal(meRes.status, 200, 'GET /api/auth/me must return 200');
      assert.ok(meRes.data.user && meRes.data.user.walkup_song, 'GET /api/auth/me must include walkup_song after reload');
      const parsed = JSON.parse(meRes.data.user.walkup_song);
      assert.equal(parsed.youtubeId, 'M7lc1UVf-VE', 'youtubeId must persist across reload');
      assert.equal(parsed.clipStart, 75, 'clipStart timestamp must persist across reload');
      assert.equal(parsed.durationSec, 308, 'durationSec must persist across reload');
    });

    await t.test('2. API.getYouTubeId, API.getYouTubeStartSeconds & API.mountYouTubeClipPlayer handle timestamps, seeking, postMessage & errors', () => {
      const env = createDomVm();
      const API = env.windowObj.API;

      assert.equal(API.getYouTubeId('https://youtu.be/M7lc1UVf-VE?t=75'), 'M7lc1UVf-VE');
      assert.equal(API.getYouTubeId('https://www.youtube.com/watch?v=M7lc1UVf-VE&t=1m30s'), 'M7lc1UVf-VE');
      assert.equal(API.getYouTubeId('https://www.youtube-nocookie.com/embed/M7lc1UVf-VE?start=45'), 'M7lc1UVf-VE');
      assert.equal(API.getYouTubeStartSeconds('https://youtu.be/M7lc1UVf-VE?t=75'), 75);
      assert.equal(API.getYouTubeStartSeconds('https://www.youtube.com/watch?v=M7lc1UVf-VE&t=1m30s'), 90);
      assert.equal(API.getYouTubeStartSeconds('https://www.youtube-nocookie.com/embed/M7lc1UVf-VE?start=45'), 45);

      const container = createEl('yt-box', 'div', env.byId);
      let playingCount = 0;
      let endedCount = 0;
      let lastErr = null;

      const ctrl = API.mountYouTubeClipPlayer(container, {
        videoId: 'M7lc1UVf-VE',
        startSec: 75,
        durationSec: 10,
        height: 200,
        title: 'Test YouTube Player',
        onPlaying: () => { playingCount++; },
        onEnded: () => { endedCount++; },
        onError: (code) => { lastErr = code; }
      });

      assert.ok(ctrl, 'mountYouTubeClipPlayer must return a controller');
      const iframe = container.children.find((c) => c.tagName === 'IFRAME');
      assert.ok(iframe, 'Container must hold an iframe');
      assert.equal(iframe.referrerPolicy, 'strict-origin-when-cross-origin');
      assert.ok(iframe.allow.includes('autoplay'));
      assert.ok(iframe.src.includes('https://www.youtube-nocookie.com/embed/M7lc1UVf-VE?'), 'Embed URL must use youtube-nocookie');
      assert.ok(iframe.src.includes('start=75&end=85'), 'Embed URL must include start=75&end=85');
      assert.ok(iframe.src.includes('enablejsapi=1'), 'Embed URL must enable JS postMessage API');
      assert.ok(iframe.src.includes('playsinline=1'), 'Embed URL must include playsinline=1');

      const footer = container.children[1];
      const link = footer.children.find((c) => c.tagName === 'A');
      assert.ok(link && link.href === 'https://www.youtube.com/watch?v=M7lc1UVf-VE&t=75s', 'Fallback link must point to exact timestamp');

      // Simulate iframe load -> listening handshake
      iframe.dispatchEvent({ type: 'load' });
      assert.ok(iframe._postedMessages.some((m) => m.msg.includes('"listening"')), 'Must send listening handshake on load');

      // Simulate YouTube onReady + playing at 75.2s
      env.windowObj.dispatchWindowEvent('message', {
        origin: 'https://www.youtube-nocookie.com',
        source: iframe.contentWindow,
        data: JSON.stringify({ event: 'onReady' })
      });
      env.windowObj.dispatchWindowEvent('message', {
        origin: 'https://www.youtube-nocookie.com',
        source: iframe.contentWindow,
        data: JSON.stringify({ event: 'infoDelivery', info: { playerState: 1, currentTime: 75.2 } })
      });
      assert.equal(playingCount, 1, 'onPlaying must fire when YouTube enters state 1');

      // Simulate reaching endSec (85.0s)
      env.windowObj.dispatchWindowEvent('message', {
        origin: 'https://www.youtube-nocookie.com',
        source: iframe.contentWindow,
        data: JSON.stringify({ event: 'infoDelivery', info: { playerState: 1, currentTime: 85.0 } })
      });
      assert.equal(endedCount, 1, 'onEnded must fire when clip reaches endSec');

      // Seeking updates start/end URL and fallback link
      ctrl.seekTo(120, 10);
      assert.ok(iframe.src.includes('start=120&end=130'), 'seekTo must update iframe src to start=120&end=130');
      assert.equal(link.href, 'https://www.youtube.com/watch?v=M7lc1UVf-VE&t=120s', 'seekTo must update fallback link');

      // Error 150 callback fires
      env.windowObj.dispatchWindowEvent('message', {
        origin: 'https://www.youtube-nocookie.com',
        source: iframe.contentWindow,
        data: JSON.stringify({ event: 'onError', info: 150 })
      });
      assert.equal(lastErr, 150, 'onError must propagate YouTube embed error code');

      ctrl.destroy();
      assert.equal(container.children.length, 0, 'destroy must clear container');
    });

    await t.test('3. Profile page embeds YouTube at saved timestamp, seeks on slider change, and auto-falls back on Error 150', async () => {
      const ytResults = [
        { videoId: 'BlockedVid1', title: 'Blocked Official Video', channel: 'VEVO', durationText: '3:30', durationSec: 210 },
        { videoId: 'WorkingVid2', title: 'Working Audio Track', channel: 'Music Archive', durationText: '3:30', durationSec: 210 }
      ];
      const env = createDomVm({
        fetch: async (url) => {
          if (String(url).includes('/api/auth/youtube-search')) {
            return { ok: true, json: async () => ({ results: ytResults }) };
          }
          return { ok: true, json: async () => ({}) };
        }
      });

      const savedSong = JSON.stringify({
        label: 'In the Rain — The Dramatics',
        trackName: 'In the Rain',
        artistName: 'The Dramatics',
        deezerId: '3135556',
        durationSec: 210,
        clipStart: 65,
        youtubeId: 'BlockedVid1',
        youtubeTitle: 'Blocked Official Video'
      });

      // Seed required Profile DOM nodes
      ['profile-name', 'profile-email', 'profile-bio', 'profile-walkup-song', 'walkup-song-results', 'walkup-song-card', 'profile-form', 'profile-alert']
        .forEach((id) => createEl(id, id === 'profile-form' ? 'form' : (id.includes('walkup-song') && !id.includes('card') && !id.includes('results') ? 'input' : 'div'), env.byId));

      env.windowObj.API.getMe = async () => ({
        id: 1,
        name: 'Test Player',
        email: 'player@example.com',
        bio: '',
        walkup_song: savedSong
      });
      env.windowObj.API.renderNav = () => {};
      env.windowObj.API.getPublicConfig = async () => ({});
      env.windowObj.API.isFeatureEnabled = () => true;
      env.windowObj.API.t = (_k, fb) => fb || '';

      const profileSrc = fs.readFileSync(path.join(PUBLIC_DIR, 'js/profile.js'), 'utf8');
      vm.runInContext(profileSrc, env.ctx, { filename: 'public/js/profile.js' });

      for (const fn of (env.docListeners.DOMContentLoaded || [])) {
        await fn();
      }
      await new Promise((r) => setTimeout(r, 20));

      const playBtn = env.byId['btn-walkup-preview'];
      const slider = env.byId['walkup-clip-start'];
      const ytPreview = env.byId['walkup-youtube-preview'];
      assert.ok(playBtn && slider && ytPreview, 'Profile walk-up clipper controls must render');
      assert.equal(slider.value, '65', 'Slider must initialize to saved clipStart 65');

      // Click Preview -> mounts BlockedVid1 at 65..75
      playBtn.dispatchEvent({ type: 'click' });
      const firstIframe = ytPreview.children.find((c) => c.tagName === 'IFRAME');
      assert.ok(firstIframe && firstIframe.src.includes('BlockedVid1') && firstIframe.src.includes('start=65&end=75'), 'Must mount YouTube iframe at 65..75');

      // Simulate YouTube Error 150 -> automatically advances to WorkingVid2 at 65..75
      env.windowObj.dispatchWindowEvent('message', {
        origin: 'https://www.youtube-nocookie.com',
        source: firstIframe.contentWindow,
        data: JSON.stringify({ event: 'onError', info: 150 })
      });
      await new Promise((r) => setTimeout(r, 20));

      const secondIframe = ytPreview.children.find((c) => c.tagName === 'IFRAME');
      assert.ok(secondIframe && secondIframe.src.includes('WorkingVid2') && secondIframe.src.includes('start=65&end=75'), 'Error 150 must automatically switch to WorkingVid2 at same timestamp');

      // Changing slider to 95 seeks active YouTube embed to 95..105
      slider.value = '95';
      slider.dispatchEvent({ type: 'change' });
      assert.ok(secondIframe.src.includes('start=95&end=105'), 'Slider change must seek active YouTube player to 95..105');
    });

    await t.test('4. Clubhouse Batting Practice DJ card plays YouTube at timestamp, auto-recovers from Error 150, and falls back when Deezer preview is empty', async () => {
      const env = createDomVm();
      const apiCalls = [];
      env.windowObj.ClubhouseStore = {
        state: { user: { id: 1, name: 'Batter One', role: 'member' }, members: [], voiceParticipants: [] },
        apiRequest: async (_method, url) => {
          apiCalls.push(url);
          if (String(url).includes('/api/auth/youtube-search')) {
            return {
              ok: true,
              data: {
                results: [
                  { videoId: 'DjBlocked01', title: 'Blocked', durationSec: 200 },
                  { videoId: 'DjWorking02', title: 'Working', durationSec: 200 }
                ]
              }
            };
          }
          if (String(url).includes('/api/auth/music-preview')) {
            return { ok: true, data: { previewUrl: '' } };
          }
          return { ok: true, data: {} };
        },
        _ui: {
          uiState: { publicConfig: {}, remoteStreams: {} },
          el: (id) => env.byId[id] || null,
          escapeHtml: (s) => String(s || ''),
          formatTime: () => '',
          tClubhouse: (_k, fb) => fb || '',
          isClubhouseBpEnabled: () => true,
          isMemberRole: () => true,
          isModeratorUser: () => false,
          abbreviateMemberNames: (arr) => arr.map((x) => x.name || ''),
          showPeerBlockedFeedback: () => {},
          handlePeerActionError: () => {}
        }
      };

      ['ch-sunday-details', 'ch-sunday-status-pill', 'ch-sunday-guest-notice', 'ch-quick-rsvp-group',
        'ch-bp-card', 'ch-duties-card', 'ch-facilitator-checklist-card', 'btn-sync-game-channel',
        'ch-bp-grid', 'ch-bp-count-label', 'ch-duties-list', 'btn-quick-rsvp-yes', 'btn-quick-rsvp-no',
        'ch-bp-dj-bar', 'ch-bp-dj-now', 'btn-bp-dj-prev', 'btn-bp-dj-play', 'btn-bp-dj-next', 'ch-bp-dj-yt-wrap']
        .forEach((id) => createEl(id, 'div', env.byId));

      const panelsSrc = fs.readFileSync(path.join(PUBLIC_DIR, 'js/clubhouse/panels.js'), 'utf8');
      vm.runInContext(panelsSrc, env.ctx, { filename: 'public/js/clubhouse/panels.js' });

      const UI = env.windowObj.ClubhouseStore._ui;
      UI.initPanelsDomEvents();
      UI.renderUpcomingEventCard({
        event: { id: 10, title: 'Sunday Pickup', status: 'active', location: 'Bushrod Park', event_date: '2026-11-22T20:00:00Z' },
        attendees: [],
        duties: [],
        bp_signups: [
          {
            slot_number: 1,
            user_id: 1,
            player_name: 'Batter One',
            walkup_song: JSON.stringify({
              label: 'Walkup One — Band',
              trackName: 'Walkup One',
              artistName: 'Band',
              clipStart: 80,
              youtubeId: 'DjBlocked01'
            })
          },
          {
            slot_number: 2,
            user_id: 2,
            player_name: 'Batter Two',
            walkup_song: JSON.stringify({
              label: 'No Deezer Track — Artist',
              trackName: 'No Deezer Track',
              artistName: 'Artist',
              deezerId: '999',
              clipStart: 12,
              youtubeId: ''
            })
          }
        ]
      });

      const playBtn = env.byId['btn-bp-dj-play'];
      const nextBtn = env.byId['btn-bp-dj-next'];
      const ytWrap = env.byId['ch-bp-dj-yt-wrap'];

      // Play Slot #1 -> starts DjBlocked01 at 80..90
      playBtn.dispatchEvent({ type: 'click' });
      const ytIframe1 = ytWrap.children.find((c) => c.tagName === 'IFRAME');
      assert.ok(ytIframe1 && ytIframe1.src.includes('DjBlocked01') && ytIframe1.src.includes('start=80&end=90'), 'BP DJ must embed YouTube at 80..90');

      // Error 150 -> auto-recovers with DjWorking02 at 80..90
      env.windowObj.dispatchWindowEvent('message', {
        origin: 'https://www.youtube-nocookie.com',
        source: ytIframe1.contentWindow,
        data: JSON.stringify({ event: 'onError', info: 150 })
      });
      await new Promise((r) => setTimeout(r, 20));
      const ytIframe2 = ytWrap.children.find((c) => c.tagName === 'IFRAME');
      assert.ok(ytIframe2 && ytIframe2.src.includes('DjWorking02') && ytIframe2.src.includes('start=80&end=90'), 'BP DJ must auto-switch to DjWorking02 on Error 150');

      // Next batter (Slot #2, clipStart 12, empty Deezer preview) -> falls back to YouTube at 12..22
      nextBtn.dispatchEvent({ type: 'click' });
      await new Promise((r) => setTimeout(r, 30));
      const ytIframe3 = ytWrap.children.find((c) => c.tagName === 'IFRAME');
      assert.ok(ytIframe3 && ytIframe3.src.includes('start=12&end=22'), 'BP DJ must fall back to YouTube at 12..22 when Deezer preview is unavailable');
      assert.ok(apiCalls.some((u) => u.includes('/api/auth/music-preview')), 'Must check Deezer preview first for <=20s');
    });

    await t.test('5. Clubhouse carries over profile avatar images to user bar, messages, members directory & voice', () => {
      const env = createDomVm();
      env.windowObj.ClubhouseStore = {
        state: {
          user: {
            id: 7,
            name: 'Alex Rivera',
            role: 'member',
            clubhouseOptedIn: true,
            avatarUrl: '/api/users/7/avatar?v=420'
          },
          channels: [{ id: 1, slug: 'dugout-voice', name: 'Dugout Voice', category: 'Voice Lounges', channel_type: 'voice' }],
          members: [
            { id: 7, name: 'Alex R.', role: 'member', avatarUrl: '/api/users/7/avatar?v=420' },
            { id: 8, name: 'Jordan K.', role: 'member', avatarUrl: '/api/users/8/avatar?v=512' },
            { id: 9, name: 'Private P.', role: 'member', avatarUrl: '' }
          ],
          voiceParticipants: [{ channel_id: 1, user_id: 7, user_name: 'Alex R.' }],
          unreadByChannel: {}
        }
      };
      env.windowObj.ClubhouseRTC = { state: { activeChannelId: 1, speakingUsers: {} } };

      ['ch-current-user-name', 'ch-current-user-role', 'ch-current-user-avatar',
        'ch-channel-list', 'ch-members-directory', 'ch-video-grid', 'ch-media-stage',
        'ch-voice-status-bar', 'ch-voice-status-name']
        .forEach((id) => createEl(id, 'div', env.byId));

      const layoutSrc = fs.readFileSync(path.join(PUBLIC_DIR, 'js/clubhouse/layout.js'), 'utf8');
      const messagesSrc = fs.readFileSync(path.join(PUBLIC_DIR, 'js/clubhouse/messages.js'), 'utf8');
      const panelsSrc = fs.readFileSync(path.join(PUBLIC_DIR, 'js/clubhouse/panels.js'), 'utf8');
      vm.runInContext(layoutSrc, env.ctx, { filename: 'public/js/clubhouse/layout.js' });
      vm.runInContext(messagesSrc, env.ctx, { filename: 'public/js/clubhouse/messages.js' });
      vm.runInContext(panelsSrc, env.ctx, { filename: 'public/js/clubhouse/panels.js' });

      const UI = env.windowObj.ClubhouseStore._ui;
      UI.renderUserBar();
      const userAvatarEl = env.byId['ch-current-user-avatar'];
      assert.ok(userAvatarEl.innerHTML.includes('src="/api/users/7/avatar?v=420"'), 'User bar must render signed-in user avatar image');
      assert.ok(userAvatarEl.classList.contains('has-avatar'), 'User bar avatar must set has-avatar class');

      const msgHtmlWithAvatar = UI.buildMessageCardHtml(
        { id: 101, channel_id: 1, author_id: 8, author_name: 'Jordan K.', content: 'Hey!', created_at: '2026-11-19T12:00:00Z' },
        env.windowObj.ClubhouseStore.state.user,
        false
      );
      assert.ok(msgHtmlWithAvatar.includes('src="/api/users/8/avatar?v=512"'), 'Message card must render member avatar image');

      const msgHtmlPrivate = UI.buildMessageCardHtml(
        { id: 102, channel_id: 1, author_id: 9, author_name: 'Private P.', content: 'Hi', created_at: '2026-11-19T12:00:00Z' },
        env.windowObj.ClubhouseStore.state.user,
        false
      );
      assert.ok(!msgHtmlPrivate.includes('<img'), 'Private member without shared avatar must fall back to initial');

      UI.renderMembersDirectory();
      const dirHtml = env.byId['ch-members-directory'].innerHTML;
      assert.ok(dirHtml.includes('src="/api/users/7/avatar?v=420"'), 'Members directory must render self avatar');
      assert.ok(dirHtml.includes('src="/api/users/8/avatar?v=512"'), 'Members directory must render peer avatar');

      UI.renderChannelSidebar();
      assert.ok(env.byId['ch-channel-list'].innerHTML.includes('src="/api/users/7/avatar?v=420"'), 'Voice roster must render participant avatar');

      UI.renderVoiceVideoTiles();
      assert.ok(env.byId['ch-video-grid'].innerHTML.includes('src="/api/users/7/avatar?v=420"'), 'Voice tile must render participant avatar');
    });

    await t.test('6. Clubhouse Moderator can add walk-in batters & walk-up songs to BP card (and regular members get 403)', async () => {
      if (ctx && ctx.apiReq && ctx.createSession) {
        const modEmail = `bp_mod_${Date.now()}@sundaypickup.org`;
        const memEmail = `bp_mem_${Date.now()}@sundaypickup.org`;
        const modRes = ctx.db.prepare(
          "INSERT INTO users (name, email, role, is_admin, is_moderator, clubhouse_opted_in) VALUES ('Clubhouse Mod', ?, 'member', 0, 1, 1)"
        ).run(modEmail);
        const memRes = ctx.db.prepare(
          "INSERT INTO users (name, email, role, is_admin, is_moderator, clubhouse_opted_in) VALUES ('Regular Member', ?, 'member', 0, 0, 1)"
        ).run(memEmail);
        const modSess = ctx.createSession(Number(modRes.lastInsertRowid));
        const memSess = ctx.createSession(Number(memRes.lastInsertRowid));
        const modCookie = `baseball_session=${typeof modSess === 'string' ? modSess : modSess.sessionId}`;
        const memCookie = `baseball_session=${typeof memSess === 'string' ? memSess : memSess.sessionId}`;

        const futureDate = new Date(Date.now() + 3 * 86400 * 1000).toISOString();
        const evRes = ctx.db.prepare(
          "INSERT INTO events (title, location, event_date, max_players, status, created_by) VALUES ('Sunday Mod BP Test', 'Bushrod Park', ?, 30, 'active', ?)"
        ).run(futureDate, Number(modRes.lastInsertRowid));
        const evId = Number(evRes.lastInsertRowid);

        const songJson = JSON.stringify({
          label: 'Enter Sandman — Metallica',
          trackName: 'Enter Sandman',
          artistName: 'Metallica',
          clipStart: 55,
          youtubeId: 'M7lc1UVf-VE',
          youtubeTitle: 'Metallica - Enter Sandman'
        });

        // Regular member must be rejected with 403
        const forbidden = await ctx.apiReq('POST', `/api/baseball/events/${evId}/quick-bp`, memCookie, {
          action: 'mod_assign',
          slot_number: 4,
          player_name: 'Walk-In Carlos',
          walkup_song: songJson
        });
        assert.equal(forbidden.status, 403, 'Non-moderator must receive 403 on mod_assign');

        // Moderator adds walk-in batter + walk-up song
        const assignRes = await ctx.apiReq('POST', `/api/baseball/events/${evId}/quick-bp`, modCookie, {
          action: 'mod_assign',
          slot_number: 4,
          player_name: 'Walk-In Carlos',
          walkup_song: songJson
        });
        assert.equal(assignRes.status, 200, 'Moderator mod_assign must return 200');
        assert.equal(assignRes.data.player_name, 'Walk-In Carlos');
        assert.ok(assignRes.data.walkup_song && assignRes.data.walkup_song.includes('M7lc1UVf-VE'));

        // Verify BP order endpoint returns the slot's walkup_song
        const bpOrderRes = await ctx.apiReq('GET', `/api/events/${evId}/bp-order`, modCookie);
        assert.equal(bpOrderRes.status, 200);
        const slot4 = (bpOrderRes.data.bp_signups || []).find((r) => Number(r.slot_number) === 4);
        assert.ok(slot4 && slot4.walkup_song && JSON.parse(slot4.walkup_song).clipStart === 55, 'BP order must return slot walkup_song');

        // Moderator can release the walk-in slot
        const relRes = await ctx.apiReq('POST', `/api/baseball/events/${evId}/quick-bp`, modCookie, {
          action: 'release',
          slot_number: 4
        });
        assert.equal(relRes.status, 200, 'Moderator must be able to release any BP slot');
      }

      // VM UI check: Mod sees "+ Add Batter" button and submitting modal calls mod_assign
      const env = createDomVm();
      const posted = [];
      env.windowObj.ClubhouseStore = {
        state: {
          user: { id: 10, name: 'Mod Pat', role: 'member', isModerator: true, is_moderator: 1 },
          members: [{ id: 11, name: 'Teammate Sam' }],
          voiceParticipants: []
        },
        apiRequest: async (method, url, body) => {
          posted.push({ method, url, body });
          return { ok: true, data: { success: true } };
        },
        _ui: {
          uiState: { publicConfig: {}, remoteStreams: {}, upcomingData: null },
          el: (id) => env.byId[id] || null,
          escapeHtml: (s) => String(s || ''),
          formatTime: () => '',
          tClubhouse: (_k, fb) => fb || '',
          isClubhouseBpEnabled: () => true,
          isMemberRole: () => true,
          isModeratorUser: (u) => Boolean((u || env.windowObj.ClubhouseStore.state.user).isModerator),
          abbreviateMemberNames: (arr) => arr.map((x) => x.name || ''),
          showPeerBlockedFeedback: () => {},
          handlePeerActionError: () => {}
        }
      };

      ['ch-sunday-details', 'ch-sunday-status-pill', 'ch-sunday-guest-notice', 'ch-quick-rsvp-group',
        'ch-bp-card', 'ch-duties-card', 'ch-facilitator-checklist-card', 'btn-sync-game-channel',
        'ch-bp-grid', 'ch-bp-count-label', 'ch-duties-list', 'btn-quick-rsvp-yes', 'btn-quick-rsvp-no',
        'ch-bp-dj-bar', 'ch-bp-dj-now', 'btn-bp-dj-prev', 'btn-bp-dj-play', 'btn-bp-dj-next', 'ch-bp-dj-yt-wrap',
        'btn-bp-mod-add', 'ch-bp-mod-modal', 'ch-bp-mod-modal-title', 'btn-close-bp-mod-modal',
        'btn-cancel-bp-mod-modal', 'ch-bp-mod-form', 'bp-mod-slot', 'bp-mod-member', 'bp-mod-name',
        'bp-mod-song-input', 'bp-mod-song-results', 'btn-bp-mod-clear-song', 'bp-mod-clip-start',
        'bp-mod-clip-hint', 'bp-mod-yt-wrap', 'bp-mod-yt-select', 'ch-bp-mod-status', 'btn-bp-mod-remove', 'btn-save-bp-mod']
        .forEach((id) => createEl(id, id === 'ch-bp-mod-form' ? 'form' : 'div', env.byId));

      const panelsSrc = fs.readFileSync(path.join(PUBLIC_DIR, 'js/clubhouse/panels.js'), 'utf8');
      vm.runInContext(panelsSrc, env.ctx, { filename: 'public/js/clubhouse/panels.js' });

      const UI = env.windowObj.ClubhouseStore._ui;
      UI.initPanelsDomEvents();
      const upcoming = {
        event: { id: 55, title: 'Sunday Game', status: 'active', location: 'Bushrod Park', event_date: '2026-11-22T20:00:00Z' },
        attendees: [],
        duties: [],
        bp_signups: []
      };
      UI.uiState.upcomingData = upcoming;
      UI.renderUpcomingEventCard(upcoming);

      assert.equal(env.byId['btn-bp-mod-add'].classList.contains('hidden'), false, 'Mod must see + Add Batter button');
      UI.openBpModModal(3);
      env.byId['bp-mod-slot'].value = '3';
      env.byId['bp-mod-name'].value = 'Guest Batter';
      env.byId['bp-mod-song-input'].value = 'https://youtu.be/M7lc1UVf-VE?t=45';
      env.byId['bp-mod-song-input'].dispatchEvent({ type: 'input' });
      env.byId['ch-bp-mod-form'].dispatchEvent({ type: 'submit', preventDefault() {} });
      await new Promise((r) => setTimeout(r, 20));

      const assignCall = posted.find((p) => p.method === 'POST' && p.url.includes('/quick-bp'));
      assert.ok(assignCall && assignCall.body.action === 'mod_assign', 'Submitting modal must POST action=mod_assign');
      assert.equal(assignCall.body.slot_number, 3);
      assert.equal(assignCall.body.player_name, 'Guest Batter');
      const savedSong = JSON.parse(assignCall.body.walkup_song);
      assert.equal(savedSong.youtubeId, 'M7lc1UVf-VE');
      assert.equal(savedSong.clipStart, 45);
    });
  });
}

if (require.main === module) {
  registerWalkupYoutubeTests(null);
}

module.exports = registerWalkupYoutubeTests;
