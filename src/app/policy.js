/**
 * Paid Operations & Fair-Share Task Scheduling Policy + Whitelist Parsing
 * Implements 12-week Monday 5:00 AM Pacific unlock, Tier 1/2/3 windows,
 * certification badges, rolling 3-month shift caps, and Backup Hero Credits.
 */

import { resolveConfig } from './config.js';
import { ERROR_CODES, jsonError } from './errors.js';

/**
 * Returns a 403 JSON error response when FEATURE_BATTING_PRACTICE is disabled, or null when enabled.
 * @param {AppContext} c
 */
export function rejectIfBattingPracticeDisabled(c) {
  if (!resolveConfig(c.env).FEATURE_BATTING_PRACTICE) {
    return jsonError(c, 403, ERROR_CODES.FORBIDDEN, 'Batting practice is disabled for this community.', {
      feature: 'FEATURE_BATTING_PRACTICE',
      disabled: true
    });
  }
  return null;
}

export function parseAllowedEmails(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return [...new Set(raw.map(e => String(e).trim().toLowerCase()).filter(e => e.includes('@')))];
  }
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return [...new Set(parsed.map(e => String(e).trim().toLowerCase()).filter(e => e.includes('@')))];
      }
    } catch (e) {
      /* not JSON; fall back to delimiter-separated parsing below */
    }
    return [...new Set(raw.split(/[,\n;]/).map(e => String(e).trim().toLowerCase()).filter(e => e.includes('@')))];
  }
  return [];
}

export function canUserAccessEvent(user, eventOrAllowedEmails) {
  const raw = eventOrAllowedEmails && typeof eventOrAllowedEmails === 'object' && !Array.isArray(eventOrAllowedEmails)
    ? eventOrAllowedEmails.allowed_emails
    : eventOrAllowedEmails;
  const allowedList = parseAllowedEmails(raw);
  if (allowedList.length === 0) return true;
  if (!user) return false;
  if (user.canManageEvents || user.isAdmin) return true;
  const email = user.email ? String(user.email).trim().toLowerCase() : '';
  return Boolean(email && allowedList.includes(email));
}

export function getTaskUnlockAt(eventDateStr) {
  const d = new Date(eventDateStr);
  const target = new Date(d.getTime() - (83 * 24 * 3600 * 1000));
  const datePart = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(target);
  const testPst = new Date(datePart + 'T05:00:00-08:00');
  const tzCheck = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', timeZoneName: 'short' }).format(testPst);
  const isPdt = tzCheck.includes('PDT');
  return new Date(datePart + (isPdt ? 'T05:00:00-07:00' : 'T05:00:00-08:00')).toISOString();
}

export function formatUnlockDateTime(isoStr) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short'
  }).format(new Date(isoStr));
}

export function getTaskTier(eventDateStr, now) {
  const unlockIso = getTaskUnlockAt(eventDateStr);
  const unlockTime = new Date(unlockIso).getTime();
  const eventTime = new Date(eventDateStr).getTime();
  const nowTime = (now || new Date()).getTime();

  if (nowTime < unlockTime) {
    return { tier: 'locked', isUnlocked: false, unlockAt: unlockIso };
  }
  if (nowTime < eventTime - (42 * 24 * 3600 * 1000)) {
    return { tier: 'tier1', isUnlocked: true, unlockAt: unlockIso };
  }
  if (nowTime < eventTime - (14 * 24 * 3600 * 1000)) {
    return { tier: 'tier2', isUnlocked: true, unlockAt: unlockIso };
  }
  return { tier: 'tier3', isUnlocked: true, unlockAt: unlockIso };
}

const VALID_DUTY_BADGES = new Set(['machine', 'field']);

/**
 * Normalizes explicit `grants_coordinator` and `required_badge` fields on a duty payload.
 * @param {Record<string, any> | null | undefined} duty
 * @returns {{ grantsCoordinator: number, requiredBadge: string | null, invalidBadge: boolean }}
 */
export function normalizeDutyFlags(duty) {
  const src = duty && typeof duty === 'object' ? duty : {};
  const rawCoord = src.grants_coordinator;
  const grantsCoordinator = rawCoord === true || rawCoord === 1 || rawCoord === '1' || rawCoord === 'true' ? 1 : 0;

  let requiredBadge = null;
  let invalidBadge = false;
  if (src.required_badge !== undefined && src.required_badge !== null) {
    let normalized = String(src.required_badge).trim().toLowerCase();
    if (normalized === 'machine_badge') normalized = 'machine';
    if (normalized === 'field_badge') normalized = 'field';
    if (normalized !== '') {
      if (VALID_DUTY_BADGES.has(normalized)) {
        requiredBadge = normalized;
      } else {
        invalidBadge = true;
      }
    }
  }
  return { grantsCoordinator, requiredBadge, invalidBadge };
}

/**
 * Resolves duty badge policy purely from the explicit `required_badge` column (or badge key)
 * and the `FEATURE_CERTIFIED_SHIFTS` flag. Never inspects duty titles.
 * @param {Record<string, any> | string | null | undefined} dutyOrBadge
 * @param {{ certifiedShiftsEnabled?: boolean }} [options]
 */
export function getDutyType(dutyOrBadge, options = {}) {
  if (options && options.certifiedShiftsEnabled === false) {
    return { type: 'general', isPaid: false, requiredBadge: null, badgeKey: null, badgeName: null };
  }

  let rawBadge = '';
  if (dutyOrBadge && typeof dutyOrBadge === 'object') {
    rawBadge = dutyOrBadge.required_badge ? String(dutyOrBadge.required_badge).trim().toLowerCase() : '';
  } else if (typeof dutyOrBadge === 'string') {
    rawBadge = dutyOrBadge.trim().toLowerCase();
  }

  if (rawBadge === 'machine' || rawBadge === 'machine_badge') {
    return { type: 'machine', isPaid: true, requiredBadge: 'machine_badge', badgeKey: 'machine', badgeName: 'Pitching Machine Badge' };
  }
  if (rawBadge === 'field' || rawBadge === 'field_badge') {
    return { type: 'field', isPaid: true, requiredBadge: 'field_badge', badgeKey: 'field', badgeName: 'Field Dragging Badge' };
  }
  return { type: 'general', isPaid: false, requiredBadge: null, badgeKey: null, badgeName: null };
}

export async function getDutyTier1Cap(db, dutyType) {
  const badgeCol = dutyType === 'machine' ? 'machine_badge' : 'field_badge';
  const row = await db.prepare(`SELECT COUNT(*) as count FROM users WHERE ${badgeCol} = 1`).first();
  const n = Math.max(1, row ? row.count : 0);
  return Math.max(1, Math.floor(12 / n));
}

export async function getUserRollingShifts(db, userId, dutyType, targetEventDate, targetEventId) {
  const requiredBadge = dutyType === 'machine' ? 'machine' : 'field';
  const row = await db.prepare(`
    SELECT COUNT(DISTINCT e.id) as count
    FROM duty_assignments da
    JOIN event_duties ed ON da.duty_id = ed.id
    JOIN attendees a ON da.attendee_id = a.id
    JOIN events e ON a.event_id = e.id
    WHERE a.user_id = ?
      AND a.status = 'attending'
      AND e.status != 'cancelled'
      AND e.id != ?
      AND ed.required_badge = ?
      AND ABS(julianday(e.event_date) - julianday(?)) <= 42
  `).bind(userId, targetEventId || 0, requiredBadge, targetEventDate).first();
  return row ? row.count : 0;
}

/**
 * Abbreviate last names in a member directory ("First L.", or "First La."
 * when multiple distinct users share the same first name and last initial).
 * @param {Array<{user_id?: number|null, attendee_id?: number|null, id?: number|null, name?: string}>} records
 * @returns {string[]}
 */
export function abbreviateMemberNames(records) {
  const list = Array.isArray(records) ? records : [];
  const seenIds = new Set();
  const keyCounts = Object.create(null);

  const parsed = list.map((rec, idx) => {
    const raw = rec && rec.name ? String(rec.name).trim() : '';
    const parts = raw ? raw.split(/\s+/) : [];
    const first = parts.length > 1 ? parts.slice(0, -1).join(' ') : (parts[0] || '');
    const last = parts.length > 1 ? parts[parts.length - 1].replace(/\.+$/, '') : '';
    const key = (first && last) ? (first.toLowerCase() + '|' + last.charAt(0).toLowerCase()) : '';
    let personId = 'i:' + idx;
    if (rec) {
      if (rec.user_id != null) personId = 'u:' + String(rec.user_id);
      else if (rec.attendee_id != null) personId = 'a:' + String(rec.attendee_id);
      else if (rec.id != null) personId = 'id:' + String(rec.id);
    }
    if (key && !seenIds.has(personId)) {
      seenIds.add(personId);
      keyCounts[key] = (keyCounts[key] || 0) + 1;
    }
    return { raw, first, last, key };
  });

  return parsed.map((p) => {
    if (!p.raw) return 'Player';
    if (!p.last) return p.raw;
    const len = keyCounts[p.key] > 1 ? 2 : 1;
    return p.first + ' ' + p.last.slice(0, len) + '.';
  });
}

/**
 * Returns true if the signed-in user holds Organizer or Admin permissions.
 * @param {AppUser|null|undefined} user
 * @returns {boolean}
 */
export function isViewerOrganizer(user) {
  return Boolean(user && (user.canManageEvents || user.isAdmin));
}

/**
 * Returns true if an attendee/waitlist row belongs to the current viewer (signed-in Member or ?token= Visitor).
 * @param {AppUser|null|undefined} user
 * @param {Record<string, any>} row
 * @param {Record<string, any>|null|undefined} myRsvp
 * @returns {boolean}
 */
export function isSelfAttendee(user, row, myRsvp) {
  if (!row) return false;
  if (user) {
    if (row.user_id != null && Number(row.user_id) === Number(user.id)) return true;
    if (user.email && row.email && String(user.email).toLowerCase() === String(row.email).toLowerCase()) return true;
  }
  if (myRsvp && row.id != null && Number(row.id) === Number(myRsvp.id)) return true;
  return false;
}

/**
 * Sanitizes event attendee/waitlist rows according to ADR-0005 privacy & consent rules.
 * - Default peer Members see "First L." names and RSVP/task status only.
 * - `notes` and `waiver_status` are restricted to Organizers and self.
 * - Full name, `gear_bringing`, and `guest_names` require `roster_visibility`/`roster_consent` (or Organizer/self).
 * - `bio` and `avatar_url` require `profile_sharing` (or Organizer/self).
 * @param {Array<Record<string, any>>} rows
 * @param {{ user?: AppUser|null, isOrganizer?: boolean, myRsvp?: Record<string, any>|null }} opts
 * @returns {Array<Record<string, any>>}
 */
export function sanitizeAttendeesForViewer(rows, { user = null, isOrganizer = false, myRsvp = null } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const abbrNames = abbreviateMemberNames(list);

  return list.map((row, idx) => {
    const isSelf = isSelfAttendee(user, row, myRsvp);
    const hasRosterConsent = Boolean(row.roster_visibility || row.roster_consent);
    const hasProfileSharing = Boolean(row.profile_sharing);
    const canSeeRoster = Boolean(isOrganizer || isSelf || hasRosterConsent);
    const canSeePrivate = Boolean(isOrganizer || isSelf);
    const canSeeProfile = Boolean(isOrganizer || isSelf || hasProfileSharing);

    const {
      email: _email,
      roster_visibility: _rv,
      profile_sharing: _ps,
      roster_consent: _rc,
      notes,
      waiver_status,
      paper_waiver_at,
      paper_waiver_by,
      ...rest
    } = row;

    /** @type {Record<string, any>} */
    const sanitized = {
      ...rest,
      name: canSeeRoster ? row.name : abbrNames[idx],
      gear_bringing: canSeeRoster ? (row.gear_bringing || '') : '',
      guest_names: canSeeRoster ? (row.guest_names || '') : '',
      bio: canSeeProfile ? (row.bio || '') : '',
      avatar_url: canSeeProfile ? (row.avatar_url || '') : '',
      show_full_name: canSeeRoster
    };

    if (canSeePrivate) {
      sanitized.notes = notes || '';
      sanitized.waiver_status = waiver_status || 'none';
      if (paper_waiver_at !== undefined) sanitized.paper_waiver_at = paper_waiver_at;
      if (paper_waiver_by !== undefined) sanitized.paper_waiver_by = paper_waiver_by;
    }

    return sanitized;
  });
}

/**
 * Sanitizes event comments for the current viewer. Visitors receive `[]`.
 * @param {Array<Record<string, any>>} rows
 * @param {{ user?: AppUser|null, isOrganizer?: boolean }} opts
 * @returns {Array<Record<string, any>>}
 */
export function sanitizeCommentsForViewer(rows, { user = null, isOrganizer = false } = {}) {
  if (!user) return [];
  const list = Array.isArray(rows) ? rows : [];
  const abbrNames = abbreviateMemberNames(
    list.map((c) => ({ id: c.id, user_id: c.user_id, name: c.author_name }))
  );

  return list.map((c, idx) => {
    const isSelf = Boolean(c.user_id != null && Number(c.user_id) === Number(user.id));
    const hasRosterConsent = Boolean(c.roster_visibility);
    const hasProfileSharing = Boolean(c.profile_sharing);
    const canSeeRoster = Boolean(isOrganizer || isSelf || hasRosterConsent);
    const canSeeProfile = Boolean(isOrganizer || isSelf || hasProfileSharing);

    return {
      id: c.id,
      author_name: canSeeRoster ? c.author_name : abbrNames[idx],
      content: c.content,
      created_at: c.created_at,
      user_id: c.user_id,
      avatar_url: canSeeProfile ? (c.avatar_url || '') : '',
      bio: canSeeProfile ? (c.bio || '') : '',
      show_full_name: canSeeRoster
    };
  });
}

/**
 * Sanitizes batting practice signup rows for signed-in Members / Organizers.
 * @param {Array<Record<string, any>>} rows
 * @param {{ user?: AppUser|null, isOrganizer?: boolean, myRsvp?: Record<string, any>|null }} opts
 * @returns {Array<Record<string, any>>}
 */
export function sanitizeBpSignupsForViewer(rows, { user = null, isOrganizer = false, myRsvp = null } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const abbrNames = abbreviateMemberNames(
    list.map((s) => ({ id: s.id, user_id: s.user_id, attendee_id: s.attendee_id, name: s.player_name }))
  );

  return list.map((s, idx) => {
    const isSelf = Boolean(
      (user && s.user_id != null && Number(s.user_id) === Number(user.id)) ||
      (myRsvp && s.attendee_id != null && Number(s.attendee_id) === Number(myRsvp.id))
    );
    const hasRosterConsent = Boolean(s.roster_visibility || s.roster_consent);
    const hasProfileSharing = Boolean(s.profile_sharing);
    const canSeeRoster = Boolean(isOrganizer || isSelf || hasRosterConsent);
    const canSeeProfile = Boolean(isOrganizer || isSelf || hasProfileSharing);

    const {
      roster_visibility: _rv,
      roster_consent: _rc,
      profile_sharing: _ps,
      ...rest
    } = s;

    return {
      ...rest,
      player_name: canSeeRoster ? s.player_name : abbrNames[idx],
      avatar_url: canSeeProfile ? (s.avatar_url || '') : '',
      show_full_name: canSeeRoster
    };
  });
}

/**
 * Sanitizes duty assignee lists for Visitors (own `?token=` RSVP only) and Members (`First L.` unless consented/Organizer/self).
 * @param {Array<Record<string, any>>} players
 * @param {{ user?: AppUser|null, isOrganizer?: boolean, myRsvp?: Record<string, any>|null, includeUserId?: boolean }} opts
 * @returns {Array<Record<string, any>>}
 */
export function sanitizeDutyAssignedPlayers(players, { user = null, isOrganizer = false, myRsvp = null, includeUserId = false } = {}) {
  const list = Array.isArray(players) ? players : [];
  if (!user) {
    return list.map((p) => {
      const isOwnTokenRsvp = Boolean(myRsvp && p.attendee_id != null && Number(p.attendee_id) === Number(myRsvp.id));
      /** @type {Record<string, any>} */
      const out = {
        attendee_id: p.attendee_id,
        name: isOwnTokenRsvp ? p.name : ''
      };
      if (includeUserId) out.user_id = null;
      if (isOwnTokenRsvp) out.show_full_name = true;
      return out;
    });
  }

  const abbrNames = abbreviateMemberNames(
    list.map((p) => ({ id: p.attendee_id, attendee_id: p.attendee_id, user_id: p.user_id, name: p.name }))
  );

  return list.map((p, idx) => {
    const isSelf = Boolean(
      (p.user_id != null && Number(p.user_id) === Number(user.id)) ||
      (user.email && p.email && String(user.email).toLowerCase() === String(p.email).toLowerCase())
    );
    const hasRosterConsent = Boolean(p.roster_visibility || p.roster_consent);
    const canSeeRoster = Boolean(isOrganizer || isSelf || hasRosterConsent);
    /** @type {Record<string, any>} */
    const out = {
      attendee_id: p.attendee_id,
      name: canSeeRoster ? p.name : abbrNames[idx],
      show_full_name: canSeeRoster
    };
    if (includeUserId) out.user_id = p.user_id;
    return out;
  });
}
