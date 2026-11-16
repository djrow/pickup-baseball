/**
 * tests/core/peer-block-ui.test.js
 * Unit & VM Integration Tests for Ticket #44:
 * Wave 1b.6: Peer Block UI, Store State, Shared-Channel Message Hiding & i18n Parity
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
    contains(cls) { return set.has(cls); },
    toArray() { return Array.from(set); }
  };
}

function createFakeElement(id = '', tag = 'div') {
  const listeners = Object.create(null);
  const attrs = Object.create(null);
  const node = {
    id,
    tagName: tag.toUpperCase(),
    innerHTML: '',
    textContent: '',
    value: '',
    disabled: false,
    checked: false,
    title: '',
    scrollTop: 0,
    scrollHeight: 100,
    style: {},
    className: '',
    classList: createClassList(),
    children: [],
    parentNode: null,
    attributes: attrs,
    setAttribute(k, v) { attrs[k] = String(v); },
    getAttribute(k) { return k in attrs ? attrs[k] : null; },
    hasAttribute(k) { return k in attrs; },
    removeAttribute(k) { delete attrs[k]; },
    addEventListener(ev, fn) {
      if (!listeners[ev]) listeners[ev] = [];
      listeners[ev].push(fn);
    },
    dispatchEvent(evObj) {
      const ev = evObj || { type: 'click', preventDefault() {}, stopPropagation() {} };
      const list = listeners[ev.type] || [];
      for (const fn of list) {
        fn.call(node, ev);
      }
    },
    appendChild(child) {
      if (child) child.parentNode = node;
      node.children.push(child);
      return child;
    },
    insertBefore(child) {
      if (child) child.parentNode = node;
      node.children.unshift(child);
      return child;
    },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    closest() { return null; },
    contains() { return false; },
    focus() {}
  };
  return node;
}

function loadApiEnDict() {
  const apiSrc = fs.readFileSync(path.join(PUBLIC_DIR, 'js', 'api.js'), 'utf8');
  const m = apiSrc.match(/const EN_DICT = \{([\s\S]*?)\n\};/);
  assert.ok(m, 'public/js/api.js must define EN_DICT');
  return vm.runInNewContext('({' + m[1] + '})');
}

function createStoreSandbox(fetchImpl) {
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Promise,
    JSON,
    Math,
    Date,
    Object,
    Array,
    String,
    Number,
    Boolean,
    RegExp,
    Error,
    encodeURIComponent,
    URL: globalThis.URL,
    Blob: globalThis.Blob,
    AbortController: globalThis.AbortController,
    fetch: fetchImpl,
    localStorage: {
      _map: Object.create(null),
      getItem(k) { return Object.prototype.hasOwnProperty.call(this._map, k) ? this._map[k] : null; },
      setItem(k, v) { this._map[k] = String(v); },
      removeItem(k) { delete this._map[k]; }
    },
    document: {
      visibilityState: 'visible',
      addEventListener() {}
    },
    module: { exports: {} }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  const storeSrc = fs.readFileSync(path.join(PUBLIC_DIR, 'js', 'store.js'), 'utf8');
  vm.runInNewContext(storeSrc, sandbox, { filename: 'public/js/store.js' });
  return sandbox;
}

function createUiSandbox({ fetchImpl, enDict }) {
  const elementsById = {
    'clubhouse-app': createFakeElement('clubhouse-app'),
    'ch-channel-list': createFakeElement('ch-channel-list'),
    'ch-message-stream': createFakeElement('ch-message-stream'),
    'ch-members-directory': createFakeElement('ch-members-directory'),
    'ch-active-channel-name': createFakeElement('ch-active-channel-name'),
    'ch-active-channel-topic': createFakeElement('ch-active-channel-topic'),
    'ch-active-e2ee-badge': createFakeElement('ch-active-e2ee-badge'),
    'ch-composer-form': createFakeElement('ch-composer-form', 'form'),
    'ch-composer-input': createFakeElement('ch-composer-input', 'textarea'),
    'ch-thread-form': createFakeElement('ch-thread-form', 'form'),
    'ch-thread-input': createFakeElement('ch-thread-input', 'input'),
    'ch-thread-messages': createFakeElement('ch-thread-messages'),
    'ch-thread-root-preview': createFakeElement('ch-thread-root-preview'),
    'ch-typing-indicator': createFakeElement('ch-typing-indicator'),
    'ch-dm-e2ee-banner': createFakeElement('ch-dm-e2ee-banner'),
    'ch-dm-e2ee-banner-text': createFakeElement('ch-dm-e2ee-banner-text'),
    'ch-auth-banner': createFakeElement('ch-auth-banner'),
    'ch-optin-banner': createFakeElement('ch-optin-banner'),
    'ch-muted-banner': createFakeElement('ch-muted-banner'),
    'ch-video-grid': createFakeElement('ch-video-grid'),
    'ch-media-stage': createFakeElement('ch-media-stage'),
    'ch-mod-reports-list': createFakeElement('ch-mod-reports-list'),
    'ch-mod-users-list': createFakeElement('ch-mod-users-list'),
    'btn-dm-verify-key': createFakeElement('btn-dm-verify-key', 'button'),
    'btn-dm-open-vault': createFakeElement('btn-dm-open-vault', 'button')
  };

  const dialogs = {
    confirms: [],
    toasts: [],
    alerts: [],
    nextConfirmResult: true
  };

  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Promise,
    JSON,
    Math,
    Date,
    Object,
    Array,
    String,
    Number,
    Boolean,
    RegExp,
    Error,
    encodeURIComponent,
    Event: function (type) { this.type = type; this.preventDefault = function () {}; },
    URL: globalThis.URL,
    Blob: globalThis.Blob,
    AbortController: globalThis.AbortController,
    fetch: fetchImpl,
    localStorage: {
      _map: Object.create(null),
      getItem(k) { return Object.prototype.hasOwnProperty.call(this._map, k) ? this._map[k] : null; },
      setItem(k, v) { this._map[k] = String(v); },
      removeItem(k) { delete this._map[k]; }
    },
    API: {
      t(key, fallbackOrVars, maybeVars) {
        let fallback = null;
        let vars = {};
        if (typeof fallbackOrVars === 'string') {
          fallback = fallbackOrVars;
          vars = (maybeVars && typeof maybeVars === 'object') ? maybeVars : {};
        } else if (fallbackOrVars && typeof fallbackOrVars === 'object') {
          vars = fallbackOrVars;
        }
        let str = enDict[key] !== undefined ? enDict[key] : (fallback !== null ? fallback : key);
        for (const [k, v] of Object.entries(vars)) {
          str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
        }
        return str;
      },
      escapeHtml(str) {
        return String(str == null ? '' : str)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      },
      isMemberRole(r) { return r === 'member' || r === 'player'; },
      isFeatureEnabled() { return true; },
      getPublicConfig() { return Promise.resolve({ turnConfigured: false, features: {} }); }
    },
    PBFDialog: {
      confirm(message, opts) {
        dialogs.confirms.push({ message, opts });
        return Promise.resolve(dialogs.nextConfirmResult);
      },
      toast(message, opts) {
        dialogs.toasts.push({ message, opts });
      },
      alert(message, opts) {
        dialogs.alerts.push({ message, opts });
        return Promise.resolve();
      }
    },
    document: {
      readyState: 'loading',
      visibilityState: 'visible',
      addEventListener() {},
      getElementById(id) { return elementsById[id] || null; },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      createElement(tag) { return createFakeElement('', tag); }
    },
    module: { exports: {} }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.addEventListener = function () {};

  const storeSrc = fs.readFileSync(path.join(PUBLIC_DIR, 'js', 'store.js'), 'utf8');
  vm.runInNewContext(storeSrc, sandbox, { filename: 'public/js/store.js' });

  sandbox.module = { exports: {} };
  const rtcSrc = fs.readFileSync(path.join(PUBLIC_DIR, 'js', 'rtc.js'), 'utf8');
  vm.runInNewContext(rtcSrc, sandbox, { filename: 'public/js/rtc.js' });

  sandbox.module = { exports: {} };
  const clubhouseSrc = fs.readFileSync(path.join(PUBLIC_DIR, 'js', 'clubhouse.js'), 'utf8');
  vm.runInNewContext(clubhouseSrc, sandbox, { filename: 'public/js/clubhouse.js' });

  return { sandbox, elementsById, dialogs };
}

function registerPeerBlockUiTests() {
  test('Peer Block Store, UI, Shared-Channel Hiding & i18n Parity (#44)', async (t) => {
    await t.test('1. ClubhouseStore tracks blockedUserIds across bootstrap, sync, blockPeer, unblockPeer, and clearLocalSessionData', async () => {
      const requests = [];
      let syncBlockedIds = [22];
      const fetchMock = async (url, opts = {}) => {
        requests.push({ method: opts.method || 'GET', url, body: opts.body ? JSON.parse(opts.body) : null });
        if (url === '/api/bootstrap') {
          return {
            ok: true,
            status: 200,
            headers: { get: () => '' },
            text: async () => JSON.stringify({
              user: { id: 10, name: 'Alice', role: 'member' },
              channels: [{ id: 1, slug: 'general', name: '#general', channel_type: 'text' }],
              members: [
                { id: 10, name: 'Alice', role: 'member' },
                { id: 22, name: 'Bob', role: 'member' },
                { id: 33, name: 'Carol', role: 'member' }
              ],
              muted_user_ids: [],
              blocked_user_ids: [22],
              unread_counts: {},
              voice_participants: [],
              last_message_id: 5,
              last_event_id: 2
            })
          };
        }
        if (url.startsWith('/api/sync')) {
          return {
            ok: true,
            status: 200,
            headers: { get: () => '' },
            text: async () => JSON.stringify({
              messages: [],
              events: [],
              rtc_signals: [],
              voice_participants: [],
              blocked_user_ids: syncBlockedIds,
              latest_msg_id: 5,
              latest_event_id: 2
            })
          };
        }
        if (url === '/api/blocks' && (opts.method || 'GET') === 'POST') {
          return {
            ok: true,
            status: 201,
            headers: { get: () => '' },
            text: async () => JSON.stringify({
              success: true,
              blocked_id: 33,
              blocked_user_id: 33,
              blocked_user_ids: [22, 33]
            })
          };
        }
        if (url === '/api/blocks/22' && opts.method === 'DELETE') {
          return {
            ok: true,
            status: 200,
            headers: { get: () => '' },
            text: async () => JSON.stringify({
              success: true,
              unblocked_id: 22,
              unblocked_user_id: 22,
              blocked_user_ids: [33]
            })
          };
        }
        if (url === '/api/channels' && opts.method === 'POST') {
          return {
            ok: false,
            status: 403,
            headers: { get: () => '' },
            text: async () => JSON.stringify({
              error: 'Direct messages are blocked between you and this member.',
              code: 'PEER_BLOCKED'
            })
          };
        }
        return { ok: true, status: 200, headers: { get: () => '' }, text: async () => '{}' };
      };

      const sandbox = createStoreSandbox(fetchMock);
      const Store = sandbox.ClubhouseStore;
      assert.ok(Array.isArray(Store.state.blockedUserIds), 'state.blockedUserIds must be initialized as an array');
      assert.equal(typeof Store.blockPeer, 'function', 'Store.blockPeer must exist');
      assert.equal(typeof Store.unblockPeer, 'function', 'Store.unblockPeer must exist');
      assert.equal(typeof Store.isPeerBlockedByMe, 'function', 'Store.isPeerBlockedByMe must exist');
      assert.equal(typeof Store.fetchBlockedPeers, 'function', 'Store.fetchBlockedPeers must exist');

      const events = [];
      Store.subscribe((ev, detail) => events.push({ ev, detail }));

      await Store.bootstrap();
      Store.stopAdaptiveSyncLoop();

      assert.deepEqual(Array.from(Store.state.blockedUserIds), [22]);
      assert.equal(Store.isPeerBlockedByMe(22), true);
      assert.equal(Store.isPeerBlockedByMe(33), false);

      await Store.blockPeer(33);
      assert.deepEqual(Array.from(Store.state.blockedUserIds), [22, 33]);
      assert.equal(Store.isPeerBlockedByMe(33), true);
      assert.ok(events.some((e) => e.ev === 'peer_blocks_changed'), 'blockPeer must emit peer_blocks_changed');

      await Store.unblockPeer(22);
      assert.deepEqual(Array.from(Store.state.blockedUserIds), [33]);
      assert.equal(Store.isPeerBlockedByMe(22), false);

      // Sync updates blockedUserIds if server list changes
      syncBlockedIds = [33, 44];
      await Store.pollDeltaSync();
      assert.deepEqual(Array.from(Store.state.blockedUserIds), [33, 44]);
      assert.equal(Store.isPeerBlockedByMe(44), true);

      // createChannel 403 PEER_BLOCKED preserves error code/status
      await assert.rejects(
        () => Store.createChannel({ channel_type: 'dm', dm_user_id: 33 }),
        (err) => err && err.code === 'PEER_BLOCKED' && err.status === 403
      );

      await Store.clearLocalSessionData();
      assert.deepEqual(Array.from(Store.state.blockedUserIds), []);
    });

    await t.test('2. Shared channels & group_dm collapse blocked messages by default with optional reveal, while NEVER suppressing announcement boards or Moderator actions', async () => {
      const enDict = loadApiEnDict();
      const { sandbox } = createUiSandbox({
        enDict,
        fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => '' }, text: async () => '{}' })
      });
      const Store = sandbox.ClubhouseStore;
      const UI = sandbox.ClubhouseUI;

      assert.equal(typeof UI.buildMessageCardHtml, 'function', 'ClubhouseUI.buildMessageCardHtml must be exposed for testing');
      assert.equal(typeof UI.shouldCollapseMessageForPeerBlock, 'function', 'ClubhouseUI.shouldCollapseMessageForPeerBlock must be exposed');

      const alice = { id: 10, name: 'Alice', role: 'member', isModerator: false };
      const generalCh = { id: 1, slug: 'general', name: '#general', channel_type: 'text' };
      const groupDmCh = { id: 2, slug: 'group-dm-1', name: 'Dugout Crew', channel_type: 'group_dm', is_encrypted: 1 };
      const announceCh = { id: 3, slug: 'announcements', name: '#announcements', channel_type: 'announcement' };
      const customAnnounceCh = { id: 4, slug: 'rainout-alerts', name: '#rainout-alerts', channel_type: 'announcement' };

      Store.state.user = alice;
      Store.state.channels = [generalCh, groupDmCh, announceCh, customAnnounceCh];
      Store.state.blockedUserIds = [22];
      Store.state.mutedUserIds = [];

      const blockedAuthorMsg = {
        id: 101,
        channel_id: 1,
        author_id: 22,
        author_name: 'Bob',
        author_role: 'member',
        content: 'Shared channel text from blocked peer',
        decrypted_content: 'Shared channel text from blocked peer',
        created_at: '2026-11-16T12:00:00Z'
      };
      const blockedGroupDmMsg = {
        id: 102,
        channel_id: 2,
        author_id: 22,
        author_name: 'Bob',
        author_role: 'member',
        content: 'Group DM message from blocked peer',
        decrypted_content: 'Group DM message from blocked peer',
        is_e2ee_decrypted: true,
        created_at: '2026-11-16T12:01:00Z'
      };
      const blockedAnnounceMsg = {
        id: 103,
        channel_id: 3,
        author_id: 22,
        author_name: 'Bob',
        author_role: 'organizer',
        content: 'Important game weather announcement!',
        decrypted_content: 'Important game weather announcement!',
        created_at: '2026-11-16T12:02:00Z'
      };
      const blockedCustomAnnounceMsg = {
        id: 104,
        channel_id: 4,
        author_id: 22,
        author_name: 'Bob',
        author_role: 'organizer',
        content: 'Field closed due to rainout!',
        decrypted_content: 'Field closed due to rainout!',
        created_at: '2026-11-16T12:03:00Z'
      };
      const modHiddenMsg = {
        id: 105,
        channel_id: 1,
        author_id: 22,
        author_name: 'Bob',
        author_role: 'member',
        is_hidden: true,
        hidden_by_name: 'Mod Carol',
        hidden_reason: 'Off-topic',
        content: '[Message hidden by moderator]',
        decrypted_content: '[Message hidden by moderator]',
        created_at: '2026-11-16T12:04:00Z'
      };
      const systemAuditMsg = {
        id: 106,
        channel_id: 2,
        author_id: 22,
        author_name: 'Bob',
        message_type: 'system',
        is_system: true,
        content: 'Bob rotated their E2EE identity key (v2).',
        created_at: '2026-11-16T12:05:00Z'
      };

      // Shared #general: collapsed by default
      assert.equal(UI.shouldCollapseMessageForPeerBlock(blockedAuthorMsg, generalCh), true);
      UI.uiState.activeChannelId = 1;
      UI.uiState.activeChannel = generalCh;
      const generalHtml = UI.buildMessageCardHtml(blockedAuthorMsg, alice, false);
      assert.ok(generalHtml.includes('ch-msg-blocked-stub'), 'Shared channel must render collapsed blocked-peer stub');
      assert.ok(!generalHtml.includes('Shared channel text from blocked peer'), 'Blocked message content must be hidden by default');
      assert.ok(generalHtml.includes('data-reveal-blocked-msg="101"'), 'Stub must provide optional Show once reveal button');
      assert.ok(generalHtml.includes('data-unblock-peer="22"'), 'Stub must provide Unblock button');

      // Optional per-message reveal shows content once
      UI.uiState.revealedBlockedMsgIds[101] = true;
      const revealedHtml = UI.buildMessageCardHtml(blockedAuthorMsg, alice, false);
      assert.ok(revealedHtml.includes('Shared channel text from blocked peer'), 'Per-message reveal must show message content');
      assert.ok(!revealedHtml.includes('ch-msg-blocked-stub'));

      // group_dm: collapsed by default
      UI.uiState.activeChannelId = 2;
      UI.uiState.activeChannel = groupDmCh;
      const groupDmHtml = UI.buildMessageCardHtml(blockedGroupDmMsg, alice, false);
      assert.ok(groupDmHtml.includes('ch-msg-blocked-stub'), 'group_dm must collapse blocked peer message by default');
      assert.ok(!groupDmHtml.includes('Group DM message from blocked peer'));

      // announcement boards: NEVER suppressed
      UI.uiState.activeChannelId = 3;
      UI.uiState.activeChannel = announceCh;
      assert.equal(UI.shouldCollapseMessageForPeerBlock(blockedAnnounceMsg, announceCh), false);
      const announceHtml = UI.buildMessageCardHtml(blockedAnnounceMsg, alice, false);
      assert.ok(announceHtml.includes('Important game weather announcement!'), '#announcements must never suppress messages');
      assert.ok(!announceHtml.includes('ch-msg-blocked-stub'));

      UI.uiState.activeChannelId = 4;
      UI.uiState.activeChannel = customAnnounceCh;
      assert.equal(UI.shouldCollapseMessageForPeerBlock(blockedCustomAnnounceMsg, customAnnounceCh), false);
      const customAnnounceHtml = UI.buildMessageCardHtml(blockedCustomAnnounceMsg, alice, false);
      assert.ok(customAnnounceHtml.includes('Field closed due to rainout!'), 'Custom announcement boards must never suppress messages');

      // Moderator actions & system audit notices: NEVER suppressed
      UI.uiState.activeChannelId = 1;
      UI.uiState.activeChannel = generalCh;
      assert.equal(UI.shouldCollapseMessageForPeerBlock(modHiddenMsg, generalCh), false);
      const modHiddenHtml = UI.buildMessageCardHtml(modHiddenMsg, alice, true);
      assert.ok(modHiddenHtml.includes('Message hidden by Mod Carol'), 'Moderator hidden notice must never be suppressed');
      assert.ok(modHiddenHtml.includes('data-unhide-msg="105"'), 'Moderator Unhide action must remain visible');

      UI.uiState.activeChannelId = 2;
      UI.uiState.activeChannel = groupDmCh;
      assert.equal(UI.shouldCollapseMessageForPeerBlock(systemAuditMsg, groupDmCh), false);
      const sysHtml = UI.buildMessageCardHtml(systemAuditMsg, alice, false);
      assert.ok(sysHtml.includes('Bob rotated their E2EE identity key'), 'System audit notice must never be suppressed');

      // Search filtering must not surface collapsed blocked-peer messages
      UI.uiState.activeChannelId = 1;
      UI.uiState.activeChannel = generalCh;
      UI.uiState.revealedBlockedMsgIds = {};
      Store.state.messagesByChannel[1] = [
        blockedAuthorMsg,
        {
          id: 107,
          channel_id: 1,
          author_id: 33,
          author_name: 'Carol',
          author_role: 'member',
          content: 'Shared channel text from Carol',
          decrypted_content: 'Shared channel text from Carol',
          created_at: '2026-11-16T12:06:00Z'
        }
      ];
      UI.uiState.searchQuery = 'shared channel text';
      UI.renderMessageStream();
      const streamEl = sandbox.document.getElementById('ch-message-stream');
      assert.ok(streamEl.innerHTML.includes('Shared channel text from Carol'));
      assert.ok(!streamEl.innerHTML.includes('data-msg-id="101"'), 'Search must not surface collapsed blocked-peer stub');
      UI.uiState.searchQuery = '';
    });

    await t.test('3. Member UI block/unblock confirmation with PBFDialog & 403 PEER_BLOCKED graceful DM/Voice feedback', async () => {
      const enDict = loadApiEnDict();
      let blockPostCalled = false;
      let unblockDelCalled = false;
      const fetchMock = async (url, opts = {}) => {
        if (url === '/api/blocks' && opts.method === 'POST') {
          blockPostCalled = true;
          return {
            ok: true,
            status: 201,
            headers: { get: () => '' },
            text: async () => JSON.stringify({ success: true, blocked_id: 22, blocked_user_id: 22, blocked_user_ids: [22] })
          };
        }
        if (url === '/api/blocks/22' && opts.method === 'DELETE') {
          unblockDelCalled = true;
          return {
            ok: true,
            status: 200,
            headers: { get: () => '' },
            text: async () => JSON.stringify({ success: true, unblocked_id: 22, unblocked_user_id: 22, blocked_user_ids: [] })
          };
        }
        if (url === '/api/channels' && opts.method === 'POST') {
          return {
            ok: false,
            status: 403,
            headers: { get: () => '' },
            text: async () => JSON.stringify({ error: 'Direct messages are blocked between you and this member.', code: 'PEER_BLOCKED' })
          };
        }
        if (url === '/api/voice/99/join' && opts.method === 'POST') {
          return {
            ok: false,
            status: 403,
            headers: { get: () => '' },
            json: async () => ({ error: 'Voice calls are blocked between you and this member.', code: 'PEER_BLOCKED' })
          };
        }
        return { ok: true, status: 200, headers: { get: () => '' }, text: async () => '{}', json: async () => ({}) };
      };

      const { sandbox, elementsById, dialogs } = createUiSandbox({ enDict, fetchImpl: fetchMock });
      const Store = sandbox.ClubhouseStore;
      const UI = sandbox.ClubhouseUI;

      Store.state.user = { id: 10, name: 'Alice', role: 'member' };
      Store.state.members = [
        { id: 10, name: 'Alice', role: 'member' },
        { id: 22, name: 'Bob', role: 'member' }
      ];
      Store.state.blockedUserIds = [];

      // Render member directory with Block button
      UI.renderMembersDirectory();
      const dirHtml = elementsById['ch-members-directory'].innerHTML;
      assert.ok(dirHtml.includes('data-peer-block-uid="22"'), 'Members directory must render Block control');

      // Cancelling confirmation must NOT call POST /api/blocks
      dialogs.nextConfirmResult = false;
      await UI.confirmAndTogglePeerBlock(22, 'Bob');
      assert.equal(dialogs.confirms.length, 1);
      assert.equal(blockPostCalled, false);

      // Confirming block calls POST /api/blocks and shows toast feedback
      dialogs.nextConfirmResult = true;
      await UI.confirmAndTogglePeerBlock(22, 'Bob');
      assert.equal(blockPostCalled, true);
      assert.equal(Store.isPeerBlockedByMe(22), true);
      assert.ok(dialogs.toasts.some((tst) => tst.opts && tst.opts.type === 'success'), 'Blocking must show confirmation toast');

      // Re-rendered directory shows Blocked badge and Unblock button
      const blockedDirHtml = elementsById['ch-members-directory'].innerHTML;
      assert.ok(blockedDirHtml.includes('badge-blocked'), 'Blocked member must show Blocked badge');
      assert.ok(blockedDirHtml.includes('data-peer-block-active="1"'));

      // Confirming unblock calls DELETE /api/blocks/22
      await UI.confirmAndTogglePeerBlock(22, 'Bob');
      assert.equal(unblockDelCalled, true);
      assert.equal(Store.isPeerBlockedByMe(22), false);

      // 403 PEER_BLOCKED when opening 1:1 DM (e.g. peer blocked us) surfaces toast/alert cleanly
      const beforeAlerts = dialogs.alerts.length + dialogs.toasts.length;
      await UI.openOrCreateDmWithUser(22, 'Bob');
      assert.ok((dialogs.alerts.length + dialogs.toasts.length) > beforeAlerts, '403 PEER_BLOCKED on DM open must surface user feedback');

      // 403 PEER_BLOCKED when joining voice lounge surfaces user feedback
      const beforeVoiceAlerts = dialogs.alerts.length + dialogs.toasts.length;
      await UI.handleJoinVoiceLounge(99);
      assert.ok((dialogs.alerts.length + dialogs.toasts.length) > beforeVoiceAlerts, '403 PEER_BLOCKED on voice join must surface user feedback');
    });

    await t.test('4. 14-locale i18n parity for all EN_DICT keys including Peer Block strings', async () => {
      const enDict = loadApiEnDict();
      const enKeys = Object.keys(enDict);
      assert.ok(enKeys.some((k) => k.startsWith('clubhouse.peer_block_')), 'EN_DICT must include clubhouse.peer_block_* keys');
      const i18nDir = path.join(PUBLIC_DIR, 'i18n');
      const locales = ['ar', 'es', 'fa', 'fr', 'hi', 'hy', 'ja', 'ko', 'pa', 'pt', 'ru', 'tl', 'vi', 'zh'];
      for (const lang of locales) {
        const dict = JSON.parse(fs.readFileSync(path.join(i18nDir, `${lang}.json`), 'utf8'));
        const missing = enKeys.filter((k) => !(k in dict));
        assert.deepEqual(missing, [], `${lang}.json must contain all EN_DICT keys`);
      }
    });
  });
}

module.exports = registerPeerBlockUiTests;

if (require.main === module) {
  registerPeerBlockUiTests();
}
