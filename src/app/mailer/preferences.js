/**
 * Notification preference enforcement and stateless RFC 8058 unsubscribe tokens.
 */
import { hmacSha256Hex, constantTimeEqual, arrayBufferToBase64, base64ToUint8Array } from '../security.js';
import { CONSENT_TYPES, recordConsentChange } from '../consent.js';

export const REMINDER_LEAD_HOURS = 24;

/** Preference key -> users column / consent type. */
export const PREF_COLUMNS = Object.freeze({
  notify_rsvp_confirm: CONSENT_TYPES.NOTIFY_RSVP_CONFIRM,
  notify_rainouts: CONSENT_TYPES.NOTIFY_RAINOUTS,
  notify_event_reminders: CONSENT_TYPES.NOTIFY_EVENT_REMINDERS,
  notify_community_updates: CONSENT_TYPES.NOTIFY_COMMUNITY_UPDATES
});

const USER_OPT_OUT_SQL = {
  notify_rsvp_confirm: 'UPDATE users SET notify_rsvp_confirm = 0 WHERE id = ?',
  notify_rainouts: 'UPDATE users SET notify_rainouts = 0 WHERE id = ?',
  notify_event_reminders: 'UPDATE users SET notify_event_reminders = 0 WHERE id = ?',
  notify_community_updates: 'UPDATE users SET notify_community_updates = 0 WHERE id = ?'
};

const PREF_DEFAULTS = {
  notify_rsvp_confirm: 1,
  notify_rainouts: 1,
  notify_event_reminders: 1,
  notify_community_updates: 0
};

function secretFor(env) {
  const e = env || {};
  return String(e.UNSUBSCRIBE_SECRET || e.WAIVER_SIGNING_SECRET || e.CRON_SECRET || e.REMINDERS_SECRET || 'pbf-unsubscribe-dev-secret');
}

function b64urlEncode(str) {
  const bytes = new TextEncoder().encode(String(str));
  return arrayBufferToBase64(bytes.buffer).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  const pad = str + '==='.slice((str.length + 3) % 4);
  const bytes = base64ToUint8Array(pad.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(bytes);
}

/**
 * @param {Record<string, any>} env
 * @param {{ pref: string, userId?: number|null, email?: string|null }} subject
 */
export async function signUnsubscribeToken(env, subject) {
  const payload = b64urlEncode(JSON.stringify({
    p: subject.pref,
    u: subject.userId ? Number(subject.userId) : null,
    e: subject.userId ? null : String(subject.email || '').toLowerCase()
  }));
  const sig = await hmacSha256Hex(secretFor(env), payload);
  return `${payload}.${sig}`;
}

/** @returns {Promise<{ pref: string, userId: number|null, email: string|null }|null>} */
export async function verifyUnsubscribeToken(env, token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const expected = await hmacSha256Hex(secretFor(env), parts[0]);
  if (!constantTimeEqual(expected, parts[1])) return null;
  try {
    const data = JSON.parse(b64urlDecode(parts[0]));
    if (!data || !PREF_COLUMNS[data.p] || (!data.u && !data.e)) return null;
    return { pref: data.p, userId: data.u || null, email: data.e || null };
  } catch (_e) {
    return null;
  }
}

/** Applies an opt-out and appends a consent_records entry. */
export async function applyUnsubscribe(db, env, subject) {
  if (subject.userId) {
    await db.prepare(USER_OPT_OUT_SQL[subject.pref]).bind(subject.userId).run();
    await recordConsentChange(db, {
      subjectType: 'member', userId: subject.userId,
      consentType: PREF_COLUMNS[subject.pref], granted: false
    }, env);
  } else {
    await db.prepare('UPDATE attendees SET notify_emails = 0 WHERE LOWER(email) = ?').bind(subject.email).run();
    await recordConsentChange(db, {
      subjectType: 'visitor', subjectEmail: subject.email,
      consentType: CONSENT_TYPES.VISITOR_NOTIFY_EMAILS, granted: false
    }, env);
  }
}

/**
 * Filters attendee rows by Member preference / Visitor notify_emails and banned_emails.
 * @param {any} db
 * @param {Array<Record<string, any>>} rows
 * @param {string} pref - key of PREF_COLUMNS
 */
export async function filterByPreference(db, rows, pref) {
  const list = rows || [];
  if (list.length === 0) return [];
  const col = PREF_COLUMNS[pref] ? pref : 'notify_event_reminders';
  const userIds = Array.from(new Set(list.filter((r) => r.user_id).map((r) => Number(r.user_id))));
  const prefMap = new Map();
  for (let i = 0; i < userIds.length; i += 50) {
    const chunk = userIds.slice(i, i + 50);
    const ph = chunk.map(() => '?').join(',');
    const res = await db.prepare(`SELECT id, notify_rsvp_confirm, notify_rainouts, notify_event_reminders, notify_community_updates FROM users WHERE id IN (${ph})`).bind(...chunk).all();
    for (const u of (res.results || [])) {
      const raw = u[col];
      prefMap.set(Number(u.id), raw === null || raw === undefined ? PREF_DEFAULTS[col] : Number(raw));
    }
  }
  const banned = new Set();
  const emails = Array.from(new Set(list.map((r) => String(r.email || '').toLowerCase()).filter(Boolean)));
  for (let i = 0; i < emails.length; i += 50) {
    const chunk = emails.slice(i, i + 50);
    const ph = chunk.map(() => '?').join(',');
    const res = await db.prepare(`SELECT email FROM banned_emails WHERE LOWER(email) IN (${ph})`).bind(...chunk).all();
    for (const b of (res.results || [])) banned.add(String(b.email).toLowerCase());
    try {
      const supRes = await db.prepare(`SELECT email FROM email_suppressions WHERE LOWER(email) IN (${ph})`).bind(...chunk).all();
      for (const s of (supRes.results || [])) banned.add(String(s.email).toLowerCase());
    } catch (_e) {
      /* email_suppressions may not exist in isolated mock tests */
    }
  }
  return list.filter((r) => {
    if (banned.has(String(r.email || '').toLowerCase())) return false;
    if (r.user_id && prefMap.has(Number(r.user_id))) return prefMap.get(Number(r.user_id)) === 1;
    return Number(r.notify_emails || 0) === 1;
  });
}

/** Adds RFC 8058 headers to a built message. */
export async function withUnsubscribeHeaders(env, origin, message, subject) {
  const token = await signUnsubscribeToken(env, subject);
  const url = `${String(origin || '').replace(/\/$/, '')}/api/notifications/unsubscribe?token=${encodeURIComponent(token)}`;
  return Object.assign({}, message, {
    headers: Object.assign({}, message.headers || {}, {
      'List-Unsubscribe': `<${url}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
    })
  });
}
