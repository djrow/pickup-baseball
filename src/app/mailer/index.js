/**
 * Unified MAIL_PROVIDER Factory, Dispatcher & Quota Manager
 * ADR-0008 / ADR-0004 / ADR-0007 / Ticket #69
 */

import { resolveConfig } from '../config.js';
import { ERROR_CODES, logEvent } from '../errors.js';
import { resendAdapter } from './resend.js';
import { brevoAdapter } from './brevo.js';
import { mockAdapter } from './mock.js';
import {
  buildAuthCodeEmail,
  buildRsvpConfirmationEmail,
  buildWaitlistConfirmationEmail,
  buildWaitlistPromotionEmail,
  buildEventReminderEmail,
  buildRainoutEmail,
  buildReopenEmail,
  buildRsvpEditLinkEmail,
  buildWaiverConfirmationEmail,
  buildErasureVerificationCode
} from './templates.js';

export { resendAdapter } from './resend.js';
export { brevoAdapter } from './brevo.js';
export { mockAdapter } from './mock.js';

export * from './templates.js';

/**
 * Validates recipient email address format locally (must not be empty, must contain valid user@domain structure,
 * and cannot be a synthetic guest dummy like .invalid or guest_).
 * @param {string|null|undefined} email
 * @returns {boolean}
 */
export function isValidRecipientEmail(email) {
  if (!email || typeof email !== 'string') return false;
  const trimmed = email.trim().toLowerCase();
  if (!trimmed || trimmed.endsWith('.invalid') || trimmed.endsWith('@guest.pickupbaseball.internal') || trimmed.includes('guest_no_email')) {
    return false;
  }
  // Standard permissive check: user@domain.tld with no whitespace
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(trimmed);
}

/**
 * Determine active mail provider ('resend' | 'brevo' | 'mock').
 * @param {Record<string, any>|null|undefined} env
 * @returns {'resend' | 'brevo' | 'mock'}
 */
export function resolveMailProvider(env) {
  if (env && env.MAIL_PROVIDER) {
    const p = String(env.MAIL_PROVIDER).toLowerCase().trim();
    if (p === 'resend' || p === 'brevo' || p === 'mock') {
      return p;
    }
  }
  if (env && env.RESEND_API_KEY) {
    return 'resend';
  }
  if (env && env.BREVO_API_KEY) {
    return 'brevo';
  }
  return 'mock';
}

/**
 * Get adapter by name.
 * @param {'resend' | 'brevo' | 'mock'} provider
 */
export function getMailAdapter(provider) {
  switch (provider) {
    case 'resend':
      return resendAdapter;
    case 'brevo':
      return brevoAdapter;
    case 'mock':
    default:
      return mockAdapter;
  }
}

/**
 * Reads suppressed emails from BASEBALL_DB.email_suppressions for the provided addresses.
 * @param {D1Database|any} db
 * @param {string[]} emails
 * @returns {Promise<Set<string>>}
 */
export async function getSuppressedEmails(db, emails) {
  const suppressed = new Set();
  if (!db || !Array.isArray(emails) || emails.length === 0) {
    return suppressed;
  }

  // Deduplicate and normalize
  const normalized = Array.from(new Set(emails.map((e) => String(e).trim().toLowerCase())));
  if (normalized.length === 0) return suppressed;

  // D1 query chunking in groups of 50 to avoid parameter limit
  const CHUNK_SIZE = 50;
  for (let i = 0; i < normalized.length; i += CHUNK_SIZE) {
    const chunk = normalized.slice(i, i + CHUNK_SIZE);
    const placeholders = chunk.map(() => '?').join(', ');
    try {
      const stmt = db.prepare(`SELECT email FROM email_suppressions WHERE email IN (${placeholders})`);
      const { results } = await stmt.bind(...chunk).all();
      if (results && results.length > 0) {
        for (const row of results) {
          if (row.email) suppressed.add(row.email.toLowerCase());
        }
      }
    } catch (e) {
      // Table might not exist in mock/isolated tests without DB; log and continue
      logEvent('warn', 'email_suppressions_check_error', { err: e && e.message ? e.message : String(e) });
    }
  }

  return suppressed;
}

/**
 * Checks and increments the daily UTC quota count in app_settings.
 * Priority tiers: auth > rainout_reopen > waitlist > rsvp_confirm > reminder > community_update
 * On pure Resend, low-priority tiers (reminder, community_update) halt at 80/100.
 *
 * @param {D1Database|any} db
 * @param {Record<string, any>} env
 * @param {number} countToAdd
 * @param {string} priority
 * @returns {Promise<{ allowed: boolean, currentCount: number, quotaPaused: boolean, shouldSpillover: boolean }>}
 */
export async function checkQuota(db, env, countToAdd = 1, priority = 'auth') {
  const safeEnv = env || {};
  const mailProvider = resolveMailProvider(safeEnv);
  const hasBrevo = Boolean(safeEnv.BREVO_API_KEY && String(safeEnv.BREVO_API_KEY).trim());

  // Mock provider has no quota limits
  if (mailProvider === 'mock') {
    return { allowed: true, currentCount: 0, quotaPaused: false, shouldSpillover: false };
  }

  // If explicit brevo provider, Brevo free tier is 300/day
  const isBrevoPrimary = mailProvider === 'brevo';
  const dailyCap = isBrevoPrimary ? 300 : 100;
  const isLowPriority = priority === 'reminder' || priority === 'community_update';
  const gateThreshold = (!isBrevoPrimary && isLowPriority) ? 80 : dailyCap;

  const todayUtc = new Date().toISOString().slice(0, 10);
  const settingKey = `email_daily_count_${todayUtc}`;

  if (!db) {
    return { allowed: true, currentCount: 0, quotaPaused: false, shouldSpillover: false };
  }

  try {
    const row = await db.prepare('SELECT value FROM app_settings WHERE key = ?').bind(settingKey).first();
    const current = row && row.value ? parseInt(row.value, 10) || 0 : 0;

    if (current + countToAdd > gateThreshold) {
      if (hasBrevo && !isBrevoPrimary) {
        // Can spillover to Brevo
        return { allowed: true, currentCount: current, quotaPaused: false, shouldSpillover: true };
      }
      return { allowed: false, currentCount: current, quotaPaused: true, shouldSpillover: false };
    }

    // Increment
    const newCount = current + countToAdd;
    await db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)').bind(settingKey, String(newCount)).run();
    return { allowed: true, currentCount: newCount, quotaPaused: false, shouldSpillover: false };
  } catch (err) {
    // If app_settings fails or is unavailable
    return { allowed: true, currentCount: 0, quotaPaused: false, shouldSpillover: false };
  }
}

/**
 * Prepares clean headers and envelope config from environment.
 * @param {Record<string, any>} env
 * @returns {{ from: string, replyTo: string, appName: string, fromEmail: string, fromName: string }}
 */
function resolveEnvelope(env) {
  const cfg = resolveConfig(env || {});
  const appName = cfg.COMMUNITY_NAME;
  const from = cfg.FROM_EMAIL || `"${appName}" <onboarding@resend.dev>`;
  const replyTo = cfg.REPLY_TO_EMAIL || '';

  // Extract pure email & name for Brevo
  let fromEmail = from;
  let fromName = appName;
  const match = from.match(/^"?([^"<]+)"?\s*<([^>]+)>$/);
  if (match) {
    fromName = match[1].trim();
    fromEmail = match[2].trim();
  }

  return { from, replyTo, appName, fromEmail, fromName };
}

/**
 * Unified Single Email Dispatcher
 * @param {Record<string, any>} env
 * @param {D1Database|any} db
 * @param {{ to: string|string[], subject: string, text: string, html: string, headers?: Record<string, string>, priority?: string }} message
 * @param {Record<string, any>} [options]
 * @returns {Promise<{ ok: boolean, provider: string, messageId: string|null, skippedReason?: string, quotaPaused?: boolean }>}
 */
export async function sendSingle(env, db, message, options = {}) {
  const safeEnv = env || {};
  let targetAddress = Array.isArray(message.to) ? message.to[0] : message.to;
  targetAddress = String(targetAddress || '').trim();

  // 1. Local Pre-validation
  if (!isValidRecipientEmail(targetAddress)) {
    return {
      ok: false,
      provider: resolveMailProvider(safeEnv),
      messageId: null,
      skippedReason: 'malformed_or_placeholder_email'
    };
  }

  // 2. Suppression Check
  if (db) {
    const suppressed = await getSuppressedEmails(db, [targetAddress]);
    if (suppressed.has(targetAddress.toLowerCase())) {
      return {
        ok: false,
        provider: resolveMailProvider(safeEnv),
        messageId: null,
        skippedReason: 'suppressed'
      };
    }
  }

  // 3. Quota & Provider resolution
  const priority = message.priority || options.priority || 'auth';
  let providerName = resolveMailProvider(safeEnv);
  const quotaRes = await checkQuota(db, safeEnv, 1, priority);

  if (!quotaRes.allowed) {
    return {
      ok: false,
      provider: providerName,
      messageId: null,
      skippedReason: 'daily_quota_exceeded',
      quotaPaused: true
    };
  }

  if (quotaRes.shouldSpillover && providerName === 'resend') {
    providerName = 'brevo';
  }

  const envelope = resolveEnvelope(safeEnv);
  // eslint-disable-next-line no-control-regex -- strip CRLF and ASCII control characters from email Subject header
  const cleanSubject = String(message.subject || '').replace(/[\r\n\x00-\x1f\x7f]+/g, ' ').trim();

  const preparedMsg = {
    ...message,
    from: envelope.from,
    fromEmail: envelope.fromEmail,
    fromName: envelope.fromName,
    replyTo: envelope.replyTo,
    to: targetAddress,
    subject: cleanSubject
  };

  let adapter = getMailAdapter(providerName);
  try {
    const res = await adapter.sendSingle(safeEnv, preparedMsg, options);
    return {
      ok: true,
      provider: providerName,
      messageId: res.messageId
    };
  } catch (err) {
    // If Resend failed with 429 daily_quota_exceeded and Brevo is configured, spillover immediately
    const isQuotaErr = err && (err.code === 'daily_quota_exceeded' || err.status === 429);
    const hasBrevo = Boolean(safeEnv.BREVO_API_KEY && String(safeEnv.BREVO_API_KEY).trim());

    if (providerName === 'resend' && isQuotaErr && hasBrevo) {
      logEvent('info', 'mail_spillover_to_brevo_on_429', { to: targetAddress });
      try {
        const brevoRes = await brevoAdapter.sendSingle(safeEnv, preparedMsg, options);
        return {
          ok: true,
          provider: 'brevo',
          messageId: brevoRes.messageId
        };
      } catch (brevoErr) {
        logEvent('error', 'brevo_spillover_failed', { to: targetAddress, err: brevoErr && brevoErr.message });
        throw brevoErr;
      }
    }

    if (isQuotaErr && !hasBrevo) {
      return {
        ok: false,
        provider: providerName,
        messageId: null,
        skippedReason: 'daily_quota_exceeded',
        quotaPaused: true
      };
    }

    logEvent('error', 'mail_delivery_failed', {
      code: ERROR_CODES.MAIL_ERROR,
      email: targetAddress,
      provider: providerName,
      msg: err && err.message ? err.message : 'Delivery failed'
    });
    throw err;
  }
}

/**
 * Unified Batch Email Dispatcher
 * Chunks into up to 100 messages per request, filters suppressions & malformed addresses locally,
 * handles 429 retries and Brevo spillover.
 *
 * @param {Record<string, any>} env
 * @param {D1Database|any} db
 * @param {Array<{ to: string, subject: string, text: string, html: string, headers?: Record<string, string>, priority?: string }>} messages
 * @param {Record<string, any>} [options]
 * @returns {Promise<{ sent: Array<{ index: number, to: string, messageId: string }>, failed: Array<{ index: number, to: string, error: string }>, skippedSuppressed: string[], quotaPaused: boolean, providerUsed: string }>}
 */
export async function sendBatch(env, db, messages, options = {}) {
  const safeEnv = env || {};
  let providerName = resolveMailProvider(safeEnv);
  const priority = options.priority || 'reminder';

  const sent = [];
  const failed = [];
  const skippedSuppressed = [];

  if (!Array.isArray(messages) || messages.length === 0) {
    return { sent, failed, skippedSuppressed, quotaPaused: false, providerUsed: providerName };
  }

  // 1. Local Pre-validation
  const validMessages = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const target = String(m.to || '').trim();
    if (!isValidRecipientEmail(target)) {
      failed.push({
        index: i,
        to: target,
        error: 'Invalid recipient address'
      });
    } else {
      validMessages.push({
        ...m,
        to: target,
        originalIndex: i
      });
    }
  }

  if (validMessages.length === 0) {
    return { sent, failed, skippedSuppressed, quotaPaused: false, providerUsed: providerName };
  }

  // 2. Email Suppression Filtering
  let activeMessages = validMessages;
  if (db) {
    const candidateEmails = validMessages.map((m) => m.to);
    const suppressedSet = await getSuppressedEmails(db, candidateEmails);
    if (suppressedSet.size > 0) {
      activeMessages = [];
      for (const m of validMessages) {
        if (suppressedSet.has(m.to.toLowerCase())) {
          skippedSuppressed.push(m.to);
        } else {
          activeMessages.push(m);
        }
      }
    }
  }

  if (activeMessages.length === 0) {
    return { sent, failed, skippedSuppressed, quotaPaused: false, providerUsed: providerName };
  }

  // 3. Quota check & spillover decision
  const quotaRes = await checkQuota(db, safeEnv, activeMessages.length, priority);
  if (!quotaRes.allowed) {
    return {
      sent,
      failed,
      skippedSuppressed,
      quotaPaused: true,
      providerUsed: providerName
    };
  }

  if (quotaRes.shouldSpillover && providerName === 'resend') {
    providerName = 'brevo';
  }

  const envelope = resolveEnvelope(safeEnv);
  const preparedMessages = activeMessages.map((m) => ({
    ...m,
    from: envelope.from,
    fromEmail: envelope.fromEmail,
    fromName: envelope.fromName,
    replyTo: envelope.replyTo,
    // eslint-disable-next-line no-control-regex -- strip CRLF and ASCII control characters from email Subject header
    subject: String(m.subject || '').replace(/[\r\n\x00-\x1f\x7f]+/g, ' ').trim()
  }));

  // Chunk in batches of 100
  const BATCH_SIZE = 100;
  let adapter = getMailAdapter(providerName);
  let hasBrevo = Boolean(safeEnv.BREVO_API_KEY && String(safeEnv.BREVO_API_KEY).trim());

  for (let i = 0; i < preparedMessages.length; i += BATCH_SIZE) {
    const chunk = preparedMessages.slice(i, i + BATCH_SIZE);
    try {
      const res = await adapter.sendBatch(safeEnv, chunk, options);
      if (res.sent) sent.push(...res.sent);
      if (res.failed) failed.push(...res.failed);
    } catch (err) {
      const isQuotaErr = err && (err.code === 'daily_quota_exceeded' || err.status === 429);
      if (providerName === 'resend' && isQuotaErr && hasBrevo) {
        logEvent('info', 'batch_mail_spillover_to_brevo_on_429', { count: chunk.length });
        try {
          const brevoRes = await brevoAdapter.sendBatch(safeEnv, chunk, options);
          if (brevoRes.sent) sent.push(...brevoRes.sent);
          if (brevoRes.failed) failed.push(...brevoRes.failed);
          providerName = 'brevo';
          continue;
        } catch (brevoErr) {
          logEvent('error', 'batch_brevo_spillover_failed', { err: brevoErr && brevoErr.message });
          for (const item of chunk) {
            failed.push({
              index: item.originalIndex,
              to: item.to,
              error: brevoErr && brevoErr.message ? brevoErr.message : 'Brevo spillover failed'
            });
          }
          continue;
        }
      }

      if (isQuotaErr && !hasBrevo) {
        // Halt cleanly, mark quotaPaused, leave remaining unsent
        return {
          sent,
          failed,
          skippedSuppressed,
          quotaPaused: true,
          providerUsed: providerName
        };
      }

      // Other error
      for (const item of chunk) {
        failed.push({
          index: item.originalIndex,
          to: item.to,
          error: err && err.message ? err.message : 'Batch dispatch error'
        });
      }
    }
  }

  return {
    sent,
    failed,
    skippedSuppressed,
    quotaPaused: false,
    providerUsed: providerName
  };
}

/**
 * Backward compatibility dispatchEmail(env, { to, subject, text, html })
 * @deprecated Use sendSingle(env, db, message)
 */
export async function dispatchEmail(env, { to, subject, text, html }) {
  const res = await sendSingle(env, null, { to, subject, text, html });
  if (!res.ok && res.skippedReason) {
    if (res.skippedReason === 'malformed_or_placeholder_email') {
      return { messageId: null, skipped: true };
    }
    throw new Error(`Email dispatch skipped: ${res.skippedReason}`);
  }
  return { messageId: res.messageId };
}

// Re-export template helper functions bound to sendSingle/dispatchEmail
export async function sendAuthCode(env, origin, params) {
  const msg = buildAuthCodeEmail(env, origin, params);
  return sendSingle(env, env && env.DB, msg);
}

export async function sendRsvpConfirmation(env, origin, params) {
  const msg = buildRsvpConfirmationEmail(env, origin, params);
  return sendSingle(env, env && env.DB, msg);
}

export async function sendWaitlistConfirmation(env, origin, params) {
  const msg = buildWaitlistConfirmationEmail(env, origin, params);
  return sendSingle(env, env && env.DB, msg);
}

export async function sendWaitlistPromotionEmail(env, origin, params) {
  const msg = buildWaitlistPromotionEmail(env, origin, params);
  return sendSingle(env, env && env.DB, msg);
}

export async function sendEventReminder(env, origin, params) {
  const msg = buildEventReminderEmail(env, origin, params);
  return sendSingle(env, env && env.DB, msg);
}

export async function sendRainoutEmail(env, origin, params) {
  const msg = buildRainoutEmail(env, origin, params);
  return sendSingle(env, env && env.DB, msg);
}

export async function sendReopenEmail(env, origin, params) {
  const msg = buildReopenEmail(env, origin, params);
  return sendSingle(env, env && env.DB, msg);
}

export async function sendRsvpEditLinkEmail(env, origin, params) {
  const msg = buildRsvpEditLinkEmail(env, origin, params);
  return sendSingle(env, env && env.DB, msg);
}

export async function sendWaiverConfirmationEmail(env, origin, params) {
  const msg = buildWaiverConfirmationEmail(env, origin, params);
  return sendSingle(env, env && env.DB, msg);
}

export async function sendErasureVerificationCode(env, origin, params) {
  const msg = buildErasureVerificationCode(env, origin, params);
  return sendSingle(env, env && env.DB, msg);
}
