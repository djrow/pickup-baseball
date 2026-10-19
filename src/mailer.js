const nodemailer = require('nodemailer');

// App base URL (for generating magic links and RSVP management links)
const APP_URL = process.env.APP_URL || 'http://localhost:3000';
const APP_NAME = process.env.APP_NAME || 'Sunday Pickup Baseball';

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;

  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (host && user && pass) {
    transporter = nodemailer.createTransport({
      host: host,
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: user,
        pass: pass
      }
    });
    console.log(`[Mailer] Configured SMTP transport with host: ${host}`);
  } else {
    // Development / Console Fallback transport
    transporter = {
      sendMail: async (options) => {
        console.log('\n================== [EMAIL DISPATCHED (LOCAL DEV)] ==================');
        console.log(`To:      ${options.to}`);
        console.log(`Subject: ${options.subject}`);
        console.log('--------------------------------------------------------------------');
        console.log(options.text);
        console.log('====================================================================\n');
        return { messageId: 'mock-' + Date.now() };
      }
    };
    console.log('[Mailer] No SMTP credentials configured. Outgoing emails will be logged to the console with clickable links.');
  }

  return transporter;
}

/**
 * Send 6-digit login code and magic link
 */
async function sendAuthCode({ email, name, code, token }) {
  const magicLink = `${APP_URL}/api/auth/verify-magic?token=${encodeURIComponent(token)}`;
  const mailer = getTransporter();
  const from = process.env.FROM_EMAIL || `"${APP_NAME}" <no-reply@baseballcharity.org>`;

  const subject = `Your Sign-In Code for ${APP_NAME}: ${code}`;
  const text = `Hi ${name || 'there'},

Welcome to ${APP_NAME}!

Your 6-digit sign-in code is: ${code}

Or simply click the link below to sign in automatically:
${magicLink}

This code and link will expire in 20 minutes.

Play ball!
- ${APP_NAME} Team`;

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 580px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 8px;">
      <h2 style="color: #1e3a8a; margin-top: 0;">⚾ ${APP_NAME}</h2>
      <p>Hi <strong>${name || 'there'}</strong>,</p>
      <p>Use the code below to sign in to your account:</p>
      <div style="background: #f1f5f9; padding: 16px; border-radius: 6px; text-align: center; margin: 24px 0;">
        <span style="font-size: 32px; font-weight: bold; letter-spacing: 6px; color: #0f172a;">${code}</span>
      </div>
      <p style="text-align: center; margin: 24px 0;">
        <a href="${magicLink}" style="background: #15803d; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600; display: inline-block;">
          Or Click to Sign In Instantly
        </a>
      </p>
      <p style="color: #64748b; font-size: 14px; margin-top: 32px;">This code expires in 20 minutes. If you did not request this, you can safely ignore this email.</p>
    </div>
  `;

  return mailer.sendMail({
    from,
    to: email,
    subject,
    text,
    html
  });
}

/**
 * Send instant RSVP confirmation email
 */
async function sendRsvpConfirmation({ email, name, event, dutyName, gearBringing, managementToken }) {
  const mailer = getTransporter();
  const from = process.env.FROM_EMAIL || `"${APP_NAME}" <no-reply@baseballcharity.org>`;
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
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 580px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 8px;">
      <h2 style="color: #1e3a8a; margin-top: 0;">⚾ RSVP Confirmed!</h2>
      <p>Hi <strong>${name}</strong>,</p>
      <p>You are on the roster for <strong>${event.title}</strong>.</p>
      
      <div style="background: #f8fafc; border-left: 4px solid #15803d; padding: 16px; margin: 20px 0; border-radius: 4px;">
        <p style="margin: 4px 0;"><strong>📅 When:</strong> ${eventDateFormatted}</p>
        <p style="margin: 4px 0;"><strong>📍 Where:</strong> ${event.location}</p>
        ${event.location_url ? `<p style="margin: 4px 0;"><a href="${event.location_url}" target="_blank" style="color: #2563eb;">View Map / Directions</a></p>` : ''}
        ${dutyName ? `<p style="margin: 4px 0; color: #166534;"><strong>🛡️ Your Duty:</strong> ${dutyName}</p>` : ''}
        ${gearBringing ? `<p style="margin: 4px 0; color: #1e293b;"><strong>🎒 Gear You're Bringing:</strong> ${gearBringing}</p>` : ''}
      </div>

      <p style="text-align: center; margin: 28px 0;">
        <a href="${manageLink}" style="background: #1e3a8a; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600; display: inline-block;">
          View Roster, Coordinate & Manage RSVP
        </a>
      </p>

      <p style="color: #64748b; font-size: 13px;">
        Plans changed? Use the button above to update your gear or cancel your attendance so another player can take your spot.
      </p>
    </div>
  `;

  return mailer.sendMail({
    from,
    to: email,
    subject,
    text,
    html
  });
}

/**
 * Send 24-hour reminder email before the event
 */
async function sendEventReminder({ email, name, event, dutyName, gearBringing, totalAttendees, managementToken }) {
  const mailer = getTransporter();
  const from = process.env.FROM_EMAIL || `"${APP_NAME}" <no-reply@baseballcharity.org>`;
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
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 580px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 8px;">
      <h2 style="color: #1e3a8a; margin-top: 0;">⚾ Game Day Tomorrow!</h2>
      <p>Hi <strong>${name}</strong>,</p>
      <p>This is your friendly reminder that pickup baseball is tomorrow at noon!</p>
      
      <div style="background: #f8fafc; border-left: 4px solid #f59e0b; padding: 16px; margin: 20px 0; border-radius: 4px;">
        <p style="margin: 4px 0;"><strong>📅 When:</strong> ${eventDateFormatted}</p>
        <p style="margin: 4px 0;"><strong>📍 Where:</strong> ${event.location}</p>
        <p style="margin: 4px 0;"><strong>👥 Attendance:</strong> <strong>${totalAttendees}</strong> players confirmed</p>
        ${dutyName ? `<p style="margin: 4px 0; color: #92400e;"><strong>🛡️ Your Duty:</strong> ${dutyName}</p>` : ''}
        ${gearBringing ? `<p style="margin: 4px 0; color: #1e293b;"><strong>🎒 Gear You're Bringing:</strong> ${gearBringing}</p>` : ''}
      </div>

      <p style="text-align: center; margin: 28px 0;">
        <a href="${manageLink}" style="background: #15803d; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600; display: inline-block;">
          Check Event Chat & Final Roster
        </a>
      </p>

      <p style="color: #64748b; font-size: 13px;">
        If you can no longer make it, please click the link above immediately to withdraw so the organizer and team can plan the game.
      </p>
    </div>
  `;

  return mailer.sendMail({
    from,
    to: email,
    subject,
    text,
    html
  });
}

module.exports = {
  sendAuthCode,
  sendRsvpConfirmation,
  sendEventReminder
};
