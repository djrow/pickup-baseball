import { Hono } from 'hono';
import { handle } from 'hono/cloudflare-pages';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';

const app = new Hono().basePath('/api');

const SESSION_COOKIE_NAME = 'baseball_session';
const SESSION_DURATION_SECONDS = 90 * 24 * 60 * 60; // 90 days
const AUTH_CODE_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes
const MAX_CODE_VERIFY_ATTEMPTS = 5;

// -----------------------------------------------------------------------------
// Security & Crypto Utilities
// -----------------------------------------------------------------------------

function generateToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function generateCode() {
  const array = new Uint32Array(1);
  // Rejection sampling to eliminate modulo bias (4294000000 is largest multiple of 900000 < 2^32)
  let val = 4294967295;
  while (val >= 4294000000) {
    crypto.getRandomValues(array);
    val = array[0];
  }
  return (100000 + (val % 900000)).toString();
}

async function sha256Hex(input) {
  const data = new TextEncoder().encode(String(input));
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sanitizeHttpUrl(rawUrl) {
  if (!rawUrl || !String(rawUrl).trim()) return '';
  const trimmed = String(rawUrl).trim();
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.href;
    }
  } catch (e) {}
  return null;
}

function getSafeRelativeRedirect(redirectParam) {
  if (!redirectParam || typeof redirectParam !== 'string') {
    return '/index.html?logged_in=1';
  }
  const trimmed = redirectParam.trim();
  try {
    const parsed = new URL(trimmed, 'https://www.pickupbaseballfoundation.org');
    if (parsed.origin === 'https://www.pickupbaseballfoundation.org' && parsed.pathname.startsWith('/') && !parsed.pathname.startsWith('//')) {
      return parsed.pathname + parsed.search + parsed.hash;
    }
  } catch (e) {}
  if (trimmed.startsWith('/') && !trimmed.startsWith('//') && !trimmed.startsWith('/\\')) {
    return trimmed;
  }
  return '/index.html?logged_in=1';
}

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function stripJpegMetadata(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 4 || bytes[0] !== 0xFF || bytes[1] !== 0xD8) return buffer;
  const chunks = [bytes.slice(0, 2)];
  let pos = 2;
  while (pos + 4 <= bytes.length) {
    if (bytes[pos] !== 0xFF) {
      chunks.push(bytes.slice(pos));
      break;
    }
    const marker = bytes[pos + 1];
    // SOS (Start of Scan) or EOI: copy the rest of the image data
    if (marker === 0xDA || marker === 0xD9) {
      chunks.push(bytes.slice(pos));
      break;
    }
    const segLen = (bytes[pos + 2] << 8) | bytes[pos + 3];
    if (segLen < 2 || pos + 2 + segLen > bytes.length) {
      chunks.push(bytes.slice(pos));
      break;
    }
    // Strip APP1..APP15 (0xE1..0xEF, which contain EXIF/GPS) and Comment (0xFE)
    if (!((marker >= 0xE1 && marker <= 0xEF) || marker === 0xFE)) {
      chunks.push(bytes.slice(pos, pos + 2 + segLen));
    }
    pos += 2 + segLen;
  }
  const totalLen = chunks.reduce((acc, c) => acc + c.length, 0);
  const out = new Uint8Array(totalLen);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out.buffer;
}

function isValidRasterImageBuffer(buffer, mime) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 12) return false;
  if (mime === 'image/jpeg') {
    return bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF;
  }
  if (mime === 'image/png') {
    return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47;
  }
  if (mime === 'image/gif') {
    return bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38;
  }
  if (mime === 'image/webp') {
    return (
      bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
    );
  }
  return false;
}

function getClientIp(c) {
  return (
    c.req.header('CF-Connecting-IP') ||
    (c.req.header('X-Forwarded-For') || '').split(',')[0].trim() ||
    'unknown'
  );
}

async function checkRateLimit(db, key, maxRequests, windowSeconds) {
  if (!db) return { allowed: true };
  const nowSec = Math.floor(Date.now() / 1000);
  const windowStartCutoff = nowSec - windowSeconds;

  try {
    const existing = await db.prepare(
      'SELECT count, window_start FROM rate_limits WHERE key = ?'
    ).bind(key).first();

    if (!existing || existing.window_start < windowStartCutoff) {
      await db.prepare(
        'INSERT OR REPLACE INTO rate_limits (key, count, window_start) VALUES (?, 1, ?)'
      ).bind(key, nowSec).run();
      return { allowed: true, remaining: maxRequests - 1 };
    }

    if (existing.count >= maxRequests) {
      return { allowed: false, remaining: 0 };
    }

    await db.prepare(
      'UPDATE rate_limits SET count = count + 1 WHERE key = ?'
    ).bind(key).run();

    return { allowed: true, remaining: maxRequests - (existing.count + 1) };
  } catch (err) {
    console.warn('[RateLimit] Fallback allow due to error:', err.message);
    return { allowed: true };
  }
}

async function verifyTurnstileIfConfigured(env, token, remoteip) {
  if (!env.TURNSTILE_SECRET_KEY) return true;
  if (!token) return false;
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        secret: env.TURNSTILE_SECRET_KEY,
        response: token,
        remoteip: remoteip || ''
      })
    });
    const data = await res.json();
    return Boolean(data.success);
  } catch (e) {
    console.error('[Turnstile] Verification error:', e);
    return false;
  }
}

// -----------------------------------------------------------------------------
// Mailer (Resend REST API)
// -----------------------------------------------------------------------------

async function dispatchEmail(env, { to, subject, text, html }) {
  const appName = env.APP_NAME || 'Sunday Pickup Baseball';
  const from = env.FROM_EMAIL || `"${appName}" <games@pickupbaseballfoundation.org>`;
  const replyTo = env.REPLY_TO_EMAIL || 'pickupbaseballfoundation@gmail.com';
  const apiKey = env.RESEND_API_KEY;

  if (apiKey) {
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey.trim()}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from,
          to: Array.isArray(to) ? to : [to],
          reply_to: replyTo,
          subject,
          text,
          html
        })
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.message || `Resend API error (${response.status})`);
      }
      return { messageId: data.id };
    } catch (err) {
      console.error('[Mailer:Resend] Delivery failed to ' + to + ':', err.message);
      throw err;
    }
  }

  console.log('\n[Email Dispatch (No Key)] To: ' + to + ' | Subject: ' + subject);
  return { messageId: 'mock-' + Date.now() };
}

async function sendAuthCode(env, origin, { email, name, code, token }) {
  const appName = env.APP_NAME || 'Sunday Pickup Baseball';
  const magicLink = `${origin}/api/auth/verify-magic?token=${encodeURIComponent(token)}`;
  const subject = `Your Sign-In Code for ${appName}: ${code}`;
  const safeName = escapeHtml(name || 'there');
  const safeAppName = escapeHtml(appName);
  const safeCode = escapeHtml(code);

  const text = `Hi ${name || 'there'},

Welcome to ${appName}!

Your 6-digit sign-in code is: ${code}

Or click the link below to sign in automatically:
${magicLink}

This code and link will expire in 10 minutes.

Play ball!
- ${appName} Team`;

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 580px; margin: 0 auto; padding: 26px; border: 1px solid #dbe4e0; border-top: 5px solid #003831; border-radius: 8px; background: #ffffff;">
      <h2 style="color: #003831; margin-top: 0; font-size: 22px;"><img src="${origin}/logo.svg" alt="" style="width: 30px; height: 30px; vertical-align: middle; margin-right: 6px;">${safeAppName}</h2>
      <p style="color: #0c1f1a; font-size: 16px;">Hi <strong>${safeName}</strong>,</p>
      <p style="color: #546e66; font-size: 15px;">Use the code below to sign in to your account:</p>
      <div style="background: #f5f8f7; border: 1px solid #dbe4e0; padding: 18px; border-radius: 8px; text-align: center; margin: 24px 0;">
        <span style="font-size: 34px; font-weight: 800; letter-spacing: 6px; color: #003831;">${safeCode}</span>
      </div>
      <p style="text-align: center; margin: 26px 0;">
        <a href="${magicLink}" style="background: #FD5A1E; color: #ffffff; padding: 13px 26px; border-radius: 6px; text-decoration: none; font-weight: 700; font-size: 15px; display: inline-block;">
          Or Click to Sign In Instantly →
        </a>
      </p>
      <p style="color: #546e66; font-size: 13px; margin-top: 32px; border-top: 1px solid #dbe4e0; padding-top: 14px;">This code expires in 10 minutes and is invalidated after 5 failed attempts. If you did not request this, you can safely ignore this email.</p>
    </div>
  `;

  return dispatchEmail(env, { to: email, subject, text, html });
}

async function sendRsvpConfirmation(env, origin, { email, name, event, dutyName, gearBringing, managementToken }) {
  const appName = env.APP_NAME || 'Sunday Pickup Baseball';
  const manageLink = `${origin}/event.html?id=${event.id}&token=${encodeURIComponent(managementToken || '')}`;
  const eventDateFormatted = new Date(event.event_date).toLocaleString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/Los_Angeles',
    timeZoneName: 'short'
  });

  const safeName = escapeHtml(name);
  const safeTitle = escapeHtml(event.title);
  const safeLocation = escapeHtml(event.location);
  const safeLocationUrl = sanitizeHttpUrl(event.location_url);
  const safeDutyName = escapeHtml(dutyName);
  const safeGear = escapeHtml(gearBringing);

  const subject = `Confirmed: You're playing in ${event.title} (${eventDateFormatted})`;
  const text = `Hi ${name},

You're confirmed for pickup baseball!

Event: ${event.title}
Date & Time: ${eventDateFormatted}
Location: ${event.location}
${dutyName ? `Duty Signed Up For: ${dutyName}\n` : ''}${gearBringing ? `Gear You're Bringing: ${gearBringing}\n` : ''}
Need to coordinate gear, check who else is coming, or change your RSVP?
Visit the event page here:
${manageLink}

See you on the field!
- ${appName}`;

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 580px; margin: 0 auto; padding: 26px; border: 1px solid #dbe4e0; border-top: 5px solid #FD5A1E; border-radius: 8px; background: #ffffff;">
      <h2 style="color: #003831; margin-top: 0; font-size: 22px;"><img src="${origin}/logo.svg" alt="" style="width: 30px; height: 30px; vertical-align: middle; margin-right: 6px;">RSVP Confirmed!</h2>
      <p style="color: #0c1f1a; font-size: 16px;">Hi <strong>${safeName}</strong>,</p>
      <p style="color: #546e66; font-size: 15px;">You are confirmed on the roster for <strong>${safeTitle}</strong>.</p>
      
      <div style="background: #f5f8f7; border-left: 4px solid #003831; border: 1px solid #dbe4e0; padding: 18px; margin: 20px 0; border-radius: 6px;">
        <p style="margin: 4px 0; color: #0c1f1a;"><strong>📅 When:</strong> ${escapeHtml(eventDateFormatted)}</p>
        <p style="margin: 4px 0; color: #0c1f1a;"><strong>📍 Where:</strong> ${safeLocation}</p>
        ${safeLocationUrl ? `<p style="margin: 4px 0;"><a href="${escapeHtml(safeLocationUrl)}" target="_blank" rel="noopener noreferrer" style="color: #FD5A1E; font-weight: 700;">View Map / Directions ↗</a></p>` : ''}
        ${safeDutyName ? `<p style="margin: 6px 0 4px 0; color: #003831;"><strong>🛡️ Your Duty:</strong> <span style="background: #e6f0ed; padding: 2px 8px; border-radius: 4px; font-weight: 700;">${safeDutyName}</span></p>` : ''}
        ${safeGear ? `<p style="margin: 4px 0; color: #0c1f1a;"><strong>🎒 Gear You're Bringing:</strong> <em>${safeGear}</em></p>` : ''}
      </div>

      <p style="text-align: center; margin: 28px 0;">
        <a href="${manageLink}" style="background: #FD5A1E; color: #ffffff; padding: 13px 26px; border-radius: 6px; text-decoration: none; font-weight: 700; font-size: 15px; display: inline-block;">
          View Live Roster & Coordinate Gear →
        </a>
      </p>

      <p style="color: #546e66; font-size: 13px; border-top: 1px solid #dbe4e0; padding-top: 14px;">
        Plans changed? Use the button above to update your gear or cancel your attendance so another player can take your spot.
      </p>
    </div>
  `;

  return dispatchEmail(env, { to: email, subject, text, html });
}

async function sendEventReminder(env, origin, { email, name, event, dutyName, gearBringing, totalAttendees, managementToken }) {
  const appName = env.APP_NAME || 'Sunday Pickup Baseball';
  const manageLink = `${origin}/event.html?id=${event.id}&token=${encodeURIComponent(managementToken || '')}`;
  const eventDateFormatted = new Date(event.event_date).toLocaleString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/Los_Angeles',
    timeZoneName: 'short'
  });

  const safeName = escapeHtml(name);
  const safeTitle = escapeHtml(event.title);
  const safeLocation = escapeHtml(event.location);
  const safeLocationUrl = sanitizeHttpUrl(event.location_url);
  const safeDutyName = escapeHtml(dutyName);
  const safeGear = escapeHtml(gearBringing);

  const subject = `Game Reminder: ${event.title} is coming up! (${eventDateFormatted})`;
  const text = `Hi ${name},

This is a reminder that you're signed up for pickup baseball:

Event: ${event.title}
Date & Time: ${eventDateFormatted}
Location: ${event.location}
${dutyName ? `Your Assigned Duty: ${dutyName}\n` : ''}${gearBringing ? `Gear You're Bringing: ${gearBringing}\n` : ''}Total Players Confirmed: ${totalAttendees}

View details & live roster:
${manageLink}

See you on the diamond!
- ${appName}`;

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 580px; margin: 0 auto; padding: 26px; border: 1px solid #dbe4e0; border-top: 5px solid #003831; border-radius: 8px; background: #ffffff;">
      <h2 style="color: #003831; margin-top: 0; font-size: 22px;"><img src="${origin}/logo.svg" alt="" style="width: 30px; height: 30px; vertical-align: middle; margin-right: 6px;">Game Day Reminder</h2>
      <p style="color: #0c1f1a; font-size: 16px;">Hi <strong>${safeName}</strong>,</p>
      <p style="color: #546e66; font-size: 15px;">Get ready! <strong>${safeTitle}</strong> is coming up soon.</p>
      
      <div style="background: #f5f8f7; border-left: 4px solid #003831; border: 1px solid #dbe4e0; padding: 18px; margin: 20px 0; border-radius: 6px;">
        <p style="margin: 4px 0; color: #0c1f1a;"><strong>📅 When:</strong> ${escapeHtml(eventDateFormatted)}</p>
        <p style="margin: 4px 0; color: #0c1f1a;"><strong>📍 Where:</strong> ${safeLocation}</p>
        <p style="margin: 4px 0; color: #0c1f1a;"><strong>👥 Confirmed Players:</strong> ${Number(totalAttendees) || 0}</p>
        ${safeLocationUrl ? `<p style="margin: 4px 0;"><a href="${escapeHtml(safeLocationUrl)}" target="_blank" rel="noopener noreferrer" style="color: #FD5A1E; font-weight: 700;">View Map / Directions ↗</a></p>` : ''}
        ${safeDutyName ? `<p style="margin: 6px 0 4px 0; color: #003831;"><strong>🛡️ Your Duty:</strong> <span style="background: #e6f0ed; padding: 2px 8px; border-radius: 4px; font-weight: 700;">${safeDutyName}</span></p>` : ''}
        ${safeGear ? `<p style="margin: 4px 0; color: #0c1f1a;"><strong>🎒 Gear You're Bringing:</strong> <em>${safeGear}</em></p>` : ''}
      </div>

      <p style="text-align: center; margin: 28px 0;">
        <a href="${manageLink}" style="background: #003831; color: #ffffff; padding: 13px 26px; border-radius: 6px; text-decoration: none; font-weight: 700; font-size: 15px; display: inline-block;">
          Check Game Discussion & Roster →
        </a>
      </p>
    </div>
  `;

  return dispatchEmail(env, { to: email, subject, text, html });
}

// -----------------------------------------------------------------------------
async function sendRainoutEmail(env, origin, { email, name, event, note, managementToken }) {
  const appName = env.APP_NAME || 'Sunday Pickup Baseball';
  const manageLink = `${origin}/event.html?id=${event.id}&token=${encodeURIComponent(managementToken || '')}`;
  const eventDateFormatted = new Date(event.event_date).toLocaleString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/Los_Angeles',
    timeZoneName: 'short'
  });

  const safeName = escapeHtml(name);
  const safeTitle = escapeHtml(event.title);
  const safeLocation = escapeHtml(event.location);
  const safeNote = note ? escapeHtml(note) : '';

  const subject = `🌧️ Sunday Pickup Baseball Rained Out: ${event.title}`;
  const text = `Hi ${name},

Today's pickup baseball game has been called due to rain and field conditions.

Event: ${event.title}
Originally Scheduled: ${eventDateFormatted}
Location: ${event.location}
${note ? `Organizer Note:\n"${note}"\n\n` : ''}Any volunteer duty or equipment commitments you made for today are excused.

The discussion board on the event page remains open if you'd like to chat with teammates or coordinate alternate plans:
${manageLink}

Stay dry, and see you on the field next Sunday!
- ${appName}`;

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 580px; margin: 0 auto; padding: 26px; border: 1px solid #cbd5e1; border-top: 5px solid #0284c7; border-radius: 8px; background: #ffffff;">
      <h2 style="color: #0f172a; margin-top: 0; font-size: 22px;"><img src="${origin}/logo.svg" alt="" style="width: 30px; height: 30px; vertical-align: middle; margin-right: 6px;">🌧️ Game Called Due to Rain</h2>
      <p style="color: #0c1f1a; font-size: 16px;">Hi <strong>${safeName}</strong>,</p>
      <p style="color: #475569; font-size: 15px;">Today's pickup baseball game (<strong>${safeTitle}</strong>) has been called due to rain and wet field conditions.</p>
      
      ${safeNote ? `
      <div style="background: #f1f5f9; border-left: 4px solid #0284c7; padding: 14px 18px; margin: 18px 0; border-radius: 6px;">
        <strong style="color: #0f172a; display: block; font-size: 13px; text-transform: uppercase; margin-bottom: 4px;">Organizer Note:</strong>
        <p style="margin: 0; color: #334155; font-size: 15px; font-style: italic;">"${safeNote}"</p>
      </div>` : ''}

      <div style="background: #f8fafc; border: 1px solid #e2e8f0; padding: 16px; margin: 18px 0; border-radius: 6px;">
        <p style="margin: 3px 0; color: #64748b; font-size: 14px;"><strong>📅 Scheduled:</strong> ${escapeHtml(eventDateFormatted)}</p>
        <p style="margin: 3px 0; color: #64748b; font-size: 14px;"><strong>📍 Field:</strong> ${safeLocation}</p>
        <p style="margin: 6px 0 0; color: #0284c7; font-weight: 600; font-size: 14px;">✓ Your duty and equipment commitments are excused for today.</p>
      </div>

      <p style="text-align: center; margin: 26px 0;">
        <a href="${manageLink}" style="background: #0f172a; color: #ffffff; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 700; font-size: 14px; display: inline-block;">
          Open Event Discussion Board →
        </a>
      </p>

      <p style="color: #64748b; font-size: 13px; border-top: 1px solid #e2e8f0; padding-top: 14px; margin-bottom: 0;">
        The discussion board is still active if you want to chat with teammates, coordinate batting cages, or catch up before next Sunday.
      </p>
    </div>
  `;

  return dispatchEmail(env, { to: email, subject, text, html });
}

async function sendReopenEmail(env, origin, { email, name, event, note, managementToken }) {
  const appName = env.APP_NAME || 'Sunday Pickup Baseball';
  const manageLink = `${origin}/event.html?id=${event.id}&token=${encodeURIComponent(managementToken || '')}`;
  const eventDateFormatted = new Date(event.event_date).toLocaleString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/Los_Angeles',
    timeZoneName: 'short'
  });

  const safeName = escapeHtml(name);
  const safeTitle = escapeHtml(event.title);
  const safeLocation = escapeHtml(event.location);
  const safeNote = note ? escapeHtml(note) : '';

  const subject = `⚾ Game is BACK ON! Sunday Pickup Baseball: ${event.title}`;
  const text = `Hi ${name},

Great news! The field or weather conditions have cleared up and today's pickup baseball game is BACK ON!

Event: ${event.title}
When: ${eventDateFormatted}
Where: ${event.location}
${note ? `Organizer Note:\n"${note}"\n\n` : ''}Your roster spot is active. Grab your gear and see you on the field!

Check the live roster & event page:
${manageLink}

Play ball!
- ${appName}`;

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 580px; margin: 0 auto; padding: 26px; border: 1px solid #dbe4e0; border-top: 5px solid #FD5A1E; border-radius: 8px; background: #ffffff;">
      <h2 style="color: #003831; margin-top: 0; font-size: 22px;"><img src="${origin}/logo.svg" alt="" style="width: 30px; height: 30px; vertical-align: middle; margin-right: 6px;">⚾ Game is BACK ON!</h2>
      <p style="color: #0c1f1a; font-size: 16px;">Hi <strong>${safeName}</strong>,</p>
      <p style="color: #546e66; font-size: 15px;">Great news! Weather or field conditions have cleared up and today's game (<strong>${safeTitle}</strong>) is officially BACK ON!</p>
      
      ${safeNote ? `
      <div style="background: #fff7ed; border-left: 4px solid #FD5A1E; padding: 14px 18px; margin: 18px 0; border-radius: 6px;">
        <strong style="color: #9a3412; display: block; font-size: 13px; text-transform: uppercase; margin-bottom: 4px;">Organizer Note:</strong>
        <p style="margin: 0; color: #7c2d12; font-size: 15px; font-style: italic;">"${safeNote}"</p>
      </div>` : ''}

      <div style="background: #f5f8f7; border-left: 4px solid #003831; border: 1px solid #dbe4e0; padding: 16px; margin: 18px 0; border-radius: 6px;">
        <p style="margin: 3px 0; color: #0c1f1a; font-size: 14px;"><strong>📅 When:</strong> ${escapeHtml(eventDateFormatted)}</p>
        <p style="margin: 3px 0; color: #0c1f1a; font-size: 14px;"><strong>📍 Where:</strong> ${safeLocation}</p>
        <p style="margin: 6px 0 0; color: #003831; font-weight: 700; font-size: 14px;">✓ Your roster spot is active. Grab your glove and head out!</p>
      </div>

      <p style="text-align: center; margin: 26px 0;">
        <a href="${manageLink}" style="background: #FD5A1E; color: #ffffff; padding: 13px 26px; border-radius: 6px; text-decoration: none; font-weight: 700; font-size: 15px; display: inline-block;">
          Check Live Roster & Duties →
        </a>
      </p>
    </div>
  `;

  return dispatchEmail(env, { to: email, subject, text, html });
}

async function sendWaitlistConfirmation(env, origin, { email, name, event, waitlistPosition, managementToken }) {
  const appName = env.APP_NAME || 'Sunday Pickup Baseball';
  const manageLink = `${origin}/event.html?id=${event.id}&token=${encodeURIComponent(managementToken || '')}`;
  const eventDateFormatted = new Date(event.event_date).toLocaleString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/Los_Angeles',
    timeZoneName: 'short'
  });

  const safeName = escapeHtml(name);
  const safeTitle = escapeHtml(event.title);
  const safeLocation = escapeHtml(event.location);

  const subject = `⏳ Waitlist Confirmed: ${event.title} (Position #${waitlistPosition})`;
  const text = `Hi ${name},

The active playing roster for ${event.title} is currently full at ${event.max_players || 'maximum'} players.

You are on the waitlist at position #${waitlistPosition}.

If an active player cancels their RSVP, you will be automatically promoted to the playing roster and notified immediately by email!

Check your waitlist status and view event details here:
${manageLink}

- ${appName}`;

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 580px; margin: 0 auto; padding: 26px; border: 1px solid #dbe4e0; border-top: 5px solid #003831; border-radius: 8px; background: #ffffff;">
      <h2 style="color: #003831; margin-top: 0; font-size: 22px;"><img src="${origin}/logo.svg" alt="" style="width: 30px; height: 30px; vertical-align: middle; margin-right: 6px;">⏳ Waitlist Confirmed</h2>
      <p style="color: #0c1f1a; font-size: 16px;">Hi <strong>${safeName}</strong>,</p>
      <p style="color: #546e66; font-size: 15px;">The playing roster for <strong>${safeTitle}</strong> is currently full. You have been placed on the waitlist.</p>
      
      <div style="background: #f5f8f7; border-left: 4px solid #FD5A1E; border: 1px solid #dbe4e0; padding: 18px; margin: 20px 0; border-radius: 6px;">
        <p style="margin: 4px 0; color: #003831; font-size: 17px;"><strong>Your Waitlist Position:</strong> <span style="background: #FD5A1E; color: #fff; padding: 3px 10px; border-radius: 20px; font-weight: 700;">#${waitlistPosition}</span></p>
        <p style="margin: 8px 0 4px 0; color: #0c1f1a;"><strong>📅 Game Date:</strong> ${escapeHtml(eventDateFormatted)}</p>
        <p style="margin: 4px 0; color: #0c1f1a;"><strong>📍 Location:</strong> ${safeLocation}</p>
      </div>

      <p style="color: #0c1f1a; font-size: 14px; line-height: 1.5;">
        <strong>How it works:</strong> Whenever a confirmed player cancels, the system automatically promotes the next waitlisted player and sends an immediate email alert. Keep an eye on your inbox!
      </p>

      <p style="text-align: center; margin: 28px 0;">
        <a href="${manageLink}" style="background: #003831; color: #ffffff; padding: 13px 26px; border-radius: 6px; text-decoration: none; font-weight: 700; font-size: 15px; display: inline-block;">
          Check Waitlist Status & Event Page →
        </a>
      </p>
    </div>
  `;

  return dispatchEmail(env, { to: email, subject, text, html });
}

async function sendWaitlistPromotionEmail(env, origin, { email, name, event, managementToken }) {
  const appName = env.APP_NAME || 'Sunday Pickup Baseball';
  const manageLink = `${origin}/event.html?id=${event.id}&token=${encodeURIComponent(managementToken || '')}`;
  const eventDateFormatted = new Date(event.event_date).toLocaleString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/Los_Angeles',
    timeZoneName: 'short'
  });

  const safeName = escapeHtml(name);
  const safeTitle = escapeHtml(event.title);
  const safeLocation = escapeHtml(event.location);
  const safeLocationUrl = sanitizeHttpUrl(event.location_url);

  const subject = `⚾ A spot opened up! You're in for ${event.title} (${eventDateFormatted})`;
  const text = `Hi ${name},

Great news! A spot just opened up for pickup baseball!

You have been automatically promoted from the waitlist to the ACTIVE ROSTER for:
${event.title}

Date & Time: ${eventDateFormatted}
Location: ${event.location}

Visit the event page to coordinate gear, sign up for duties, or view the roster:
${manageLink}

If your plans have changed and you can no longer attend, please cancel your RSVP on the page so another player from the waitlist can take your spot.

See you on the field!
- ${appName}`;

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 580px; margin: 0 auto; padding: 26px; border: 1px solid #dbe4e0; border-top: 5px solid #003831; border-radius: 8px; background: #ffffff;">
      <h2 style="color: #003831; margin-top: 0; font-size: 22px;"><img src="${origin}/logo.svg" alt="" style="width: 30px; height: 30px; vertical-align: middle; margin-right: 6px;">⚾ You're Off the Waitlist — You're In!</h2>
      <p style="color: #0c1f1a; font-size: 16px;">Hi <strong>${safeName}</strong>,</p>
      <p style="color: #546e66; font-size: 15px;">A spot just opened up! You have been <strong>automatically promoted from the waitlist to the confirmed roster</strong> for <strong>${safeTitle}</strong>.</p>
      
      <div style="background: #f5f8f7; border-left: 4px solid #003831; border: 1px solid #dbe4e0; padding: 18px; margin: 20px 0; border-radius: 6px;">
        <p style="margin: 4px 0; color: #0c1f1a;"><strong>📅 When:</strong> ${escapeHtml(eventDateFormatted)}</p>
        <p style="margin: 4px 0; color: #0c1f1a;"><strong>📍 Where:</strong> ${safeLocation}</p>
        ${safeLocationUrl ? `<p style="margin: 4px 0;"><a href="${escapeHtml(safeLocationUrl)}" target="_blank" rel="noopener noreferrer" style="color: #FD5A1E; font-weight: 700;">View Map / Directions ↗</a></p>` : ''}
        <p style="margin: 6px 0 0 0; color: #003831; font-weight: 700;">Status: Confirmed Player</p>
      </div>

      <p style="text-align: center; margin: 28px 0;">
        <a href="${manageLink}" style="background: #FD5A1E; color: #ffffff; padding: 13px 26px; border-radius: 6px; text-decoration: none; font-weight: 700; font-size: 15px; display: inline-block;">
          View Roster & Sign Up for Duties →
        </a>
      </p>

      <p style="color: #546e66; font-size: 13px; border-top: 1px solid #dbe4e0; padding-top: 14px;">
        Can't make it after all? Please click the button above to cancel your RSVP so the next person on the waitlist gets their chance to play!
      </p>
    </div>
  `;

  return dispatchEmail(env, { to: email, subject, text, html });
}

// Auth, RBAC & Security Headers Middleware
// -----------------------------------------------------------------------------

async function getUserFromSession(db, sessionId) {
  if (!sessionId) return null;

  const session = await db.prepare(`
    SELECT 
      s.id as session_id, 
      s.expires_at, 
      u.id, 
      u.name, 
      u.email, 
      u.bio, 
      CASE WHEN u.avatar_url IS NOT NULL AND u.avatar_url != '' THEN '/api/users/' || u.id || '/avatar?v=' || length(u.avatar_url) ELSE '' END as avatar_url, 
      u.is_admin,
      COALESCE(u.role, CASE WHEN u.is_admin = 1 THEN 'admin' ELSE 'player' END) as role
    FROM sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.id = ?
      AND datetime(s.expires_at) > datetime('now')
      AND NOT EXISTS (SELECT 1 FROM banned_emails b WHERE b.email = u.email)
  `).bind(sessionId).first();

  if (!session) return null;

  const role = session.role || (session.is_admin === 1 ? 'admin' : 'player');
  const isAdmin = role === 'admin' || Boolean(session.is_admin);
  const canManageEvents = role === 'admin' || role === 'organizer' || isAdmin;

  return {
    id: session.id,
    name: session.name,
    email: session.email,
    bio: session.bio || '',
    avatarUrl: session.avatar_url || '',
    role: role,
    isAdmin: isAdmin,
    canManageEvents: canManageEvents
  };
}

app.use('*', async (c, next) => {
  const reqUrl = new URL(c.req.url);

  // Block direct API access via *.pages.dev so all traffic must pass through the custom domain WAF
  if (reqUrl.hostname.endsWith('.pages.dev')) {
    if (c.req.method === 'GET' || c.req.method === 'HEAD') {
      return c.redirect(`https://www.pickupbaseballfoundation.org${reqUrl.pathname}${reqUrl.search}`, 301);
    }
    return c.json({ error: 'Direct origin/preview API access is disabled. Please use www.pickupbaseballfoundation.org.' }, 403);
  }

  // CSRF Origin verification on all state-changing requests (POST, PUT, DELETE)
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    const reqOrigin = reqUrl.origin;
    const originHeader = c.req.header('Origin');
    const refererHeader = c.req.header('Referer');
    if (originHeader && originHeader !== reqOrigin) {
      return c.json({ error: 'Cross-origin request blocked (CSRF protection).' }, 403);
    }
    if (!originHeader && refererHeader) {
      try {
        if (new URL(refererHeader).origin !== reqOrigin) {
          return c.json({ error: 'Cross-origin referer blocked (CSRF protection).' }, 403);
        }
      } catch (e) {
        return c.json({ error: 'Invalid referer header.' }, 403);
      }
    }
  }

  const sessionId = getCookie(c, SESSION_COOKIE_NAME);
  if (sessionId && c.env.DB) {
    try {
      c.set('user', await getUserFromSession(c.env.DB, sessionId));
    } catch (e) {
      console.error('[Auth Middleware] Session error:', e);
      c.set('user', null);
    }
  } else {
    c.set('user', null);
  }
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  c.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
});

const DEFAULT_BASEBALL_DUTIES = [
  { title: "Bases", description: "Bring 3 throw-down bases.", slots_needed: 1 },
  { title: "Pitching machine and power", description: "Bring a pitching machine and a way to run it on the field.", slots_needed: 1 },
  { title: "Game Baseballs", description: "Bring game balls bucket.", slots_needed: 1 },
  { title: "Field Dragging", description: "Arrive 20 mins early to drag the infield with the pull rake.", slots_needed: 2 }
];

async function getDefaultDuties(db) {
  const { results } = await db.prepare(
    'SELECT title, description, slots_needed, sort_order FROM default_duties ORDER BY sort_order ASC, id ASC'
  ).all();
  return results && results.length > 0 ? results : DEFAULT_BASEBALL_DUTIES;
}

// -----------------------------------------------------------------------------
// Health Check
// -----------------------------------------------------------------------------

app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    environment: 'cloudflare-pages',
    timestamp: new Date().toISOString()
  });
});

// -----------------------------------------------------------------------------
// Auth Routes
// -----------------------------------------------------------------------------

app.post('/auth/send-code', async (c) => {
  try {
    const body = await c.req.json();
    let { email, name, cf_turnstile_response } = body;
    if (!email || typeof email !== 'string' || !email.includes('@') || email.length > 254) {
      return c.json({ error: 'A valid email address is required.' }, 400);
    }

    email = email.trim().toLowerCase();
    name = (name || '').toString().trim().slice(0, 120);

    const clientIp = getClientIp(c);
    const turnstileOk = await verifyTurnstileIfConfigured(c.env, cf_turnstile_response, clientIp);
    if (!turnstileOk) {
      return c.json({ error: 'Bot verification failed. Please refresh and try again.' }, 403);
    }

    // Rate limit: max 5 send-code requests per IP per 10 minutes, max 3 per email per 10 minutes
    const ipLimit = await checkRateLimit(c.env.DB, `send_code_ip:${clientIp}`, 5, 600);
    if (!ipLimit.allowed) {
      return c.json({ error: 'Too many sign-in requests from your network. Please wait 10 minutes and try again.' }, 429);
    }
    const emailLimit = await checkRateLimit(c.env.DB, `send_code_email:${email}`, 3, 600);
    if (!emailLimit.allowed) {
      return c.json({ error: 'Too many sign-in codes requested for this email. Please check your inbox or wait 10 minutes.' }, 429);
    }

    const banRecord = await c.env.DB.prepare('SELECT id, reason FROM banned_emails WHERE email = ?').bind(email).first();
    if (banRecord) {
      return c.json({ error: 'This email address has been restricted from accessing this service.' }, 403);
    }

    const existingUser = await c.env.DB.prepare('SELECT id, name FROM users WHERE email = ?').bind(email).first();
    if (existingUser && !name) {
      name = existingUser.name;
    }

    const code = generateCode();
    const token = generateToken();
    const codeHash = await sha256Hex(code);
    const tokenHash = await sha256Hex(token);
    const expiresAt = new Date(Date.now() + AUTH_CODE_EXPIRY_MS).toISOString();

    // Invalidate any previous unused codes for this email so only the newest code is valid
    await c.env.DB.batch([
      c.env.DB.prepare('UPDATE auth_codes SET used_at = CURRENT_TIMESTAMP WHERE email = ? AND used_at IS NULL').bind(email),
      c.env.DB.prepare(`
        INSERT INTO auth_codes (email, name, code, token, attempts, expires_at)
        VALUES (?, ?, ?, ?, 0, ?)
      `).bind(email, name, codeHash, tokenHash, expiresAt)
    ]);

    const origin = new URL(c.req.url).origin;
    await sendAuthCode(c.env, origin, {
      email,
      name: name || 'Player',
      code,
      token
    });

    return c.json({
      success: true,
      message: `A 6-digit code has been sent to ${email}. It expires in 10 minutes.`
    });
  } catch (err) {
    console.error('[Auth] Error sending code:', err);
    return c.json({ error: 'Failed to dispatch verification code.' }, 500);
  }
});

app.post('/auth/verify-code', async (c) => {
  try {
    const { email, code } = await c.req.json();
    if (!email || !code) {
      return c.json({ error: 'Email and 6-digit verification code are required.' }, 400);
    }

    const cleanEmail = String(email).trim().toLowerCase();
    const cleanCode = String(code).trim();

    const clientIp = getClientIp(c);
    const ipLimit = await checkRateLimit(c.env.DB, `verify_code_ip:${clientIp}`, 10, 600);
    if (!ipLimit.allowed) {
      return c.json({ error: 'Too many verification attempts. Please wait 10 minutes before trying again.' }, 429);
    }

    const banRecord = await c.env.DB.prepare('SELECT id FROM banned_emails WHERE email = ?').bind(cleanEmail).first();
    if (banRecord) {
      return c.json({ error: 'This email address has been restricted from accessing this service.' }, 403);
    }

    // Fetch the most recent active code for this email
    const latestActive = await c.env.DB.prepare(`
      SELECT * FROM auth_codes
      WHERE email = ? AND used_at IS NULL AND datetime(expires_at) > datetime('now')
      ORDER BY id DESC LIMIT 1
    `).bind(cleanEmail).first();

    if (!latestActive) {
      return c.json({ error: 'Invalid or expired code. Please request a new code.' }, 400);
    }

    const codeHash = await sha256Hex(cleanCode);
    const isMatch = (latestActive.code === codeHash || latestActive.code === cleanCode);

    if (!isMatch) {
      const newAttempts = (latestActive.attempts || 0) + 1;
      if (newAttempts >= MAX_CODE_VERIFY_ATTEMPTS) {
        await c.env.DB.prepare(
          'UPDATE auth_codes SET attempts = ?, used_at = CURRENT_TIMESTAMP WHERE id = ?'
        ).bind(newAttempts, latestActive.id).run();
        return c.json({
          error: 'Too many failed attempts. This code has been invalidated—please request a new code.'
        }, 400);
      } else {
        await c.env.DB.prepare(
          'UPDATE auth_codes SET attempts = ? WHERE id = ?'
        ).bind(newAttempts, latestActive.id).run();
        return c.json({
          error: `Invalid verification code (${MAX_CODE_VERIFY_ATTEMPTS - newAttempts} attempt(s) remaining).`
        }, 400);
      }
    }

    await c.env.DB.prepare('UPDATE auth_codes SET used_at = CURRENT_TIMESTAMP WHERE id = ?').bind(latestActive.id).run();

    let user = await c.env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(cleanEmail).first();
    if (!user) {
      const displayName = (latestActive.name || cleanEmail.split('@')[0]).slice(0, 120);
      const configuredAdminEmail = (c.env.ADMIN_EMAIL || 'pickupbaseballfoundation@gmail.com').toLowerCase();
      const shouldBeAdmin = (cleanEmail === configuredAdminEmail);
      const role = shouldBeAdmin ? 'admin' : 'player';
      const isAdminFlag = shouldBeAdmin ? 1 : 0;

      const insertRes = await c.env.DB.prepare(`
        INSERT INTO users (name, email, role, is_admin) VALUES (?, ?, ?, ?)
      `).bind(displayName, cleanEmail, role, isAdminFlag).run();

      const lastId = insertRes.meta.last_row_id;
      user = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(lastId).first();
    }

    const sessionId = generateToken();
    const expiresAt = new Date(Date.now() + SESSION_DURATION_SECONDS * 1000).toISOString();

    await c.env.DB.prepare(`
      INSERT INTO sessions (id, user_id, expires_at)
      VALUES (?, ?, ?)
    `).bind(sessionId, user.id, expiresAt).run();

    setCookie(c, SESSION_COOKIE_NAME, sessionId, {
      httpOnly: true,
      sameSite: 'Lax',
      secure: true,
      path: '/',
      maxAge: SESSION_DURATION_SECONDS
    });

    return c.json({
      success: true,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        isAdmin: Boolean(user.is_admin || user.role === 'admin')
      }
    });
  } catch (err) {
    console.error('[Auth] Error verifying code:', err);
    return c.json({ error: 'Failed to verify code.' }, 500);
  }
});

app.get('/auth/verify-magic', async (c) => {
  try {
    const token = c.req.query('token');
    const redirect = c.req.query('redirect');

    if (!token) {
      return c.text('Invalid or missing magic link token.', 400);
    }

    const tokenHash = await sha256Hex(token);

    const authRecord = await c.env.DB.prepare(`
      SELECT * FROM auth_codes
      WHERE (token = ? OR token = ?) AND used_at IS NULL AND datetime(expires_at) > datetime('now')
    `).bind(tokenHash, token).first();

    if (!authRecord) {
      return c.text('This sign-in link is invalid or has expired. Please request a new one on the login page.', 400);
    }

    const cleanEmail = authRecord.email.trim().toLowerCase();
    const banRecord = await c.env.DB.prepare('SELECT id FROM banned_emails WHERE email = ?').bind(cleanEmail).first();
    if (banRecord) {
      return c.text('This email address has been restricted from accessing this service.', 403);
    }

    await c.env.DB.prepare('UPDATE auth_codes SET used_at = CURRENT_TIMESTAMP WHERE id = ?').bind(authRecord.id).run();

    let user = await c.env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(cleanEmail).first();
    if (!user) {
      const displayName = (authRecord.name || cleanEmail.split('@')[0]).slice(0, 120);
      const configuredAdminEmail = (c.env.ADMIN_EMAIL || 'pickupbaseballfoundation@gmail.com').toLowerCase();
      const shouldBeAdmin = (cleanEmail === configuredAdminEmail);
      const role = shouldBeAdmin ? 'admin' : 'player';
      const isAdminFlag = shouldBeAdmin ? 1 : 0;

      const insertRes = await c.env.DB.prepare(`
        INSERT INTO users (name, email, role, is_admin) VALUES (?, ?, ?, ?)
      `).bind(displayName, cleanEmail, role, isAdminFlag).run();

      const lastId = insertRes.meta.last_row_id;
      user = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(lastId).first();
    }

    const sessionId = generateToken();
    const expiresAt = new Date(Date.now() + SESSION_DURATION_SECONDS * 1000).toISOString();

    await c.env.DB.prepare(`
      INSERT INTO sessions (id, user_id, expires_at)
      VALUES (?, ?, ?)
    `).bind(sessionId, user.id, expiresAt).run();

    setCookie(c, SESSION_COOKIE_NAME, sessionId, {
      httpOnly: true,
      sameSite: 'Lax',
      secure: true,
      path: '/',
      maxAge: SESSION_DURATION_SECONDS
    });

    return c.redirect(getSafeRelativeRedirect(redirect));
  } catch (err) {
    console.error('[Auth] Error handling magic link:', err);
    return c.text('Internal error verifying magic link.', 500);
  }
});

app.get('/auth/me', (c) => {
  const user = c.get('user');
  return c.json({ user });
});

app.put('/auth/profile', async (c) => {
  const user = c.get('user');
  if (!user) {
    return c.json({ error: 'Authentication required.' }, 401);
  }

  try {
    const { name, bio } = await c.req.json();
    if (!name || !String(name).trim()) {
      return c.json({ error: 'Name cannot be empty.' }, 400);
    }

    const cleanName = String(name).trim().slice(0, 120);
    const cleanBio = String(bio || '').trim().slice(0, 280);

    await c.env.DB.prepare(`
      UPDATE users SET name = ?, bio = ? WHERE id = ?
    `).bind(cleanName, cleanBio, user.id).run();

    user.name = cleanName;
    user.bio = cleanBio;

    return c.json({
      success: true,
      message: 'Profile updated successfully.',
      user
    });
  } catch (err) {
    console.error('[Auth] Error updating profile:', err);
    return c.json({ error: 'Failed to update profile.' }, 500);
  }
});

app.post('/auth/avatar', async (c) => {
  const user = c.get('user');
  if (!user) {
    return c.json({ error: 'Authentication required.' }, 401);
  }

  try {
    const body = await c.req.parseBody();
    const file = body['avatar'];
    if (!file || typeof file === 'string') {
      return c.json({ error: 'No image file uploaded.' }, 400);
    }

    const allowedMimes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    const mime = (file.type || '').toLowerCase();
    if (!allowedMimes.includes(mime)) {
      return c.json({ error: 'Only JPEG, PNG, WebP, or GIF image files are allowed.' }, 400);
    }

    const buffer = await file.arrayBuffer();
    if (buffer.byteLength > 250 * 1024) {
      return c.json({ error: 'Image size exceeds 250KB limit.' }, 400);
    }

    if (!isValidRasterImageBuffer(buffer, mime)) {
      return c.json({ error: 'Invalid or corrupted image file content.' }, 400);
    }

    const cleanBuffer = mime === 'image/jpeg' ? stripJpegMetadata(buffer) : buffer;
    const base64 = arrayBufferToBase64(cleanBuffer);
    const dataUrl = `data:${mime};base64,${base64}`;

    await c.env.DB.prepare('UPDATE users SET avatar_url = ? WHERE id = ?').bind(dataUrl, user.id).run();
    const avatarEndpointUrl = `/api/users/${user.id}/avatar?v=${dataUrl.length}`;
    user.avatarUrl = avatarEndpointUrl;

    return c.json({
      success: true,
      avatarUrl: avatarEndpointUrl,
      message: 'Profile picture updated successfully!'
    });
  } catch (err) {
    console.error('[Auth] Error updating avatar:', err);
    return c.json({ error: 'Failed to upload profile picture.' }, 500);
  }
});

app.get('/users/:id/avatar', async (c) => {
  try {
    const userId = parseInt(c.req.param('id'), 10);
    if (!userId || isNaN(userId)) {
      return c.text('Not found', 404);
    }

    const row = await c.env.DB.prepare('SELECT avatar_url FROM users WHERE id = ?').bind(userId).first();
    if (!row || !row.avatar_url) {
      return c.text('No avatar', 404);
    }

    const raw = String(row.avatar_url).trim();
    const etag = `W/"av-${userId}-${raw.length}"`;
    if (c.req.header('If-None-Match') === etag) {
      return new Response(null, {
        status: 304,
        headers: {
          'ETag': etag,
          'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800'
        }
      });
    }

    const match = raw.match(/^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/i);
    if (!match) {
      return c.text('Invalid avatar format', 404);
    }

    const mime = match[1].toLowerCase();
    const b64 = match[2];
    const binStr = atob(b64);
    const len = binStr.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binStr.charCodeAt(i);
    }

    return new Response(bytes.buffer, {
      status: 200,
      headers: {
        'Content-Type': mime,
        'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800',
        'ETag': etag,
        'X-Content-Type-Options': 'nosniff'
      }
    });
  } catch (err) {
    console.error('[Avatar] Error serving avatar:', err);
    return c.text('Error serving avatar', 500);
  }
});

app.delete('/auth/avatar', async (c) => {
  const user = c.get('user');
  if (!user) {
    return c.json({ error: 'Authentication required.' }, 401);
  }

  try {
    await c.env.DB.prepare('UPDATE users SET avatar_url = NULL WHERE id = ?').bind(user.id).run();
    user.avatarUrl = null;
    return c.json({ success: true, message: 'Profile picture removed.' });
  } catch (err) {
    console.error('[Auth] Error removing avatar:', err);
    return c.json({ error: 'Failed to remove profile picture.' }, 500);
  }
});

app.get('/auth/users', async (c) => {
  const user = c.get('user');
  if (!user || !user.isAdmin) {
    return c.json({ error: 'Administrator access required.' }, 403);
  }

  try {
    const { results } = await c.env.DB.prepare(`
      SELECT 
        u.id, 
        u.name, 
        u.email, 
        u.bio, 
        CASE WHEN u.avatar_url IS NOT NULL AND u.avatar_url != '' THEN '/api/users/' || u.id || '/avatar?v=' || length(u.avatar_url) ELSE '' END as avatarUrl, 
        COALESCE(u.role, CASE WHEN u.is_admin = 1 THEN 'admin' ELSE 'player' END) as role,
        u.is_admin as isAdmin,
        u.created_at as createdAt,
        (SELECT COUNT(*) FROM attendees WHERE user_id = u.id AND status = 'attending') as eventsAttended
      FROM users u
      ORDER BY 
        CASE WHEN u.role = 'admin' OR u.is_admin = 1 THEN 1 
             WHEN u.role = 'organizer' THEN 2 
             ELSE 3 END,
        u.name COLLATE NOCASE ASC
    `).all();

    return c.json({ users: results || [] });
  } catch (err) {
    console.error('[Auth] Error fetching users:', err);
    return c.json({ error: 'Failed to fetch users list.' }, 500);
  }
});

app.put('/auth/users/:id/role', async (c) => {
  const currentUser = c.get('user');
  if (!currentUser || !currentUser.isAdmin) {
    return c.json({ error: 'Administrator access required.' }, 403);
  }

  const targetId = parseInt(c.req.param('id'), 10);
  const { role } = await c.req.json();

  if (!['admin', 'organizer', 'player'].includes(role)) {
    return c.json({ error: 'Invalid role. Must be admin, organizer, or player.' }, 400);
  }

  const targetUser = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(targetId).first();
  if (!targetUser) {
    return c.json({ error: 'User not found.' }, 404);
  }

  if (targetId === currentUser.id && role !== 'admin') {
    const adminCountRow = await c.env.DB.prepare("SELECT COUNT(*) as c FROM users WHERE (role = 'admin' OR is_admin = 1) AND id != ?").bind(targetId).first();
    if (!adminCountRow || adminCountRow.c === 0) {
      return c.json({ error: 'Cannot remove the last administrator.' }, 400);
    }
  }

  const isAdminFlag = role === 'admin' ? 1 : 0;
  await c.env.DB.prepare('UPDATE users SET role = ?, is_admin = ? WHERE id = ?').bind(role, isAdminFlag, targetId).run();

  return c.json({
    success: true,
    message: `Role updated to ${role}.`,
    user: { id: targetId, role, isAdmin: Boolean(isAdminFlag) }
  });
});

app.delete('/auth/users/:id', async (c) => {
  const currentUser = c.get('user');
  if (!currentUser || !currentUser.isAdmin) {
    return c.json({ error: 'Administrator access required.' }, 403);
  }

  const targetId = parseInt(c.req.param('id'), 10);
  if (targetId === currentUser.id) {
    return c.json({ error: 'You cannot delete your own administrator account.' }, 400);
  }

  const targetUser = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(targetId).first();
  if (!targetUser) {
    return c.json({ error: 'User not found.' }, 404);
  }

  const ban = c.req.query('ban') === 'true';
  const reason = (c.req.query('reason') || 'Banned by administrator').slice(0, 200);

  if (ban) {
    await c.env.DB.prepare(
      'INSERT OR REPLACE INTO banned_emails (email, reason) VALUES (?, ?)'
    ).bind(targetUser.email.toLowerCase(), reason).run();
  }

  const cleanupBatch = [
    c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(targetId),
    c.env.DB.prepare('DELETE FROM auth_codes WHERE email = ?').bind(targetUser.email),
    ban
      ? c.env.DB.prepare('DELETE FROM attendees WHERE user_id = ? OR email = ?').bind(targetId, targetUser.email)
      : c.env.DB.prepare('UPDATE attendees SET user_id = NULL WHERE user_id = ?').bind(targetId),
    ban
      ? c.env.DB.prepare('DELETE FROM comments WHERE user_id = ? OR author_email = ?').bind(targetId, targetUser.email)
      : c.env.DB.prepare('UPDATE comments SET user_id = NULL WHERE user_id = ?').bind(targetId),
    c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(targetId)
  ];

  await c.env.DB.batch(cleanupBatch);

  return c.json({
    success: true,
    message: ban ? `User ${targetUser.email} has been removed and banned from re-registering.` : `User ${targetUser.email} has been removed.`
  });
});

app.get('/auth/banned-emails', async (c) => {
  const currentUser = c.get('user');
  if (!currentUser || !currentUser.isAdmin) {
    return c.json({ error: 'Administrator access required.' }, 403);
  }
  const { results } = await c.env.DB.prepare('SELECT * FROM banned_emails ORDER BY id DESC').all();
  return c.json({ bannedEmails: results || [] });
});

app.post('/auth/banned-emails', async (c) => {
  const currentUser = c.get('user');
  if (!currentUser || !currentUser.isAdmin) {
    return c.json({ error: 'Administrator access required.' }, 403);
  }
  const { email, reason } = await c.req.json();
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return c.json({ error: 'A valid email is required.' }, 400);
  }
  const cleanEmail = email.trim().toLowerCase();
  if (cleanEmail === currentUser.email.toLowerCase()) {
    return c.json({ error: 'You cannot ban your own administrator email address.' }, 400);
  }
  const cleanReason = (reason || 'Banned by admin').toString().trim().slice(0, 200);

  // Immediately insert ban and revoke any active sessions or pending login codes for this email
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT OR REPLACE INTO banned_emails (email, reason) VALUES (?, ?)').bind(cleanEmail, cleanReason),
    c.env.DB.prepare('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email = ?)').bind(cleanEmail),
    c.env.DB.prepare('DELETE FROM auth_codes WHERE email = ?').bind(cleanEmail)
  ]);

  return c.json({ success: true, message: `Email ${cleanEmail} added to ban list and any active sessions revoked.` });
});

app.delete('/auth/banned-emails/:id', async (c) => {
  const currentUser = c.get('user');
  if (!currentUser || !currentUser.isAdmin) {
    return c.json({ error: 'Administrator access required.' }, 403);
  }
  const id = parseInt(c.req.param('id'), 10);
  await c.env.DB.prepare('DELETE FROM banned_emails WHERE id = ?').bind(id).run();
  return c.json({ success: true, message: 'Ban removed.' });
});

app.get('/settings', async (c) => {
  const row = await c.env.DB.prepare("SELECT value FROM app_settings WHERE key = 'require_login_to_rsvp'").first();
  const requireLogin = row ? row.value === 'true' : true;
  return c.json({ require_login_to_rsvp: requireLogin });
});

app.put('/settings', async (c) => {
  const currentUser = c.get('user');
  if (!currentUser || !currentUser.isAdmin) {
    return c.json({ error: 'Administrator access required.' }, 403);
  }
  const { require_login_to_rsvp } = await c.req.json();
  const val = require_login_to_rsvp ? 'true' : 'false';
  await c.env.DB.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('require_login_to_rsvp', ?)").bind(val).run();
  return c.json({ success: true, require_login_to_rsvp: val === 'true', message: 'Settings saved.' });
});

app.post('/auth/logout', async (c) => {
  const sessionId = getCookie(c, SESSION_COOKIE_NAME);
  if (sessionId && c.env.DB) {
    try {
      await c.env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sessionId).run();
    } catch (e) {}
  }

  deleteCookie(c, SESSION_COOKIE_NAME, { path: '/' });
  return c.json({ success: true, message: 'Logged out successfully.' });
});

// -----------------------------------------------------------------------------
// Events Routes
// -----------------------------------------------------------------------------

async function promoteNextWaitlistedPlayer(env, origin, eventId) {
  try {
    const event = await env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(eventId).first();
    if (!event || event.status === 'rainout') return null;

    const countRow = await env.DB.prepare(`
      SELECT COUNT(*) as count FROM attendees WHERE event_id = ? AND status = 'attending'
    `).bind(eventId).first();
    const activeCount = countRow ? countRow.count : 0;

    if (event.max_players && activeCount >= event.max_players) {
      return null;
    }

    const nextWaitlisted = await env.DB.prepare(`
      SELECT * FROM attendees
      WHERE event_id = ? AND status = 'waitlist'
      ORDER BY created_at ASC, id ASC
      LIMIT 1
    `).bind(eventId).first();

    if (!nextWaitlisted) return null;

    await env.DB.prepare(`
      UPDATE attendees SET status = 'attending' WHERE id = ?
    `).bind(nextWaitlisted.id).run();

    console.log(`[Waitlist Promotion:D1] Automatically promoted ${nextWaitlisted.name} (${nextWaitlisted.email}) for event ${eventId}`);

    const p = sendWaitlistPromotionEmail(env, origin, {
      email: nextWaitlisted.email,
      name: nextWaitlisted.name,
      event,
      managementToken: nextWaitlisted.management_token
    }).catch(e => console.error('[Waitlist Promotion Email Error]:', e));

    return nextWaitlisted;
  } catch (err) {
    console.error('[Waitlist Promotion Helper Error]:', err);
    return null;
  }
}

app.get('/events', async (c) => {
  try {
    const filter = c.req.query('filter');
    const user = c.get('user');
    const nowIso = new Date().toISOString();

    let query = `
      SELECT e.*,
        (SELECT COUNT(*) FROM attendees a WHERE a.event_id = e.id AND a.status = 'attending') as attendee_count,
        (SELECT COUNT(*) FROM event_duties d WHERE d.event_id = e.id) as duty_count
      FROM events e
      WHERE e.status IN ('active', 'rainout')
    `;
    const params = [];

    if (filter === 'past') {
      query += ' AND e.event_date < ?';
      params.push(nowIso);
    } else if (filter === 'all') {
      // no restriction
    } else {
      query += " AND e.event_date >= date('now', '-1 day')";
    }

    query += ' ORDER BY e.event_date ASC';

    const stmt = c.env.DB.prepare(query);
    const { results: events } = params.length > 0 ? await stmt.bind(...params).all() : await stmt.all();

    if (events && events.some(ev => ev.location === 'Bushrod Part Field 1')) {
      await c.env.DB.prepare("UPDATE events SET location = 'Bushrod Park Field 1' WHERE location = 'Bushrod Part Field 1'").run();
      events.forEach(ev => {
        if (ev.location === 'Bushrod Part Field 1') ev.location = 'Bushrod Park Field 1';
      });
    }

    if (user && events && events.length > 0) {
      const { results: userRsvps } = await c.env.DB.prepare(`
        SELECT event_id, status, gear_bringing
        FROM attendees
        WHERE user_id = ?
      `).bind(user.id).all();

      const rsvpMap = new Map((userRsvps || []).map(r => [r.event_id, r]));
      events.forEach(ev => {
        ev.my_rsvp = rsvpMap.get(ev.id) || null;
      });
    }

    return c.json({ events: events || [], user: user || null });
  } catch (err) {
    console.error('[Events] Error listing events:', err);
    return c.json({ error: 'Failed to fetch events.' }, 500);
  }
});

app.get('/events/default-duties', async (c) => {
  const duties = await getDefaultDuties(c.env.DB);
  return c.json({ duties });
});

app.put('/events/default-duties', async (c) => {
  const user = c.get('user');
  if (!user || !user.isAdmin) {
    return c.json({ error: 'Administrator access required.' }, 403);
  }

  try {
    const { duties } = await c.req.json();
    if (!Array.isArray(duties)) {
      return c.json({ error: 'duties array is required.' }, 400);
    }

    const batch = [c.env.DB.prepare('DELETE FROM default_duties')];
    duties.filter(d => d && d.title && String(d.title).trim()).forEach((d, idx) => {
      batch.push(
        c.env.DB.prepare(`
          INSERT INTO default_duties (title, description, slots_needed, sort_order)
          VALUES (?, ?, ?, ?)
        `).bind(String(d.title).trim().slice(0, 120), String(d.description || '').trim().slice(0, 300), parseInt(d.slots_needed || 1, 10), idx)
      );
    });

    await c.env.DB.batch(batch);
    const updated = await getDefaultDuties(c.env.DB);
    return c.json({ success: true, duties: updated, message: 'Default task template updated successfully!' });
  } catch (err) {
    console.error('[Events] Error saving default duties:', err);
    return c.json({ error: 'Failed to update default duties template.' }, 500);
  }
});

app.get('/events/admin/backup-db', async (c) => {
  const user = c.get('user');
  if (!user || !user.isAdmin) {
    return c.text('Administrator access required. Please sign in as an admin.', 403);
  }

  try {
    const tables = [
      'users',
      'events',
      'event_duties',
      'attendees',
      'duty_assignments',
      'comments',
      'default_duties',
      'banned_emails',
      'app_settings'
    ];

    const timestamp = new Date().toISOString();
    const dateStr = timestamp.slice(0, 10);
    let sqlDump = `-- Sunday Pickup Baseball Database Backup\n-- Exported: ${timestamp}\n-- Platform: Cloudflare D1 SQL\n\n`;

    for (const table of tables) {
      const { results: rows } = await c.env.DB.prepare(`SELECT * FROM "${table}"`).all();
      if (rows && rows.length > 0) {
        sqlDump += `-- Table: ${table} (${rows.length} rows)\n`;
        for (const row of rows) {
          const cols = Object.keys(row).map(k => `"${k}"`).join(', ');
          const vals = Object.values(row).map(v => {
            if (v === null || v === undefined) return 'NULL';
            if (typeof v === 'number') return v;
            return `'${String(v).replace(/'/g, "''")}'`;
          }).join(', ');
          sqlDump += `INSERT OR IGNORE INTO "${table}" (${cols}) VALUES (${vals});\n`;
        }
        sqlDump += '\n';
      }
    }

    return new Response(sqlDump, {
      status: 200,
      headers: {
        'Content-Type': 'application/sql; charset=utf-8',
        'Content-Disposition': `attachment; filename="baseball_backup_${dateStr}.sql"`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY'
      }
    });
  } catch (err) {
    console.error('[Backup] Error creating SQL dump:', err);
    return c.text('Failed to generate database backup: ' + err.message, 500);
  }
});

app.get('/events/:id', async (c) => {
  try {
    const eventId = parseInt(c.req.param('id'), 10);
    const token = c.req.query('token');
    const user = c.get('user');

    const batchStmts = [
      c.env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(eventId),
      c.env.DB.prepare(`
        SELECT d.*,
          COALESCE((
            SELECT json_group_array(json_object('attendee_id', a.id, 'name', a.name))
            FROM duty_assignments da
            JOIN attendees a ON da.attendee_id = a.id
            WHERE da.duty_id = d.id AND a.status = 'attending'
          ), '[]') as assigned_players
        FROM event_duties d
        WHERE d.event_id = ?
        ORDER BY d.sort_order ASC, d.id ASC
      `).bind(eventId),
      c.env.DB.prepare(`
        SELECT a.id, a.name, a.status, a.gear_bringing, a.is_guest, a.created_at,
          u.bio,
          CASE WHEN u.avatar_url IS NOT NULL AND u.avatar_url != '' THEN '/api/users/' || u.id || '/avatar?v=' || length(u.avatar_url) ELSE '' END as avatar_url,
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
      `).bind(eventId),
      c.env.DB.prepare(`
        SELECT c.id, c.author_name, c.content, c.created_at, c.user_id,
          CASE WHEN u.avatar_url IS NOT NULL AND u.avatar_url != '' THEN '/api/users/' || u.id || '/avatar?v=' || length(u.avatar_url) ELSE '' END as avatar_url,
          u.bio
        FROM comments c
        LEFT JOIN users u ON c.user_id = u.id
        WHERE c.event_id = ?
        ORDER BY c.created_at ASC
      `).bind(eventId),
      c.env.DB.prepare("SELECT value FROM app_settings WHERE key = 'require_login_to_rsvp'")
    ];

    if (user) {
      batchStmts.push(
        c.env.DB.prepare(`
          SELECT a.id, a.event_id, a.user_id, a.name, a.status, a.gear_bringing,
            (SELECT json_group_array(duty_id) FROM duty_assignments WHERE attendee_id = a.id) as duty_ids
          FROM attendees a
          WHERE a.event_id = ? AND (a.user_id = ? OR a.email = ?)
        `).bind(eventId, user.id, user.email)
      );
    } else if (token) {
      batchStmts.push(
        c.env.DB.prepare(`
          SELECT a.id, a.event_id, a.user_id, a.name, a.status, a.gear_bringing,
            (SELECT json_group_array(duty_id) FROM duty_assignments WHERE attendee_id = a.id) as duty_ids
          FROM attendees a
          WHERE a.event_id = ? AND a.management_token = ?
        `).bind(eventId, token)
      );
    }

    const batchRes = await c.env.DB.batch(batchStmts);
    const event = (batchRes[0].results && batchRes[0].results[0]) || null;
    if (!event) {
      return c.json({ error: 'Event not found.' }, 404);
    }

    const rawDuties = batchRes[1].results || [];
    const duties = rawDuties.map(d => ({
      ...d,
      assigned_players: JSON.parse(d.assigned_players || '[]')
    }));

    const attendees = batchRes[2].results || [];
    const comments = batchRes[3].results || [];
    const settingRow = (batchRes[4].results && batchRes[4].results[0]) || null;
    const requireLogin = settingRow ? settingRow.value === 'true' : true;

    let myRsvp = (batchRes[5] && batchRes[5].results && batchRes[5].results[0]) || null;
    if (myRsvp) {
      myRsvp.duty_ids = JSON.parse(myRsvp.duty_ids || '[]');
    }

    return c.json({
      event,
      duties: duties || [],
      attendees: attendees || [],
      comments: comments || [],
      myRsvp,
      totalAttendees: (attendees || []).length,
      user: user || null,
      require_login_to_rsvp: requireLogin
    });
  } catch (err) {
    console.error('[Events] Error fetching event details:', err);
    return c.json({ error: 'Failed to fetch event details.' }, 500);
  }
});

app.post('/events', async (c) => {
  const user = c.get('user');
  if (!user || !user.canManageEvents) {
    return c.json({ error: 'Organizer or Admin permissions required to create events.' }, 403);
  }

  try {
    const {
      title,
      description,
      location,
      location_url,
      event_date,
      max_players,
      use_default_duties,
      custom_duties
    } = await c.req.json();

    if (!title || !String(title).trim() || !location || !String(location).trim() || !event_date) {
      return c.json({ error: 'Title, location, and event date/time are required.' }, 400);
    }

    if (isNaN(new Date(event_date).getTime())) {
      return c.json({ error: 'A valid event date/time is required.' }, 400);
    }

    const safeLocUrl = sanitizeHttpUrl(location_url);
    if (safeLocUrl === null) {
      return c.json({ error: 'Map link must be a valid http:// or https:// URL.' }, 400);
    }

    let dutiesToInsert = [];
    if (use_default_duties || (!custom_duties || custom_duties.length === 0)) {
      dutiesToInsert = await getDefaultDuties(c.env.DB);
    } else if (Array.isArray(custom_duties)) {
      for (const d of custom_duties) {
        if (!d || !d.title || !String(d.title).trim()) {
          return c.json({ error: 'All custom duties must have a non-empty title.' }, 400);
        }
      }
      dutiesToInsert = custom_duties;
    } else {
      dutiesToInsert = await getDefaultDuties(c.env.DB);
    }

    const insertEventRes = await c.env.DB.prepare(`
      INSERT INTO events (title, description, location, location_url, event_date, max_players, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      String(title).trim().slice(0, 150),
      String(description || '').trim().slice(0, 2000),
      String(location).trim().slice(0, 200),
      safeLocUrl,
      event_date,
      max_players ? parseInt(max_players, 10) : null,
      user.id
    ).run();

    const eventId = insertEventRes.meta.last_row_id;

    if (dutiesToInsert.length > 0) {
      const dutyBatch = dutiesToInsert.map((d, idx) => (
        c.env.DB.prepare(`
          INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
          VALUES (?, ?, ?, ?, ?)
        `).bind(
          eventId,
          String(d.title).trim().slice(0, 120),
          String(d.description || '').trim().slice(0, 300),
          parseInt(d.slots_needed || 1, 10),
          d.sort_order !== undefined ? parseInt(d.sort_order, 10) : idx
        )
      ));
      await c.env.DB.batch(dutyBatch);
    }

    const newEvent = await c.env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(eventId).first();

    return c.json({
      success: true,
      eventId,
      event: newEvent,
      message: 'Event created successfully.'
    });
  } catch (err) {
    console.error('[Events] Error creating event:', err);
    return c.json({ error: 'Failed to create event.' }, 500);
  }
});

app.put('/events/:id', async (c) => {
  const user = c.get('user');
  if (!user || !user.canManageEvents) {
    return c.json({ error: 'Organizer or Admin permissions required.' }, 403);
  }

  try {
    const eventId = parseInt(c.req.param('id'), 10);
    const { title, description, location, location_url, event_date, max_players, status } = await c.req.json();

    const existingEvent = await c.env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(eventId).first();
    if (!existingEvent) {
      return c.json({ error: 'Event not found.' }, 404);
    }

    if (title !== undefined && (!title || !String(title).trim())) {
      return c.json({ error: 'Event title cannot be empty.' }, 400);
    }
    if (location !== undefined && (!location || !String(location).trim())) {
      return c.json({ error: 'Event location cannot be empty.' }, 400);
    }
    if (event_date !== undefined && event_date !== null) {
      if (isNaN(new Date(event_date).getTime())) {
        return c.json({ error: 'A valid event date/time is required.' }, 400);
      }
    }

    let safeLocUrl = null;
    if (location_url !== undefined) {
      safeLocUrl = sanitizeHttpUrl(location_url);
      if (safeLocUrl === null) {
        return c.json({ error: 'Map link must be a valid http:// or https:// URL.' }, 400);
      }
    }

    let newMaxPlayers;
    if (max_players === undefined) {
      newMaxPlayers = existingEvent.max_players;
    } else if (max_players === null || max_players === '') {
      newMaxPlayers = null;
    } else {
      const parsed = parseInt(max_players, 10);
      newMaxPlayers = isNaN(parsed) ? existingEvent.max_players : parsed;
    }

    await c.env.DB.prepare(`
      UPDATE events
      SET title = COALESCE(?, title),
          description = COALESCE(?, description),
          location = COALESCE(?, location),
          location_url = COALESCE(?, location_url),
          event_date = COALESCE(?, event_date),
          max_players = ?,
          status = COALESCE(?, status)
      WHERE id = ?
    `).bind(
      title !== undefined ? String(title).trim().slice(0, 150) : null,
      description !== undefined ? String(description).trim().slice(0, 2000) : null,
      location !== undefined ? String(location).trim().slice(0, 200) : null,
      location_url !== undefined ? safeLocUrl : null,
      event_date || null,
      newMaxPlayers,
      status || null,
      eventId
    ).run();

    const updated = await c.env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(eventId).first();
    return c.json({ success: true, event: updated, message: 'Event updated.' });
  } catch (err) {
    console.error('[Events] Error updating event:', err);
    return c.json({ error: 'Failed to update event.' }, 500);
  }
});

app.delete('/events/:id', async (c) => {
  const user = c.get('user');
  if (!user || !user.isAdmin) {
    return c.json({ error: 'Administrator access required.' }, 403);
  }

  try {
    const eventId = parseInt(c.req.param('id'), 10);
    const res = await c.env.DB.prepare('DELETE FROM events WHERE id = ?').bind(eventId).run();
    if (res.meta.changes === 0) {
      return c.json({ error: 'Event not found.' }, 404);
    }
    return c.json({ success: true, message: 'Event deleted.' });
  } catch (err) {
    console.error('[Events] Error deleting event:', err);
    return c.json({ error: 'Failed to delete event.' }, 500);
  }
});

app.post('/events/:id/rsvp', async (c) => {
  try {
    const eventId = parseInt(c.req.param('id'), 10);
    const user = c.get('user');

    const clientIp = getClientIp(c);
    const rsvpLimit = await checkRateLimit(c.env.DB, `rsvp_ip:${clientIp}`, 10, 600);
    if (!rsvpLimit.allowed) {
      return c.json({ error: 'Too many RSVP requests. Please wait a few minutes and try again.' }, 429);
    }

    const event = await c.env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(eventId).first();
    if (!event) {
      return c.json({ error: 'Event not found.' }, 404);
    }

    let { name, email, gear_bringing, duty_ids, management_token, status, cf_turnstile_response } = await c.req.json();
    status = status === 'declined' ? 'declined' : 'attending';

    if (event.status === 'rainout' && status === 'attending') {
      return c.json({ error: 'RSVPs are closed because this game has been called for rain.' }, 400);
    }

    if (!user) {
      const turnstileOk = await verifyTurnstileIfConfigured(c.env, cf_turnstile_response, clientIp);
      if (!turnstileOk) {
        return c.json({ error: 'Bot verification failed. Please refresh and try again.' }, 403);
      }
    }

    const settingRow = await c.env.DB.prepare("SELECT value FROM app_settings WHERE key = 'require_login_to_rsvp'").first();
    const requireLogin = settingRow ? settingRow.value === 'true' : true;
    if (requireLogin && !user) {
      return c.json({ error: 'Sign-in required to RSVP. Please sign in or register before joining the roster.' }, 401);
    }

    let userId = user ? user.id : null;
    let isGuest = user ? 0 : 1;

    if (user) {
      name = (name ? String(name).trim() : user.name).slice(0, 120);
      email = user.email;
    } else {
      if (!name || !String(name).trim()) {
        return c.json({ error: 'Your name is required to RSVP.' }, 400);
      }
      if (!email || typeof email !== 'string' || !email.includes('@')) {
        return c.json({ error: 'A valid email address is required.' }, 400);
      }
      name = String(name).trim().slice(0, 120);
      email = email.trim().toLowerCase();

      const existingUser = await c.env.DB.prepare('SELECT id, name FROM users WHERE email = ?').bind(email).first();
      if (existingUser) {
        userId = existingUser.id;
        isGuest = 0;
      }
    }

    if (email) {
      const banRecord = await c.env.DB.prepare('SELECT id FROM banned_emails WHERE email = ?').bind(email).first();
      if (banRecord) {
        return c.json({ error: 'This email address has been restricted from registering.' }, 403);
      }
    }

    const cleanGear = String(gear_bringing || '').trim().slice(0, 300);
    const mgmtToken = management_token || generateToken();

    const existingAttendee = await c.env.DB.prepare(
      'SELECT * FROM attendees WHERE event_id = ? AND email = ?'
    ).bind(eventId, email).first();

    let attendeeId;
    if (existingAttendee) {
      attendeeId = existingAttendee.id;
      await c.env.DB.prepare(`
        UPDATE attendees
        SET name = ?, status = ?, gear_bringing = ?, user_id = COALESCE(?, user_id), is_guest = ?
        WHERE id = ?
      `).bind(name, status, cleanGear, userId, isGuest, attendeeId).run();
    } else {
      const insertAttendeeRes = await c.env.DB.prepare(`
        INSERT INTO attendees (event_id, user_id, name, email, is_guest, status, gear_bringing, management_token)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(eventId, userId, name, email, isGuest, status, cleanGear, mgmtToken).run();
      attendeeId = insertAttendeeRes.meta.last_row_id;
    }

    const assignedDutyNames = [];
    if (status === 'attending' && Array.isArray(duty_ids)) {
      await c.env.DB.prepare('DELETE FROM duty_assignments WHERE attendee_id = ?').bind(attendeeId).run();

      for (const dId of duty_ids) {
        const duty = await c.env.DB.prepare(
          'SELECT * FROM event_duties WHERE id = ? AND event_id = ?'
        ).bind(dId, eventId).first();

        if (duty) {
          const countRow = await c.env.DB.prepare(`
            SELECT COUNT(*) as count FROM duty_assignments da
            JOIN attendees a ON da.attendee_id = a.id
            WHERE da.duty_id = ? AND a.status = 'attending' AND a.id != ?
          `).bind(dId, attendeeId).first();

          const currentCount = countRow ? countRow.count : 0;
          if (currentCount < duty.slots_needed) {
            await c.env.DB.prepare(`
              INSERT OR IGNORE INTO duty_assignments (duty_id, attendee_id)
              VALUES (?, ?)
            `).bind(dId, attendeeId).run();
            assignedDutyNames.push(duty.title);
          }
        }
      }
    } else if (status === 'declined') {
      await c.env.DB.prepare('DELETE FROM duty_assignments WHERE attendee_id = ?').bind(attendeeId).run();
    }

    if (status === 'attending') {
      const origin = new URL(c.req.url).origin;
      const sendPromise = sendRsvpConfirmation(c.env, origin, {
        email,
        name,
        event,
        dutyName: assignedDutyNames.join(', '),
        gearBringing: cleanGear,
        managementToken: existingAttendee ? (existingAttendee.management_token || mgmtToken) : mgmtToken
      }).catch(e => console.error('[RSVP Email Error]:', e));

      if (c.executionCtx && c.executionCtx.waitUntil) {
        c.executionCtx.waitUntil(sendPromise);
      }
    }

    return c.json({
      success: true,
      status,
      managementToken: existingAttendee ? (existingAttendee.management_token || mgmtToken) : mgmtToken,
      message: status === 'attending'
        ? `You're on the roster! A confirmation email has been sent to ${email}.`
        : 'Your RSVP has been cancelled.'
    });
  } catch (err) {
    console.error('[RSVP] Error updating RSVP:', err);
    return c.json({ error: 'Failed to record RSVP.' }, 500);
  }
});

app.post('/events/:id/comments', async (c) => {
  try {
    const eventId = parseInt(c.req.param('id'), 10);
    const user = c.get('user');

    const clientIp = getClientIp(c);
    const commentLimit = await checkRateLimit(c.env.DB, `comment_ip:${clientIp}`, 10, 600);
    if (!commentLimit.allowed) {
      return c.json({ error: 'Too many comments posted recently. Please wait a few minutes.' }, 429);
    }

    const event = await c.env.DB.prepare('SELECT id FROM events WHERE id = ?').bind(eventId).first();
    if (!event) {
      return c.json({ error: 'Event not found.' }, 404);
    }

    const { content, author_name, author_email } = await c.req.json();
    if (!content || !String(content).trim()) {
      return c.json({ error: 'Comment message cannot be empty.' }, 400);
    }

    const settingRow = await c.env.DB.prepare("SELECT value FROM app_settings WHERE key = 'require_login_to_rsvp'").first();
    const requireLogin = settingRow ? settingRow.value === 'true' : true;
    if (requireLogin && !user) {
      return c.json({ error: 'Sign-in required to post comments.' }, 401);
    }

    let name = '';
    let email = '';
    let userId = null;

    if (user) {
      name = user.name;
      email = user.email;
      userId = user.id;
    } else {
      name = String(author_name || '').trim().slice(0, 120);
      email = String(author_email || '').trim().toLowerCase().slice(0, 254);
      if (!name) {
        return c.json({ error: 'Please enter your name to post a comment.' }, 400);
      }
    }

    if (email) {
      const banRecord = await c.env.DB.prepare('SELECT id FROM banned_emails WHERE email = ?').bind(email).first();
      if (banRecord) {
        return c.json({ error: 'This email address has been restricted.' }, 403);
      }
    }

    const cleanContent = String(content).trim().slice(0, 2000);

    const insertCommentRes = await c.env.DB.prepare(`
      INSERT INTO comments (event_id, user_id, author_name, author_email, content)
      VALUES (?, ?, ?, ?, ?)
    `).bind(eventId, userId, name, email || 'guest', cleanContent).run();

    const commentId = insertCommentRes.meta.last_row_id;
    // Never return author_email in the public response payload
    const newComment = await c.env.DB.prepare(
      'SELECT id, event_id, user_id, author_name, content, created_at FROM comments WHERE id = ?'
    ).bind(commentId).first();

    return c.json({ success: true, comment: newComment });
  } catch (err) {
    console.error('[Comments] Error posting comment:', err);
    return c.json({ error: 'Failed to post comment.' }, 500);
  }
});

app.delete('/events/:id/comments/:commentId', async (c) => {
  const user = c.get('user');
  if (!user || !user.canManageEvents) {
    return c.json({ error: 'Organizer or Admin permissions required.' }, 403);
  }

  try {
    const eventId = parseInt(c.req.param('id'), 10);
    const commentId = parseInt(c.req.param('commentId'), 10);
    const res = await c.env.DB.prepare('DELETE FROM comments WHERE id = ? AND event_id = ?').bind(commentId, eventId).run();
    if (res.meta.changes === 0) {
      return c.json({ error: 'Comment not found.' }, 404);
    }
    return c.json({ success: true, message: 'Comment deleted.' });
  } catch (err) {
    console.error('[Comments] Error deleting comment:', err);
    return c.json({ error: 'Failed to delete comment.' }, 500);
  }
});

app.delete('/events/:id/attendees/:attendeeId', async (c) => {
  const user = c.get('user');
  if (!user || !user.canManageEvents) {
    return c.json({ error: 'Organizer or Admin permissions required.' }, 403);
  }

  try {
    const eventId = parseInt(c.req.param('id'), 10);
    const attendeeId = parseInt(c.req.param('attendeeId'), 10);
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM duty_assignments WHERE attendee_id = ?').bind(attendeeId),
      c.env.DB.prepare('DELETE FROM attendees WHERE id = ? AND event_id = ?').bind(attendeeId, eventId)
    ]);
    return c.json({ success: true, message: 'Player removed from roster.' });
  } catch (err) {
    console.error('[RSVP] Error removing attendee:', err);
    return c.json({ error: 'Failed to remove attendee.' }, 500);
  }
});

app.post('/events/:id/duties', async (c) => {
  const user = c.get('user');
  if (!user || !user.canManageEvents) {
    return c.json({ error: 'Organizer or Admin permissions required.' }, 403);
  }

  try {
    const eventId = parseInt(c.req.param('id'), 10);
    const { title, description, slots_needed } = await c.req.json();

    if (!title || !String(title).trim()) {
      return c.json({ error: 'Duty title is required.' }, 400);
    }

    const maxSortRow = await c.env.DB.prepare('SELECT MAX(sort_order) as max_sort FROM event_duties WHERE event_id = ?').bind(eventId).first();
    const nextSort = (maxSortRow && maxSortRow.max_sort !== null) ? maxSortRow.max_sort + 1 : 0;

    const res = await c.env.DB.prepare(`
      INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
      VALUES (?, ?, ?, ?, ?)
    `).bind(
      eventId,
      String(title).trim().slice(0, 120),
      String(description || '').trim().slice(0, 300),
      parseInt(slots_needed || 1, 10),
      nextSort
    ).run();

    const duty = await c.env.DB.prepare('SELECT * FROM event_duties WHERE id = ?').bind(res.meta.last_row_id).first();
    return c.json({ success: true, duty });
  } catch (err) {
    console.error('[Events] Error adding duty:', err);
    return c.json({ error: 'Failed to add duty.' }, 500);
  }
});

app.put('/events/:id/duties/:dutyId', async (c) => {
  const user = c.get('user');
  if (!user || !user.canManageEvents) {
    return c.json({ error: 'Organizer or Admin permissions required.' }, 403);
  }

  try {
    const eventId = parseInt(c.req.param('id'), 10);
    const dutyId = parseInt(c.req.param('dutyId'), 10);
    const { title, description, slots_needed } = await c.req.json();

    if (title !== undefined && (!title || !String(title).trim())) {
      return c.json({ error: 'Duty title cannot be empty.' }, 400);
    }

    const res = await c.env.DB.prepare(`
      UPDATE event_duties
      SET title = COALESCE(?, title),
          description = COALESCE(?, description),
          slots_needed = COALESCE(?, slots_needed)
      WHERE id = ? AND event_id = ?
    `).bind(
      title ? String(title).trim().slice(0, 120) : null,
      description !== undefined ? String(description).trim().slice(0, 300) : null,
      slots_needed ? parseInt(slots_needed, 10) : null,
      dutyId,
      eventId
    ).run();

    if (res.meta.changes === 0) {
      return c.json({ error: 'Duty not found.' }, 404);
    }

    const updated = await c.env.DB.prepare('SELECT * FROM event_duties WHERE id = ?').bind(dutyId).first();
    return c.json({ success: true, duty: updated });
  } catch (err) {
    console.error('[Events] Error updating duty:', err);
    return c.json({ error: 'Failed to update duty.' }, 500);
  }
});

app.delete('/events/:id/duties/:dutyId', async (c) => {
  const user = c.get('user');
  if (!user || !user.canManageEvents) {
    return c.json({ error: 'Organizer or Admin permissions required.' }, 403);
  }

  try {
    const eventId = parseInt(c.req.param('id'), 10);
    const dutyId = parseInt(c.req.param('dutyId'), 10);

    const res = await c.env.DB.prepare('DELETE FROM event_duties WHERE id = ? AND event_id = ?').bind(dutyId, eventId).run();
    if (res.meta.changes === 0) {
      return c.json({ error: 'Duty not found.' }, 404);
    }

    return c.json({ success: true, message: 'Duty removed.' });
  } catch (err) {
    console.error('[Events] Error deleting duty:', err);
    return c.json({ error: 'Failed to delete duty.' }, 500);
  }
});

app.post('/events/:id/send-reminders', async (c) => {
  const user = c.get('user');
  if (!user || !user.isAdmin) {
    return c.json({ error: 'Administrator access required.' }, 403);
  }

  try {
    const eventId = parseInt(c.req.param('id'), 10);
    const event = await c.env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(eventId).first();
    if (!event) {
      return c.json({ error: 'Event not found.' }, 404);
    }

    const { results: attendees } = await c.env.DB.prepare(`
      SELECT a.*, d.title as duty_name
      FROM attendees a
      LEFT JOIN duty_assignments da ON a.id = da.attendee_id
      LEFT JOIN event_duties d ON da.duty_id = d.id
      WHERE a.event_id = ? AND a.status = 'attending'
    `).bind(eventId).all();

    const origin = new URL(c.req.url).origin;
    const totalCount = attendees ? attendees.length : 0;

    for (const att of (attendees || [])) {
      try {
        await sendEventReminder(c.env, origin, {
          email: att.email,
          name: att.name,
          event,
          dutyName: att.duty_name,
          gearBringing: att.gear_bringing,
          totalAttendees: totalCount,
          managementToken: att.management_token
        });
      } catch (e) {
        console.error('[Reminders] Error sending reminder to ' + att.email + ':', e);
      }
    }

    await c.env.DB.prepare('UPDATE events SET reminder_sent = 1 WHERE id = ?').bind(eventId).run();

    return c.json({ success: true, message: 'Reminders have been sent to all confirmed attendees.' });
  } catch (err) {
    console.error('[Events] Error sending reminders manually:', err);
    return c.json({ error: 'Failed to send reminders.' }, 500);
  }
});

app.post('/events/:id/rainout', async (c) => {
  const user = c.get('user');
  if (!user || (!user.isAdmin && !user.canManageEvents)) {
    return c.json({ error: 'Organizer or administrator access required.' }, 403);
  }

  try {
    const eventId = parseInt(c.req.param('id'), 10);
    const event = await c.env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(eventId).first();
    if (!event) {
      return c.json({ error: 'Event not found.' }, 404);
    }

    const body = await c.req.json().catch(() => ({}));
    const cleanNote = body.note ? String(body.note).trim() : null;
    const shouldEmail = Boolean(body.sendEmail);

    await c.env.DB.prepare(`
      UPDATE events
      SET status = 'rainout',
          rainout_note = ?,
          rainout_at = CURRENT_TIMESTAMP,
          rainout_email_sent = CASE WHEN ? = 1 THEN 1 ELSE rainout_email_sent END
      WHERE id = ?
    `).bind(cleanNote, shouldEmail ? 1 : 0, eventId).run();

    if (shouldEmail) {
      const { results: attendees } = await c.env.DB.prepare(`
        SELECT a.*
        FROM attendees a
        WHERE a.event_id = ? AND a.status = 'attending'
      `).bind(eventId).all();

      const origin = new URL(c.req.url).origin;
      for (const att of (attendees || [])) {
        try {
          await sendRainoutEmail(c.env, origin, {
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

    return c.json({ success: true, message: 'Game has been marked as rained out.' });
  } catch (err) {
    console.error('[Events] Error marking rainout:', err);
    return c.json({ error: 'Failed to mark game as rained out.' }, 500);
  }
});

app.post('/events/:id/reopen', async (c) => {
  const user = c.get('user');
  if (!user || (!user.isAdmin && !user.canManageEvents)) {
    return c.json({ error: 'Organizer or administrator access required.' }, 403);
  }

  try {
    const eventId = parseInt(c.req.param('id'), 10);
    const event = await c.env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(eventId).first();
    if (!event) {
      return c.json({ error: 'Event not found.' }, 404);
    }

    const body = await c.req.json().catch(() => ({}));
    const cleanNote = body.note ? String(body.note).trim() : null;
    const shouldEmail = Boolean(body.sendEmail);

    await c.env.DB.prepare(`
      UPDATE events
      SET status = 'active',
          rainout_note = NULL,
          rainout_at = NULL,
          rainout_email_sent = 0
      WHERE id = ?
    `).bind(eventId).run();

    if (shouldEmail) {
      const { results: attendees } = await c.env.DB.prepare(`
        SELECT a.*
        FROM attendees a
        WHERE a.event_id = ? AND a.status = 'attending'
      `).bind(eventId).all();

      const origin = new URL(c.req.url).origin;
      for (const att of (attendees || [])) {
        try {
          await sendReopenEmail(c.env, origin, {
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

    return c.json({ success: true, message: 'Game has been reopened and is back on!' });
  } catch (err) {
    console.error('[Events] Error reopening event:', err);
    return c.json({ error: 'Failed to reopen game.' }, 500);
  }
});

app.post('/events/:id/send-rainout-email', async (c) => {
  const user = c.get('user');
  if (!user || (!user.isAdmin && !user.canManageEvents)) {
    return c.json({ error: 'Organizer or administrator access required.' }, 403);
  }

  try {
    const eventId = parseInt(c.req.param('id'), 10);
    const event = await c.env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(eventId).first();
    if (!event) {
      return c.json({ error: 'Event not found.' }, 404);
    }

    const body = await c.req.json().catch(() => ({}));
    const cleanNote = body.note !== undefined ? (body.note ? String(body.note).trim() : null) : event.rainout_note;

    const { results: attendees } = await c.env.DB.prepare(`
      SELECT a.*
      FROM attendees a
      WHERE a.event_id = ? AND a.status = 'attending'
    `).bind(eventId).all();

    const origin = new URL(c.req.url).origin;
    for (const att of (attendees || [])) {
      try {
        await sendRainoutEmail(c.env, origin, {
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

    await c.env.DB.prepare('UPDATE events SET rainout_email_sent = 1 WHERE id = ?').bind(eventId).run();

    return c.json({ success: true, message: 'Rainout email sent to confirmed attendees.' });
  } catch (err) {
    console.error('[Events] Error sending rainout email:', err);
    return c.json({ error: 'Failed to send rainout email.' }, 500);
  }
});

export const onRequest = handle(app);
