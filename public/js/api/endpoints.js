// @ts-check
/**
 * @fileoverview Domain API Wrappers, Pacific Formatters, Calendar Sync & Media Sanitizers for Pickup Baseball Foundation.
 * Vanilla ES6 (no bundler, no optional chaining/nullish coalescing).
 *
 * @global API
 */

(function () {
  'use strict';

  var root = typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this);
  if (!root) return;

  var API = root.API = root.API || {};

  // ==========================================
  // Domain API Wrappers
  // ==========================================

  API.getPosts = function () {
    return this.request('GET', '/api/posts', null, {
      noStore: true, throwOnError: true, errorMsg: 'Failed to load community highlights.'
    });
  };

  API.createPost = function (payload) {
    return this.request('POST', '/api/posts', payload || {}, {
      throwOnError: true, errorMsg: 'Failed to publish post.'
    });
  };

  API.deletePost = function (id) {
    return this.request('DELETE', '/api/posts/' + encodeURIComponent(id), null, {
      throwOnError: true, errorMsg: 'Failed to delete post.'
    });
  };

  API.getMedia = function (params) {
    var p = params || {};
    var q = new URLSearchParams();
    if (p.type) q.set('type', p.type);
    if (p.album) q.set('album', p.album);
    if (p.order) q.set('order', p.order);
    if (p.status) q.set('status', p.status);
    var qs = q.toString() ? '?' + q.toString() : '';
    return this.request('GET', '/api/media' + qs, null, {
      noStore: true, throwOnError: true, errorMsg: 'Failed to load community gallery.'
    });
  };

  API.submitMedia = function (payload) {
    return this.request('POST', '/api/media', payload || {}, {
      throwOnError: true, errorMsg: 'Failed to submit media.'
    });
  };

  API.approveMedia = function (id) {
    return this.request('PUT', '/api/media/' + encodeURIComponent(id) + '/approve', null, {
      throwOnError: true, errorMsg: 'Failed to approve media item.'
    });
  };

  API.updateMedia = function (id, payload) {
    return this.request('PUT', '/api/media/' + encodeURIComponent(id), payload || {}, {
      throwOnError: true, errorMsg: 'Failed to update media item.'
    });
  };

  API.deleteMedia = function (id, token) {
    var headers = {};
    if (token) headers['X-Delete-Token'] = token;
    var qs = token ? '?token=' + encodeURIComponent(token) : '';
    return this.request('DELETE', '/api/media/' + encodeURIComponent(id) + qs, null, {
      headers: headers,
      throwOnError: true,
      errorMsg: 'Failed to delete media item.'
    });
  };

  API.getEvents = function (filter) {
    var filterVal = filter !== undefined ? filter : 'upcoming';
    return this.request('GET', '/api/events?filter=' + encodeURIComponent(filterVal), null, {
      noStore: true, throwOnError: true, errorMsg: 'Failed to sync schedule with cloud.'
    }).then(function (data) {
      if (data && data.user !== undefined) {
        API.currentUser = data.user || null;
        if (typeof API.setCachedUser === 'function') {
          API.setCachedUser(API.currentUser);
        }
      }
      return data;
    });
  };

  API.getEvent = function (id, token) {
    var safeId = encodeURIComponent(id);
    var tokenVal = token || '';
    var url = '/api/events/' + safeId + (tokenVal ? '?token=' + encodeURIComponent(tokenVal) : '');
    return this.request('GET', url).then(function (data) {
      if (data && data.user !== undefined) {
        API.currentUser = data.user || null;
        if (typeof API.setCachedUser === 'function') {
          API.setCachedUser(API.currentUser);
        }
      }
      return data;
    });
  };

  API.postRsvp = function (id, payload) {
    return this.request('POST', '/api/events/' + encodeURIComponent(id) + '/rsvp', payload, {
      invalidateKeys: ['pickup_cached_event_' + id, 'pickup_cached_events_upcoming', 'pickup_cached_events_all']
    });
  };

  API.requestRsvpEditLink = function (id, email) {
    return this.request('POST', '/api/events/' + encodeURIComponent(id) + '/rsvp/edit-link', {
      email: email
    });
  };

  API.postComment = function (id, payload) {
    return this.request('POST', '/api/events/' + encodeURIComponent(id) + '/comments', payload, {
      invalidateKeys: ['pickup_cached_event_' + id]
    });
  };

  API.deleteComment = function (eventId, commentId) {
    return this.request('DELETE', '/api/events/' + encodeURIComponent(eventId) + '/comments/' + encodeURIComponent(commentId), null, {
      invalidateKeys: ['pickup_cached_event_' + eventId]
    });
  };

  API.removeAttendee = function (eventId, attendeeId) {
    return this.request('DELETE', '/api/events/' + encodeURIComponent(eventId) + '/attendees/' + encodeURIComponent(attendeeId), null, {
      invalidateKeys: ['pickup_cached_event_' + eventId, 'pickup_cached_events_upcoming', 'pickup_cached_events_all']
    });
  };

  API.callRainout = function (id, payload) {
    return this.request('POST', '/api/events/' + encodeURIComponent(id) + '/rainout', payload || {}, {
      invalidateKeys: ['pickup_cached_event_' + id, 'pickup_cached_events_upcoming', 'pickup_cached_events_all']
    });
  };

  API.reopenEvent = function (id, payload) {
    return this.request('POST', '/api/events/' + encodeURIComponent(id) + '/reopen', payload || {}, {
      invalidateKeys: ['pickup_cached_event_' + id, 'pickup_cached_events_upcoming', 'pickup_cached_events_all']
    });
  };

  API.sendRainoutEmail = function (id, payload) {
    return this.request('POST', '/api/events/' + encodeURIComponent(id) + '/send-rainout-email', payload || {});
  };

  API.sendReminders = function (id) {
    return this.request('POST', '/api/events/' + encodeURIComponent(id) + '/send-reminders');
  };

  API.getBpOrder = function (eventId, token) {
    var tokenVal = token || '';
    var url = '/api/events/' + encodeURIComponent(eventId) + '/bp-order' + (tokenVal ? '?token=' + encodeURIComponent(tokenVal) : '');
    return this.request('GET', url);
  };

  API.postBpSignup = function (eventId, payload) {
    return this.request('POST', '/api/events/' + encodeURIComponent(eventId) + '/bp-order', payload, {
      invalidateKeys: ['pickup_cached_event_' + eventId]
    });
  };

  API.updateBpSignup = function (eventId, signupId, payload) {
    return this.request('PUT', '/api/events/' + encodeURIComponent(eventId) + '/bp-order/' + encodeURIComponent(signupId), payload, {
      invalidateKeys: ['pickup_cached_event_' + eventId]
    });
  };

  API.deleteBpSignup = function (eventId, signupId, payload) {
    return this.request('DELETE', '/api/events/' + encodeURIComponent(eventId) + '/bp-order/' + encodeURIComponent(signupId), payload || {}, {
      invalidateKeys: ['pickup_cached_event_' + eventId]
    });
  };

  API.clearBpOrder = function (eventId) {
    return this.request('POST', '/api/events/' + encodeURIComponent(eventId) + '/bp-order/clear', {}, {
      invalidateKeys: ['pickup_cached_event_' + eventId]
    });
  };

  API.sendLoginCode = function (email, name, sharedDevice) {
    return this.request('POST', '/api/auth/send-code', {
      email: email,
      name: name !== undefined ? name : '',
      shared_device: Boolean(sharedDevice)
    });
  };

  API.verifyLoginCode = function (email, code, sharedDevice) {
    var payload = { email: email, code: code };
    if (sharedDevice !== undefined) {
      payload.shared_device = Boolean(sharedDevice);
    }
    return this.request('POST', '/api/auth/verify-code', payload);
  };

  API.getActiveSessions = function () {
    return this.request('GET', '/api/auth/sessions', null, { noStore: true });
  };

  API.logoutOtherDevices = function () {
    return this.request('POST', '/api/auth/logout-other-devices', {});
  };

  API.exportMyData = function () {
    return this.request('GET', '/api/auth/export', null, { noStore: true });
  };

  API.updateProfile = function updateProfile(name, bio, extra) {
    var payload = { name: name, bio: bio };
    if (extra && typeof extra === 'object') {
      Object.keys(extra).forEach(function (k) {
        if (extra[k] !== undefined) {
          payload[k] = extra[k];
        }
      });
    }
    return this.request('PUT', '/api/auth/profile', payload);
  };

  API.getConsent = function () {
    return this.request('GET', '/api/auth/consent', null, { noStore: true });
  };

  API.updateConsent = function (payload) {
    return this.request('PUT', '/api/auth/consent', payload || {});
  };

  API.setClubhouseOptIn = function (optedIn) {
    return this.request('PUT', '/api/auth/clubhouse-opt-in', { opted_in: Boolean(optedIn) });
  };

  API.uploadAvatar = function (file) {
    var formData = new FormData();
    formData.append('avatar', file);
    return this.request('POST', '/api/auth/avatar', formData);
  };

  API.deleteAvatar = function () {
    return this.request('DELETE', '/api/auth/avatar');
  };

  API.getDefaultDuties = function () {
    return this.request('GET', '/api/events/default-duties');
  };

  API.saveDefaultDuties = function (duties) {
    return this.request('PUT', '/api/events/default-duties', { duties: duties });
  };

  API.createEvent = function (payload) {
    return this.request('POST', '/api/events', payload, {
      invalidateKeys: ['pickup_cached_events_upcoming', 'pickup_cached_events_all']
    });
  };

  API.updateEvent = function (id, payload) {
    return this.request('PUT', '/api/events/' + encodeURIComponent(id), payload, {
      invalidateOnSuccess: true,
      invalidateKeys: [
        'pickup_cached_event_' + id,
        'pickup_cached_events_upcoming',
        'pickup_cached_events_past',
        'pickup_cached_events_all'
      ]
    });
  };

  API.deleteEvent = function (id) {
    return this.request('DELETE', '/api/events/' + encodeURIComponent(id), null, {
      invalidateOnSuccess: true,
      invalidateKeys: [
        'pickup_cached_event_' + id,
        'pickup_cached_events_upcoming',
        'pickup_cached_events_past',
        'pickup_cached_events_all'
      ]
    });
  };

  API.addDuty = function (eventId, payload) {
    return this.request('POST', '/api/events/' + encodeURIComponent(eventId) + '/duties', payload, {
      invalidateKeys: ['pickup_cached_event_' + eventId]
    });
  };

  API.updateDuty = function (eventId, dutyId, payload) {
    return this.request('PUT', '/api/events/' + encodeURIComponent(eventId) + '/duties/' + encodeURIComponent(dutyId), payload, {
      invalidateKeys: ['pickup_cached_event_' + eventId]
    });
  };

  API.deleteDuty = function (eventId, dutyId) {
    return this.request('DELETE', '/api/events/' + encodeURIComponent(eventId) + '/duties/' + encodeURIComponent(dutyId), null, {
      invalidateKeys: ['pickup_cached_event_' + eventId]
    });
  };

  API.getAttendeeCandidates = function () {
    return this.request('GET', '/api/events/attendee-candidates');
  };

  API.getUsers = function () {
    return this.request('GET', '/api/auth/users');
  };

  API.updateUserRole = function (userId, role) {
    return this.request('PUT', '/api/auth/users/' + encodeURIComponent(userId) + '/role', { role: role });
  };

  API.updateUserBadges = function (userId, badges) {
    return this.request('PUT', '/api/auth/users/' + encodeURIComponent(userId) + '/badges', badges);
  };

  API.updateUserModerator = function (userId, isModerator) {
    return this.request('PUT', '/api/auth/users/' + encodeURIComponent(userId) + '/moderator', { is_moderator: Boolean(isModerator) });
  };

  API.muteUserModeration = function (userId, muted, reason) {
    return this.request('PUT', '/api/moderation/users/' + encodeURIComponent(userId) + '/mute', {
      muted: Boolean(muted),
      reason: reason || ''
    });
  };

  API.getWaiverStatus = function () {
    return this.request('GET', '/api/waiver/status', null, { noStore: true });
  };

  API.signWaiver = function (payload) {
    return this.request('POST', '/api/waiver/sign', payload || {});
  };

  API.updateUserWaiverStatus = function (userId, waiverStatus) {
    return this.request('PUT', '/api/waiver/admin/users/' + encodeURIComponent(userId), { waiver_status: waiverStatus });
  };

  API.deleteUser = function (userId, ban, reason) {
    var banVal = ban !== undefined ? ban : false;
    var reasonVal = reason !== undefined ? reason : '';
    return this.request('DELETE', '/api/auth/users/' + encodeURIComponent(userId) + '?ban=' + (banVal ? 'true' : 'false') + '&reason=' + encodeURIComponent(reasonVal));
  };

  API.deleteMyAccount = function (payload) {
    return this.request('DELETE', '/api/auth/me', payload || {});
  };

  API.requestVisitorErasure = function (email) {
    return this.request('POST', '/api/auth/erasure/request', { email: email });
  };

  API.confirmVisitorErasure = function (payload) {
    return this.request('POST', '/api/auth/erasure/confirm', payload || {});
  };

  API.getQuarantinedWaivers = function () {
    return this.request('GET', '/api/waiver/admin/quarantined', null, { noStore: true });
  };

  API.purgeQuarantinedWaivers = function () {
    return this.request('POST', '/api/waiver/admin/quarantined/purge', {});
  };

  API.getBannedEmails = function () {
    return this.request('GET', '/api/auth/banned-emails');
  };

  API.banEmail = function (email, reason) {
    var reasonVal = reason !== undefined ? reason : '';
    return this.request('POST', '/api/auth/banned-emails', { email: email, reason: reasonVal });
  };

  API.unbanEmail = function (id) {
    return this.request('DELETE', '/api/auth/banned-emails/' + encodeURIComponent(id));
  };

  API.getSuppressions = function () {
    return this.request('GET', '/api/admin/suppressions');
  };

  API.clearSuppression = function (email) {
    return this.request('DELETE', '/api/admin/suppressions/' + encodeURIComponent(email));
  };

  API.getSettings = function () {
    return this.request('GET', '/api/settings');
  };

  API.updateSettings = function (settings) {
    return this.request('PUT', '/api/settings', settings);
  };

  API.testAppscript = function (url) {
    return this.request('POST', '/api/settings/test-appscript', { url: url });
  };

  // ==========================================
  // Pacific Date/Time Formatters
  // ==========================================

  API.formatDate = function (isoString) {
    if (!isoString) return '';
    var d = new Date(isoString);
    var locale = (typeof this.getLangMeta === 'function' && this.getLangMeta().locale) ? this.getLangMeta().locale : 'en-US';
    return d.toLocaleDateString(locale, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'America/Los_Angeles'
    });
  };

  API.formatDateTime = function (isoString) {
    if (!isoString) return '';
    var d = new Date(isoString);
    var locale = (typeof this.getLangMeta === 'function' && this.getLangMeta().locale) ? this.getLangMeta().locale : 'en-US';
    return d.toLocaleString(locale, {
      weekday: 'long',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: 'America/Los_Angeles',
      timeZoneName: 'short'
    });
  };

  API.isoToPacificLocalInput = function (isoString) {
    if (!isoString) return '';
    var d = new Date(isoString);
    if (isNaN(d.getTime())) return '';
    var parts = new Intl.DateTimeFormat('en-US', /** @type {any} */ ({
      timeZone: 'America/Los_Angeles',
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    })).formatToParts(d);
    var get = function (t) {
      var found = parts.find(function (p) { return p.type === t; });
      return (found && found.value) ? found.value : '00';
    };
    return get('year') + '-' + get('month') + '-' + get('day') + 'T' + get('hour') + ':' + get('minute');
  };

  API.localToPacificIso = function (dateString, timeString) {
    if (!dateString) return '';
    var defaultTime = timeString !== undefined ? timeString : '12:00';
    var splitDate = dateString.includes('T') ? dateString.split('T') : [dateString, defaultTime];
    var datePart = splitDate[0];
    var timePart = splitDate[1];
    var dateNums = datePart.split('-').map(Number);
    var year = dateNums[0];
    var month = dateNums[1];
    var day = dateNums[2];
    var timeNums = (timePart || '12:00').split(':').map(Number);
    var hour = timeNums[0];
    var min = timeNums[1];
    var d = new Date(Date.UTC(year, month - 1, day, hour + 7, min || 0));
    var parts = new Intl.DateTimeFormat('en-US', /** @type {any} */ ({
      timeZone: 'America/Los_Angeles',
      hourCycle: 'h23',
      year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric'
    })).formatToParts(d);
    var hourPart = parts.find(function (p) { return p.type === 'hour'; });
    var pHour = Number(hourPart ? hourPart.value : hour);
    var diffHours = hour - pHour;
    d = new Date(d.getTime() + diffHours * 3600000);
    return d.toISOString();
  };

  API.getNextSundayNoonPacificIso = function () {
    var now = new Date();
    var laFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short'
    });
    var weekdayPart = laFormatter.formatToParts(now).find(function (p) { return p.type === 'weekday'; });
    var dayName = weekdayPart ? weekdayPart.value : '';
    var daysMap = { 'Sun': 0, 'Mon': 1, 'Tue': 2, 'Wed': 3, 'Thu': 4, 'Fri': 5, 'Sat': 6 };
    var currentDay = (daysMap[dayName] !== undefined) ? daysMap[dayName] : now.getDay();
    var daysUntilSunday = 7 - currentDay;
    if (daysUntilSunday === 7) {
      var currentHour = Number(new Intl.DateTimeFormat('en-US', /** @type {any} */ ({ timeZone: 'America/Los_Angeles', hourCycle: 'h23', hour: 'numeric' })).format(now));
      if (currentHour < 12) daysUntilSunday = 0;
    }
    var targetDate = new Date(now.getTime() + daysUntilSunday * 86400000);
    var parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(targetDate);
    var yPart = parts.find(function (p) { return p.type === 'year'; });
    var mPart = parts.find(function (p) { return p.type === 'month'; });
    var dPart = parts.find(function (p) { return p.type === 'day'; });
    var yyyy = yPart ? yPart.value : '2026';
    var mm = mPart ? mPart.value : '01';
    var dd = dPart ? dPart.value : '01';
    return this.localToPacificIso(yyyy + '-' + mm + '-' + dd, '12:00');
  };

  // ==========================================
  // Calendar Links & ICS Export
  // ==========================================

  API.getGoogleCalendarUrl = function (ev) {
    if (!ev || !ev.event_date) return '#';
    var startDate = new Date(ev.event_date);
    if (isNaN(startDate.getTime())) {
      startDate = new Date();
    }
    var endDate = new Date(startDate.getTime() + 3 * 60 * 60 * 1000);
    var pad = function (n) { return String(n).padStart(2, '0'); };
    var formatGCal = function (d) {
      return d.getUTCFullYear() +
        pad(d.getUTCMonth() + 1) +
        pad(d.getUTCDate()) + 'T' +
        pad(d.getUTCHours()) +
        pad(d.getUTCMinutes()) +
        pad(d.getUTCSeconds()) + 'Z';
    };
    var title = encodeURIComponent(
      (typeof this.translateEventTitle === 'function' ? this.translateEventTitle(ev) : '') ||
      ev.title ||
      'Sunday Pickup Baseball - Noon Game'
    );
    var details = encodeURIComponent('Free community pickup baseball. Check headcount, coordinate gear & volunteer for tasks at https://www.pickupbaseballfoundation.org/event.html?id=' + ev.id);
    var location = encodeURIComponent(ev.location || 'Bushrod Park Field 1, Oakland, CA');
    return 'https://calendar.google.com/calendar/render?action=TEMPLATE&text=' + title + '&dates=' + formatGCal(startDate) + '/' + formatGCal(endDate) + '&details=' + details + '&location=' + location;
  };

  API.downloadEventsIcs = function (events, filename) {
    var upcoming = (events || []).filter(function (e) { return e && e.status !== 'cancelled'; });
    if (upcoming.length === 0) {
      if (typeof window !== 'undefined' && window.PBFDialog) {
        window.PBFDialog.toast(this.t('calendar.no_upcoming_export', 'No upcoming games scheduled to export.'), { type: 'info' });
      }
      return;
    }

    var pad = function (n) { return String(n).padStart(2, '0'); };
    var formatIcsDate = function (d) {
      return d.getUTCFullYear() +
        pad(d.getUTCMonth() + 1) +
        pad(d.getUTCDate()) + 'T' +
        pad(d.getUTCHours()) +
        pad(d.getUTCMinutes()) +
        pad(d.getUTCSeconds()) + 'Z';
    };

    var icsLines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Pickup Baseball Foundation//NONSGML Pickup Baseball Calendar//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'X-WR-CALNAME:Sunday Pickup Baseball',
      'X-WR-TIMEZONE:America/Los_Angeles'
    ];

    for (var i = 0; i < upcoming.length; i++) {
      var ev = upcoming[i];
      var startDate = new Date(ev.event_date);
      if (isNaN(startDate.getTime())) continue;
      var endDate = new Date(startDate.getTime() + 3 * 60 * 60 * 1000);
      var isRainout = ev.status === 'rainout';
      var baseTitle = ev.title || 'Sunday Pickup Baseball - Noon Game';
      var summary = isRainout ? ('🌧️ RAINED OUT: ' + baseTitle) : baseTitle;

      icsLines.push('BEGIN:VEVENT');
      icsLines.push('UID:pickup-baseball-event-' + ev.id + '@pickupbaseballfoundation.org');
      icsLines.push('DTSTAMP:' + formatIcsDate(new Date()));
      icsLines.push('DTSTART:' + formatIcsDate(startDate));
      icsLines.push('DTEND:' + formatIcsDate(endDate));
      icsLines.push('SUMMARY:' + summary.replace(/,/g, '\\,'));
      icsLines.push('LOCATION:' + (ev.location || 'Bushrod Park Field 1, Oakland, CA').replace(/,/g, '\\,'));
      icsLines.push('DESCRIPTION:Free community pickup baseball. Check headcount and volunteer at https://www.pickupbaseballfoundation.org/event.html?id=' + ev.id);
      icsLines.push('STATUS:CONFIRMED');
      icsLines.push('END:VEVENT');
    }

    icsLines.push('END:VCALENDAR');

    var blob = new Blob([icsLines.join('\r\n')], { type: 'text/calendar;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename || 'pickup-baseball-schedule.ics';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  API.renderSubscribePanel = function (panelEl, options) {
    if (!panelEl) return;
    var opts = options || {};
    var singleEvent = opts.event || null;
    var isSingleGame = Boolean(singleEvent && singleEvent.id);
    var host = (typeof window !== 'undefined' && window.location && window.location.host) ? window.location.host : 'www.pickupbaseballfoundation.org';
    var origin = (typeof window !== 'undefined' && window.location && window.location.origin) ? window.location.origin : ('https://' + host);
    var calToken = opts.calendarToken || (this.currentUser && (this.currentUser.calendarToken || this.currentUser.calendar_token)) || '';
    var baseFeedPath = isSingleGame ? ('/api/events/' + singleEvent.id + '/calendar.ics') : '/api/events/calendar.ics';
    var feedPath = calToken ? (baseFeedPath + '?cal_token=' + encodeURIComponent(calToken)) : baseFeedPath;
    var rawFeedHttpUrl = opts.feedHttpUrl ? String(opts.feedHttpUrl).trim() : '';
    var rawWebcalUrl = opts.webcalUrl ? String(opts.webcalUrl).trim() : '';
    var feedHttpUrl = /^https?:\/\//i.test(rawFeedHttpUrl) ? rawFeedHttpUrl : (origin + feedPath);
    var webcalUrl = /^webcal:\/\//i.test(rawWebcalUrl) ? rawWebcalUrl : ('webcal://' + host + feedPath);
    var googleSubscribeUrl = 'https://calendar.google.com/calendar/r?cid=' + encodeURIComponent(webcalUrl);
    var googleAddOnceUrl = isSingleGame ? this.getGoogleCalendarUrl(singleEvent) : '';

    var titleText = isSingleGame
      ? '🔄 Single-Game Live Calendar Sync (.ics)'
      : this.t('calendar.subscribe_title', '🔄 All-Games Live Calendar Sync (.ics)');
    var descText = isSingleGame
      ? 'Subscribe to this game for live rainout alerts and time/field updates — or add it directly to Google Calendar.'
      : this.t('calendar.subscribe_desc', 'Subscribe once so newly scheduled games, field changes, and rainout alerts update automatically on your phone or computer.');
    var appleBtnLabel = this.t('calendar.subscribe_apple_btn', '🍎 Apple / Outlook (Live Sync)');
    var googleLiveLabel = this.t('calendar.subscribe_google_btn', '📅 Google Calendar (Live Sync)');
    var snapshotBtnLabel = isSingleGame
      ? '📥 Download Game .ics'
      : this.t('calendar.subscribe_snapshot_btn', '📥 Download One-Time .ics File');
    var copyBtnLabel = this.t('calendar.subscribe_copy_btn', '📋 Copy Feed URL');
    var copiedBtnLabel = this.t('calendar.subscribe_copied', '✓ Copied!');
    var idPrefix = opts.idPrefix || 'calendar';
    var tokenFooterHtml = calToken
      ? '<div style="margin-top:0.5rem;display:flex;align-items:center;justify-content:space-between;gap:0.75rem;flex-wrap:wrap;font-size:0.78rem;color:var(--text-muted);">' +
          '<span>🔒 Personal feed link includes public games + invite-only games you are invited to. Keep this link private.</span>' +
          '<button type="button" id="' + idPrefix + '-rotate-token-btn" class="btn btn-outline btn-xs" style="font-size:0.74rem;padding:0.2rem 0.55rem;">' +
            (opts._justReset ? '✓ Secret Link Reset!' : '🔄 Reset Secret Link') +
          '</button>' +
        '</div>'
      : '<div style="margin-top:0.5rem;font-size:0.78rem;color:var(--text-muted);">' +
          '🌐 Public games only. <a href="/login.html" style="font-weight:600;">Sign in</a> for a personal link that includes invite-only games you\'re invited to.' +
        '</div>';

    panelEl.innerHTML =
      '<div class="subscribe-panel-header">' +
        '<div>' +
          '<h3 class="subscribe-panel-title">' + this.escapeHtml(titleText) + '</h3>' +
          '<p class="subscribe-panel-desc">' + this.escapeHtml(descText) + '</p>' +
        '</div>' +
        '<button type="button" id="' + idPrefix + '-subscribe-close-btn" class="calendar-drawer-close-btn" aria-label="Close calendar sync options" title="Close">✕</button>' +
      '</div>' +
      '<div class="subscribe-actions-row">' +
        '<a href="' + this.escapeHtml(webcalUrl) + '" class="btn btn-primary btn-sm" style="font-weight: 700; text-decoration: none;">' +
          this.escapeHtml(appleBtnLabel) +
        '</a>' +
        '<a href="' + this.escapeHtml(googleSubscribeUrl) + '" target="_blank" rel="noopener noreferrer" class="btn btn-primary btn-sm" style="font-weight: 700; text-decoration: none;">' +
          this.escapeHtml(googleLiveLabel) +
        '</a>' +
        (isSingleGame
          ? '<a href="' + this.escapeHtml(googleAddOnceUrl) + '" target="_blank" rel="noopener noreferrer" class="btn btn-outline btn-sm" style="font-weight: 600; text-decoration: none;" title="Add this game once to your primary Google Calendar">➕ Add Once to Google Cal ↗</a>'
          : '') +
        '<button type="button" id="' + idPrefix + '-download-snapshot-btn" class="btn btn-outline btn-sm" title="Download a static .ics file">' +
          this.escapeHtml(snapshotBtnLabel) +
        '</button>' +
      '</div>' +
      '<div class="subscribe-url-row">' +
        '<input type="text" id="' + idPrefix + '-feed-url-input" class="subscribe-url-input" value="' + this.escapeHtml(feedHttpUrl) + '" readonly aria-label="Live calendar subscription URL">' +
        '<button type="button" id="' + idPrefix + '-copy-feed-btn" class="btn btn-outline btn-sm" style="white-space: nowrap; font-weight: 600;">' +
          this.escapeHtml(copyBtnLabel) +
        '</button>' +
      '</div>' +
      tokenFooterHtml;

    var closeBtn = panelEl.querySelector('#' + idPrefix + '-subscribe-close-btn');
    if (closeBtn && typeof opts.onClose === 'function') {
      closeBtn.addEventListener('click', opts.onClose);
    }

    var self = this;
    var rotateBtn = /** @type {HTMLButtonElement|null} */ (panelEl.querySelector('#' + idPrefix + '-rotate-token-btn'));
    if (rotateBtn) {
      rotateBtn.addEventListener('click', function () {
        rotateBtn.disabled = true;
        rotateBtn.textContent = 'Resetting...';
        self.regenerateCalendarToken().then(function (res) {
          var nextOpts = Object.assign({}, opts, {
            calendarToken: (res && res.calendarToken) ? res.calendarToken : (self.currentUser && self.currentUser.calendarToken),
            feedHttpUrl: undefined,
            webcalUrl: undefined,
            _justReset: true
          });
          self.renderSubscribePanel(panelEl, nextOpts);
        }).catch(function (err) {
          rotateBtn.disabled = false;
          rotateBtn.textContent = '🔄 Reset Secret Link';
          console.error('[Calendar] Token reset failed:', err);
        });
      });
    }

    var snapshotBtn = panelEl.querySelector('#' + idPrefix + '-download-snapshot-btn');
    if (snapshotBtn) {
      snapshotBtn.addEventListener('click', function () {
        if (isSingleGame) {
          self.downloadEventsIcs([singleEvent], 'pickup-baseball-game-' + singleEvent.id + '.ics');
        } else {
          self.downloadEventsIcs(opts.events || [], 'pickup-baseball-schedule.ics');
        }
      });
    }

    var copyBtn = panelEl.querySelector('#' + idPrefix + '-copy-feed-btn');
    var urlInput = /** @type {HTMLInputElement|null} */ (panelEl.querySelector('#' + idPrefix + '-feed-url-input'));
    if (copyBtn && urlInput) {
      copyBtn.addEventListener('click', function () {
        var markCopied = function () {
          copyBtn.textContent = copiedBtnLabel;
          setTimeout(function () {
            copyBtn.textContent = copyBtnLabel;
          }, 2200);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(feedHttpUrl).then(markCopied).catch(function () {
            urlInput.select();
            try { document.execCommand('copy'); } catch (e) { /* clipboard fallback unavailable */ }
            markCopied();
          });
        } else {
          urlInput.select();
          try { document.execCommand('copy'); } catch (e) { /* clipboard fallback unavailable */ }
          markCopied();
        }
      });
    }
  };

  // ==========================================
  // Display Name & Privacy Helpers
  // ==========================================

  API.formatDisplayName = function (rawName, fallback) {
    var fb = fallback !== undefined ? fallback : 'Player';
    var raw = rawName ? String(rawName).trim() : '';
    if (!raw) return fb;
    var parts = raw.split(/\s+/);
    if (parts.length < 2) return raw;
    var first = parts.slice(0, -1).join(' ');
    var last = parts[parts.length - 1].replace(/\.+$/, '');
    if (!last) return first || fb;
    return first + ' ' + last.charAt(0) + '.';
  };

  API.formatDisplayNameList = function (rawList) {
    var raw = rawList ? String(rawList).trim() : '';
    if (!raw) return '';
    var self = this;
    return raw.split(',').map(function (entry) {
      var trimmed = entry.trim();
      return trimmed ? self.formatDisplayName(trimmed, trimmed) : '';
    }).filter(Boolean).join(', ');
  };

  API.abbreviateDisplayNames = function (records, nameProp, idProp, fallback) {
    var list = Array.isArray(records) ? records : [];
    var prop = nameProp || 'name';
    var fb = fallback !== undefined ? fallback : 'Player';
    var seenIds = {};
    var keyCounts = {};

    var parsed = list.map(function (rec, idx) {
      var raw = (rec && rec[prop]) ? String(rec[prop]).trim() : '';
      var parts = raw ? raw.split(/\s+/) : [];
      var first = parts.length > 1 ? parts.slice(0, -1).join(' ') : (parts[0] || '');
      var last = parts.length > 1 ? parts[parts.length - 1].replace(/\.+$/, '') : '';
      var key = (first && last) ? (first.toLowerCase() + '|' + last.charAt(0).toLowerCase()) : '';
      var uid = rec && (idProp ? rec[idProp] : (rec.user_id || rec.id));
      var personId = uid ? ('u:' + String(uid)) : (raw ? ('n:' + raw.toLowerCase()) : ('i:' + idx));
      if (key && !Object.prototype.hasOwnProperty.call(seenIds, personId)) {
        seenIds[personId] = true;
        keyCounts[key] = (keyCounts[key] || 0) + 1;
      }
      return { raw: raw, first: first, last: last, key: key };
    });

    return parsed.map(function (p) {
      if (!p.raw) return fb;
      if (!p.last) return p.raw;
      var len = keyCounts[p.key] > 1 ? 2 : 1;
      return p.first + ' ' + p.last.slice(0, len) + '.';
    });
  };

  API.isMemberRole = function (role) {
    return role === 'member' || role === 'player';
  };

  API.escapeHtml = function (str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  };

  API.parseMediaType = function (url, explicitType) {
    if (explicitType && explicitType !== 'auto') return explicitType;
    if (!url) return 'none';
    var u = String(url).trim();
    if (/youtube\.com\/watch\?|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\//i.test(u)) {
      return 'youtube';
    }
    if (/\.(jpeg|jpg|png|webp|gif|svg)(\?.*)?$/i.test(u) || /imgur\.com\//i.test(u)) {
      return 'image';
    }
    if (/\.(mp4|webm|mov)(\?.*)?$/i.test(u)) {
      return 'video';
    }
    if (/\.(mp3|wav|ogg|m4a)(\?.*)?$/i.test(u)) {
      return 'audio';
    }
    return 'link';
  };

  API.getYouTubeId = function (url) {
    if (!url) return null;
    var match = String(url).match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=|shorts\/))([\w-]{11})/i);
    return match ? match[1] : null;
  };

  API.getYouTubeEmbedUrl = function (url) {
    var id = this.getYouTubeId(url);
    if (!id) return '';
    return 'https://www.youtube-nocookie.com/embed/' + id;
  };

  API.getGoogleDriveId = function (url) {
    if (!url) return null;
    var match = String(url).match(/(?:drive\.google\.com\/(?:file\/d\/|open\?id=)|docs\.google\.com\/file\/d\/)([\w-]{25,})/i);
    return match ? match[1] : null;
  };

  API.getGoogleDriveEmbedUrl = function (url) {
    var id = this.getGoogleDriveId(url);
    if (!id) return '';
    return 'https://drive.google.com/file/d/' + id + '/preview';
  };

  API.safeUrl = function (rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return '';
    var trimmed = rawUrl.trim();
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(trimmed)) return '';
    if (trimmed.startsWith('/') && !trimmed.startsWith('//') && !trimmed.startsWith('/\\')) {
      return trimmed;
    }
    try {
      var parsed = new URL(trimmed);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        return parsed.href;
      }
    } catch (e) { /* invalid URL rejected */ }
    return '';
  };

  API.safeAvatarUrl = function (rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return '';
    var trimmed = rawUrl.trim();
    if (/^\/api\/users\/\d+\/avatar(\?v=\d+)?$/i.test(trimmed)) {
      return trimmed;
    }
    if (/^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/i.test(trimmed)) {
      return trimmed;
    }
    return this.safeUrl(trimmed);
  };

  API.icon = function (name, size) {
    var iconSize = size !== undefined ? size : 20;
    var attrs = 'width="' + iconSize + '" height="' + iconSize + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: -0.18em; flex-shrink: 0;"';
    var icons = {
      calendar: '<svg ' + attrs + '><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
      pin: '<svg ' + attrs + '><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>',
      users: '<svg ' + attrs + '><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
      shield: '<svg ' + attrs + '><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
      bag: '<svg ' + attrs + '><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>',
      mail: '<svg ' + attrs + '><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>',
      chat: '<svg ' + attrs + '><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>'
    };
    return icons[name] || '';
  };
})();
