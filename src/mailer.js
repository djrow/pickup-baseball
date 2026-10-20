const nodemailer = require('nodemailer');

// App base URL (for generating magic links and RSVP management links)
const APP_URL = process.env.APP_URL || 'http://localhost:3000';
const APP_NAME = process.env.APP_NAME || 'Sunday Pickup Baseball';

let transporter = null;

/**
 * Universal dispatcher: Resend REST API -> SMTP Transport -> Local Console
 */
async function dispatchEmail({ to, subject, text, html }) {
  const from = process.env.FROM_EMAIL || `"${APP_NAME}" <games@pickupbaseballfoundation.org>`;
  const replyTo = process.env.REPLY_TO_EMAIL || 'pickupbaseballfoundation@gmail.com';
  const resendApiKey = process.env.RESEND_API_KEY;

  // 1. Direct Resend REST API (Fast, no SMTP port blocks, 100% free tier compatible)
  if (resendApiKey) {
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${resendApiKey.trim()}`,
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

      console.log(`[Mailer:Resend] Email delivered to ${to} (ID: ${data.id})`);
      return { messageId: data.id };
    } catch (err) {
      console.error(`[Mailer:Resend] Delivery failed to ${to}:`, err.message);
      throw err;
    }
  }

  // 2. Direct Gmail SMTP (Send directly from your personal @gmail.com using a free Google App Password)
  const gmailUser = process.env.GMAIL_USER;
  const gmailPass = process.env.GMAIL_APP_PASSWORD || process.env.GMAIL_APP_PASS;

  if (gmailUser && gmailPass) {
    if (!transporter) {
      transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
          user: gmailUser.trim(),
          pass: gmailPass.trim()
        }
      });
      console.log(`[Mailer:Gmail] Configured direct Gmail SMTP transport for: ${gmailUser}`);
    }

    const fromAddress = `"${APP_NAME}" <${gmailUser.trim()}>`;
    return transporter.sendMail({ from: fromAddress, to, replyTo, subject, text, html });
  }

  // 3. Standard SMTP Fallback (e.g. custom SMTP servers)
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (host && user && pass) {
    if (!transporter) {
      transporter = nodemailer.createTransport({
        host: host,
        port: parseInt(process.env.SMTP_PORT || '587', 10),
        secure: process.env.SMTP_SECURE === 'true',
        auth: { user, pass }
      });
      console.log(`[Mailer:SMTP] Configured SMTP transport with host: ${host}`);
    }

    return transporter.sendMail({ from, to, replyTo, subject, text, html });
  }

  // 3. Local Development / Console Fallback
  console.log('\n================== [EMAIL DISPATCHED (LOCAL DEV)] ==================');
  console.log(`From:    ${from}`);
  console.log(`To:      ${to}`);
  console.log(`Subject: ${subject}`);
  console.log('--------------------------------------------------------------------');
  console.log(text);
  console.log('====================================================================\n');
  return { messageId: 'mock-' + Date.now() };
}

/**
 * Send 6-digit login code and magic link
 */
async function sendAuthCode({ email, name, code, token }) {
  const magicLink = `${APP_URL}/api/auth/verify-magic?token=${encodeURIComponent(token)}`;
  const subject = `Your Sign-In Code for ${APP_NAME}: ${code}`;
  
  const text = `Hi ${name || 'there'},

Welcome to ${APP_NAME}!

Your 6-digit sign-in code is: ${code}

Or click the link below to sign in automatically:
${magicLink}

This code and link will expire in 20 minutes.

Play ball!
- ${APP_NAME} Team`;

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 580px; margin: 0 auto; padding: 26px; border: 1px solid #dbe4e0; border-top: 5px solid #003831; border-radius: 8px; background: #ffffff;">
      <h2 style="color: #003831; margin-top: 0; font-size: 22px;">⚾ ${APP_NAME}</h2>
      <p style="color: #0c1f1a; font-size: 16px;">Hi <strong>${name || 'there'}</strong>,</p>
      <p style="color: #546e66; font-size: 15px;">Use the code below to sign in to your account:</p>
      <div style="background: #f5f8f7; border: 1px solid #dbe4e0; padding: 18px; border-radius: 8px; text-align: center; margin: 24px 0;">
        <span style="font-size: 34px; font-weight: 800; letter-spacing: 6px; color: #003831;">${code}</span>
      </div>
      <p style="text-align: center; margin: 26px 0;">
        <a href="${magicLink}" style="background: #FD5A1E; color: #ffffff; padding: 13px 26px; border-radius: 6px; text-decoration: none; font-weight: 700; font-size: 15px; display: inline-block;">
          Or Click to Sign In Instantly →
        </a>
      </p>
      <p style="color: #546e66; font-size: 13px; margin-top: 32px; border-top: 1px solid #dbe4e0; padding-top: 14px;">This code expires in 20 minutes. If you did not request this, you can safely ignore this email.</p>
    </div>
  `;

  return dispatchEmail({ to: email, subject, text, html });
}

/**
 * Send instant RSVP confirmation email
 */
async function sendRsvpConfirmation({ email, name, event, dutyName, gearBringing, managementToken }) {
  const manageLink = `${APP_URL}/event.html?id=${event.id}&token=${encodeURIComponent(managementToken || '')}`;
  const eventDateFormatted = new Date(event.event_date).toLocaleString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short'
  });

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
- ${APP_NAME}`;

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 580px; margin: 0 auto; padding: 26px; border: 1px solid #dbe4e0; border-top: 5px solid #FD5A1E; border-radius: 8px; background: #ffffff;">
      <h2 style="color: #003831; margin-top: 0; font-size: 22px;">⚾ RSVP Confirmed!</h2>
      <p style="color: #0c1f1a; font-size: 16px;">Hi <strong>${name}</strong>,</p>
      <p style="color: #546e66; font-size: 15px;">You are confirmed on the roster for <strong>${event.title}</strong>.</p>
      
      <div style="background: #f5f8f7; border-left: 4px solid #003831; border: 1px solid #dbe4e0; padding: 18px; margin: 20px 0; border-radius: 6px;">
        <p style="margin: 4px 0; color: #0c1f1a;"><strong>📅 When:</strong> ${eventDateFormatted}</p>
        <p style="margin: 4px 0; color: #0c1f1a;"><strong>📍 Where:</strong> ${event.location}</p>
        ${event.location_url ? `<p style="margin: 4px 0;"><a href="${event.location_url}" target="_blank" style="color: #FD5A1E; font-weight: 700;">View Map / Directions ↗</a></p>` : ''}
        ${dutyName ? `<p style="margin: 6px 0 4px 0; color: #003831;"><strong>🛡️ Your Duty:</strong> <span style="background: #e6f0ed; padding: 2px 8px; border-radius: 4px; font-weight: 700;">${dutyName}</span></p>` : ''}
        ${gearBringing ? `<p style="margin: 4px 0; color: #0c1f1a;"><strong>🎒 Gear You're Bringing:</strong> <em>${gearBringing}</em></p>` : ''}
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

  return dispatchEmail({ to: email, subject, text, html });
}

/**
 * Send 24-hour reminder email before the event
 */
async function sendEventReminder({ email, name, event, dutyName, gearBringing, totalAttendees, managementToken }) {
  const manageLink = `${APP_URL}/event.html?id=${event.id}&token=${encodeURIComponent(managementToken || '')}`;
  const eventDateFormatted = new Date(event.event_date).toLocaleString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short'
  });

  const subject = `Reminder: Baseball Tomorrow! ${event.title} (${eventDateFormatted})`;
  const text = `Hi ${name},

Pickup baseball is tomorrow!

Event: ${event.title}
When: ${eventDateFormatted}
Where: ${event.location}
Current Count: ${totalAttendees} players confirmed
${dutyName ? `Your Assigned Duty: ${dutyName}\n` : ''}${gearBringing ? `Gear You Promised: ${gearBringing}\n` : ''}
Check the discussion board for weather updates and carpools, or update your attendance:
${manageLink}

See you tomorrow at the field!
- ${APP_NAME}`;

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 580px; margin: 0 auto; padding: 26px; border: 1px solid #dbe4e0; border-top: 5px solid #003831; border-radius: 8px; background: #ffffff;">
      <h2 style="color: #003831; margin-top: 0; font-size: 22px;">⚾ Game Day Tomorrow!</h2>
      <p style="color: #0c1f1a; font-size: 16px;">Hi <strong>${name}</strong>,</p>
      <p style="color: #546e66; font-size: 15px;">Friendly reminder that pickup baseball is tomorrow at noon!</p>
      
      <div style="background: #f5f8f7; border-left: 4px solid #FD5A1E; border: 1px solid #dbe4e0; padding: 18px; margin: 20px 0; border-radius: 6px;">
        <p style="margin: 4px 0; color: #0c1f1a;"><strong>📅 When:</strong> ${eventDateFormatted}</p>
        <p style="margin: 4px 0; color: #0c1f1a;"><strong>📍 Where:</strong> ${event.location}</p>
        <p style="margin: 4px 0; color: #003831;"><strong>👥 Headcount:</strong> <strong style="font-size: 16px; color: #FD5A1E;">${totalAttendees}</strong> players confirmed</p>
        ${dutyName ? `<p style="margin: 6px 0 4px 0; color: #003831;"><strong>🛡️ Your Duty:</strong> <span style="background: #e6f0ed; padding: 2px 8px; border-radius: 4px; font-weight: 700;">${dutyName}</span></p>` : ''}
        ${gearBringing ? `<p style="margin: 4px 0; color: #0c1f1a;"><strong>🎒 Gear You Promised:</strong> <em>${gearBringing}</em></p>` : ''}
      </div>

      <p style="text-align: center; margin: 28px 0;">
        <a href="${manageLink}" style="background: #003831; color: #ffffff; padding: 13px 26px; border-radius: 6px; text-decoration: none; font-weight: 700; font-size: 15px; display: inline-block;">
          Check Event Chat & Final Roster →
        </a>
      </p>

      <p style="color: #546e66; font-size: 13px; border-top: 1px solid #dbe4e0; padding-top: 14px;">
        If you can no longer make it, please click the link above immediately to withdraw so the organizer and team can plan the game.
      </p>
    </div>
  `;

  return dispatchEmail({ to: email, subject, text, html });
}

module.exports = {
  dispatchEmail,
  sendAuthCode,
  sendRsvpConfirmation,
  sendEventReminder
};
