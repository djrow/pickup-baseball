/**
 * @fileoverview Append-only Privacy Consent, Feature Opt-In, and Notification Preference ledger (`consent_records`).
 * Implements ADR-0005 §2: records explicit versioned grants/withdrawals without ever logging raw IP or User-Agent.
 *
 * @module app/consent
 */

import { sha256Hex } from './security.js';
import { logEvent } from './errors.js';

export const PRIVACY_POLICY_VERSION = '2026-11-v1';

export const PRIVACY_POLICY_SUMMARY = [
  'Pickup Baseball Foundation Community Privacy & Consent Policy (v2026-11-v1).',
  'Member rosters default to First L. abbreviation and hide gear, companions, bio, and avatar from peers unless explicit Privacy Consent (roster_visibility, profile_sharing) is granted.',
  'Visitor RSVPs default to First L. abbreviation (roster_consent = 0) and opt-out of topic notifications (notify_emails = 0) unless explicitly checked.',
  'Clubhouse chat & voice require explicit Feature Opt-In (clubhouse_opt_in).',
  'All consent grants and withdrawals are recorded in an append-only ledger with policy version and SHA-256 digest, without logging raw IP addresses or User-Agent strings.'
].join(' ');

export const CONSENT_TYPES = Object.freeze({
  ROSTER_VISIBILITY: 'roster_visibility',
  PROFILE_SHARING: 'profile_sharing',
  ROSTER_CONSENT: 'roster_consent',
  CLUBHOUSE_OPT_IN: 'clubhouse_opt_in',
  NOTIFY_RSVP_CONFIRM: 'notify_rsvp_confirm',
  NOTIFY_RAINOUTS: 'notify_rainouts',
  NOTIFY_EVENT_REMINDERS: 'notify_event_reminders',
  NOTIFY_COMMUNITY_UPDATES: 'notify_community_updates',
  VISITOR_NOTIFY_EMAILS: 'visitor_notify_emails'
});

/** @type {Promise<{ policyVersion: string, policySha256: string }> | null} */
let cachedPolicyMetaPromise = null;

/**
 * Returns the current Privacy & Consent policy version and SHA-256 hex digest.
 * @returns {Promise<{ policyVersion: string, policySha256: string }>}
 */
export async function getConsentPolicyMetadata() {
  if (!cachedPolicyMetaPromise) {
    cachedPolicyMetaPromise = sha256Hex(PRIVACY_POLICY_SUMMARY).then((policySha256) => ({
      policyVersion: PRIVACY_POLICY_VERSION,
      policySha256
    }));
  }
  return cachedPolicyMetaPromise;
}

/**
 * Parses an optional boolean-like input (`true`/`false`/`1`/`0`/`"true"`/`"false"`).
 * Returns `undefined` when `value === undefined` so callers can preserve omitted fields.
 * @param {unknown} value
 * @returns {boolean | undefined}
 */
export function parseOptionalBoolean(value) {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off', ''].includes(normalized)) return false;
  }
  return Boolean(value);
}

/**
 * Computes the normalized SHA-256 hex digest of a subject's lowercase trimmed email address.
 * @param {string | null | undefined} email
 * @returns {Promise<string | null>}
 */
export async function hashSubjectEmail(email) {
  if (!email || typeof email !== 'string') return null;
  const normalized = email.trim().toLowerCase();
  if (!normalized) return null;
  return sha256Hex(normalized);
}

/**
 * Appends a single immutable consent transition row to `BASEBALL_DB.consent_records`.
 * Never accepts, logs, or stores raw IP addresses or User-Agent headers.
 *
 * @param {D1Database} db
 * @param {{
 *   subjectType: 'member' | 'visitor',
 *   userId?: number | null,
 *   subjectEmail?: string | null,
 *   subjectEmailHash?: string | null,
 *   consentType: string,
 *   granted: boolean,
 *   timestamp?: string | null
 * }} entry
 * @returns {Promise<{ recorded: boolean, status: 'granted' | 'withdrawn', policyVersion: string, policySha256: string }>}
 */
export async function recordConsentChange(db, entry) {
  const { policyVersion, policySha256 } = await getConsentPolicyMetadata();
  const status = entry.granted ? 'granted' : 'withdrawn';
  if (!db) {
    return { recorded: false, status, policyVersion, policySha256 };
  }

  const subjectType = entry.subjectType === 'visitor' ? 'visitor' : 'member';
  const userId = subjectType === 'member' && entry.userId != null ? Number(entry.userId) : null;
  if (subjectType === 'member' && (!userId || Number.isNaN(userId))) {
    throw new Error('Member consent_records entry requires a valid userId.');
  }

  let subjectEmailHash = null;
  if (subjectType === 'visitor') {
    subjectEmailHash = entry.subjectEmailHash
      ? String(entry.subjectEmailHash)
      : (entry.subjectEmail ? await hashSubjectEmail(entry.subjectEmail) : null);
  }

  const ts = entry.timestamp ? String(entry.timestamp) : new Date().toISOString();
  const grantedAt = entry.granted ? ts : null;
  const withdrawnAt = entry.granted ? null : ts;

  try {
    await db.prepare(`
      INSERT INTO consent_records (
        subject_type, user_id, subject_email_hash, consent_type,
        policy_version, policy_sha256, status, granted_at, withdrawn_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      subjectType,
      userId,
      subjectEmailHash,
      String(entry.consentType),
      policyVersion,
      policySha256,
      status,
      grantedAt,
      withdrawnAt
    ).run();
    return { recorded: true, status, policyVersion, policySha256 };
  } catch (err) {
    logEvent('error', 'consent_record_insert_failed', {
      subjectType,
      consentType: entry.consentType,
      err
    });
    throw err;
  }
}
