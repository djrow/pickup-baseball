/**
 * Paid Operations & Fair-Share Task Scheduling Policy + Whitelist Parsing
 * Implements 12-week Monday 5:00 AM Pacific unlock, Tier 1/2/3 windows,
 * certification badges, rolling 3-month shift caps, and Backup Hero Credits.
 */

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
    } catch (e) {}
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

export function getDutyType(title) {
  const lower = (title || '').toLowerCase();
  if (lower.includes('machine')) {
    return { type: 'machine', isPaid: true, requiredBadge: 'machine_badge', badgeName: 'Pitching Machine Badge' };
  }
  if (lower.includes('drag')) {
    return { type: 'field', isPaid: true, requiredBadge: 'field_badge', badgeName: 'Field Dragging Badge' };
  }
  return { type: 'general', isPaid: false, requiredBadge: null, badgeName: null };
}

export async function getDutyTier1Cap(db, dutyType) {
  const badgeCol = dutyType === 'machine' ? 'machine_badge' : 'field_badge';
  const row = await db.prepare(`SELECT COUNT(*) as count FROM users WHERE ${badgeCol} = 1`).first();
  const n = Math.max(1, row ? row.count : 0);
  return Math.max(1, Math.floor(12 / n));
}

export async function getUserRollingShifts(db, userId, dutyType, targetEventDate, targetEventId) {
  const likePattern = dutyType === 'machine' ? '%machine%' : '%drag%';
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
      AND LOWER(ed.title) LIKE ?
      AND ABS(julianday(e.event_date) - julianday(?)) <= 42
  `).bind(userId, targetEventId || 0, likePattern, targetEventDate).first();
  return row ? row.count : 0;
}
