const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { db, DEFAULT_BASEBALL_DUTIES, getDefaultDuties, saveDefaultDuties } = require('../db');
const { optionalUser, requireAdmin, requireEventCreator } = require('../auth');
const { sendRsvpConfirmation, sendWaitlistConfirmation, sendWaitlistPromotionEmail, sendRainoutEmail, sendReopenEmail } = require('../mailer');
const { sendRemindersForEvent } = require('../reminders');

/**
 * List events (upcoming by default)
 */
router.get('/', optionalUser, (req, res) => {
  try {
    const { filter } = req.query; // 'upcoming', 'past', 'all'
    let whereClause = "WHERE status IN ('active', 'rainout')";
    const nowIso = new Date().toISOString();

    let orderBy = 'ORDER BY e.event_date ASC';
    if (filter === 'past') {
      whereClause += " AND datetime(e.event_date) < datetime('now', '-4 hours')";
      orderBy = 'ORDER BY e.event_date DESC';
    } else if (filter === 'all') {
      orderBy = 'ORDER BY e.event_date ASC';
    } else {
      whereClause += " AND datetime(e.event_date) >= datetime('now', '-4 hours')";
      orderBy = 'ORDER BY e.event_date ASC';
    }

    const events = db.prepare(`
      SELECT e.*,
        (SELECT COALESCE(SUM(COALESCE(a.players_count, 1 + COALESCE(a.additional_guests, 0))), 0) FROM attendees a WHERE a.event_id = e.id AND a.status = 'attending') as attendee_count,
        (SELECT COALESCE(SUM(COALESCE(a.spectators_count, 0)), 0) FROM attendees a WHERE a.event_id = e.id AND a.status = 'attending') as spectator_count,
        (SELECT COUNT(*) FROM event_duties d WHERE d.event_id = e.id) as duty_count
      FROM events e
      ${whereClause}
      ${orderBy}
    `).all();

    // If user is logged in, attach their personal RSVP status to each event
    if (req.user) {
      const userRsvps = db.prepare(`
        SELECT event_id, status, gear_bringing, players_count, spectators_count
        FROM attendees
        WHERE user_id = ?
      `).all(req.user.id);
      
      const rsvpMap = new Map(userRsvps.map(r => [r.event_id, r]));
      events.forEach(ev => {
        ev.my_rsvp = rsvpMap.get(ev.id) || null;
      });
    }

    events.forEach(ev => {
      const allowed = parseAllowedEmails(ev.allowed_emails);
      ev.is_restricted = allowed.length > 0;
      ev.allowed_emails_list = allowed;
    });

    res.setHeader('Cache-Control', 'no-store');
    res.json({ events, synced_at: nowIso });
  } catch (err) {
    console.error('[Events] Error listing events:', err);
    res.status(500).json({ error: 'Failed to fetch events.' });
  }
});

/**
 * Get default charity duties template
 */
router.get('/default-duties', (req, res) => {
  res.json({ duties: getDefaultDuties() });
});

/**
 * Update default charity duties template (Admin only)
 */
router.put('/default-duties', requireAdmin, (req, res) => {
  try {
    const { duties } = req.body;
    if (!Array.isArray(duties)) {
      return res.status(400).json({ error: 'duties array is required.' });
    }
    saveDefaultDuties(duties);
    res.json({ success: true, duties: getDefaultDuties(), message: 'Default task template updated successfully!' });
  } catch (err) {
    console.error('[Events] Error updating default duties:', err);
    res.status(500).json({ error: 'Failed to update default duties template.' });
  }
});

/**
 * Download consistent SQLite database backup snapshot (Admin only)
 */
router.get('/admin/backup-db', requireAdmin, async (req, res) => {
  try {
    const tempBackupPath = path.join(os.tmpdir(), `baseball_backup_${Date.now()}.db`);
    await db.backup(tempBackupPath);
    const dateStr = new Date().toISOString().slice(0, 10);
    res.download(tempBackupPath, `baseball_charity_${dateStr}.db`, (err) => {
      try {
        if (fs.existsSync(tempBackupPath)) fs.unlinkSync(tempBackupPath);
      } catch (e) {}
    });
  } catch (err) {
    console.error('[Events] Error creating DB backup:', err);
    res.status(500).json({ error: 'Failed to create database backup.' });
  }
});

/**
 * Periodic reminder trigger endpoint (can be called by cron-job.org or internal scheduler)
 */
router.all('/reminders/check', async (req, res) => {
  try {
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret && req.headers['x-cron-secret'] !== cronSecret && req.query.secret !== cronSecret) {
      return res.status(401).json({ error: 'Unauthorized cron request.' });
    }

    const { processUpcomingEventReminders } = require('../reminders');
    await processUpcomingEventReminders();
    res.json({ success: true, message: 'Upcoming reminder check completed.' });
  } catch (err) {
    console.error('[Reminders] Error during check endpoint:', err);
    res.status(500).json({ error: 'Failed to process reminders.' });
  }
});

/**
 * Helper: Parse allowed email addresses from JSON or delimited text
 */
function parseAllowedEmails(raw) {
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

/**
 * Helper: Calculate task unlock timestamp for an event.
 * Tasks unlock at 5:00 AM on Monday, 12 weeks prior to the event (83 days prior to Sunday game).
 */
function getTaskUnlockAt(eventDateStr) {
  const d = new Date(eventDateStr);
  const target = new Date(d.getTime() - (83 * 24 * 3600 * 1000));
  const datePart = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(target);
  const testPst = new Date(datePart + 'T05:00:00-08:00');
  const tzCheck = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', timeZoneName: 'short' }).format(testPst);
  const isPdt = tzCheck.includes('PDT');
  return new Date(datePart + (isPdt ? 'T05:00:00-07:00' : 'T05:00:00-08:00')).toISOString();
}

/**
 * Helper: Format an ISO timestamp nicely in Pacific Time
 */
function formatUnlockDateTime(isoStr) {
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

/**
 * Helper: Determine current scheduling tier for an event.
 * - 'locked': before 5:00 AM Monday, 12 weeks prior
 * - 'tier1': Weeks 12 to 6 prior (fair-share cap applies)
 * - 'tier2': Weeks 6 to 2 prior (open to all badged workers)
 * - 'tier3': Within 2 weeks of game day (standby / urgent cover <48h earns hero credit)
 */
function getTaskTier(eventDateStr, now) {
  const unlockIso = getTaskUnlockAt(eventDateStr);
  const unlockTime = new Date(unlockIso).getTime();
  const eventTime = new Date(eventDateStr).getTime();
  const nowTime = (now || new Date()).getTime();

  if (nowTime < unlockTime) {
    return {
      tier: 'locked',
      isUnlocked: false,
      unlockAt: unlockIso
    };
  }

  const tier2Time = eventTime - (42 * 24 * 3600 * 1000);
  if (nowTime < tier2Time) {
    return {
      tier: 'tier1',
      isUnlocked: true,
      unlockAt: unlockIso
    };
  }

  const tier3Time = eventTime - (14 * 24 * 3600 * 1000);
  if (nowTime < tier3Time) {
    return {
      tier: 'tier2',
      isUnlocked: true,
      unlockAt: unlockIso
    };
  }

  return {
    tier: 'tier3',
    isUnlocked: true,
    unlockAt: unlockIso
  };
}

/**
 * Helper: Detect whether a duty is a certified paid role ('machine' | 'field') or general
 */
function getDutyType(title) {
  const lower = (title || '').toLowerCase();
  if (lower.includes('machine')) {
    return {
      type: 'machine',
      isPaid: true,
      requiredBadge: 'machine_badge',
      badgeName: 'Pitching Machine Badge'
    };
  }
  if (lower.includes('drag')) {
    return {
      type: 'field',
      isPaid: true,
      requiredBadge: 'field_badge',
      badgeName: 'Field Dragging Badge'
    };
  }
  return {
    type: 'general',
    isPaid: false,
    requiredBadge: null,
    badgeName: null
  };
}

/**
 * Helper: Calculate rolling 3-month fair-share cap for a duty type: floor(24 / (2n)) = floor(12 / n)
 */
function getDutyTier1Cap(dutyType) {
  const badgeCol = dutyType === 'machine' ? 'machine_badge' : 'field_badge';
  const row = db.prepare(`SELECT COUNT(*) as count FROM users WHERE ${badgeCol} = 1`).get();
  const n = Math.max(1, (row ? row.count : 0));
  return Math.max(1, Math.floor(12 / n));
}

/**
 * Helper: Count how many shifts of this duty type user has in the rolling 12-week (84-day) window
 */
function getUserRollingShifts(userId, dutyType, targetEventDate, targetEventId) {
  const likePattern = dutyType === 'machine' ? '%machine%' : '%drag%';
  const row = db.prepare(`
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
  `).get(userId, targetEventId || 0, likePattern, targetEventDate);
  return row ? row.count : 0;
}

/**
 * Get potential allowed players (registered user accounts) for event whitelist
 */
router.get('/attendee-candidates', requireEventCreator, (req, res) => {
  try {
    const users = db.prepare('SELECT id, name, email FROM users ORDER BY name ASC').all();
    res.json({ users });
  } catch (err) {
    console.error('[Events] Error fetching candidate accounts:', err);
    res.status(500).json({ error: 'Failed to fetch candidate accounts.' });
  }
});

/**
 * Helper: Escape text values per RFC 5545 iCalendar specification
 */
function escapeIcsText(str) {
  return String(str || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

function formatIcsUtcDate(d) {
  const pad = n => String(n).padStart(2, '0');
  return d.getUTCFullYear() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) + 'T' +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) + 'Z';
}

/**
 * Live iCalendar (.ics) subscription feed for Apple Calendar, Google Calendar, & Outlook
 * Public endpoint: excludes restricted private/invitational games and contains zero player PII.
 */
router.get('/calendar.ics', (req, res) => {
  try {
    const allEvents = db.prepare(`
      SELECT id, title, description, location, event_date, status, rainout_note, allowed_emails, created_at
      FROM events
      WHERE status IN ('active', 'rainout')
      ORDER BY event_date ASC
    `).all();

    // Only publish unrestricted community events to the anonymous public calendar feed
    const publicEvents = allEvents.filter(ev => parseAllowedEmails(ev.allowed_emails).length === 0);

    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    const host = req.get('host') || 'www.pickupbaseballfoundation.org';
    const origin = `${proto}://${host}`;
    const nowStamp = formatIcsUtcDate(new Date());

    const icsLines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Pickup Baseball Foundation//NONSGML Pickup Baseball Calendar//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'X-WR-CALNAME:Sunday Pickup Baseball',
      'X-WR-CALDESC:Live game schedule from Pickup Baseball Foundation (www.pickupbaseballfoundation.org)',
      'X-WR-TIMEZONE:America/Los_Angeles',
      'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
      'X-PUBLISHED-TTL:PT1H'
    ];

    for (const ev of publicEvents) {
      const startDate = new Date(ev.event_date);
      if (isNaN(startDate.getTime())) continue;
      const endDate = new Date(startDate.getTime() + 3 * 60 * 60 * 1000);
      const isRainout = ev.status === 'rainout';
      const baseTitle = ev.title || 'Sunday Pickup Baseball - Noon Game';
      const summary = isRainout ? `🌧️ RAINED OUT: ${baseTitle}` : baseTitle;
      const eventUrl = `${origin}/event.html?id=${ev.id}`;
      const descParts = [];
      if (isRainout) {
        descParts.push(ev.rainout_note ? `RAINED OUT — "${ev.rainout_note}"` : 'RAINED OUT — Check event page for field updates.');
      } else {
        descParts.push('Free community pickup baseball. Check live roster, coordinate gear & volunteer for tasks:');
      }
      descParts.push(eventUrl);
      if (ev.description && ev.description.trim()) {
        descParts.push(ev.description.trim());
      }

      icsLines.push('BEGIN:VEVENT');
      icsLines.push(`UID:pickup-baseball-event-${ev.id}@pickupbaseballfoundation.org`);
      icsLines.push(`DTSTAMP:${nowStamp}`);
      icsLines.push(`DTSTART:${formatIcsUtcDate(startDate)}`);
      icsLines.push(`DTEND:${formatIcsUtcDate(endDate)}`);
      icsLines.push(`SUMMARY:${escapeIcsText(summary)}`);
      icsLines.push(`LOCATION:${escapeIcsText(ev.location || 'Bushrod Park Field 1, Oakland, CA')}`);
      icsLines.push(`DESCRIPTION:${escapeIcsText(descParts.join('\n\n'))}`);
      icsLines.push(`URL:${eventUrl}`);
      icsLines.push('STATUS:CONFIRMED');
      icsLines.push('END:VEVENT');
    }

    icsLines.push('END:VCALENDAR');

    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline; filename="pickup-baseball-schedule.ics"');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.send(icsLines.join('\r\n') + '\r\n');
  } catch (err) {
    console.error('[Events] Error generating live calendar.ics feed:', err);
    res.status(500).send('Failed to generate calendar feed.');
  }
});

/**
 * Get single event details with duties, attendees, and comments
 */
router.get('/:id', optionalUser, (req, res) => {
  try {
    const eventId = req.params.id;
    const token = req.query.token; // guest management token if present

    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
    if (!event) {
      return res.status(404).json({ error: 'Event not found.' });
    }

    // Fetch duties and their assigned players
    const duties = db.prepare(`
      SELECT d.*,
        COALESCE((
          SELECT json_group_array(json_object('attendee_id', a.id, 'name', a.name, 'avatar_url', u.avatar_url))
          FROM duty_assignments da
          JOIN attendees a ON da.attendee_id = a.id
          LEFT JOIN users u ON a.user_id = u.id
          WHERE da.duty_id = d.id AND a.status = 'attending'
        ), '[]') as assigned_players
      FROM event_duties d
      WHERE d.event_id = ?
      ORDER BY d.sort_order ASC, d.id ASC
    `).all(eventId).map(d => ({
      ...d,
      assigned_players: JSON.parse(d.assigned_players || '[]')
    }));

    // Fetch confirmed attendees
    const attendees = db.prepare(`
      SELECT a.id, a.name, a.status, a.gear_bringing,
        COALESCE(a.players_count, 1 + COALESCE(a.additional_guests, 0)) as players_count,
        COALESCE(a.spectators_count, 0) as spectators_count,
        a.additional_guests, a.guest_names, a.is_guest, a.created_at,
        u.bio, u.avatar_url,
        (
          SELECT group_concat(d.title, ', ')
          FROM duty_assignments da
          JOIN event_duties d ON da.duty_id = d.id
          WHERE da.attendee_id = a.id
        ) as duties_assigned
      FROM attendees a
      LEFT JOIN users u ON a.user_id = u.id
      WHERE a.event_id = ? AND a.status = 'attending'
      ORDER BY a.created_at ASC
    `).all(eventId);

    // Fetch waitlisted attendees in signup order
    const waitlist = db.prepare(`
      SELECT a.id, a.name, a.status,
        COALESCE(a.players_count, 1 + COALESCE(a.additional_guests, 0)) as players_count,
        COALESCE(a.spectators_count, 0) as spectators_count,
        a.additional_guests, a.guest_names, a.is_guest, a.created_at,
        u.bio, u.avatar_url
      FROM attendees a
      LEFT JOIN users u ON a.user_id = u.id
      WHERE a.event_id = ? AND a.status = 'waitlist'
      ORDER BY a.created_at ASC, a.id ASC
    `).all(eventId);

    // Fetch comments
    const comments = db.prepare(`
      SELECT c.id, c.author_name, c.content, c.created_at, c.user_id,
        u.avatar_url, u.bio
      FROM comments c
      LEFT JOIN users u ON c.user_id = u.id
      WHERE c.event_id = ?
      ORDER BY c.created_at ASC
    `).all(eventId);

    // Determine current viewer's RSVP if any
    let myRsvp = null;
    if (req.user) {
      myRsvp = db.prepare(`
        SELECT a.*,
          (SELECT json_group_array(duty_id) FROM duty_assignments WHERE attendee_id = a.id) as duty_ids
        FROM attendees a
        WHERE a.event_id = ? AND (a.user_id = ? OR a.email = ?)
      `).get(eventId, req.user.id, req.user.email);
    } else if (token) {
      myRsvp = db.prepare(`
        SELECT a.*,
          (SELECT json_group_array(duty_id) FROM duty_assignments WHERE attendee_id = a.id) as duty_ids
        FROM attendees a
        WHERE a.event_id = ? AND a.management_token = ?
      `).get(eventId, token);
    }

    if (myRsvp) {
      myRsvp.duty_ids = JSON.parse(myRsvp.duty_ids || '[]');
    }

    const isOrganizer = Boolean(req.user && (req.user.canManageEvents || req.user.isAdmin));
    const hasRsvpd = Boolean(myRsvp && (myRsvp.status === 'attending' || myRsvp.status === 'declined' || myRsvp.status === 'waitlist'));
    const canViewRoster = Boolean(hasRsvpd || isOrganizer);

    const tierInfo = getTaskTier(event.event_date);
    const viewerId = req.user ? req.user.id : (myRsvp && myRsvp.user_id ? myRsvp.user_id : null);
    const viewerUser = viewerId ? db.prepare('SELECT id, machine_badge, field_badge, hero_credits FROM users WHERE id = ?').get(viewerId) : null;
    const hoursUntilEvent = (new Date(event.event_date).getTime() - Date.now()) / (3600 * 1000);
    const isUrgentCoverWindow = hoursUntilEvent > 0 && hoursUntilEvent < 48;

    if (myRsvp && viewerUser) {
      myRsvp.hero_credits = viewerUser.hero_credits || 0;
      myRsvp.machine_badge = viewerUser.machine_badge || 0;
      myRsvp.field_badge = viewerUser.field_badge || 0;
    }

    const enrichedDuties = duties.map(d => {
      const dType = getDutyType(d.title);
      let userHasBadge = false;
      let isEligible = true;
      let ineligibilityReason = null;
      let canUseHeroCredit = false;
      let tier1Cap = null;
      let userCurrentShifts = 0;

      if (!tierInfo.isUnlocked) {
        isEligible = false;
        ineligibilityReason = `Tasks locked until ${formatUnlockDateTime(tierInfo.unlockAt)}`;
      } else if (dType.isPaid) {
        tier1Cap = getDutyTier1Cap(dType.type);
        if (viewerUser) {
          userHasBadge = dType.type === 'machine' ? Boolean(viewerUser.machine_badge) : Boolean(viewerUser.field_badge);
          if (!userHasBadge) {
            isEligible = false;
            ineligibilityReason = `Requires ${dType.badgeName}`;
          } else {
            userCurrentShifts = getUserRollingShifts(viewerUser.id, dType.type, event.event_date, event.id);
            if (tierInfo.tier === 'tier1') {
              if (userCurrentShifts >= tier1Cap) {
                if ((viewerUser.hero_credits || 0) >= 1) {
                  isEligible = true;
                  canUseHeroCredit = true;
                  ineligibilityReason = `Tier 1 cap reached (${tier1Cap} shifts). Redeem 1 Backup Hero Credit to select early.`;
                } else {
                  isEligible = false;
                  canUseHeroCredit = false;
                  ineligibilityReason = `Tier 1 cap reached (${tier1Cap} shifts). Opens in Tier 2 (6 weeks before game) or requires 1 Backup Hero Credit.`;
                }
              }
            }
          }
        } else {
          isEligible = false;
          ineligibilityReason = `Sign in with a certified badged account to select paid tasks.`;
        }
      }

      return {
        ...d,
        duty_type: dType.type,
        is_paid: dType.isPaid,
        requires_badge: dType.requiredBadge,
        badge_name: dType.badgeName,
        user_has_badge: userHasBadge,
        is_eligible: isEligible,
        ineligibility_reason: ineligibilityReason,
        can_use_hero_credit: canUseHeroCredit,
        tier1_cap: tier1Cap,
        user_current_shifts: userCurrentShifts,
        is_urgent_cover: isUrgentCoverWindow && dType.isPaid
      };
    });

    // Sanitize duties: hide volunteer names if viewer is not authorized to view the roster, but preserve slot counts
    const sanitizedDuties = enrichedDuties.map(d => ({
      ...d,
      assigned_players: canViewRoster
        ? d.assigned_players
        : (d.assigned_players || []).map(p => ({ attendee_id: p.attendee_id, name: '' }))
    }));

    const allowedList = parseAllowedEmails(event.allowed_emails);
    const isRestricted = allowedList.length > 0;
    let isAllowedToRsvp = true;
    if (isRestricted) {
      if (req.user && (req.user.canManageEvents || req.user.isAdmin)) {
        isAllowedToRsvp = true;
      } else if (req.user && req.user.email) {
        isAllowedToRsvp = allowedList.includes(req.user.email.toLowerCase());
      } else if (myRsvp && myRsvp.email) {
        isAllowedToRsvp = allowedList.includes(myRsvp.email.toLowerCase());
      } else {
        isAllowedToRsvp = false;
      }
    }

    const totalConfirmedPlayers = attendees.reduce((sum, a) => sum + (a.players_count != null ? a.players_count : (1 + (a.additional_guests || 0))), 0);
    const totalConfirmedSpectators = attendees.reduce((sum, a) => sum + (a.spectators_count || 0), 0);
    const totalWaitlistPlayers = waitlist.reduce((sum, w) => sum + (w.players_count != null ? w.players_count : (1 + (w.additional_guests || 0))), 0);

    res.json({
      event: {
        ...event,
        allowed_emails_list: allowedList,
        is_restricted: isRestricted,
        is_allowed_to_rsvp: isAllowedToRsvp,
        task_unlock_at: tierInfo.unlockAt,
        task_tier: tierInfo.tier,
        is_tasks_unlocked: tierInfo.isUnlocked,
        hours_until_event: hoursUntilEvent
      },
      duties: sanitizedDuties,
      attendees: canViewRoster ? attendees : [],
      waitlist: canViewRoster ? waitlist : [],
      comments,
      myRsvp,
      canViewRoster,
      totalAttendees: totalConfirmedPlayers,
      totalSpectators: totalConfirmedSpectators,
      totalHeadcount: totalConfirmedPlayers + totalConfirmedSpectators,
      totalWaitlist: totalWaitlistPlayers
    });
  } catch (err) {
    console.error('[Events] Error fetching event details:', err);
    res.status(500).json({ error: 'Failed to fetch event details.' });
  }
});

/**
 * Helper: Automatically promote the next waitlisted player if capacity allows.
 */
function promoteNextWaitlistedPlayer(eventId) {
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  if (!event || event.status === 'rainout') return null;

  let firstPromoted = null;
  while (true) {
    const activeRow = db.prepare(`
      SELECT COALESCE(SUM(COALESCE(players_count, 1 + COALESCE(additional_guests, 0))), 0) as total
      FROM attendees WHERE event_id = ? AND status = 'attending'
    `).get(eventId);
    const activeCount = activeRow ? activeRow.total : 0;

    if (event.max_players && activeCount >= event.max_players) {
      break; // Roster is at capacity
    }

    const availableSlots = event.max_players ? (event.max_players - activeCount) : 999;

    // Get the earliest waitlisted attendee
    const nextWaitlisted = db.prepare(`
      SELECT * FROM attendees
      WHERE event_id = ? AND status = 'waitlist'
      ORDER BY created_at ASC, id ASC
      LIMIT 1
    `).get(eventId);

    if (!nextWaitlisted) break;

    const partyPlayers = nextWaitlisted.players_count != null
      ? nextWaitlisted.players_count
      : (1 + (nextWaitlisted.additional_guests || 0));
    // If party player size exceeds available slots, do not overfill
    if (event.max_players && partyPlayers > availableSlots) {
      break;
    }

    // Promote to attending
    db.prepare(`
      UPDATE attendees SET status = 'attending' WHERE id = ?
    `).run(nextWaitlisted.id);

    if (!firstPromoted) firstPromoted = nextWaitlisted;

    console.log(`[Waitlist Promotion] Automatically promoted ${nextWaitlisted.name} (${nextWaitlisted.email}) for event ${eventId}`);

    // Send promotion email
    sendWaitlistPromotionEmail({
      email: nextWaitlisted.email,
      name: nextWaitlisted.name,
      event,
      managementToken: nextWaitlisted.management_token
    }).catch(err => {
      console.error('[Waitlist] Failed to dispatch promotion email:', err);
    });
  }

  return firstPromoted;
}

/**
 * RSVP for an event (handles players, spectators, and group volunteer tasks)
 */
router.post('/:id/rsvp', optionalUser, async (req, res) => {
  try {
    const eventId = req.params.id;
    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
    if (!event) {
      return res.status(404).json({ error: 'Event not found.' });
    }

    let {
      name,
      email,
      gear_bringing,
      duty_ids,
      management_token,
      status,
      players_count,
      spectators_count,
      additional_guests,
      guest_names
    } = req.body;
    status = status === 'declined' ? 'declined' : 'attending';

    let playersCount = 1;
    let spectatorsCount = 0;

    if (status === 'declined') {
      playersCount = 0;
      spectatorsCount = 0;
    } else if (players_count !== undefined || spectators_count !== undefined) {
      const parsedPlayers = players_count !== undefined ? parseInt(players_count, 10) : 0;
      const parsedSpectators = spectators_count !== undefined ? parseInt(spectators_count, 10) : 0;
      playersCount = isNaN(parsedPlayers) ? 0 : Math.max(0, Math.min(25, parsedPlayers));
      spectatorsCount = isNaN(parsedSpectators) ? 0 : Math.max(0, Math.min(25, parsedSpectators));

      if (playersCount === 0 && spectatorsCount === 0) {
        if (Array.isArray(duty_ids) && duty_ids.length > 0) {
          spectatorsCount = 1;
        } else {
          return res.status(400).json({ error: 'Please include at least 1 player, spectator, or volunteer task in your RSVP.' });
        }
      }
    } else {
      let legacyGuests = parseInt(additional_guests, 10);
      if (isNaN(legacyGuests) || legacyGuests < 0) {
        legacyGuests = 0;
      } else if (legacyGuests > 20) {
        legacyGuests = 20;
      }
      playersCount = 1 + legacyGuests;
      spectatorsCount = 0;
    }

    const additionalGuests = status === 'declined' ? 0 : Math.max(0, playersCount - 1);
    const cleanGuestNames = status === 'declined' ? '' : (guest_names || '').trim().slice(0, 500);

    if (event.status === 'rainout' && status === 'attending') {
      return res.status(400).json({ error: 'RSVPs are closed because this game has been called for rain.' });
    }

    let userId = req.user ? req.user.id : null;
    let isGuest = req.user ? 0 : 1;

    if (req.user) {
      name = name || req.user.name;
      email = req.user.email;
    } else {
      if (!name || !name.trim()) {
        return res.status(400).json({ error: 'Your name is required to RSVP.' });
      }
      if (!email || !email.includes('@')) {
        return res.status(400).json({ error: 'A valid email address is required.' });
      }
      name = name.trim();
      email = email.trim().toLowerCase();

      // Check if this email belongs to a registered user
      const existingUser = db.prepare('SELECT id, name FROM users WHERE email = ?').get(email);
      if (existingUser) {
        userId = existingUser.id;
        isGuest = 0;
      }
    }

    const allowedList = parseAllowedEmails(event.allowed_emails);
    if (allowedList.length > 0 && status === 'attending') {
      const isOrganizer = Boolean(req.user && (req.user.canManageEvents || req.user.isAdmin));
      if (!isOrganizer && !allowedList.includes(email.toLowerCase())) {
        return res.status(403).json({ error: 'RSVP for this game is restricted to invited player accounts. Your email is not on the allowed list.' });
      }
    }

    // Generate management token for easy access via email
    const mgmtToken = management_token || crypto.randomBytes(24).toString('hex');

    // Check if attendee already exists for this event
    const existingAttendee = db.prepare(`
      SELECT * FROM attendees WHERE event_id = ? AND email = ?
    `).get(eventId, email);

    const wasAttending = existingAttendee && existingAttendee.status === 'attending';
    const prevPlayersCount = existingAttendee
      ? (existingAttendee.players_count != null ? existingAttendee.players_count : (1 + (existingAttendee.additional_guests || 0)))
      : 0;

    let finalStatus = status;
    let waitlistPos = 0;

    if (status === 'attending' && playersCount > 0) {
      // Only on-field players count toward max_players capacity; spectators & off-field volunteers never consume player slots
      if (event.max_players && event.max_players > 0) {
        const activeRow = db.prepare(`
          SELECT COALESCE(SUM(COALESCE(players_count, 1 + COALESCE(additional_guests, 0))), 0) as total
          FROM attendees
          WHERE event_id = ? AND status = 'attending' AND email != ?
        `).get(eventId, email);

        const currentOtherPlayers = activeRow ? activeRow.total : 0;

        if (currentOtherPlayers + playersCount > event.max_players) {
          finalStatus = 'waitlist';
        }
      }
    }

    const tierInfo = getTaskTier(event.event_date);
    if (status === 'attending' && Array.isArray(duty_ids) && duty_ids.length > 0) {
      if (!tierInfo.isUnlocked) {
        return res.status(400).json({
          error: `Volunteer tasks for this game are locked until ${formatUnlockDateTime(tierInfo.unlockAt)} (12 weeks before first pitch).`
        });
      }

      let attendeeUser = null;
      if (userId) {
        attendeeUser = db.prepare('SELECT id, machine_badge, field_badge, hero_credits FROM users WHERE id = ?').get(userId);
      }

      let creditsNeeded = 0;
      for (const dId of duty_ids) {
        const duty = db.prepare('SELECT * FROM event_duties WHERE id = ? AND event_id = ?').get(dId, eventId);
        if (!duty) continue;
        const dType = getDutyType(duty.title);
        if (dType.isPaid) {
          if (!attendeeUser) {
            return res.status(400).json({
              error: `Selecting paid tasks (${duty.title}) requires signing in with a certified badged account.`
            });
          }
          const hasBadge = dType.type === 'machine' ? Boolean(attendeeUser.machine_badge) : Boolean(attendeeUser.field_badge);
          if (!hasBadge) {
            return res.status(400).json({
              error: `Selecting '${duty.title}' requires the ${dType.badgeName}. Contact an administrator to be certified.`
            });
          }
          if (tierInfo.tier === 'tier1') {
            const cap = getDutyTier1Cap(dType.type);
            const userShifts = getUserRollingShifts(attendeeUser.id, dType.type, event.event_date, eventId);
            if (userShifts >= cap) {
              if (!req.body.redeem_hero_credit) {
                return res.status(400).json({
                  error: `Tier 1 rolling 3-month fair-share cap reached (${cap} shifts). You have ${attendeeUser.hero_credits || 0} Backup Hero Credit(s). Check 'Redeem 1 Backup Hero Credit' to claim this shift early.`
                });
              }
              if ((attendeeUser.hero_credits || 0) < 1) {
                return res.status(400).json({
                  error: `Tier 1 fair-share cap reached (${cap} shifts) and you do not have any Backup Hero Credits available.`
                });
              }
              creditsNeeded += 1;
            }
          }
        }
      }

      if (creditsNeeded > 0 && (attendeeUser.hero_credits || 0) < creditsNeeded) {
        return res.status(400).json({
          error: `Insufficient Backup Hero Credits. You need ${creditsNeeded} credit(s) but have ${attendeeUser.hero_credits || 0}.`
        });
      }
    }

    let attendeeId;
    if (existingAttendee) {
      if (!req.user && existingAttendee.management_token && management_token && management_token !== existingAttendee.management_token) {
        return res.status(403).json({ error: 'Invalid management token provided for this RSVP.' });
      }
      attendeeId = existingAttendee.id;
      db.prepare(`
        UPDATE attendees
        SET name = ?, status = ?, gear_bringing = ?, players_count = ?, spectators_count = ?, additional_guests = ?, guest_names = ?, user_id = COALESCE(?, user_id), is_guest = ?
        WHERE id = ?
      `).run(name, finalStatus, (gear_bringing || '').trim(), playersCount, spectatorsCount, additionalGuests, cleanGuestNames, userId, isGuest, attendeeId);
    } else {
      const result = db.prepare(`
        INSERT INTO attendees (event_id, user_id, name, email, is_guest, status, gear_bringing, players_count, spectators_count, additional_guests, guest_names, management_token)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(eventId, userId, name, email, isGuest, finalStatus, (gear_bringing || '').trim(), playersCount, spectatorsCount, additionalGuests, cleanGuestNames, mgmtToken);
      attendeeId = result.lastInsertRowid;
    }

    // Handle group task assignments: any confirmed attending group (players, spectators, or off-field volunteers) can hold task slots
    const assignedDutyNames = [];
    let heroCreditEarned = false;
    let heroCreditRedeemed = false;
    const hoursUntilEvent = (new Date(event.event_date).getTime() - Date.now()) / (3600 * 1000);
    const isUrgentWindow = hoursUntilEvent > 0 && hoursUntilEvent < 48;

    const prevDuties = attendeeId
      ? db.prepare('SELECT duty_id FROM duty_assignments WHERE attendee_id = ?').all(attendeeId).map(r => r.duty_id)
      : [];

    if (finalStatus === 'attending' && Array.isArray(duty_ids)) {
      db.prepare('DELETE FROM duty_assignments WHERE attendee_id = ?').run(attendeeId);

      for (const dId of duty_ids) {
        const duty = db.prepare('SELECT * FROM event_duties WHERE id = ? AND event_id = ?').get(dId, eventId);
        if (duty) {
          const currentCount = db.prepare(`
            SELECT COUNT(*) as count FROM duty_assignments da
            JOIN attendees a ON da.attendee_id = a.id
            WHERE da.duty_id = ? AND a.status = 'attending' AND a.id != ?
          `).get(dId, attendeeId).count;

          if (currentCount < duty.slots_needed) {
            db.prepare(`
              INSERT OR IGNORE INTO duty_assignments (duty_id, attendee_id)
              VALUES (?, ?)
            `).run(dId, attendeeId);
            assignedDutyNames.push(duty.title);

            const dType = getDutyType(duty.title);
            if (dType.isPaid && userId) {
              if (tierInfo.tier === 'tier1' && req.body.redeem_hero_credit && !heroCreditRedeemed) {
                const cap = getDutyTier1Cap(dType.type);
                const shifts = getUserRollingShifts(userId, dType.type, event.event_date, eventId);
                if (shifts >= cap) {
                  db.prepare('UPDATE users SET hero_credits = MAX(0, hero_credits - 1) WHERE id = ?').run(userId);
                  heroCreditRedeemed = true;
                }
              }
              if (isUrgentWindow && !prevDuties.includes(dId) && !heroCreditEarned) {
                db.prepare('UPDATE users SET hero_credits = hero_credits + 1 WHERE id = ?').run(userId);
                heroCreditEarned = true;
              }
            }
          }
        }
      }
    } else if (finalStatus !== 'attending') {
      // Clear duties if declined or waitlisted
      db.prepare('DELETE FROM duty_assignments WHERE attendee_id = ?').run(attendeeId);
    }

    // If active player declined/cancelled or reduced on-field player count, trigger waitlist promotion!
    if (wasAttending && (status === 'declined' || finalStatus === 'waitlist' || prevPlayersCount > playersCount)) {
      promoteNextWaitlistedPlayer(eventId);
    }

    // Send notifications
    if (finalStatus === 'waitlist') {
      waitlistPos = db.prepare(`
        SELECT COUNT(*) as count FROM attendees
        WHERE event_id = ? AND status = 'waitlist' AND (created_at < (SELECT created_at FROM attendees WHERE id = ?) OR (created_at = (SELECT created_at FROM attendees WHERE id = ?) AND id <= ?))
      `).get(eventId, attendeeId, attendeeId, attendeeId).count;

      sendWaitlistConfirmation({
        email,
        name,
        event,
        waitlistPosition: waitlistPos,
        playersCount,
        spectatorsCount,
        additionalGuests,
        guestNames: cleanGuestNames,
        managementToken: existingAttendee ? (existingAttendee.management_token || mgmtToken) : mgmtToken
      }).catch(err => {
        console.error('[Waitlist] Failed to dispatch confirmation email:', err);
      });

      return res.json({
        success: true,
        status: 'waitlist',
        waitlistPosition: waitlistPos,
        playersCount,
        spectatorsCount,
        managementToken: existingAttendee ? (existingAttendee.management_token || mgmtToken) : mgmtToken,
        message: `The playing roster is full (${event.max_players} players), so your group is #${waitlistPos} on the player waitlist! If a spot opens up, you will be automatically promoted and notified immediately.`
      });
    }

    if (finalStatus === 'attending') {
      sendRsvpConfirmation({
        email,
        name,
        event,
        dutyName: assignedDutyNames.join(', '),
        gearBringing: (gear_bringing || '').trim(),
        playersCount,
        spectatorsCount,
        additionalGuests,
        guestNames: cleanGuestNames,
        managementToken: existingAttendee ? (existingAttendee.management_token || mgmtToken) : mgmtToken
      }).catch(err => {
        console.error('[RSVP] Failed to dispatch confirmation email:', err);
      });

      let confirmMsg = `You're confirmed! A confirmation email has been sent to ${email}.`;
      if (playersCount > 0 && spectatorsCount > 0) {
        confirmMsg = `RSVP confirmed (${playersCount} ${playersCount === 1 ? 'player' : 'players'}, ${spectatorsCount} ${spectatorsCount === 1 ? 'spectator' : 'spectators'})! Confirmation sent to ${email}.`;
      } else if (playersCount === 0 && spectatorsCount > 0) {
        const label = assignedDutyNames.length > 0
          ? (spectatorsCount === 1 ? 'volunteer' : 'volunteers/spectators')
          : (spectatorsCount === 1 ? 'spectator' : 'spectators');
        confirmMsg = `RSVP confirmed (${spectatorsCount} ${label})! Confirmation sent to ${email}.`;
      }

      if (heroCreditEarned) {
        confirmMsg += ' 🛡️ Short-notice urgent shift cover (<48 hrs): +1 Backup Hero Credit awarded!';
      }
      if (heroCreditRedeemed) {
        confirmMsg += ' 🛡️ 1 Backup Hero Credit redeemed for Tier 1 early access.';
      }

      return res.json({
        success: true,
        status: 'attending',
        playersCount,
        spectatorsCount,
        managementToken: existingAttendee ? (existingAttendee.management_token || mgmtToken) : mgmtToken,
        message: confirmMsg
      });
    }

    // Declined
    res.json({
      success: true,
      status: 'declined',
      playersCount: 0,
      spectatorsCount: 0,
      managementToken: existingAttendee ? (existingAttendee.management_token || mgmtToken) : mgmtToken,
      message: 'Your RSVP has been cancelled.'
    });
  } catch (err) {
    console.error('[RSVP] Error updating RSVP:', err);
    res.status(500).json({ error: 'Failed to record RSVP.' });
  }
});

/**
 * Add comment to event discussion
 */
router.post('/:id/comments', optionalUser, (req, res) => {
  try {
    const eventId = req.params.id;
    const event = db.prepare('SELECT id FROM events WHERE id = ?').get(eventId);
    if (!event) {
      return res.status(404).json({ error: 'Event not found.' });
    }

    const { content, author_name, author_email } = req.body;

    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'Comment message cannot be empty.' });
    }

    let name = '';
    let email = '';
    let userId = null;

    if (req.user) {
      name = req.user.name;
      email = req.user.email;
      userId = req.user.id;
    } else {
      name = (author_name || '').trim();
      email = (author_email || '').trim().toLowerCase();
      if (!name) {
        return res.status(400).json({ error: 'Please enter your name to post a comment.' });
      }
    }

    const result = db.prepare(`
      INSERT INTO comments (event_id, user_id, author_name, author_email, content)
      VALUES (?, ?, ?, ?, ?)
    `).run(eventId, userId, name, email || 'guest', content.trim());

    const newComment = db.prepare('SELECT * FROM comments WHERE id = ?').get(result.lastInsertRowid);

    res.json({
      success: true,
      comment: newComment
    });
  } catch (err) {
    console.error('[Comments] Error posting comment:', err);
    res.status(500).json({ error: 'Failed to post comment.' });
  }
});

/**
 * Create new event (Admin or Organizer)
 */
router.post('/', requireEventCreator, (req, res) => {
  try {
    const {
      title,
      description,
      location,
      location_url,
      event_date,
      max_players,
      actual_attendance,
      use_default_duties,
      custom_duties,
      allowed_emails
    } = req.body;

    if (!title || !title.trim() || !location || !location.trim() || !event_date) {
      return res.status(400).json({ error: 'Title, location, and event date/time are required.' });
    }

    if (isNaN(new Date(event_date).getTime())) {
      return res.status(400).json({ error: 'A valid event date/time is required.' });
    }

    // Determine duties to insert
    let dutiesToInsert = [];
    if (use_default_duties || (!custom_duties || custom_duties.length === 0)) {
      dutiesToInsert = getDefaultDuties();
    } else if (Array.isArray(custom_duties)) {
      for (const d of custom_duties) {
        if (!d || !d.title || !d.title.trim()) {
          return res.status(400).json({ error: 'All custom duties must have a non-empty title.' });
        }
      }
      dutiesToInsert = custom_duties;
    } else {
      dutiesToInsert = getDefaultDuties();
    }

    const allowedList = parseAllowedEmails(allowed_emails);
    const allowedEmailsJson = allowedList.length > 0 ? JSON.stringify(allowedList) : null;

    // Wrap event creation and duty insertions in an atomic SQLite transaction
    const createEventTxn = db.transaction((eventData, duties) => {
      const result = db.prepare(`
        INSERT INTO events (title, description, location, location_url, event_date, max_players, actual_attendance, allowed_emails, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        eventData.title.trim(),
        (eventData.description || '').trim(),
        eventData.location.trim(),
        (eventData.location_url || '').trim(),
        eventData.event_date,
        eventData.max_players ? parseInt(eventData.max_players, 10) : null,
        eventData.actual_attendance !== undefined && eventData.actual_attendance !== null && eventData.actual_attendance !== '' ? parseInt(eventData.actual_attendance, 10) : null,
        eventData.allowed_emails || null,
        eventData.userId
      );

      const eventId = result.lastInsertRowid;

      const insertDuty = db.prepare(`
        INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
        VALUES (?, ?, ?, ?, ?)
      `);

      duties.forEach((d, idx) => {
        insertDuty.run(
          eventId,
          d.title.trim(),
          (d.description || '').trim(),
          parseInt(d.slots_needed || 1, 10),
          d.sort_order !== undefined ? parseInt(d.sort_order, 10) : idx
        );
      });

      return eventId;
    });

    const eventId = createEventTxn({
      title,
      description,
      location,
      location_url,
      event_date,
      max_players,
      actual_attendance,
      allowed_emails: allowedEmailsJson,
      userId: req.user.id
    }, dutiesToInsert);

    const newEvent = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);

    res.json({
      success: true,
      eventId,
      event: newEvent,
      message: 'Event created successfully.'
    });
  } catch (err) {
    console.error('[Events] Error creating event:', err);
    res.status(500).json({ error: 'Failed to create event.' });
  }
});

/**
 * Update event (Admin or Organizer)
 */
router.put('/:id', requireEventCreator, (req, res) => {
  try {
    const eventId = req.params.id;
    const { title, description, location, location_url, event_date, max_players, actual_attendance, status, allowed_emails } = req.body;

    const existingEvent = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
    if (!existingEvent) {
      return res.status(404).json({ error: 'Event not found.' });
    }

    if (title !== undefined && (!title || !title.trim())) {
      return res.status(400).json({ error: 'Event title cannot be empty.' });
    }

    if (location !== undefined && (!location || !location.trim())) {
      return res.status(400).json({ error: 'Event location cannot be empty.' });
    }

    if (event_date !== undefined && event_date !== null) {
      if (isNaN(new Date(event_date).getTime())) {
        return res.status(400).json({ error: 'A valid event date/time is required.' });
      }
    }

    // Preserve existing max_players if not provided (undefined)
    let newMaxPlayers;
    if (max_players === undefined) {
      newMaxPlayers = existingEvent.max_players;
    } else if (max_players === null || max_players === '') {
      newMaxPlayers = null;
    } else {
      const parsed = parseInt(max_players, 10);
      newMaxPlayers = isNaN(parsed) ? existingEvent.max_players : parsed;
    }

    // Preserve existing actual_attendance if not provided (undefined)
    let newActualAttendance;
    if (actual_attendance === undefined) {
      newActualAttendance = existingEvent.actual_attendance;
    } else if (actual_attendance === null || actual_attendance === '') {
      newActualAttendance = null;
    } else {
      const parsed = parseInt(actual_attendance, 10);
      newActualAttendance = isNaN(parsed) || parsed < 0 ? null : parsed;
    }

    let newAllowedEmails = existingEvent.allowed_emails;
    if (allowed_emails !== undefined) {
      if (allowed_emails === null || allowed_emails === '') {
        newAllowedEmails = null;
      } else {
        const allowedList = parseAllowedEmails(allowed_emails);
        newAllowedEmails = allowedList.length > 0 ? JSON.stringify(allowedList) : null;
      }
    }

    const result = db.prepare(`
      UPDATE events
      SET title = COALESCE(?, title),
          description = COALESCE(?, description),
          location = COALESCE(?, location),
          location_url = COALESCE(?, location_url),
          event_date = COALESCE(?, event_date),
          max_players = ?,
          actual_attendance = ?,
          allowed_emails = ?,
          status = COALESCE(?, status)
      WHERE id = ?
    `).run(
      title !== undefined ? title.trim() : null,
      description !== undefined ? description.trim() : null,
      location !== undefined ? location.trim() : null,
      location_url !== undefined ? location_url.trim() : null,
      event_date || null,
      newMaxPlayers,
      newActualAttendance,
      newAllowedEmails,
      status || null,
      eventId
    );

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Event not found.' });
    }

    const updatedEvent = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);

    res.json({ success: true, event: updatedEvent, message: 'Event updated.' });
  } catch (err) {
    console.error('[Events] Error updating event:', err);
    res.status(500).json({ error: 'Failed to update event.' });
  }
});

/**
 * Delete / Cancel event (Admin only)
 */
router.delete('/:id', requireAdmin, (req, res) => {
  try {
    const eventId = req.params.id;
    const result = db.prepare('DELETE FROM events WHERE id = ?').run(eventId);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Event not found.' });
    }
    res.json({ success: true, message: 'Event deleted.' });
  } catch (err) {
    console.error('[Events] Error deleting event:', err);
    res.status(500).json({ error: 'Failed to delete event.' });
  }
});

/**
 * Remove attendee from event (Organizer or Admin)
 */
router.delete('/:id/attendees/:attendeeId', requireEventCreator, (req, res) => {
  try {
    const eventId = req.params.id;
    const attendeeId = req.params.attendeeId;
    const attendee = db.prepare('SELECT * FROM attendees WHERE id = ? AND event_id = ?').get(attendeeId, eventId);
    if (!attendee) {
      return res.status(404).json({ error: 'Attendee not found.' });
    }

    const wasAttending = attendee.status === 'attending';
    db.prepare('DELETE FROM duty_assignments WHERE attendee_id = ?').run(attendeeId);
    db.prepare('DELETE FROM attendees WHERE id = ? AND event_id = ?').run(attendeeId, eventId);

    if (wasAttending) {
      promoteNextWaitlistedPlayer(eventId);
    }

    res.json({ success: true, message: 'Attendee removed from roster.' });
  } catch (err) {
    console.error('[RSVP] Error removing attendee:', err);
    res.status(500).json({ error: 'Failed to remove attendee.' });
  }
});


/**
 * Add a new duty/task to an existing event (Admin or Organizer)
 */
router.post('/:id/duties', requireEventCreator, (req, res) => {
  try {
    const eventId = req.params.id;
    const event = db.prepare('SELECT id FROM events WHERE id = ?').get(eventId);
    if (!event) {
      return res.status(404).json({ error: 'Event not found.' });
    }

    const { title, description, slots_needed } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({ error: 'Duty title is required.' });
    }

    const maxSort = db.prepare('SELECT MAX(sort_order) as max_sort FROM event_duties WHERE event_id = ?').get(eventId);
    const nextSort = (maxSort && maxSort.max_sort !== null) ? maxSort.max_sort + 1 : 0;

    const result = db.prepare(`
      INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
      VALUES (?, ?, ?, ?, ?)
    `).run(eventId, title.trim(), (description || '').trim(), parseInt(slots_needed || 1, 10), nextSort);

    const newDuty = db.prepare('SELECT * FROM event_duties WHERE id = ?').get(result.lastInsertRowid);
    res.json({ success: true, duty: newDuty });
  } catch (err) {
    console.error('[Events] Error adding duty:', err);
    res.status(500).json({ error: 'Failed to add duty.' });
  }
});

/**
 * Update an existing duty/task (Admin or Organizer)
 */
router.put('/:id/duties/:dutyId', requireEventCreator, (req, res) => {
  try {
    const { id: eventId, dutyId } = req.params;
    const { title, description, slots_needed } = req.body;

    if (title !== undefined && (!title || !title.trim())) {
      return res.status(400).json({ error: 'Duty title cannot be empty.' });
    }

    const result = db.prepare(`
      UPDATE event_duties
      SET title = COALESCE(?, title),
          description = COALESCE(?, description),
          slots_needed = COALESCE(?, slots_needed)
      WHERE id = ? AND event_id = ?
    `).run(
      title ? title.trim() : null,
      description !== undefined ? description.trim() : null,
      slots_needed ? parseInt(slots_needed, 10) : null,
      dutyId,
      eventId
    );

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Duty not found.' });
    }

    const updated = db.prepare('SELECT * FROM event_duties WHERE id = ?').get(dutyId);
    res.json({ success: true, duty: updated });
  } catch (err) {
    console.error('[Events] Error updating duty:', err);
    res.status(500).json({ error: 'Failed to update duty.' });
  }
});

/**
 * Delete a duty/task from an event (Admin or Organizer)
 */
router.delete('/:id/duties/:dutyId', requireEventCreator, (req, res) => {
  try {
    const { id: eventId, dutyId } = req.params;
    const result = db.prepare('DELETE FROM event_duties WHERE id = ? AND event_id = ?').run(dutyId, eventId);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Duty not found.' });
    }
    res.json({ success: true, message: 'Duty removed.' });
  } catch (err) {
    console.error('[Events] Error deleting duty:', err);
    res.status(500).json({ error: 'Failed to delete duty.' });
  }
});

/**
 * Trigger manual reminders for an event (Admin only)
 */
router.post('/:id/send-reminders', requireAdmin, async (req, res) => {
  try {
    const eventId = req.params.id;
    const event = db.prepare('SELECT id FROM events WHERE id = ?').get(eventId);
    if (!event) {
      return res.status(404).json({ error: 'Event not found.' });
    }
    await sendRemindersForEvent(eventId);
    res.json({ success: true, message: 'Reminders have been sent to all confirmed attendees.' });
  } catch (err) {
    console.error('[Events] Error sending reminders manually:', err);
    res.status(500).json({ error: 'Failed to send reminders.' });
  }
});

/**
 * Mark event as rained out (Organizer or Admin)
 */
router.post('/:id/rainout', requireEventCreator, async (req, res) => {
  try {
    const eventId = req.params.id;
    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
    if (!event) {
      return res.status(404).json({ error: 'Event not found.' });
    }

    const { note, sendEmail } = req.body;
    const cleanNote = note ? String(note).trim() : null;
    const shouldEmail = Boolean(sendEmail);

    db.prepare(`
      UPDATE events
      SET status = 'rainout',
          rainout_note = ?,
          rainout_at = CURRENT_TIMESTAMP,
          rainout_email_sent = CASE WHEN ? = 1 THEN 1 ELSE rainout_email_sent END
      WHERE id = ?
    `).run(cleanNote, shouldEmail ? 1 : 0, eventId);

    if (shouldEmail) {
      const attendees = db.prepare(`
        SELECT a.*
        FROM attendees a
        WHERE a.event_id = ? AND a.status = 'attending'
      `).all(eventId);

      for (const att of attendees) {
        try {
          await sendRainoutEmail({
            email: att.email,
            name: att.name,
            event: { ...event, title: event.title, event_date: event.event_date, location: event.location, id: event.id },
            note: cleanNote,
            managementToken: att.management_token
          });
        } catch (e) {
          console.error('[Rainout] Error sending email to ' + att.email + ':', e);
        }
      }
    }

    res.json({ success: true, message: 'Game has been marked as rained out.' });
  } catch (err) {
    console.error('[Events] Error marking rainout:', err);
    res.status(500).json({ error: 'Failed to mark game as rained out.' });
  }
});

/**
 * Reopen a rained-out event (Organizer or Admin)
 */
router.post('/:id/reopen', requireEventCreator, async (req, res) => {
  try {
    const eventId = req.params.id;
    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
    if (!event) {
      return res.status(404).json({ error: 'Event not found.' });
    }

    const { note, sendEmail } = req.body;
    const cleanNote = note ? String(note).trim() : null;
    const shouldEmail = Boolean(sendEmail);

    db.prepare(`
      UPDATE events
      SET status = 'active',
          rainout_note = NULL,
          rainout_at = NULL,
          rainout_email_sent = 0
      WHERE id = ?
    `).run(eventId);

    if (shouldEmail) {
      const attendees = db.prepare(`
        SELECT a.*
        FROM attendees a
        WHERE a.event_id = ? AND a.status = 'attending'
      `).all(eventId);

      for (const att of attendees) {
        try {
          await sendReopenEmail({
            email: att.email,
            name: att.name,
            event: { ...event, title: event.title, event_date: event.event_date, location: event.location, id: event.id },
            note: cleanNote,
            managementToken: att.management_token
          });
        } catch (e) {
          console.error('[Reopen] Error sending email to ' + att.email + ':', e);
        }
      }
    }

    res.json({ success: true, message: 'Game has been reopened and is back on!' });
  } catch (err) {
    console.error('[Events] Error reopening event:', err);
    res.status(500).json({ error: 'Failed to reopen game.' });
  }
});

/**
 * Send rainout email manually to attendees (Organizer or Admin)
 */
router.post('/:id/send-rainout-email', requireEventCreator, async (req, res) => {
  try {
    const eventId = req.params.id;
    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
    if (!event) {
      return res.status(404).json({ error: 'Event not found.' });
    }

    const { note } = req.body;
    const cleanNote = note !== undefined ? (note ? String(note).trim() : null) : event.rainout_note;

    const attendees = db.prepare(`
      SELECT a.*
      FROM attendees a
      WHERE a.event_id = ? AND a.status = 'attending'
    `).all(eventId);

    for (const att of attendees) {
      try {
        await sendRainoutEmail({
          email: att.email,
          name: att.name,
          event: { ...event, title: event.title, event_date: event.event_date, location: event.location, id: event.id },
          note: cleanNote,
          managementToken: att.management_token
        });
      } catch (e) {
        console.error('[Rainout] Error sending email to ' + att.email + ':', e);
      }
    }

    db.prepare('UPDATE events SET rainout_email_sent = 1 WHERE id = ?').run(eventId);

    res.json({ success: true, message: 'Rainout email sent to confirmed attendees.' });
  } catch (err) {
    console.error('[Events] Error sending rainout email:', err);
    res.status(500).json({ error: 'Failed to send rainout email.' });
  }
});

module.exports = router;
