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
