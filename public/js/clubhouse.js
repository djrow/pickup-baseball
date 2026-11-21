// @ts-check
/**
 * @fileoverview Pickup Baseball Clubhouse — Orchestrator Entry Script (`clubhouse.js`).
 * Connects `ClubhouseStore`, `ClubhouseCrypto`, `ClubhouseRTC`, and the 4 Clubhouse UI submodules
 * (`clubhouse/layout.js`, `clubhouse/messages.js`, `clubhouse/e2ee-ui.js`, `clubhouse/panels.js`)
 * to the DOM with zero `window.*` page exports.
 * Vanilla ES6 (no bundler, no optional chaining/nullish coalescing).
 *
 * TABLE OF CONTENTS:
 * 1. Node CommonJS Submodule Auto-Composition Bridge
 * 2. Unified DOM Event Wiring (`initDomEvents`)
 * 3. Lazy i18n Surface Loading, Store/RTC Subscriptions & Application Boot (`initClubhouseApp`)
 * 4. CommonJS Test Export Bridge (zero `window.*` exports)
 */
(function () {
  'use strict';

  var root = typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this);
  if (!root) return;

  var Store = root.ClubhouseStore = root.ClubhouseStore || /** @type {any} */ ({ state: {} });
  /** @type {any} */
  var UI = Store._ui = Store._ui || {};

  // Auto-compose Clubhouse UI submodules when loaded directly via require() in Node CommonJS test environments
  if ((typeof window === 'undefined' || (typeof module !== 'undefined' && module.exports)) && typeof require === 'function' && typeof UI.renderMessageStream !== 'function') {
    var uiSubmodules = ['./clubhouse/layout.js', './clubhouse/messages.js', './clubhouse/e2ee-ui.js', './clubhouse/panels.js'];
    for (var smIdx = 0; smIdx < uiSubmodules.length; smIdx++) {
      var smRel = uiSubmodules[smIdx];
      try {
        var resolvedPath = require.resolve(smRel);
        if (require.cache && require.cache[resolvedPath]) {
          delete require.cache[resolvedPath];
        }
      } catch (e) { /* ignore resolve errors */ }
      try {
        require(smRel);
      } catch (e) { /* ignore in non-Node contexts */ }
    }
  }

  var uiState = UI.uiState;
  var el = UI.el;
  var tClubhouse = UI.tClubhouse;

  function initDomEvents() {
    if (typeof UI.initLayoutDomEvents === 'function') UI.initLayoutDomEvents();
    if (typeof UI.initMessagesDomEvents === 'function') UI.initMessagesDomEvents();
    if (typeof UI.initE2eeUiDomEvents === 'function') UI.initE2eeUiDomEvents();
    if (typeof UI.initPanelsDomEvents === 'function') UI.initPanelsDomEvents();
  }

  function initClubhouseApp() {
    if (typeof document === 'undefined' || !el || !el('clubhouse-app')) return;

    var RtcEngine = root.ClubhouseRTC;

    if (typeof window !== 'undefined' && window.API && typeof window.API.loadSurfaceDict === 'function') {
      if (!window.API.activeSurfaces) window.API.activeSurfaces = [];
      if (window.API.activeSurfaces.indexOf('clubhouse') === -1) {
        window.API.activeSurfaces.push('clubhouse');
      }
      window.API.loadSurfaceDict('clubhouse').then(function () {
        if (typeof window.API.applyTranslations === 'function') {
          window.API.applyTranslations(el('clubhouse-app'));
        }
      }).catch(function () {});
    }

    initDomEvents();

    Store.subscribe(function (eventType, detail) {
      if (eventType === 'bootstrapped' || eventType === 'bootstrap_cached') {
        var authBanner = el('ch-auth-banner');
        if (authBanner) {
          if (Store.state.user) {
            authBanner.classList.add('hidden');
          } else {
            authBanner.classList.remove('hidden');
          }
        }
        UI.renderUserBar();
        UI.renderChannelSidebar();
        UI.renderMembersDirectory();
        if (uiState.upcomingData) {
          UI.renderUpcomingEventCard(uiState.upcomingData);
        }
        if (!uiState.activeChannelId && Store.state.channels.length > 0) {
          var general = null;
          for (var i = 0; i < Store.state.channels.length; i++) {
            if (Store.state.channels[i].slug === 'general') {
              general = Store.state.channels[i];
              break;
            }
          }
          UI.selectTextChannel((general || Store.state.channels[0]).id);
        } else if (eventType === 'bootstrapped' && uiState.activeChannelId) {
          uiState.activeChannel = UI.findChannelInStore(uiState.activeChannelId) || uiState.activeChannel;
          if (typeof UI.refreshComposerPlaceholder === 'function') UI.refreshComposerPlaceholder(uiState.activeChannel);
          if (typeof UI.refreshDmE2eeNotice === 'function') UI.refreshDmE2eeNotice(uiState.activeChannel);
          if (typeof UI.refreshVerifyKeyButton === 'function') UI.refreshVerifyKeyButton(uiState.activeChannel);
          UI.renderMessageStream(null);
        }
      } else if (eventType === 'auth_required') {
        var authWarn = el('ch-auth-banner');
        if (authWarn) authWarn.classList.remove('hidden');
        UI.clearSignedOutUi();
        if (uiState.upcomingData) {
          UI.renderUpcomingEventCard(uiState.upcomingData);
        }
      } else if (eventType === 'public_channels_loaded') {
        var pubAuthWarn = el('ch-auth-banner');
        if (pubAuthWarn && !Store.state.user) pubAuthWarn.classList.remove('hidden');
        UI.renderUserBar();
        UI.renderChannelSidebar();
        UI.renderMembersDirectory();
        if (!uiState.activeChannelId && Store.state.channels.length > 0) {
          UI.selectTextChannel(Store.state.channels[0].id);
        }
      } else if (eventType === 'messages_loaded') {
        UI.renderChannelSidebar();
        UI.renderMessageStream(null);
      } else if (eventType === 'delta_messages') {
        UI.renderChannelSidebar();
        UI.renderMessageStream({ appendOnly: true });
      } else if (eventType === 'sync_tick') {
        if (detail && Array.isArray(detail.events) && detail.events.length > 0) {
          UI.renderChannelSidebar();
          UI.renderMessageStream(null);
        }
      } else if (eventType === 'channel_created' || eventType === 'channel_updated') {
        UI.renderChannelSidebar();
        if (detail && Number(detail.id) === Number(uiState.activeChannelId)) {
          uiState.activeChannel = detail;
          var topicHdr = el('ch-active-channel-topic');
          if (topicHdr) topicHdr.textContent = detail.topic || 'Community coordination & chat';
        }
      } else if (eventType === 'channel_deleted') {
        UI.renderChannelSidebar();
        var deletedChId = Number((detail && (detail.channelId || detail.id)) || 0);
        if (deletedChId && deletedChId === Number(uiState.activeChannelId)) {
          if (Store.state.channels.length > 0) {
            var nextCh = null;
            for (var nc = 0; nc < Store.state.channels.length; nc++) {
              if (Store.state.channels[nc].slug === 'general') {
                nextCh = Store.state.channels[nc];
                break;
              }
            }
            UI.selectTextChannel((nextCh || Store.state.channels[0]).id);
          } else {
            uiState.activeChannelId = null;
            uiState.activeChannel = null;
            UI.renderMessageStream(null);
          }
        }
      } else if (eventType === 'sync_message_hide' || eventType === 'sync_message_unhide') {
        UI.renderMessageStream(null);
        if (uiState.activeThreadRoot) {
          UI.loadThreadReplies(uiState.activeThreadRoot.id);
        }
      } else if (eventType === 'user_mute_updated') {
        UI.renderUserBar();
        UI.renderChannelSidebar();
        UI.renderMembersDirectory();
      } else if (eventType === 'personal_mutes_changed') {
        UI.renderMessageStream(null);
        UI.renderMembersDirectory();
        UI.renderVoiceVideoTiles();
      } else if (eventType === 'peer_blocks_changed') {
        UI.renderMembersDirectory();
        UI.renderMessageStream(null);
        UI.renderVoiceVideoTiles();
        UI.refreshDmE2eeNotice(null);
        if (uiState.activeThreadRoot) {
          UI.loadThreadReplies(uiState.activeThreadRoot.id);
        }
      } else if (eventType === 'member_opt_changed') {
        UI.renderUserBar();
        UI.renderChannelSidebar();
        UI.renderMembersDirectory();
        if (uiState.activeChannelId) {
          Store.fetchChannelMessages(uiState.activeChannelId).then(function () {
            UI.renderMessageStream(null);
          }).catch(function () {});
        }
      } else if (eventType === 'key_rotated') {
        UI.refreshVerifyKeyButton(null);
        UI.refreshDmE2eeNotice(null);
        UI.renderMembersDirectory();
        UI.renderMessageStream(null);
      } else if (eventType === 'user_erased') {
        var erasedUid = Number((detail && detail.userId) || 0);
        if (uiState.activeThreadRoot && erasedUid && Number(uiState.activeThreadRoot.author_id) === erasedUid) {
          uiState.activeThreadRoot = null;
          UI.switchContextTab('sunday');
        } else if (uiState.activeThreadRoot) {
          UI.loadThreadReplies(uiState.activeThreadRoot.id);
        }
        UI.renderChannelSidebar();
        UI.renderMembersDirectory();
        UI.renderMessageStream(null);
        UI.renderVoiceVideoTiles();
        UI.refreshVerifyKeyButton(null);
        UI.refreshDmE2eeNotice(null);
      } else if (eventType === 'rtc_signals' && RtcEngine) {
        RtcEngine.handleIncomingSignals(detail);
      }
    });

    if (RtcEngine && typeof RtcEngine.onRtcEvent === 'function') {
      RtcEngine.onRtcEvent(function (evType, detail, rtcState) {
        if (!evType) return;
        if (evType === 'typing_update') {
          var typingEl = el('ch-typing-indicator');
          if (!typingEl) return;
          var typingMap = (rtcState && rtcState.typingUsersByChannel) ? rtcState.typingUsersByChannel : (RtcEngine.state && RtcEngine.state.typingUsersByChannel);
          var chMap = (typingMap && uiState.activeChannelId) ? typingMap[uiState.activeChannelId] : null;
          var names = [];
          var now = Date.now();
          if (chMap) {
            var uids = Object.keys(chMap);
            for (var i = 0; i < uids.length; i++) {
              var entry = chMap[uids[i]];
              if (entry && (!entry.expiresAt || entry.expiresAt > now) && entry.userName) {
                names.push(entry.userName);
              }
            }
          }
          typingEl.textContent = names.length > 0 ? (names.join(', ') + ' is typing...') : '';
        } else if (evType === 'remote_stream' && detail && detail.userId && detail.stream) {
          uiState.remoteStreams[detail.userId] = detail.stream;
          UI.renderVoiceVideoTiles();
        } else if (evType === 'remote_stream_removed' && detail && detail.userId) {
          delete uiState.remoteStreams[detail.userId];
          UI.renderVoiceVideoTiles();
        } else if (evType === 'voice_left') {
          uiState.remoteStreams = {};
          UI.renderVoiceVideoTiles();
        } else if (evType === 'speaking_update') {
          UI.renderChannelSidebar();
          UI.renderVoiceVideoTiles();
        } else if (evType === 'privacy_relay_unavailable') {
          var mediaStage = el('ch-media-stage');
          if (mediaStage) {
            var warnEl = el('ch-rtc-relay-warning');
            if (!warnEl) {
              warnEl = document.createElement('div');
              warnEl.id = 'ch-rtc-relay-warning';
              warnEl.style.cssText = 'margin:6px 0;padding:8px 10px;border-radius:6px;background:rgba(245,158,11,0.14);border:1px solid rgba(245,158,11,0.45);color:#fbbf24;font-size:12px;';
              mediaStage.insertBefore(warnEl, mediaStage.firstChild);
            }
            warnEl.textContent = tClubhouse(
              'rtc_turn_blocked_warning',
              'Privacy Relay Mode blocked direct P2P voice because no TURN relay server is configured.'
            );
          }
        } else if (evType === 'turn_config_updated') {
          UI.syncPrivacyRelayToggleUi();
        } else if (evType === 'peer_blocked' && detail && detail.message) {
          UI.showPeerBlockedFeedback(detail.message);
        }
      });
    }

    UI.initClubhouseTheme();
    UI.initQuickSiteNav();

    if (typeof window !== 'undefined' && window.API && typeof window.API.getPublicConfig === 'function') {
      window.API.getPublicConfig().then(function (cfg) {
        uiState.publicConfig = cfg;
        if (RtcEngine && typeof RtcEngine.setTurnConfigured === 'function') {
          RtcEngine.setTurnConfigured(Boolean(cfg && cfg.turnConfigured));
        }
        if (cfg && cfg.turnConfigured && RtcEngine && typeof RtcEngine.loadIceServers === 'function' && Store && Store.state && Store.state.user) {
          RtcEngine.loadIceServers();
        }
        UI.syncPrivacyRelayToggleUi();
        if (uiState.upcomingData) {
          UI.renderUpcomingEventCard(uiState.upcomingData);
        } else if (!UI.isClubhouseBpEnabled()) {
          var bpCard = el('ch-bp-card');
          if (bpCard) bpCard.classList.add('hidden');
        }
        UI.renderMessageStream(null);
      }).catch(function () {});
    }

    Store.bootstrap().then(function () {
      UI.loadUpcomingEventCard();
    }).catch(function () {
      var authFallback = el('ch-auth-banner');
      if (authFallback && !Store.state.user) authFallback.classList.remove('hidden');
      if (!Store.state.user) {
        UI.clearSignedOutUi();
      } else {
        UI.renderUserBar();
      }
      UI.loadUpcomingEventCard();
    });

    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('storage', function (ev) {
        if (ev && ev.key === 'pickup_cached_user' && !ev.newValue && Store.state.user) {
          Store.clearLocalSessionData();
          UI.clearSignedOutUi();
        }
      });
    }
  }

  var ClubhouseUI = {
    uiState: uiState,
    isClubhouseTurnConfigured: UI.isClubhouseTurnConfigured,
    syncPrivacyRelayToggleUi: UI.syncPrivacyRelayToggleUi,
    shouldCollapseMessageForPeerBlock: UI.shouldCollapseMessageForPeerBlock,
    buildMessageCardHtml: UI.buildMessageCardHtml,
    renderMessageStream: UI.renderMessageStream,
    renderMembersDirectory: UI.renderMembersDirectory,
    confirmAndTogglePeerBlock: UI.confirmAndTogglePeerBlock,
    openOrCreateDmWithUser: UI.openOrCreateDmWithUser,
    handleJoinVoiceLounge: UI.handleJoinVoiceLounge,
    setPublicConfig: function (cfg) {
      var RtcEngine = root.ClubhouseRTC;
      uiState.publicConfig = cfg;
      if (RtcEngine && typeof RtcEngine.setTurnConfigured === 'function') {
        RtcEngine.setTurnConfigured(Boolean(cfg && cfg.turnConfigured));
      }
      if (typeof UI.syncPrivacyRelayToggleUi === 'function') {
        UI.syncPrivacyRelayToggleUi();
      }
    }
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = ClubhouseUI;
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initClubhouseApp);
    } else {
      initClubhouseApp();
    }
  }
})();
