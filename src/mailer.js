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
async function sendRsvpConfirmation({ email, name, event, dutyName, gearBringing, additionalGuests, guestNames, managementToken }) {
  const manageLink = `${APP_URL}/event.html?id=${event.id}&token=${encodeURIComponent(managementToken || '')}`;
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

  const guestsCount = Number(additionalGuests) || 0;
  const totalParty = 1 + guestsCount;

  const subject = `Confirmed: You're playing in ${event.title} (${eventDateFormatted})`;
  const text = `Hi ${name},

You're confirmed for pickup baseball!

Event: ${event.title}
Date & Time: ${eventDateFormatted}
Location: ${event.location}
${guestsCount > 0 ? `Additional Guests: +${guestsCount}${guestNames ? ` (${guestNames})` : ''}\nTotal in Your Party: ${totalParty} players\n` : ''}${dutyName ? `Task Signed Up For: ${dutyName}\n` : ''}${gearBringing ? `Gear You're Bringing: ${gearBringing}\n` : ''}
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
        ${guestsCount > 0 ? `<p style="margin: 4px 0; color: #003831;"><strong>👥 Additional Guests:</strong> +${guestsCount} ${guestNames ? `<em>(${guestNames})</em>` : ''} (${totalParty} players total in your party)</p>` : ''}
        ${event.location_url ? `<p style="margin: 4px 0;"><a href="${event.location_url}" target="_blank" style="color: #FD5A1E; font-weight: 700;">View Map / Directions ↗</a></p>` : ''}
        ${dutyName ? `<p style="margin: 6px 0 4px 0; color: #003831;"><strong>🛡️ Your Task:</strong> <span style="background: #e6f0ed; padding: 2px 8px; border-radius: 4px; font-weight: 700;">${dutyName}</span></p>` : ''}
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
    timeZone: 'America/Los_Angeles',
    timeZoneName: 'short'
  });

  const subject = `Reminder: Baseball Tomorrow! ${event.title} (${eventDateFormatted})`;
  const text = `Hi ${name},

Pickup baseball is tomorrow!

Event: ${event.title}
When: ${eventDateFormatted}
Where: ${event.location}
Current Count: ${totalAttendees} players confirmed
${dutyName ? `Your Assigned Task: ${dutyName}\n` : ''}${gearBringing ? `Gear You Promised: ${gearBringing}\n` : ''}
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
        ${dutyName ? `<p style="margin: 6px 0 4px 0; color: #003831;"><strong>🛡️ Your Task:</strong> <span style="background: #e6f0ed; padding: 2px 8px; border-radius: 4px; font-weight: 700;">${dutyName}</span></p>` : ''}
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

/**
 * Send rainout cancellation notification email to confirmed attendee
 */
async function sendRainoutEmail({ email, name, event, note, managementToken }) {
  const manageLink = `${APP_URL}/event.html?id=${event.id}&token=${encodeURIComponent(managementToken || '')}`;
  const eventDateFormatted = new Date(event.event_date).toLocaleString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/Los_Angeles',
    timeZoneName: 'short'
  });

  const subject = `🌧️ Sunday Pickup Baseball Rained Out: ${event.title}`;
  const text = `Hi ${name},

Today's pickup baseball game has been called due to rain and field conditions.

Event: ${event.title}
Originally Scheduled: ${eventDateFormatted}
Location: ${event.location}
${note ? `Organizer Note:\n"${note}"\n\n` : ''}Any volunteer task or equipment commitments you made for today are excused.

The discussion board on the event page remains open if you'd like to chat with the team or coordinate alternate plans:
${manageLink}

Stay dry, and see you on the field next Sunday!
- ${APP_NAME}`;

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 580px; margin: 0 auto; padding: 26px; border: 1px solid #cbd5e1; border-top: 5px solid #0284c7; border-radius: 8px; background: #ffffff;">
      <h2 style="color: #0f172a; margin-top: 0; font-size: 22px;">🌧️ Game Called Due to Rain</h2>
      <p style="color: #0c1f1a; font-size: 16px;">Hi <strong>${name}</strong>,</p>
      <p style="color: #475569; font-size: 15px;">Today's pickup baseball game (<strong>${event.title}</strong>) has been called due to rain and wet field conditions.</p>
      
      ${note ? `
      <div style="background: #f1f5f9; border-left: 4px solid #0284c7; padding: 14px 18px; margin: 18px 0; border-radius: 6px;">
        <strong style="color: #0f172a; display: block; font-size: 13px; text-transform: uppercase; margin-bottom: 4px;">Organizer Note:</strong>
        <p style="margin: 0; color: #334155; font-size: 15px; font-style: italic;">"${note}"</p>
      </div>` : ''}

      <div style="background: #f8fafc; border: 1px solid #e2e8f0; padding: 16px; margin: 18px 0; border-radius: 6px;">
        <p style="margin: 3px 0; color: #64748b; font-size: 14px;"><strong>📅 Scheduled:</strong> ${eventDateFormatted}</p>
        <p style="margin: 3px 0; color: #64748b; font-size: 14px;"><strong>📍 Field:</strong> ${event.location}</p>
        <p style="margin: 6px 0 0; color: #0284c7; font-weight: 600; font-size: 14px;">✓ Your task and equipment commitments are excused for today.</p>
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

  return dispatchEmail({ to: email, subject, text, html });
}

/**
 * Send reopening / back-on notification email to confirmed attendee
 */
async function sendReopenEmail({ email, name, event, note, managementToken }) {
  const manageLink = `${APP_URL}/event.html?id=${event.id}&token=${encodeURIComponent(managementToken || '')}`;
  const eventDateFormatted = new Date(event.event_date).toLocaleString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/Los_Angeles',
    timeZoneName: 'short'
  });

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
- ${APP_NAME}`;

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 580px; margin: 0 auto; padding: 26px; border: 1px solid #dbe4e0; border-top: 5px solid #FD5A1E; border-radius: 8px; background: #ffffff;">
      <h2 style="color: #003831; margin-top: 0; font-size: 22px;">⚾ Game is BACK ON!</h2>
      <p style="color: #0c1f1a; font-size: 16px;">Hi <strong>${name}</strong>,</p>
      <p style="color: #546e66; font-size: 15px;">Great news! Weather or field conditions have cleared up and today's game (<strong>${event.title}</strong>) is officially BACK ON!</p>
      
      ${note ? `
      <div style="background: #fff7ed; border-left: 4px solid #FD5A1E; padding: 14px 18px; margin: 18px 0; border-radius: 6px;">
        <strong style="color: #9a3412; display: block; font-size: 13px; text-transform: uppercase; margin-bottom: 4px;">Organizer Note:</strong>
        <p style="margin: 0; color: #7c2d12; font-size: 15px; font-style: italic;">"${note}"</p>
      </div>` : ''}

      <div style="background: #f5f8f7; border-left: 4px solid #003831; border: 1px solid #dbe4e0; padding: 16px; margin: 18px 0; border-radius: 6px;">
        <p style="margin: 3px 0; color: #0c1f1a; font-size: 14px;"><strong>📅 When:</strong> ${eventDateFormatted}</p>
        <p style="margin: 3px 0; color: #0c1f1a; font-size: 14px;"><strong>📍 Where:</strong> ${event.location}</p>
        <p style="margin: 6px 0 0; color: #003831; font-weight: 700; font-size: 14px;">✓ Your roster spot is active. Grab your glove and head out!</p>
      </div>

      <p style="text-align: center; margin: 26px 0;">
        <a href="${manageLink}" style="background: #FD5A1E; color: #ffffff; padding: 13px 26px; border-radius: 6px; text-decoration: none; font-weight: 700; font-size: 15px; display: inline-block;">
          Check Live Roster & Tasks →
        </a>
      </p>
    </div>
  `;

  return dispatchEmail({ to: email, subject, text, html });
}

/**
 * Send confirmation that attendee is placed on waitlist
 */
async function sendWaitlistConfirmation({ email, name, event, waitlistPosition, additionalGuests, guestNames, managementToken }) {
  const manageLink = `${APP_URL}/event.html?id=${event.id}&token=${encodeURIComponent(managementToken || '')}`;
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

  const guestsCount = Number(additionalGuests) || 0;
  const totalParty = 1 + guestsCount;

  const subject = `⏳ Waitlist Confirmed: ${event.title} (Position #${waitlistPosition})`;
  const text = `Hi ${name},

The active playing roster for ${event.title} is currently full at ${event.max_players || 'maximum'} players.

You are on the waitlist at position #${waitlistPosition}${guestsCount > 0 ? ` with your party of ${totalParty} players` : ''}.

If active roster spots open up, you will be automatically promoted to the playing roster and notified immediately by email!

Check your waitlist status and view event details here:
${manageLink}

- ${APP_NAME}`;

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 580px; margin: 0 auto; padding: 26px; border: 1px solid #dbe4e0; border-top: 5px solid #003831; border-radius: 8px; background: #ffffff;">
      <h2 style="color: #003831; margin-top: 0; font-size: 22px;">⏳ Waitlist Confirmed</h2>
      <p style="color: #0c1f1a; font-size: 16px;">Hi <strong>${name}</strong>,</p>
      <p style="color: #546e66; font-size: 15px;">The playing roster for <strong>${event.title}</strong> is currently full. You have been placed on the waitlist.</p>
      
      <div style="background: #f5f8f7; border-left: 4px solid #FD5A1E; border: 1px solid #dbe4e0; padding: 18px; margin: 20px 0; border-radius: 6px;">
        <p style="margin: 4px 0; color: #003831; font-size: 17px;"><strong>Your Waitlist Position:</strong> <span style="background: #FD5A1E; color: #fff; padding: 3px 10px; border-radius: 20px; font-weight: 700;">#${waitlistPosition}</span></p>
        ${guestsCount > 0 ? `<p style="margin: 6px 0 4px 0; color: #0c1f1a;"><strong>👥 Party Size:</strong> ${totalParty} players (+${guestsCount} guests)</p>` : ''}
        <p style="margin: 8px 0 4px 0; color: #0c1f1a;"><strong>📅 Game Date:</strong> ${eventDateFormatted}</p>
        <p style="margin: 4px 0; color: #0c1f1a;"><strong>📍 Location:</strong> ${event.location}</p>
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

  return dispatchEmail({ to: email, subject, text, html });
}

/**
 * Send notification that player was promoted from waitlist to active roster
 */
async function sendWaitlistPromotionEmail({ email, name, event, managementToken }) {
  const manageLink = `${APP_URL}/event.html?id=${event.id}&token=${encodeURIComponent(managementToken || '')}`;
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

  const subject = `⚾ A spot opened up! You're in for ${event.title} (${eventDateFormatted})`;
  const text = `Hi ${name},

Great news! A spot just opened up for pickup baseball!

You have been automatically promoted from the waitlist to the ACTIVE ROSTER for:
${event.title}

Date & Time: ${eventDateFormatted}
Location: ${event.location}

Visit the event page to coordinate gear, sign up for tasks, or view the roster:
${manageLink}

If your plans have changed and you can no longer attend, please cancel your RSVP on the page so another player from the waitlist can take your spot.

See you on the field!
- ${APP_NAME}`;

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 580px; margin: 0 auto; padding: 26px; border: 1px solid #dbe4e0; border-top: 5px solid #003831; border-radius: 8px; background: #ffffff;">
      <h2 style="color: #003831; margin-top: 0; font-size: 22px;">⚾ You're Off the Waitlist — You're In!</h2>
      <p style="color: #0c1f1a; font-size: 16px;">Hi <strong>${name}</strong>,</p>
      <p style="color: #546e66; font-size: 15px;">A spot just opened up! You have been <strong>automatically promoted from the waitlist to the confirmed roster</strong> for <strong>${event.title}</strong>.</p>
      
      <div style="background: #f5f8f7; border-left: 4px solid #003831; border: 1px solid #dbe4e0; padding: 18px; margin: 20px 0; border-radius: 6px;">
        <p style="margin: 4px 0; color: #0c1f1a;"><strong>📅 When:</strong> ${eventDateFormatted}</p>
        <p style="margin: 4px 0; color: #0c1f1a;"><strong>📍 Where:</strong> ${event.location}</p>
        ${event.location_url ? `<p style="margin: 4px 0;"><a href="${event.location_url}" target="_blank" style="color: #FD5A1E; font-weight: 700;">View Map / Directions ↗</a></p>` : ''}
        <p style="margin: 6px 0 0 0; color: #003831; font-weight: 700;">Status: Confirmed Player</p>
      </div>

      <p style="text-align: center; margin: 28px 0;">
        <a href="${manageLink}" style="background: #FD5A1E; color: #ffffff; padding: 13px 26px; border-radius: 6px; text-decoration: none; font-weight: 700; font-size: 15px; display: inline-block;">
          View Roster & Sign Up for Tasks →
        </a>
      </p>

      <p style="color: #546e66; font-size: 13px; border-top: 1px solid #dbe4e0; padding-top: 14px;">
        Can't make it after all? Please click the button above to cancel your RSVP so the next person on the waitlist gets their chance to play!
      </p>
    </div>
  `;

  return dispatchEmail({ to: email, subject, text, html });
}

module.exports = {
  dispatchEmail,
  sendAuthCode,
  sendRsvpConfirmation,
  sendWaitlistConfirmation,
  sendWaitlistPromotionEmail,
  sendEventReminder,
  sendRainoutEmail,
  sendReopenEmail
};
