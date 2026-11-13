/**
 * Native Digital & Paper Waiver Service with Cryptographic Provenance (ESIGN / UETA Compliant)
 * Form 41335\14760738.1 — CONSENT, WAIVER AND INDEMNITY
 */

import { Hono } from 'hono';
import {
  escapeHtml,
  sha256Hex,
  getClientIp,
  checkRateLimit,
  requireAuth,
  requireAdmin
} from '../security.js';
import { isGDriveConfigured, uploadGDriveTextFile } from '../gdrive.js';
import { sendWaiverConfirmationEmail } from '../mailer.js';

export const waiverRouter = new Hono();

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

function getSubtleCrypto() {
  if (typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.subtle) {
    return globalThis.crypto.subtle;
  }
  return null;
}

let ephemeralProvenanceSecret = null;

function getProvenanceSecretMaterial(env) {
  const e = env || process.env || {};
  const configured =
    e.WAIVER_SIGNING_SECRET ||
    e.SESSION_SECRET ||
    e.GDRIVE_CLIENT_SECRET ||
    e.TURNSTILE_SECRET_KEY;
  if (configured) return configured;

  if (!ephemeralProvenanceSecret) {
    const bytes = new Uint8Array(32);
    globalThis.crypto.getRandomValues(bytes);
    ephemeralProvenanceSecret = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    if (!e.NODE_ENV || e.NODE_ENV !== 'test') {
      console.warn('[Waiver] WAIVER_SIGNING_SECRET is not set; using ephemeral per-isolate key for HMAC provenance seals.');
    }
  }
  return ephemeralProvenanceSecret;
}

export async function computeProvenanceSeal(env, payloadStr) {
  const secretMaterial = getProvenanceSecretMaterial(env);
  const subtle = getSubtleCrypto();
  const keyBytes = new TextEncoder().encode(secretMaterial);
  const cryptoKey = await subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sigBuffer = await subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(String(payloadStr || '')));
  return Array.from(new Uint8Array(sigBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function generateCertificateId(signedDateStr) {
  const dateCompact = String(signedDateStr || new Date().toISOString().slice(0, 10)).replace(/[^0-9]/g, '').slice(0, 8) || '20260101';
  const randBytes = new Uint8Array(5);
  globalThis.crypto.getRandomValues(randBytes);
  const randHex = Array.from(randBytes).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  return `PBF-WVR-${dateCompact}-${randHex}`;
}

export function buildCanonicalWaiverPayload({
  document_version,
  waiver_text_sha256,
  email,
  printed_name,
  signed_date,
  signature_type,
  signature_sha256,
  electronic_consent
}) {
  return JSON.stringify({
    document_version: String(document_version || WAIVER_DOC_VERSION),
    waiver_text_sha256: String(waiver_text_sha256 || ''),
    email: String(email || '').trim().toLowerCase(),
    printed_name: String(printed_name || '').trim(),
    signed_date: String(signed_date || '').trim(),
    signature_type: String(signature_type || 'drawn'),
    signature_sha256: String(signature_sha256 || ''),
    electronic_consent: Boolean(electronic_consent)
  });
}

export function renderSignedWaiverCertificateHtml(waiverRow, integrityVerified = true, includePii = false) {
  const safeName = includePii ? escapeHtml(waiverRow.printed_name || '') : 'Redacted (sign in as owner or organizer to view)';
  const safeEmail = includePii ? escapeHtml(waiverRow.email || '') : 'Redacted (sign in as owner or organizer to view)';
  const safeDate = escapeHtml(waiverRow.signed_date || '');
  const safeSignedAt = escapeHtml(waiverRow.signed_at || '');
  const safeCertId = escapeHtml(waiverRow.certificate_id || '');
  const safeDocVer = escapeHtml(waiverRow.document_version || WAIVER_DOC_VERSION);
  const safeTextHash = escapeHtml(waiverRow.waiver_text_sha256 || '');
  const safeDocHash = escapeHtml(waiverRow.document_sha256 || '');
  const safeSeal = escapeHtml(waiverRow.provenance_seal || '');
  const safeIp = includePii ? escapeHtml(waiverRow.signer_ip || 'recorded') : 'Redacted';
  const safeUa = includePii ? escapeHtml(waiverRow.user_agent || 'browser') : 'Verification View';
  const sigData = includePii ? String(waiverRow.signature_data || '') : '';
  const isImgSig = includePii && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(sigData);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Signed Waiver Certificate (${safeCertId}) - Pickup Baseball Foundation</title>
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
      <strong>🔏 Pickup Baseball Foundation — Signed Waiver Record</strong>
      <span style="font-size: 0.8rem; opacity: 0.85; margin-left: 8px;">(${safeCertId})</span>
    </div>
    <div>
      <a href="/waiver.html" class="secondary">← Back to Waiver Page</a>
      <span style="font-size: 0.8rem; opacity: 0.9;">Use Ctrl/Cmd+P to print or save as PDF</span>
    </div>
  </div>

  <div class="sheet">
    <h1>CONSENT, WAIVER AND INDEMNITY</h1>

    <p>${escapeHtml(WAIVER_PARAGRAPHS[0])}</p>
    <p>${escapeHtml(WAIVER_PARAGRAPHS[1])}</p>
    <p>${escapeHtml(WAIVER_PARAGRAPHS[2])}</p>
    <p class="bold-clause">${escapeHtml(WAIVER_PARAGRAPHS[3])}</p>

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
        <div class="prov-val">${safeIp} • ${safeUa}</div>
        <div class="prov-label">Electronic Consent:</div>
        <div class="prov-val">Explicitly affirmed by signer prior to execution</div>
        <div class="prov-label">Waiver Text SHA-256:</div>
        <div class="prov-val">${safeTextHash}</div>
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
  const waiverTextSha256 = await sha256Hex(OFFICIAL_WAIVER_TEXT);

  if (!user) {
    return c.json({
      authenticated: false,
      waiver_status: 'none',
      waiver_signed: false,
      document_version: WAIVER_DOC_VERSION,
      waiver_text_sha256: waiverTextSha256,
      paragraphs: WAIVER_PARAGRAPHS,
      latest_waiver: null
    });
  }

  const dbUser = await c.env.DB.prepare(
    "SELECT COALESCE(waiver_status, 'none') as waiver_status, waiver_signed_at FROM users WHERE id = ?"
  ).bind(user.id).first();

  const latestWaiver = await c.env.DB.prepare(`
    SELECT certificate_id, printed_name, email, signed_date, signature_type, document_version,
           waiver_text_sha256, document_sha256, provenance_seal, gdrive_file_id, signed_at
    FROM waivers
    WHERE user_id = ? OR LOWER(email) = LOWER(?)
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
    document_version: WAIVER_DOC_VERSION,
    waiver_text_sha256: waiverTextSha256,
    paragraphs: WAIVER_PARAGRAPHS,
    latest_waiver: latestWaiver || null
  });
}

waiverRouter.get('/', getWaiverStatusHandler);
waiverRouter.get('/status', getWaiverStatusHandler);

// POST /api/waiver/sign — Execute digital waiver with cryptographic provenance
waiverRouter.post('/sign', requireAuth, async (c) => {
  const user = c.get('user');
  const clientIp = getClientIp(c);
  const rl = await checkRateLimit(c.env.DB, `waiver_sign_${user.id}`, 10, 3600, c.env);
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
  const signedDate = /^\d{4}-\d{2}-\d{2}$/.test(rawDate)
    ? rawDate
    : new Date().toISOString().slice(0, 10);

  if (body.electronic_consent !== true) {
    return c.json({ error: 'You must check the box consenting to sign this Consent, Waiver and Indemnity electronically.' }, 400);
  }

  const signatureData = String(body.signature_data || '').trim();
  const signatureType = body.signature_type === 'typed' ? 'typed' : 'drawn';

  if (!signatureData || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(signatureData)) {
    return c.json({ error: 'A valid signature on the signature line is required.' }, 400);
  }
  if (signatureData.length > 250 * 1024) {
    return c.json({ error: 'Signature image data exceeds maximum size (250 KB).' }, 400);
  }

  const waiverTextSha256 = await sha256Hex(OFFICIAL_WAIVER_TEXT);
  const signatureSha256 = await sha256Hex(signatureData);
  const canonicalPayload = buildCanonicalWaiverPayload({
    document_version: WAIVER_DOC_VERSION,
    waiver_text_sha256: waiverTextSha256,
    email: user.email,
    printed_name: printedName,
    signed_date: signedDate,
    signature_type: signatureType,
    signature_sha256: signatureSha256,
    electronic_consent: true
  });
  const documentSha256 = await sha256Hex(canonicalPayload);
  const certificateId = generateCertificateId(signedDate);
  const provenanceSeal = await computeProvenanceSeal(c.env, `${certificateId}:${documentSha256}`);
  const signedAtIso = new Date().toISOString();
  const userAgent = (c.req.header('User-Agent') || 'unknown').slice(0, 250);

  await c.env.DB.batch([
    c.env.DB.prepare(`
      INSERT INTO waivers (
        certificate_id, user_id, email, printed_name, signed_date,
        signature_type, signature_data, document_version,
        waiver_text_sha256, document_sha256, provenance_seal,
        signer_ip, user_agent, electronic_consent, signed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    `).bind(
      certificateId,
      user.id,
      user.email.toLowerCase(),
      printedName,
      signedDate,
      signatureType,
      signatureData,
      WAIVER_DOC_VERSION,
      waiverTextSha256,
      documentSha256,
      provenanceSeal,
      clientIp,
      userAgent,
      signedAtIso
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
    document_version: WAIVER_DOC_VERSION,
    waiver_text_sha256: waiverTextSha256,
    document_sha256: documentSha256,
    provenance_seal: provenanceSeal,
    signer_ip: clientIp,
    user_agent: userAgent,
    signed_at: signedAtIso
  };

  const origin = new URL(c.req.url).origin;

  const backgroundWork = (async () => {
    try {
      if (isGDriveConfigured(c.env)) {
        const htmlCert = renderSignedWaiverCertificateHtml(waiverRow, true, true);
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
      console.warn('[Waiver] Optional Google Drive archival skipped:', err.message);
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

  if (c.executionCtx && typeof c.executionCtx.waitUntil === 'function') {
    c.executionCtx.waitUntil(backgroundWork);
  } else {
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
      document_version: WAIVER_DOC_VERSION,
      waiver_text_sha256: waiverTextSha256,
      document_sha256: documentSha256,
      provenance_seal: provenanceSeal
    }
  }, 201);
});

// GET /api/waiver/certificate/:id — Retrieve or print a signed waiver certificate with live integrity verification
waiverRouter.get('/certificate/:id', async (c) => {
  const paramId = String(c.req.param('id') || '').trim();
  const user = c.get('user');

  let row = null;
  if (/^\d+$/.test(paramId)) {
    if (!user || (!user.canManageEvents && user.id !== parseInt(paramId, 10))) {
      return c.json({ error: 'Unauthorized to view this user waiver.' }, 403);
    }
    row = await c.env.DB.prepare(
      'SELECT * FROM waivers WHERE user_id = ? ORDER BY id DESC LIMIT 1'
    ).bind(parseInt(paramId, 10)).first();
  } else {
    row = await c.env.DB.prepare(
      'SELECT * FROM waivers WHERE certificate_id = ?'
    ).bind(paramId).first();
  }

  if (!row) {
    return c.json({ error: 'Signed waiver certificate not found.' }, 404);
  }

  // Re-verify cryptographic provenance hash and HMAC seal
  const sigSha256 = await sha256Hex(row.signature_data);
  const expectedCanonical = buildCanonicalWaiverPayload({
    document_version: row.document_version,
    waiver_text_sha256: row.waiver_text_sha256,
    email: row.email,
    printed_name: row.printed_name,
    signed_date: row.signed_date,
    signature_type: row.signature_type,
    signature_sha256: sigSha256,
    electronic_consent: Boolean(row.electronic_consent)
  });
  const recomputedDocSha256 = await sha256Hex(expectedCanonical);
  const recomputedSeal = await computeProvenanceSeal(c.env, `${row.certificate_id}:${recomputedDocSha256}`);
  const integrityVerified = (
    recomputedDocSha256 === row.document_sha256 &&
    recomputedSeal === row.provenance_seal
  );

  const canViewPii = Boolean(user && (user.canManageEvents || user.id === row.user_id));

  if (c.req.query('format') === 'html') {
    const html = renderSignedWaiverCertificateHtml(row, integrityVerified, canViewPii);
    return new Response(html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'none'; object-src 'none'; frame-ancestors 'none';"
      }
    });
  }

  return c.json({
    waiver: {
      certificate_id: row.certificate_id,
      user_id: row.user_id,
      email: canViewPii ? row.email : null,
      printed_name: canViewPii ? row.printed_name : null,
      signed_date: row.signed_date,
      signature_type: row.signature_type,
      signature_data: canViewPii ? row.signature_data : null,
      document_version: row.document_version,
      waiver_text_sha256: row.waiver_text_sha256,
      document_sha256: row.document_sha256,
      provenance_seal: row.provenance_seal,
      gdrive_file_id: row.gdrive_file_id || null,
      signed_at: row.signed_at,
      integrity_verified: integrityVerified
    }
  });
});

// PUT /api/waiver/admin/users/:id — Admin endpoint to set waiver_status ('none' | 'paper' | 'digital')
waiverRouter.put('/admin/users/:id', requireAdmin, async (c) => {
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
});
