// @ts-check
/**
 * @fileoverview Event Page — Orchestrator Entry Script (`event.js`).
 * URL/Invite Token Parsing, Zero-PII Offline Cache Read/Write, Event Data Loader,
 * Header Details & Native Share Event Control, and Authenticated Discussion Comments.
 * Connects `event/rsvp.js`, `event/organizer.js`, and `event/bp.js` to the DOM with zero `window.*` page exports.
 * Vanilla ES6 (no bundler, no optional chaining/nullish coalescing).
 *
 * TABLE OF CONTENTS:
 * 1. Node CommonJS Submodule Auto-Composition Bridge & Feature Flag Helpers
 * 2. URL/Invite Token Parsing, Zero-PII Cache & Event Loader (`initEvent`, `loadEventData`, `applyLoadedEventToDom`)
 * 3. Header Details, Weather Forecast & Native Share Event Control (`renderEventDetails`)
 * 4. Authenticated Discussion Comments & Moderation (`renderComments`, `deleteDiscussionComment`, `setupCommentForm`)
 * 5. CommonJS Test Export Bridge & DOM Boot
 */
(function () {
  'use strict';

  var root = typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this);
  if (!root) return;

  var API = root.API = root.API || /** @type {any} */ ({});
  /** @type {any} */
  var EventUI = API._eventUi = API._eventUi || {};
  var state = EventUI.state = EventUI.state || {
    eventId: /** @type {string|null} */ (null),
    visitorToken: '',
    inviteToken: '',
    eventData: /** @type {any} */ (null),
    eventPublicConfig: /** @type {any} */ (null)
  };

  // Auto-compose Event submodules when loaded directly via require() in Node CommonJS test environments
  if ((typeof window === 'undefined' || (typeof module !== 'undefined' && module.exports)) && typeof require === 'function' && typeof EventUI.renderAttendeesRoster !== 'function') {
    var eventSubmodules = ['./event/rsvp.js', './event/organizer.js', './event/bp.js'];
    for (var smIdx = 0; smIdx < eventSubmodules.length; smIdx++) {
      var smRel = eventSubmodules[smIdx];
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

  function el(id) {
    return typeof document !== 'undefined' ? /** @type {any} */ (document.getElementById(id)) : null;
  }

  function isBattingPracticeEnabled() {
    return API.isFeatureEnabled('battingPractice', state.eventPublicConfig);
  }

  function isCertifiedShiftsEnabled() {
    return API.isFeatureEnabled('certifiedShifts', state.eventPublicConfig);
  }

  function applyEventFeatureFlags() {
    var bpEnabled = isBattingPracticeEnabled();
    var bpMeta = el('event-bp-meta-item');
    if (bpMeta) bpMeta.style.display = bpEnabled ? '' : 'none';
    var bpSignupWrap = el('rsvp-bp-signup-wrap');
    if (bpSignupWrap) bpSignupWrap.style.display = bpEnabled ? '' : 'none';
    var bpSignupEl = /** @type {HTMLInputElement|null} */ (el('rsvp-bp-signup'));
    if (!bpEnabled && bpSignupEl) bpSignupEl.checked = false;
    var bpSection = el('bp-order-section');
    if (bpSection) bpSection.style.display = bpEnabled ? '' : 'none';
  }

  function showError(msg) {
    var loadingEl = el('event-loading');
    if (loadingEl) loadingEl.style.display = 'none';
    var errBox = el('event-error');
    if (errBox) {
      errBox.style.display = 'block';
      errBox.textContent = msg;
    }
  }

  function applyLoadedEventToDom(res, preserveAlertHtml) {
    state.eventData = res;
    if (res.user !== undefined) {
      API.renderNav(res.user);
    }
    applyEventFeatureFlags();
    renderEventDetails();
    if (typeof EventUI.renderAttendeesRoster === 'function') EventUI.renderAttendeesRoster();
    if (typeof EventUI.renderBpOrder === 'function') EventUI.renderBpOrder();
    renderComments();
    var rsvpStatePromise = typeof EventUI.setupRsvpState === 'function'
      ? EventUI.setupRsvpState(preserveAlertHtml)
      : Promise.resolve();
    if (typeof EventUI.renderOrganizerInvitePanel === 'function') EventUI.renderOrganizerInvitePanel();
    if (typeof EventUI.renderOrganizerRainoutPanel === 'function') EventUI.renderOrganizerRainoutPanel();
    if (typeof EventUI.renderOrganizerAttendancePanel === 'function') EventUI.renderOrganizerAttendancePanel();
    if (typeof EventUI.renderOrganizerAdminActions === 'function') EventUI.renderOrganizerAdminActions();

    var loadingEl = el('event-loading');
    if (loadingEl) loadingEl.style.display = 'none';
    var containerEl = el('event-container');
    if (containerEl) containerEl.style.display = 'block';

    return rsvpStatePromise;
  }

  async function loadEventData(preserveAlertHtml) {
    var cacheKey = 'pickup_cached_event_' + state.eventId;
    if (!preserveAlertHtml) {
      try {
        var cachedRaw = localStorage.getItem(cacheKey);
        if (cachedRaw) {
          var cachedRes = JSON.parse(cachedRaw);
          if (cachedRes && cachedRes.event && !cachedRes.event.is_restricted) {
            // Zero-PII contract: ensure no attendee, companion, comment, or my_rsvp PII in memory from cache
            cachedRes.attendees = [];
            cachedRes.waitlist = [];
            cachedRes.comments = [];
            cachedRes.bp_signups = [];
            delete cachedRes.myRsvp;
            delete cachedRes.my_rsvp;
            if (Array.isArray(cachedRes.duties)) {
              cachedRes.duties = cachedRes.duties.map(function (d) {
                return Object.assign({}, d, {
                  assigned_players: (d.assigned_players || []).map(function (p) {
                    return { attendee_id: p.attendee_id, name: '' };
                  })
                });
              });
            }
            applyLoadedEventToDom(cachedRes, false);
          }
        }
      } catch (e) { /* localStorage cache unavailable or invalid JSON */ }
    }

    try {
      var res = await API.getEvent(state.eventId, state.visitorToken, state.inviteToken);
      if (res.error) {
        try { localStorage.removeItem(cacheKey); } catch (e) { /* localStorage unavailable */ }
        showError(res.error);
        return;
      }

      if (!API.currentUser && state.visitorToken) {
        if (res.myRsvp) {
          try { localStorage.setItem('guest_token_' + state.eventId, state.visitorToken); } catch (e) { /* localStorage unavailable */ }
        } else {
          state.visitorToken = '';
          try { localStorage.removeItem('guest_token_' + state.eventId); } catch (e) { /* localStorage unavailable */ }
        }
      }

      try {
        if (res.event && res.event.is_restricted) {
          localStorage.removeItem(cacheKey);
        } else {
          // Cache only public non-restricted event fields without volunteer PII
          var publicCacheCopy = {
            event: res.event,
            duties: (res.duties || []).map(function (d) {
              return Object.assign({}, d, {
                assigned_players: (d.assigned_players || []).map(function (p) {
                  return { attendee_id: p.attendee_id, name: '' };
                })
              });
            }),
            attendees: [],
            waitlist: [],
            comments: [],
            bp_signups: [],
            totalAttendees: res.totalAttendees,
            totalSpectators: res.totalSpectators,
            totalHeadcount: res.totalHeadcount,
            require_login_to_rsvp: res.require_login_to_rsvp
          };
          localStorage.setItem(cacheKey, JSON.stringify(publicCacheCopy));
        }
      } catch (e) { /* storage quota / private mode */ }

      await applyLoadedEventToDom(res, preserveAlertHtml);
    } catch (err) {
      console.error('Error loading event:', err);
      if (!state.eventData) {
        showError('Unable to load event details. Please try again.');
      }
    }
  }

  function renderEventDetails() {
    var eventData = state.eventData;
    if (!eventData || !eventData.event) return;
    var ev = eventData.event;
    var titleEl = el('event-title');
    if (titleEl) titleEl.textContent = API.translateEventTitle(ev);
    var dtEl = el('event-datetime');
    if (dtEl) {
      dtEl.textContent = API.formatDateTime(ev.event_date);
    }
    var eventSubBtn = el('event-subscribe-ics-btn');
    var eventSubPanel = el('event-subscribe-panel');
    if (eventSubBtn && eventSubPanel) {
      var closeEventSub = function () {
        var panel = el('event-subscribe-panel');
        var btn = el('event-subscribe-ics-btn');
        if (panel) panel.style.display = 'none';
        if (btn) btn.setAttribute('aria-expanded', 'false');
      };
      if (eventSubPanel.style.display !== 'none') {
        API.renderSubscribePanel(eventSubPanel, {
          mode: 'game',
          event: ev,
          idPrefix: 'event',
          onClose: closeEventSub
        });
      }
      if (!eventSubBtn.dataset.cspBound) {
        eventSubBtn.dataset.cspBound = '1';
        eventSubBtn.addEventListener('click', function () {
          var curEv = state.eventData && state.eventData.event ? state.eventData.event : ev;
          var isOpen = eventSubPanel.style.display !== 'none';
          if (isOpen) {
            closeEventSub();
          } else {
            API.renderSubscribePanel(eventSubPanel, {
              mode: 'game',
              event: curEv,
              idPrefix: 'event',
              onClose: closeEventSub
            });
            eventSubPanel.style.display = 'block';
            eventSubBtn.setAttribute('aria-expanded', 'true');
          }
        });
      }
    }

    var eventShareBtn = el('event-share-btn');
    if (eventShareBtn && !eventShareBtn.dataset.cspBound) {
      eventShareBtn.dataset.cspBound = '1';
      eventShareBtn.addEventListener('click', function () {
        var curEv = state.eventData && state.eventData.event ? state.eventData.event : ev;
        var shareUrl = window.location.href;
        var shareTitle = (curEv && curEv.title) ? curEv.title : 'Sunday Pickup Baseball';
        var shareText = 'Check out this pickup baseball game: ' + shareTitle;
        var fallbackCopy = function () {
          if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            try {
              navigator.clipboard.writeText(shareUrl).catch(function () {});
            } catch (e) { /* ignore clipboard error */ }
          }
          if (root.PBFDialog && typeof root.PBFDialog.toast === 'function') {
            root.PBFDialog.toast(API.t('event.share_copied', 'Event link copied to clipboard!'), { type: 'success' });
          }
        };
        if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
          try {
            Promise.resolve(navigator.share({
              title: shareTitle,
              text: shareText,
              url: shareUrl
            })).catch(function (err) {
              if (!err || err.name !== 'AbortError') {
                fallbackCopy();
              }
            });
          } catch (err) {
            if (!err || err.name !== 'AbortError') {
              fallbackCopy();
            }
          }
        } else {
          fallbackCopy();
        }
      });
    }
    var locEl = el('event-location');
    if (locEl) locEl.textContent = ev.location;

    var statusBadge = el('event-status-badge');
    var rainoutBanner = el('rainout-banner');

    var existingRestrictedBadge = el('restricted-roster-badge');
    if (existingRestrictedBadge && typeof existingRestrictedBadge.remove === 'function') {
      existingRestrictedBadge.remove();
    }

    if (ev.status === 'rainout') {
      if (statusBadge) {
        statusBadge.className = 'badge badge-rainout';
        statusBadge.textContent = '🌧️ ' + API.t('event.rained_out_badge', 'Rained Out');
      }

      if (rainoutBanner) {
        rainoutBanner.style.display = 'block';
        rainoutBanner.innerHTML =
          '<div class="rainout-banner-inner">' +
            '<div class="rainout-icon">🌧️</div>' +
            '<div class="rainout-content">' +
              '<h2 class="rainout-title">Game Called Due to Rain &amp; Wet Field Conditions</h2>' +
              '<p class="rainout-subtitle">This game has been called for weather. Volunteer tasks and gear commitments are excused for today.</p>' +
              (ev.rainout_note ? (
                '<div class="rainout-note-box">' +
                  '<span class="rainout-note-label">Organizer Update:</span>' +
                  '<p class="rainout-note-text">"' + API.escapeHtml(ev.rainout_note) + '"</p>' +
                '</div>'
              ) : '') +
              (ev.rainout_at ? '<div class="rainout-timestamp">Called by organizer on ' + API.formatDateTime(ev.rainout_at) + '</div>' : '') +
            '</div>' +
          '</div>';
      }
    } else {
      if (statusBadge) {
        statusBadge.className = 'badge badge-green';
        statusBadge.textContent = ev.actual_attendance != null
          ? ('⚾ ' + API.t('home.players_played', { count: ev.actual_attendance }))
          : API.t('event.upcoming_badge', 'Upcoming Game');
      }
      if (rainoutBanner) {
        rainoutBanner.style.display = 'none';
        rainoutBanner.innerHTML = '';
      }
    }

    if (ev.is_restricted && statusBadge && typeof statusBadge.insertAdjacentHTML === 'function') {
      statusBadge.insertAdjacentHTML('afterend', ' <span id="restricted-roster-badge" class="badge badge-orange" style="display: inline-flex; align-items: center; gap: 4px;">🔒 Invited Roster</span>');
    }

    var mapLink = el('event-map-link');
    var safeMapUrl = API.safeUrl(ev.location_url);
    if (mapLink) {
      if (safeMapUrl) {
        mapLink.innerHTML = ' <a href="' + API.escapeHtml(safeMapUrl) + '" target="_blank" rel="noopener noreferrer" style="color: var(--primary); font-size: 0.85rem;">' + API.escapeHtml(API.t('event.open_map')) + '</a>';
      } else {
        mapLink.innerHTML = '';
      }
    }

    var rawDesc = ev.description || 'No special announcements for this pickup game. Bring your glove and enthusiasm!';
    var descEl = el('event-description');
    if (descEl) descEl.textContent = API.translatePhrase(rawDesc);

    var totalParticipants = eventData.totalAttendees != null ? eventData.totalAttendees : 0;
    var totalSpectators = eventData.totalSpectators != null ? eventData.totalSpectators : 0;

    var rosterLabel = typeof document !== 'undefined' && typeof document.querySelector === 'function'
      ? document.querySelector('[data-i18n="event.roster_count"]')
      : null;
    var attendeeCountEl = el('event-attendee-count');
    if (ev.actual_attendance != null) {
      if (rosterLabel) rosterLabel.textContent = API.t('event.actual_turnout', 'Actual Turnout');
      var subParts = [totalParticipants + ' online ' + (totalParticipants === 1 ? 'player' : 'players')];
      if (totalSpectators > 0) {
        subParts.push(totalSpectators + ' ' + (totalSpectators === 1 ? 'spectator' : 'spectators'));
      }
      if (attendeeCountEl) {
        attendeeCountEl.innerHTML =
          '<div style="display: flex; flex-direction: column;">' +
            '<span style="color: var(--secondary); font-size: 1.25rem; font-weight: 800; display: inline-flex; align-items: center; gap: 6px;">' +
              '<span>⚾</span> <span>' + API.escapeHtml(API.t('home.players_played', { count: ev.actual_attendance })) + '</span>' +
            '</span>' +
            '<span style="font-size: 0.78rem; font-weight: 500; color: var(--text-muted); margin-top: 2px;">' +
              '(' + API.escapeHtml(subParts.join(', ')) + ')' +
            '</span>' +
          '</div>';
      }
    } else {
      if (rosterLabel) rosterLabel.textContent = API.t('event.roster_count', 'Roster Count');
      if (attendeeCountEl) {
        if (totalSpectators > 0) {
          var totalAttendeesAll = totalParticipants + totalSpectators;
          attendeeCountEl.innerHTML =
            '<div style="display: flex; flex-direction: column; line-height: 1.2;">' +
              '<span>' + totalAttendeesAll + ' ' + (totalAttendeesAll === 1 ? 'Attendee' : 'Attendees') + '</span>' +
              '<span style="font-size: 0.78rem; font-weight: 600; color: var(--secondary); margin-top: 2px;">' +
                totalParticipants + ' ' + (totalParticipants === 1 ? 'Player' : 'Players') + ' + ' + totalSpectators + ' Non-Playing' +
              '</span>' +
            '</div>';
        } else {
          attendeeCountEl.textContent = API.t('home.players_count', { count: totalParticipants });
        }
      }
    }

    // Total tasks filled calculation
    var totalSlots = 0;
    var filledSlots = 0;
    (eventData.duties || []).forEach(function (d) {
      totalSlots += d.slots_needed;
      filledSlots += Math.min((d.assigned_players || []).length, d.slots_needed);
    });
    var pct = totalSlots > 0 ? Math.min(100, Math.round((filledSlots / totalSlots) * 100)) : 100;
    var dutiesStatusEl = el('event-duties-status');
    if (dutiesStatusEl) {
      dutiesStatusEl.innerHTML =
        '<div>' + API.escapeHtml(API.t('event.slots_filled', { filled: filledSlots, total: totalSlots })) + '</div>' +
        '<div class="duty-progress-track" title="' + pct + '%">' +
          '<div class="duty-progress-fill" style="width: ' + pct + '%;"></div>' +
        '</div>';
    }

    // Asynchronously load weather and Smart Rainout Assistant
    var weatherIcon = el('event-weather-icon');
    var weatherDisplay = el('event-weather-display');
    if (weatherDisplay && root.WeatherService && typeof root.WeatherService.getForecastForGame === 'function') {
      root.WeatherService.getForecastForGame(ev.event_date, ev.location).then(function (fc) {
        if (!fc || !fc.available) {
          if (weatherDisplay) {
            if (fc && fc.error) {
              weatherDisplay.innerHTML = '<span style="font-size: 0.84rem; color: var(--text-muted);">Weather forecast temporarily unavailable</span>';
            } else {
              weatherDisplay.innerHTML = '<span style="font-size: 0.84rem; color: var(--text-muted);">10-day forecast activates closer to game</span>';
            }
          }
          if (weatherIcon) weatherIcon.textContent = '📅';
          if (typeof root.WeatherService.renderAssistantWidget === 'function') {
            /** @type {any} */ (root.WeatherService).renderAssistantWidget('smart-rainout-widget', fc, { locationName: ev.location });
          }
          return;
        }

        if (weatherIcon) weatherIcon.textContent = fc.emoji;
        if (weatherDisplay) {
          weatherDisplay.innerHTML =
            '<div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">' +
              '<span style="font-weight: 800; color: var(--secondary); font-size: 1.05rem;">' + API.escapeHtml(fc.temperature) + '°F</span>' +
              '<span style="font-size: 0.82rem; color: var(--text-muted); font-weight: 600;">' + API.escapeHtml(fc.condition) + '</span>' +
              '<span class="badge ' + API.escapeHtml(fc.badgeClass) + '" style="font-size: 0.72rem; padding: 1px 6px;">' + API.escapeHtml(fc.statusLabel) + '</span>' +
            '</div>';
        }

        if (typeof root.WeatherService.renderAssistantWidget === 'function') {
          /** @type {any} */ (root.WeatherService).renderAssistantWidget('smart-rainout-widget', fc, { locationName: ev.location });
        }
      }).catch(function (err) {
        console.warn('Weather forecast fetch failed:', err);
        if (weatherDisplay) {
          weatherDisplay.innerHTML = '<span style="font-size: 0.84rem; color: var(--text-muted);">Weather forecast temporarily unavailable</span>';
        }
      });
    }
  }

  async function deleteDiscussionComment(commentId) {
    var ok = root.PBFDialog
      ? await root.PBFDialog.confirm('Delete this comment from the discussion board?', { danger: true })
      : false;
    if (!ok) return;
    try {
      var data = await API.deleteComment(state.eventId, commentId);
      if (data.error) {
        if (root.PBFDialog) root.PBFDialog.toast(data.error, { type: 'error' });
      } else {
        await loadEventData();
      }
    } catch (e) {
      if (root.PBFDialog) root.PBFDialog.toast('Failed to delete comment.', { type: 'error' });
    }
  }

  function renderComments() {
    var container = el('comments-container');
    var eventData = state.eventData;
    if (!container || !eventData) return;
    var comments = eventData.comments || [];

    if (!API.currentUser) {
      container.innerHTML =
        '<p style="color: var(--text-muted); font-style: italic;">' +
          '🔒 ' + API.escapeHtml(API.t('event.comments_members_only', 'Event discussion is visible to signed-in members only.')) +
        '</p>';
      return;
    }

    if (comments.length === 0) {
      container.innerHTML =
        '<p style="color: var(--text-muted); font-style: italic;">' +
          API.escapeHtml(API.t('event.no_comments_yet')) +
        '</p>';
      return;
    }

    var commentAbbr = API.abbreviateDisplayNames(comments, 'author_name', 'user_id', 'Player');
    container.innerHTML = comments.map(function (c, idx) {
      var authorDisplay = c.show_full_name ? (c.author_name || 'Player') : (commentAbbr[idx] || API.formatDisplayName(c.author_name, 'Player'));
      var safeAvatar = API.safeAvatarUrl(c.avatar_url);
      var avatarImg = safeAvatar
        ? '<img src="' + API.escapeHtml(safeAvatar) + '" alt="' + API.escapeHtml(authorDisplay) + '" class="comment-avatar" loading="lazy" decoding="async">'
        : '<span class="comment-avatar-placeholder">' + API.escapeHtml((authorDisplay || 'P').charAt(0).toUpperCase()) + '</span>';
      var canMod = Boolean(API.currentUser && API.currentUser.canManageEvents);

      return (
        '<div class="comment-bubble" style="display: flex; gap: 12px; align-items: flex-start;">' +
          avatarImg +
          '<div style="flex: 1; min-width: 0;">' +
            '<div class="comment-header">' +
              '<div>' +
                '<span class="comment-author">' + API.escapeHtml(authorDisplay) + '</span>' +
                (c.bio ? '<span style="font-size: 0.75rem; color: var(--text-muted); font-style: italic; margin-left: 6px;">• ' + API.escapeHtml(c.bio) + '</span>' : '') +
              '</div>' +
              '<div style="display: flex; gap: 8px; align-items: center;">' +
                '<span class="comment-time">' + API.formatDateTime(c.created_at) + '</span>' +
                (canMod ? '<button type="button" data-action="delete-comment" data-comment-id="' + c.id + '" title="Delete comment" style="background:none;border:none;cursor:pointer;font-size:0.85rem;color:var(--danger);padding:0 2px;">🗑️</button>' : '') +
              '</div>' +
            '</div>' +
            '<div class="comment-body">' + API.escapeHtml(c.content) + '</div>' +
          '</div>' +
        '</div>'
      );
    }).join('');

    if (!container.dataset.cspBound) {
      container.dataset.cspBound = '1';
      container.addEventListener('click', function (e) {
        var target = /** @type {HTMLElement|null} */ (e.target);
        if (!target || typeof target.closest !== 'function') return;
        var btn = /** @type {HTMLElement|null} */ (target.closest('[data-action="delete-comment"]'));
        if (!btn || (container.contains && !container.contains(btn))) return;
        deleteDiscussionComment(parseInt(btn.dataset.commentId || '0', 10));
      });
    }
  }

  function setupCommentForm() {
    var form = el('comment-form');
    if (!form) return;
    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      var submitBtn = /** @type {HTMLButtonElement|null} */ (el('comment-submit-btn'));
      var contentEl = /** @type {HTMLTextAreaElement|null} */ (el('comment-content'));
      var content = contentEl ? contentEl.value : '';
      var authorNameEl = /** @type {HTMLInputElement|null} */ (el('comment-author-name'));
      var authorEmailEl = /** @type {HTMLInputElement|null} */ (el('comment-author-email'));
      var authorName = authorNameEl ? authorNameEl.value : '';
      var authorEmail = authorEmailEl ? authorEmailEl.value : '';

      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Posting...';
      }

      try {
        var res = await API.postComment(state.eventId, {
          content: content,
          author_name: authorName,
          author_email: authorEmail
        });

        if (res.error) {
          if (root.PBFDialog) root.PBFDialog.toast(res.error, { type: 'error' });
        } else {
          if (contentEl) contentEl.value = '';
          await loadEventData();
        }
      } catch (err) {
        if (root.PBFDialog) root.PBFDialog.toast('Error posting comment.', { type: 'error' });
      } finally {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Post to Discussion';
        }
      }
    });
  }

  async function initEvent() {
    var params = new URLSearchParams(window.location.search);
    var rawEventId = params.get('id');
    state.eventId = (rawEventId && /^\d+$/.test(rawEventId.trim())) ? rawEventId.trim() : null;
    var storedVisitorToken = '';
    try {
      storedVisitorToken = state.eventId ? (localStorage.getItem('guest_token_' + state.eventId) || '') : '';
    } catch (e) { /* localStorage unavailable */ }
    state.visitorToken = params.get('token') || storedVisitorToken || '';
    state.inviteToken = params.get('invite') || '';

    if (params.has('token') && typeof window.history !== 'undefined' && typeof window.history.replaceState === 'function') {
      try {
        var cleanUrl = new URL(window.location.href);
        cleanUrl.searchParams.delete('token');
        window.history.replaceState({}, document.title, cleanUrl.pathname + cleanUrl.search + cleanUrl.hash);
      } catch (e) { /* best-effort URL token strip */ }
    }

    if (!state.eventId) {
      showError('Invalid or missing event ID in URL.');
      return;
    }

    // Instant 0ms nav + cached event render on low-signal mobile connections
    var cachedUser = API.getCachedUser();
    if (cachedUser) {
      API.currentUser = cachedUser;
      API.renderNav(cachedUser);
    } else {
      API.renderNav(null);
    }

    window.addEventListener('pickup:langchange', function () {
      if (state.eventData && state.eventData.event) {
        renderEventDetails();
        if (typeof EventUI.renderAttendeesRoster === 'function') EventUI.renderAttendeesRoster();
        if (typeof EventUI.renderBpOrder === 'function') EventUI.renderBpOrder();
        renderComments();
        if (typeof EventUI.setupRsvpState === 'function') EventUI.setupRsvpState();
      }
    });

    if (typeof EventUI.setupRsvpForm === 'function') EventUI.setupRsvpForm();
    if (typeof EventUI.setupEditLinkForm === 'function') EventUI.setupEditLinkForm();
    setupCommentForm();
    if (typeof EventUI.setupBpOrderUi === 'function') EventUI.setupBpOrderUi();
    var configPromise = typeof API.getPublicConfig === 'function'
      ? API.getPublicConfig().then(function (cfg) {
          state.eventPublicConfig = cfg;
          applyEventFeatureFlags();
        }).catch(function () {})
      : Promise.resolve();
    await Promise.all([configPromise, loadEventData()]);
    applyEventFeatureFlags();
  }

  EventUI.isBattingPracticeEnabled = isBattingPracticeEnabled;
  EventUI.isCertifiedShiftsEnabled = isCertifiedShiftsEnabled;
  EventUI.applyEventFeatureFlags = applyEventFeatureFlags;
  EventUI.showError = showError;
  EventUI.applyLoadedEventToDom = applyLoadedEventToDom;
  EventUI.loadEventData = loadEventData;
  EventUI.renderEventDetails = renderEventDetails;
  EventUI.renderComments = renderComments;
  EventUI.deleteDiscussionComment = deleteDiscussionComment;
  EventUI.setupCommentForm = setupCommentForm;
  EventUI.initEvent = initEvent;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = EventUI;
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', initEvent);
  }
})();
