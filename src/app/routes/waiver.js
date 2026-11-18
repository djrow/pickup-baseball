/**
 * Native Digital & Paper Waiver Service with Cryptographic Provenance (ESIGN / UETA Compliant)
 * Form 41335\14760738.1 — CONSENT, WAIVER AND INDEMNITY
 */

import { Hono } from 'hono';
import {
  escapeHtml,
  sha256Hex,
  hmacSha256Hex,
  base64ToUint8Array,
  isValidRasterImageBuffer,
  getClientIp,
  getSafePublicOrigin,
  constantTimeEqual,
  checkRateLimit,
  requireAuth,
  requireOrganizer,
  requireAdmin
} from '../security.js';
import { isGDriveConfigured, uploadGDriveTextFile } from '../gdrive.js';
import { sendWaiverConfirmationEmail } from '../mailer.js';
import { logEvent } from '../errors.js';
import { resolveConfig, PRESET_PICKUP_BASEBALL } from '../config.js';
import { purgeExpiredQuarantinedWaivers, scrubExpiredWaiverTelemetry } from '../erasure.js';
import { resolveStorageProvider, canonicalObjectKey, r2StorageAdapter } from '../storage/index.js';

export { scrubExpiredWaiverTelemetry };

export const waiverRouter = /** @type {AppHono} */ (new Hono());

export const WAIVER_DOC_VERSION = '41335\\14760738.1';

export const WAIVER_PARAGRAPHS = [
  'I wish to participate in the baseball and other outdoor activities (the “Activities”) with Pickup Baseball Foundation volunteers and other participants (collectively, the “Participants”). I understand that the Released Parties will not permit me to participate in the Activities if I do not sign this Consent, Waiver and Indemnity, because the possibility of liability for them is too great to accept.',
  'I understand that the Activities carry some risk of harm to myself and others. I voluntarily assume full responsibility for all risks of personal injury, death and property damage while participating in the Activities, including the risk of passive or active negligence on the part of the Participants, or hidden, latent or obvious defects at the location of any of the Activities, whether such location is under the control of any of the Participants or any other party.',
  'Accordingly, I agree that I release, and will not bring any legal action of any nature whatsoever against the Participants, or any of their trustees, directors, agents, employees or representatives, including volunteer managers, chaperones and the other participants (the "Released Parties”) in connection with the Activities, including, without limitation, any and all claims which may be based upon negligence of any of the Released Parties. Furthermore, I agree to indemnify, defend and hold the Released Parties and their respective agents and representatives harmless from any loss, claim, expense (including attorneys\' fees), demand or cause of action of any kind or character arising from the assertion by me, my family members, or any other person, firm, or corporation that may have, or claim to have, a claim or claims connected with my participation in the Activities. This agreement is intended to be construed to be as comprehensive as is allowed by law, as severable, and the invalidity of any portion of which will not affect the validity of any other provision.',
  'I am signing this Waiver and Indemnity to induce the Participants to allow me to participate in the Activities described above for my convenience. I understand this Waiver and Indemnity and would not sign it if I did not.'
];

export const OFFICIAL_WAIVER_TEXT = [
  'CONSENT, WAIVER AND INDEMNITY',
  ...WAIVER_PARAGRAPHS,
  WAIVER_DOC_VERSION
].join('\n\n');

export const GENERIC_WAIVER_DOC_VERSION = 'community-waiver-v1';

/**
 * Resolve preset-appropriate waiver text, version, and branding.
 * Preserves byte-identical OFFICIAL_WAIVER_TEXT under `pickup-baseball`
 * so existing sealed waiver SHA-256 hashes remain valid.
 * @param {Record<string, any> | null | undefined} env
 */
export function getWaiverSpec(env) {
  const cfg = resolveConfig(env);
  if (cfg.COMMUNITY_PRESET === PRESET_PICKUP_BASEBALL) {
    return {
      documentVersion: WAIVER_DOC_VERSION,
      paragraphs: WAIVER_PARAGRAPHS,
      officialText: OFFICIAL_WAIVER_TEXT,
      organizationLabel: 'Pickup Baseball Foundation',
      certificatePrefix: 'PBF-WVR'
    };
  }

  const communityName = cfg.COMMUNITY_NAME;
  const paragraphs = [
    `I wish to participate in the community events and activities (the “Activities”) organized with ${communityName} volunteers and other participants (collectively, the “Participants”). I understand that the Released Parties will not permit me to participate in the Activities if I do not sign this Consent, Waiver and Indemnity, because the possibility of liability for them is too great to accept.`,
    WAIVER_PARAGRAPHS[1],
    WAIVER_PARAGRAPHS[2],
    WAIVER_PARAGRAPHS[3]
  ];
  const officialText = [
    'CONSENT, WAIVER AND INDEMNITY',
    ...paragraphs,
    GENERIC_WAIVER_DOC_VERSION
  ].join('\n\n');

  return {
    documentVersion: GENERIC_WAIVER_DOC_VERSION,
    paragraphs,
    officialText,
    organizationLabel: communityName,
    certificatePrefix: 'WVR'
  };
}

let ephemeralProvenanceSecret = null;

/**
 * @param {string} sessionSecret
 * @returns {Promise<string>}
 */
async function deriveLegacySessionProvenanceSecret(sessionSecret) {
  return hmacSha256Hex(String(sessionSecret), 'pickup-waiver-provenance-key-v1');
}

/**
 * Resolve isolated waiver provenance HMAC secret material (never coupled to SESSION_SECRET).
 *
 * @param {Record<string, any> | null | undefined} env
 * @param {D1Database | null} [db]
 * @returns {Promise<string>}
 */
async function getProvenanceSecretMaterial(env, db = null) {
  const e = env || (typeof process !== 'undefined' ? process.env : {}) || {};
  const explicitWaiverSecret = e.WAIVER_SIGNING_SECRET !== undefined && e.WAIVER_SIGNING_SECRET !== null
    ? String(e.WAIVER_SIGNING_SECRET).trim()
    : '';
  if (explicitWaiverSecret) {
    return explicitWaiverSecret;
  }

  const targetDb = db || e.DB || e.BASEBALL_DB || null;
  if (targetDb) {
    try {
      const existing = await targetDb.prepare("SELECT value FROM app_settings WHERE key = 'waiver_provenance_secret'").first();
      if (existing && existing.value) {
        return String(existing.value);
      }
      const bytes = new Uint8Array(32);
      crypto.getRandomValues(bytes);
      const generated = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
      await targetDb.prepare("INSERT OR IGNORE INTO app_settings (key, value) VALUES ('waiver_provenance_secret', ?)").bind(generated).run();
      const row = await targetDb.prepare("SELECT value FROM app_settings WHERE key = 'waiver_provenance_secret'").first();
      if (row && row.value) {
        return String(row.value);
      }
    } catch (err) {
      logEvent('warn', 'waiver_provenance_secret_db_failed', { err });
    }
  }

  if (!e.NODE_ENV || e.NODE_ENV !== 'test') {
    throw new Error('WAIVER_SIGNING_SECRET or database binding is required for persistent waiver provenance seals.');
  }

  if (!ephemeralProvenanceSecret) {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    ephemeralProvenanceSecret = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return ephemeralProvenanceSecret;
}

export async function computeProvenanceSeal(env, payloadStr, db = null) {
  const secretMaterial = await getProvenanceSecretMaterial(env, db);
  return hmacSha256Hex(secretMaterial, payloadStr);
}

/**
 * Verify a waiver provenance seal against the isolated `WAIVER_SIGNING_SECRET` /
 * `app_settings.waiver_provenance_secret`, with backward-compatible fallback
 * to DB-stored secret (if WAIVER_SIGNING_SECRET was added later) and the legacy
 * `SESSION_SECRET`-derived HMAC key for pre-cutover waivers.
 *
 * @param {Record<string, any> | null | undefined} env
 * @param {string} payloadStr
 * @param {string} storedSeal
 * @param {D1Database | null} [db]
 * @returns {Promise<boolean>}
 */
export async function verifyWaiverProvenanceSeal(env, payloadStr, storedSeal, db = null) {
  if (!storedSeal || typeof storedSeal !== 'string') {
    return false;
  }
  const primarySeal = await computeProvenanceSeal(env, payloadStr, db);
  if (constantTimeEqual(primarySeal, storedSeal)) {
    return true;
  }

  const e = env || (typeof process !== 'undefined' ? process.env : {}) || {};
  const explicitWaiverSecret = e.WAIVER_SIGNING_SECRET !== undefined && e.WAIVER_SIGNING_SECRET !== null
    ? String(e.WAIVER_SIGNING_SECRET).trim()
    : '';
  const targetDb = db || e.DB || e.BASEBALL_DB || null;
  if (explicitWaiverSecret && targetDb) {
    try {
      const existing = await targetDb.prepare("SELECT value FROM app_settings WHERE key = 'waiver_provenance_secret'").first();
      if (existing && existing.value) {
        const dbSeal = await hmacSha256Hex(String(existing.value), payloadStr);
        if (constantTimeEqual(dbSeal, storedSeal)) {
          return true;
        }
      }
    } catch (err) {
      logEvent('warn', 'waiver_provenance_legacy_db_lookup_failed', { err });
    }
  }

  const legacySessionSecret = e.SESSION_SECRET !== undefined && e.SESSION_SECRET !== null
    ? String(e.SESSION_SECRET)
    : '';
  if (legacySessionSecret) {
    const legacyMaterial = await deriveLegacySessionProvenanceSecret(legacySessionSecret);
    const legacySeal = await hmacSha256Hex(legacyMaterial, payloadStr);
    if (constantTimeEqual(legacySeal, storedSeal)) {
      return true;
    }
  }

  return false;
}

function generateCertificateId(signedDateStr, prefix = 'PBF-WVR') {
  const dateCompact = String(signedDateStr || new Date().toISOString().slice(0, 10)).replace(/[^0-9]/g, '').slice(0, 8) || '20260101';
  const randBytes = new Uint8Array(5);
  crypto.getRandomValues(randBytes);
  const randHex = Array.from(randBytes).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  return `${prefix}-${dateCompact}-${randHex}`;
}

export function buildCanonicalWaiverPayload({
  document_version,
  waiver_text_sha256,
  email,
  printed_name,
  signed_date,
  signature_type,
  signature_sha256,
  electronic_consent,
  waiver_locale
}) {
  const payloadObj = {
    document_version: String(document_version || WAIVER_DOC_VERSION),
    waiver_text_sha256: String(waiver_text_sha256 || ''),
    email: String(email || '').trim().toLowerCase(),
    printed_name: String(printed_name || '').trim(),
    signed_date: String(signed_date || '').trim(),
    signature_type: String(signature_type || 'drawn'),
    signature_sha256: String(signature_sha256 || ''),
    electronic_consent: Boolean(electronic_consent)
  };
  if (waiver_locale && typeof waiver_locale === 'string') {
    payloadObj.waiver_locale = String(waiver_locale).trim().toLowerCase();
  }
  return JSON.stringify(payloadObj);
}

export function renderSignedWaiverCertificateHtml(waiverRow, integrityVerified = true, includePii = false, env = null) {
  const spec = waiverRow.document_version === WAIVER_DOC_VERSION
    ? {
        documentVersion: WAIVER_DOC_VERSION,
        paragraphs: WAIVER_PARAGRAPHS,
        organizationLabel: 'Pickup Baseball Foundation'
      }
    : getWaiverSpec(env);
  const safeOrgLabel = escapeHtml(spec.organizationLabel);
  const safeName = includePii ? escapeHtml(waiverRow.printed_name || '') : 'Redacted (sign in as owner or organizer to view)';
  const safeEmail = includePii ? escapeHtml(waiverRow.email || '') : 'Redacted (sign in as owner or organizer to view)';
  const safeDate = escapeHtml(waiverRow.signed_date || '');
  const safeSignedAt = escapeHtml(waiverRow.signed_at || '');
  const safeCertId = escapeHtml(waiverRow.certificate_id || '');
  const safeDocVer = escapeHtml(waiverRow.document_version || spec.documentVersion);
  const safeTextHash = escapeHtml(waiverRow.waiver_text_sha256 || '');
  const safeDocHash = escapeHtml(waiverRow.document_sha256 || '');
  const safeSeal = escapeHtml(waiverRow.provenance_seal || '');
  const safeLocale = escapeHtml(waiverRow.waiver_locale || 'en');
  const sigData = includePii ? String(waiverRow.signature_data || '') : '';
  const isImgSig = includePii && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(sigData);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Signed Waiver Certificate (${safeCertId}) - ${safeOrgLabel}</title>
  <style>
    body {
      font-family: Georgia, "Times New Roman", Times, serif;
      color: #111827;
      background: #f3f4f6;
      margin: 0;
      padding: 24px 16px;
      line-height: 1.6;
    }
    .toolbar {
      max-width: 780px;
      margin: 0 auto 16px auto;
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #003831;
      color: #ffffff;
      padding: 12px 18px;
      border-radius: 8px;
    }
    .toolbar button, .toolbar a {
      background: #FD5A1E;
      color: #ffffff;
      border: none;
      padding: 8px 14px;
      border-radius: 6px;
      font-weight: 700;
      font-size: 0.88rem;
      cursor: pointer;
      text-decoration: none;
      display: inline-block;
    }
    .toolbar a.secondary {
      background: rgba(255,255,255,0.15);
      margin-right: 8px;
    }
    .sheet {
      max-width: 780px;
      margin: 0 auto;
      background: #ffffff;
      padding: 48px 56px;
      border: 1px solid #d1d5db;
      box-shadow: 0 4px 16px rgba(0,0,0,0.08);
      box-sizing: border-box;
    }
    h1 {
      text-align: center;
      font-size: 1.25rem;
      letter-spacing: 0.03em;
      margin: 0 0 28px 0;
      text-transform: uppercase;
    }
    p {
      margin: 0 0 18px 0;
      font-size: 1rem;
      text-align: justify;
    }
    p.bold-clause {
      font-weight: 700;
    }
    .sig-grid {
      display: grid;
      grid-template-columns: 1fr 1.3fr;
      gap: 36px;
      margin-top: 38px;
      align-items: end;
    }
    .field-line {
      border-bottom: 1.5px solid #111827;
      padding-bottom: 6px;
      min-height: 36px;
      display: flex;
      align-items: flex-end;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-weight: 700;
      font-size: 1.05rem;
    }
    .field-label {
      font-size: 0.92rem;
      margin-top: 4px;
      color: #374151;
    }
    .sig-img {
      max-height: 76px;
      max-width: 100%;
      display: block;
    }
    .doc-footer-code {
      margin-top: 36px;
      font-size: 0.78rem;
      color: #4b5563;
      font-family: monospace;
    }
    .provenance-box {
      margin-top: 28px;
      padding: 18px 20px;
      background: #f8fafc;
      border: 1.5px solid #cbd5e1;
      border-left: 5px solid #003831;
      border-radius: 6px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 0.82rem;
      line-height: 1.45;
    }
    .provenance-title {
      font-weight: 800;
      color: #003831;
      font-size: 0.92rem;
      margin-bottom: 8px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
    }
    .seal-badge {
      background: ${integrityVerified ? '#dcfce7' : '#fee2e2'};
      color: ${integrityVerified ? '#166534' : '#991b1b'};
      border: 1px solid ${integrityVerified ? '#86efac' : '#fca5a5'};
      padding: 2px 8px;
      border-radius: 99px;
      font-size: 0.75rem;
      font-weight: 700;
    }
    .prov-grid {
      display: grid;
      grid-template-columns: 170px 1fr;
      gap: 4px 12px;
      word-break: break-all;
    }
    .prov-label {
      color: #475569;
      font-weight: 600;
    }
    .prov-val {
      color: #0f172a;
      font-family: monospace;
    }
    @media print {
      body { background: #ffffff; padding: 0; }
      .toolbar { display: none !important; }
      .sheet { box-shadow: none; border: none; padding: 24px; max-width: 100%; }
    }
    @media (max-width: 600px) {
      .sheet { padding: 24px 20px; }
      .sig-grid { grid-template-columns: 1fr; gap: 20px; }
      .prov-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <div>
      <strong>🔏 ${safeOrgLabel} — Signed Waiver Record</strong>
      <span style="font-size: 0.8rem; opacity: 0.85; margin-left: 8px;">(${safeCertId})</span>
    </div>
    <div>
      <a href="/waiver.html" class="secondary">← Back to Waiver Page</a>
      <span style="font-size: 0.8rem; opacity: 0.9;">Use Ctrl/Cmd+P to print or save as PDF</span>
    </div>
  </div>

  <div class="sheet">
    <h1>CONSENT, WAIVER AND INDEMNITY</h1>

    <p>${escapeHtml(spec.paragraphs[0])}</p>
    <p>${escapeHtml(spec.paragraphs[1])}</p>
    <p>${escapeHtml(spec.paragraphs[2])}</p>
    <p class="bold-clause">${escapeHtml(spec.paragraphs[3])}</p>

    <div class="sig-grid">
      <div>
        <div class="field-line">Dated: &nbsp; ${safeDate}</div>
      </div>
      <div>
        <div class="field-line" style="min-height: 68px;">
          ${isImgSig ? `<img src="${sigData}" alt="Digital Signature of ${safeName}" class="sig-img">` : `<span>${safeName}</span>`}
        </div>
        <div class="field-label">Signature</div>

        <div class="field-line" style="margin-top: 22px;">${safeName}</div>
        <div class="field-label">Printed Name</div>
      </div>
    </div>

    <div class="doc-footer-code">${safeDocVer}</div>

    <div class="provenance-box">
      <div class="provenance-title">
        <span>🔒 Electronic Signature Audit Trail &amp; Cryptographic Provenance (ESIGN / UETA)</span>
        <span class="seal-badge">${integrityVerified ? '✓ Cryptographic Seal Verified' : '⚠️ Seal Mismatch'}</span>
      </div>
      <div class="prov-grid">
        <div class="prov-label">Certificate ID:</div>
        <div class="prov-val">${safeCertId}</div>
        <div class="prov-label">Verified Account Email:</div>
        <div class="prov-val">${safeEmail} (OTP Session Verified)</div>
        <div class="prov-label">Printed Name:</div>
        <div class="prov-val">${safeName}</div>
        <div class="prov-label">Executed Timestamp (UTC):</div>
        <div class="prov-val">${safeSignedAt}</div>
        <div class="prov-label">Client IP &amp; User-Agent:</div>
        <div class="prov-val">Redacted (30-day anti-fraud window)</div>
        <div class="prov-label">Electronic Consent:</div>
        <div class="prov-val">Explicitly affirmed by signer prior to execution</div>
        <div class="prov-label">Waiver Text SHA-256:</div>
        <div class="prov-val">${safeTextHash}</div>
        <div class="prov-label">Waiver Signed Locale:</div>
        <div class="prov-val">${safeLocale}</div>
        <div class="prov-label">Signed Record SHA-256:</div>
        <div class="prov-val">${safeDocHash}</div>
        <div class="prov-label">HMAC-SHA256 Provenance Seal:</div>
        <div class="prov-val">${safeSeal}</div>
      </div>
    </div>
  </div>
</body>
</html>`;
}

// GET /api/waiver or /api/waiver/status
async function getWaiverStatusHandler(c) {
  const user = c.get('user');
  const spec = getWaiverSpec(c.env);
  const waiverTextSha256 = await sha256Hex(spec.officialText);

  if (!user) {
    return c.json({
      authenticated: false,
      waiver_status: 'none',
      waiver_signed: false,
      document_version: spec.documentVersion,
      waiver_text_sha256: waiverTextSha256,
      paragraphs: spec.paragraphs,
      latest_waiver: null
    });
  }

  await scrubExpiredWaiverTelemetry(c.env.DB);

  const dbUser = await c.env.DB.prepare(
    "SELECT COALESCE(waiver_status, 'none') as waiver_status, waiver_signed_at FROM users WHERE id = ?"
  ).bind(user.id).first();

  const latestWaiver = await c.env.DB.prepare(`
    SELECT certificate_id, printed_name, email, signed_date, signature_type, document_version,
           waiver_text_sha256, document_sha256, provenance_seal, gdrive_file_id, signed_at
    FROM waivers
    WHERE (user_id = ? OR LOWER(email) = LOWER(?))
      AND COALESCE(status, 'active') != 'quarantined'
    ORDER BY id DESC LIMIT 1
  `).bind(user.id, user.email).first();

  const effectiveStatus = (dbUser && dbUser.waiver_status) ? dbUser.waiver_status : 'none';

  return c.json({
    authenticated: true,
    user: {
      id: user.id,
      name: user.name,
      email: user.email
    },
    waiver_status: effectiveStatus,
    waiver_signed: effectiveStatus === 'digital' || effectiveStatus === 'paper',
    waiver_signed_at: (dbUser && dbUser.waiver_signed_at) || (latestWaiver && latestWaiver.signed_at) || null,
    document_version: spec.documentVersion,
    waiver_text_sha256: waiverTextSha256,
    paragraphs: spec.paragraphs,
    latest_waiver: latestWaiver || null
  });
}

waiverRouter.get('/', getWaiverStatusHandler);
waiverRouter.get('/status', getWaiverStatusHandler);

// POST /api/waiver/sign — Execute digital waiver with cryptographic provenance
waiverRouter.post('/sign', requireAuth, async (c) => {
  const user = c.get('user');
  const clientIp = getClientIp(c);
  const rl = await checkRateLimit(c.env.DB, `waiver_sign:${user.id}`, 10, 3600, c.env);
  if (!rl.allowed) {
    return c.json({ error: 'Too many waiver submissions. Please try again later.' }, 429);
  }

  let body;
  try {
    body = await c.req.json();
  } catch (e) {
    return c.json({ error: 'Invalid JSON request body.' }, 400);
  }

  const printedName = String(body.printed_name || '').trim();
  if (!printedName || printedName.length < 2 || printedName.length > 120) {
    return c.json({ error: 'Please enter your full Printed Name (2 to 120 characters).' }, 400);
  }

  const rawDate = String(body.signed_date || '').trim();
  const todayStr = new Date().toISOString().slice(0, 10);
  let signedDate = todayStr;
  if (rawDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
      return c.json({ error: 'Invalid signed_date format; expected YYYY-MM-DD.' }, 400);
    }
    const [yr, mo, dy] = rawDate.split('-').map(Number);
    const parsedUtc = new Date(Date.UTC(yr, mo - 1, dy));
    if (
      parsedUtc.getUTCFullYear() !== yr ||
      parsedUtc.getUTCMonth() !== mo - 1 ||
      parsedUtc.getUTCDate() !== dy
    ) {
      return c.json({ error: 'Invalid signed_date calendar date.' }, 400);
    }
    const isTest = Boolean(c.env && c.env.NODE_ENV === 'test');
    if (!isTest) {
      const [ty, tm, td] = todayStr.split('-').map(Number);
      const todayUtcMs = Date.UTC(ty, tm - 1, td);
      if (Math.abs(parsedUtc.getTime() - todayUtcMs) > 86400000) {
        return c.json({ error: 'Signature date must match the current date.' }, 400);
      }
    }
    signedDate = rawDate;
  }

  const rawAgeAttestation = body.age_attestation !== undefined ? body.age_attestation : body.attested_18_plus;
  if (rawAgeAttestation !== true && rawAgeAttestation !== 1) {
    return c.json({
      error: 'You must confirm that you are 18 years of age or older (or a parent/legal guardian signing on behalf of a minor).'
    }, 400);
  }

  if (body.electronic_consent !== true) {
    return c.json({ error: 'You must check the box consenting to sign this Consent, Waiver and Indemnity electronically.' }, 400);
  }

  const signatureData = String(body.signature_data || '').trim();
  const signatureType = body.signature_type === 'typed' ? 'typed' : 'drawn';

  const sigMatch = signatureData.match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
  if (!signatureData || !sigMatch) {
    return c.json({ error: 'A valid signature on the signature line is required.' }, 400);
  }
  if (signatureData.length > 250 * 1024) {
    return c.json({ error: 'Signature image data exceeds maximum size (250 KB).' }, 400);
  }
  let sigBytes;
  try {
    sigBytes = base64ToUint8Array(sigMatch[1]);
  } catch (e) {
    return c.json({ error: 'Signature image data contains invalid base64 encoding.' }, 400);
  }
  if (
    !isValidRasterImageBuffer(sigBytes, 'image/png') ||
    sigBytes[4] !== 0x0D || sigBytes[5] !== 0x0A || sigBytes[6] !== 0x1A || sigBytes[7] !== 0x0A
  ) {
    return c.json({ error: 'Signature image must be a valid PNG file.' }, 400);
  }

  const cfg = resolveConfig(c.env);
  const spec = getWaiverSpec(c.env);
  const rawLocale = String(body.waiver_locale || body.locale || '').trim().toLowerCase();
  const validLocales = ['en', 'ar', 'es', 'fa', 'fr', 'hi', 'hy', 'ja', 'ko', 'pa', 'pt', 'ru', 'tl', 'vi', 'zh'];
  const waiverLocale = validLocales.indexOf(rawLocale) !== -1 ? rawLocale : 'en';

  const waiverTextSha256 = await sha256Hex(spec.officialText);
  const signatureSha256 = await sha256Hex(signatureData);
  const canonicalPayload = buildCanonicalWaiverPayload({
    document_version: spec.documentVersion,
    waiver_text_sha256: waiverTextSha256,
    email: user.email,
    printed_name: printedName,
    signed_date: signedDate,
    signature_type: signatureType,
    signature_sha256: signatureSha256,
    electronic_consent: true,
    waiver_locale: waiverLocale
  });
  const documentSha256 = await sha256Hex(canonicalPayload);
  const certificateId = generateCertificateId(signedDate, spec.certificatePrefix);
  const provenanceSeal = await computeProvenanceSeal(c.env, `${certificateId}:${documentSha256}`, c.env.DB);
  const signedAtDate = new Date();
  const signedAtIso = signedAtDate.toISOString();
  const retentionUntilDate = new Date(signedAtDate.getTime());
  retentionUntilDate.setUTCFullYear(retentionUntilDate.getUTCFullYear() + cfg.WAIVER_RETENTION_YEARS);
  const retentionUntilIso = retentionUntilDate.toISOString();
  const userAgent = (c.req.header('User-Agent') || 'unknown').slice(0, 250);

  await c.env.DB.batch([
    c.env.DB.prepare(`
      INSERT INTO waivers (
        certificate_id, user_id, email, printed_name, signed_date,
        signature_type, signature_data, document_version,
        waiver_text_sha256, document_sha256, provenance_seal,
        signer_ip, user_agent, electronic_consent, signed_at, retention_until,
        waiver_locale
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
    `).bind(
      certificateId,
      user.id,
      user.email.toLowerCase(),
      printedName,
      signedDate,
      signatureType,
      signatureData,
      spec.documentVersion,
      waiverTextSha256,
      documentSha256,
      provenanceSeal,
      clientIp,
      userAgent,
      signedAtIso,
      retentionUntilIso,
      waiverLocale
    ),
    c.env.DB.prepare(
      "UPDATE users SET waiver_status = 'digital', waiver_signed_at = ? WHERE id = ?"
    ).bind(signedAtIso, user.id)
  ]);

  const waiverRow = {
    certificate_id: certificateId,
    user_id: user.id,
    email: user.email.toLowerCase(),
    printed_name: printedName,
    signed_date: signedDate,
    signature_type: signatureType,
    signature_data: signatureData,
    document_version: spec.documentVersion,
    waiver_text_sha256: waiverTextSha256,
    document_sha256: documentSha256,
    provenance_seal: provenanceSeal,
    waiver_locale: waiverLocale,
    signed_at: signedAtIso
  };

  const origin = getSafePublicOrigin(c);

  const backgroundWork = (async () => {
    await scrubExpiredWaiverTelemetry(c.env.DB);
    try {
      const provider = resolveStorageProvider(c.env);
      if (provider === 'r2' || (c.env && (c.env.MEDIA_BUCKET || c.env.R2_BUCKET))) {
        const htmlCert = renderSignedWaiverCertificateHtml(waiverRow, true, true, c.env);
        const certKey = canonicalObjectKey('waivers', { certificateId });
        await r2StorageAdapter.putObject(c.env, {
          kind: 'waivers',
          objectKey: certKey,
          mimeType: 'text/html; charset=utf-8',
          bytes: new TextEncoder().encode(htmlCert)
        });
      } else if (isGDriveConfigured(c.env)) {
        const htmlCert = renderSignedWaiverCertificateHtml(waiverRow, true, true, c.env);
        const safeFileNamePart = printedName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40) || 'Player';
        const fileName = `Waiver_${safeFileNamePart}_${signedDate}_${certificateId}.html`;
        const driveFileId = await uploadGDriveTextFile(c.env, {
          fileName,
          mimeType: 'text/html; charset=utf-8',
          content: htmlCert
        });
        if (driveFileId) {
          await c.env.DB.prepare('UPDATE waivers SET gdrive_file_id = ? WHERE certificate_id = ?')
            .bind(driveFileId, certificateId).run();
        }
      }
    } catch (err) {
      console.warn('[Waiver] Optional Google Drive/R2 archival skipped:', err.message);
    }

    try {
      await sendWaiverConfirmationEmail(c.env, origin, {
        email: user.email,
        printedName,
        signedDate,
        certificateId,
        documentSha256
      });
    } catch (err) {
      console.warn('[Waiver] Email receipt dispatch error:', err.message);
    }
  })();

  let scheduledInBackground = false;
  try {
    if (c.executionCtx && typeof c.executionCtx.waitUntil === 'function') {
      c.executionCtx.waitUntil(backgroundWork);
      scheduledInBackground = true;
    }
  } catch (e) {
    /* executionCtx unavailable outside Cloudflare Workers runtime */
  }
  if (!scheduledInBackground) {
    await backgroundWork;
  }

  return c.json({
    success: true,
    message: 'Consent, Waiver and Indemnity signed and cryptographically sealed!',
    waiver_status: 'digital',
    waiver: {
      certificate_id: certificateId,
      printed_name: printedName,
      email: user.email.toLowerCase(),
      signed_date: signedDate,
      signed_at: signedAtIso,
      document_version: spec.documentVersion,
      waiver_text_sha256: waiverTextSha256,
      document_sha256: documentSha256,
      provenance_seal: provenanceSeal,
      waiver_locale: waiverLocale
    }
  }, 201);
});

async function verifyWaiverIntegrity(env, row, db) {
  const sigSha256 = await sha256Hex(row.signature_data);
  const computePayloadWithLocale = (includeLocale) => buildCanonicalWaiverPayload({
    document_version: row.document_version,
    waiver_text_sha256: row.waiver_text_sha256,
    email: row.email,
    printed_name: row.printed_name,
    signed_date: row.signed_date,
    signature_type: row.signature_type,
    signature_sha256: sigSha256,
    electronic_consent: Boolean(row.electronic_consent),
    waiver_locale: includeLocale ? (row.waiver_locale || null) : null
  });

  // Try sealed payload with waiver_locale first
  let expectedCanonical = computePayloadWithLocale(true);
  let recomputedDocSha256 = await sha256Hex(expectedCanonical);
  let sealVerified = await verifyWaiverProvenanceSeal(
    env,
    `${row.certificate_id}:${recomputedDocSha256}`,
    row.provenance_seal,
    db
  );

  // If seal mismatch and row.document_sha256 doesn't match, fallback to legacy payload without waiver_locale
  if (!constantTimeEqual(recomputedDocSha256, row.document_sha256) || !sealVerified) {
    const legacyCanonical = computePayloadWithLocale(false);
    const legacyDocSha256 = await sha256Hex(legacyCanonical);
    const legacySealVerified = await verifyWaiverProvenanceSeal(
      env,
      `${row.certificate_id}:${legacyDocSha256}`,
      row.provenance_seal,
      db
    );
    if (constantTimeEqual(legacyDocSha256, row.document_sha256) && legacySealVerified) {
      return true;
    }
  }

  return Boolean(
    constantTimeEqual(recomputedDocSha256, row.document_sha256) &&
    sealVerified
  );
}

function renderWaiverHtmlResponse(row, integrityVerified, includePii, env) {
  const html = renderSignedWaiverCertificateHtml(row, integrityVerified, includePii, env);
  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-ancestors 'none';"
    }
  });
}

// GET /api/waiver/certificate/:id — Retrieve or print a signed waiver certificate with live integrity verification
waiverRouter.get('/certificate/:id', async (c) => {
  const paramId = String(c.req.param('id') || '').trim();
  const user = c.get('user');

  if ((!user || !user.isAdmin) && c.env && c.env.DB) {
    const certLimit = await checkRateLimit(c.env.DB, `waiver_cert:${getClientIp(c)}`, 30, 600, c.env);
    if (!certLimit.allowed) {
      return c.json({ error: 'Too many certificate lookup requests. Please try again later.' }, 429);
    }
  }

  let row;
  if (/^\d+$/.test(paramId)) {
    if (!user || (!user.isAdmin && user.id !== parseInt(paramId, 10))) {
      return c.json({ error: 'Unauthorized to view this user waiver.' }, 403);
    }
    row = await c.env.DB.prepare(
      "SELECT * FROM waivers WHERE user_id = ? AND COALESCE(status, 'active') != 'quarantined' ORDER BY id DESC LIMIT 1"
    ).bind(parseInt(paramId, 10)).first();
  } else {
    row = await c.env.DB.prepare(
      'SELECT * FROM waivers WHERE certificate_id = ?'
    ).bind(paramId).first();
  }

  if (!row || row.status === 'quarantined') {
    return c.json({ error: 'Signed waiver certificate not found.' }, 404);
  }

  if (c.env && c.env.DB && row.signed_at && (row.signer_ip !== null || row.user_agent !== null || !row.signer_ip_scrubbed_at)) {
    const signedMs = Date.parse(String(row.signed_at));
    if (Number.isFinite(signedMs) && signedMs <= Date.now() - 30 * 86400 * 1000) {
      await scrubExpiredWaiverTelemetry(c.env.DB);
    }
  }

  const integrityVerified = await verifyWaiverIntegrity(c.env, row, c.env.DB);

  const canViewPii = Boolean(user && (user.isAdmin || user.id === row.user_id));

  if (c.req.query('format') === 'html') {
    return renderWaiverHtmlResponse(row, integrityVerified, canViewPii, c.env);
  }

  return c.json({
    waiver: {
      certificate_id: row.certificate_id,
      user_id: canViewPii ? row.user_id : null,
      email: canViewPii ? row.email : null,
      printed_name: canViewPii ? row.printed_name : null,
      signed_date: row.signed_date,
      signature_type: row.signature_type,
      signature_data: canViewPii ? row.signature_data : null,
      document_version: row.document_version,
      waiver_text_sha256: row.waiver_text_sha256,
      document_sha256: row.document_sha256,
      provenance_seal: row.provenance_seal,
      gdrive_file_id: canViewPii ? (row.gdrive_file_id || null) : null,
      signed_at: canViewPii ? row.signed_at : null,
      integrity_verified: integrityVerified
    }
  });
});

// GET /api/waiver/admin/quarantined — Audited Admin legal-defense listing of Quarantined Waivers
waiverRouter.get('/admin/quarantined', requireAdmin, async (c) => {
  const user = c.get('user');
  const db = c.env && (c.env.BASEBALL_DB || c.env.DB);
  if (!db) return c.json({ error: 'Database unavailable.' }, 500);

  await purgeExpiredQuarantinedWaivers(db, c.env);

  const { results } = await db.prepare(`
    SELECT id, certificate_id, email, printed_name, signed_date, signed_at,
           document_version, waiver_locale, status, erasure_requested_at, retention_until,
           document_sha256, provenance_seal, gdrive_file_id
    FROM waivers
    WHERE status = 'quarantined'
    ORDER BY erasure_requested_at DESC, id DESC
    LIMIT 200
  `).all();

  const waivers = results || [];
  logEvent('info', 'admin_quarantined_waiver_list', {
    adminId: user.id,
    count: waivers.length
  });

  return c.json({ waivers });
});

// POST /api/waiver/admin/quarantined/purge — Idempotent Admin purge of expired Quarantined Waivers
waiverRouter.post('/admin/quarantined/purge', requireAdmin, async (c) => {
  const user = c.get('user');
  const db = c.env && (c.env.BASEBALL_DB || c.env.DB);
  if (!db) return c.json({ error: 'Database unavailable.' }, 500);

  const result = await purgeExpiredQuarantinedWaivers(db, c.env);
  logEvent('info', 'admin_quarantined_waiver_purge', {
    adminId: user.id,
    purgedCount: result.purgedCount
  });

  return c.json({
    success: true,
    purgedCount: result.purgedCount,
    certificateIds: result.certificateIds
  });
});

// GET /api/waiver/admin/quarantined/:id — Audited Admin legal-defense inspection of a Quarantined Waiver
waiverRouter.get('/admin/quarantined/:id', requireAdmin, async (c) => {
  const user = c.get('user');
  const db = c.env && (c.env.BASEBALL_DB || c.env.DB);
  if (!db) return c.json({ error: 'Database unavailable.' }, 500);

  const paramId = String(c.req.param('id') || '').trim();
  const row = /^\d+$/.test(paramId)
    ? await db.prepare("SELECT * FROM waivers WHERE id = ? AND status = 'quarantined'").bind(parseInt(paramId, 10)).first()
    : await db.prepare("SELECT * FROM waivers WHERE certificate_id = ? AND status = 'quarantined'").bind(paramId).first();

  if (!row) {
    return c.json({ error: 'Quarantined waiver record not found.' }, 404);
  }

  const integrityVerified = await verifyWaiverIntegrity(c.env, row, db);
  const format = c.req.query('format') === 'html' ? 'html' : 'json';

  logEvent('info', 'admin_quarantined_waiver_access', {
    adminId: user.id,
    waiverId: row.id,
    certificateId: row.certificate_id,
    format,
    integrityVerified
  });

  if (format === 'html') {
    return renderWaiverHtmlResponse(row, integrityVerified, true, c.env);
  }

  return c.json({
    waiver: {
      id: row.id,
      certificate_id: row.certificate_id,
      user_id: row.user_id,
      email: row.email,
      printed_name: row.printed_name,
      signed_date: row.signed_date,
      signature_type: row.signature_type,
      signature_data: row.signature_data,
      document_version: row.document_version,
      waiver_text_sha256: row.waiver_text_sha256,
      document_sha256: row.document_sha256,
      provenance_seal: row.provenance_seal,
      waiver_locale: row.waiver_locale || 'en',
      status: row.status,
      erasure_requested_at: row.erasure_requested_at || null,
      retention_until: row.retention_until || null,
      gdrive_file_id: row.gdrive_file_id || null,
      signed_at: row.signed_at || null,
      integrity_verified: integrityVerified
    }
  });
});

// PUT /api/waiver/checkin/users/:id or PUT /api/waiver/admin/users/:id — Organizer/Admin endpoint to set waiver_status ('none' | 'paper' | 'digital')
const handleUserWaiverCheckin = async (c) => {
  const targetId = parseInt(c.req.param('id'), 10);
  if (!targetId || isNaN(targetId) || targetId <= 0) {
    return c.json({ error: 'Invalid user ID.' }, 400);
  }
  const targetUser = await c.env.DB.prepare('SELECT id, name, email, waiver_status, waiver_signed_at FROM users WHERE id = ?').bind(targetId).first();
  if (!targetUser) {
    return c.json({ error: 'User not found.' }, 404);
  }

  let body;
  try {
    body = await c.req.json();
  } catch (e) {
    return c.json({ error: 'Invalid JSON request body.' }, 400);
  }

  const newStatus = String(body.waiver_status || '').trim().toLowerCase();
  if (!['none', 'paper', 'digital'].includes(newStatus)) {
    return c.json({ error: "Invalid waiver_status. Must be 'none', 'paper', or 'digital'." }, 400);
  }

  const currentStatus = targetUser.waiver_status || 'none';
  if (currentStatus === 'digital' && newStatus !== 'digital') {
    return c.json({ error: 'Cannot overwrite an existing digital ESIGN waiver.' }, 409);
  }

  const newSignedAt = newStatus === 'none'
    ? null
    : (targetUser.waiver_signed_at || new Date().toISOString());

  await c.env.DB.prepare(
    'UPDATE users SET waiver_status = ?, waiver_signed_at = ? WHERE id = ?'
  ).bind(newStatus, newSignedAt, targetId).run();

  return c.json({
    success: true,
    message: `Waiver status for ${targetUser.name} (${targetUser.email}) updated to ${newStatus}.`,
    user: {
      id: targetId,
      waiver_status: newStatus,
      waiver_signed: newStatus === 'paper' || newStatus === 'digital',
      waiver_signed_at: newSignedAt
    }
  });
};

waiverRouter.put('/checkin/users/:id', requireOrganizer, handleUserWaiverCheckin);
waiverRouter.put('/admin/users/:id', requireAdmin, handleUserWaiverCheckin);

// PUT /api/waiver/checkin/attendees/:id — Organizer/Admin endpoint to toggle paper waiver on Visitor RSVP row
waiverRouter.put('/checkin/attendees/:id', requireOrganizer, async (c) => {
  const attendeeId = parseInt(c.req.param('id'), 10);
  if (!attendeeId || isNaN(attendeeId) || attendeeId <= 0) {
    return c.json({ error: 'Invalid attendee ID.' }, 400);
  }
  const user = c.get('user');
  const attendee = await c.env.DB.prepare(`
    SELECT a.id, a.user_id, a.name, a.email, a.paper_waiver_at, a.paper_waiver_by, u.waiver_status as user_waiver_status
    FROM attendees a
    LEFT JOIN users u ON a.user_id = u.id
    WHERE a.id = ?
  `).bind(attendeeId).first();
  if (!attendee) {
    return c.json({ error: 'Attendee not found.' }, 404);
  }

  // Check if this attendee is already covered by an active digital waiver (via user account or waivers table)
  if (attendee.user_waiver_status === 'digital') {
    return c.json({ error: 'Cannot overwrite an existing digital ESIGN waiver.' }, 409);
  }
  if (attendee.email) {
    const activeDigital = await c.env.DB.prepare(`
      SELECT id FROM waivers
      WHERE email = ? AND COALESCE(status, 'active') != 'quarantined'
      LIMIT 1
    `).bind(String(attendee.email).toLowerCase()).first();
    if (activeDigital) {
      return c.json({ error: 'Cannot overwrite an existing digital ESIGN waiver.' }, 409);
    }
  }

  let body;
  try {
    body = await c.req.json();
  } catch (e) {
    return c.json({ error: 'Invalid JSON request body.' }, 400);
  }

  const requestedStatus = String(body.waiver_status || '').trim().toLowerCase();
  if (!['none', 'paper'].includes(requestedStatus)) {
    return c.json({ error: "Invalid waiver_status. Must be 'none' or 'paper'." }, 400);
  }

  const newPaperAt = requestedStatus === 'paper' ? new Date().toISOString() : null;
  const newPaperBy = requestedStatus === 'paper' ? (user ? user.id : null) : null;

  await c.env.DB.prepare(`
    UPDATE attendees
    SET paper_waiver_at = ?, paper_waiver_by = ?
    WHERE id = ?
  `).bind(newPaperAt, newPaperBy, attendeeId).run();

  return c.json({
    success: true,
    message: `Paper waiver for ${attendee.name} updated to ${requestedStatus}.`,
    attendee: {
      id: attendeeId,
      waiver_status: requestedStatus,
      paper_waiver_at: newPaperAt,
      paper_waiver_by: newPaperBy
    }
  });
});
