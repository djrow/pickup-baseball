/**
 * Unified Email Dispatcher & Templates (Resend REST API + Dev/Test Fallback)
 * Consolidates 7 HTML/Text templates via a shared email card layout helper.
 */

import { escapeHtml, sanitizeHttpUrl } from './security.js';

function formatEmailEventDate(dateStr) {
  return new Date(dateStr).toLocaleString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/Los_Angeles',
    timeZoneName: 'short'
  });
}

function renderEmailLayout({
  origin,
  topColor = '#003831',
  borderColor = '#dbe4e0',
  headingColor = '#003831',
  showLogo = true,
  headingHtml,
  bodyHtml,
  ctaUrl,
  ctaLabel,
  ctaColor = '#FD5A1E',
  footerText = ''
}) {
  const logoHtml = showLogo
    ? `<img src="${origin}/logo.svg" alt="" style="width: 30px; height: 30px; vertical-align: middle; margin-right: 6px;">`
    : '';
  const ctaBlock = ctaUrl
    ? `<p style="text-align: center; margin: 26px 0;">
        <a href="${ctaUrl}" style="background: ${ctaColor}; color: #ffffff; padding: 13px 26px; border-radius: 6px; text-decoration: none; font-weight: 700; font-size: 15px; display: inline-block;">
          ${ctaLabel}
        </a>
      </p>`
    : '';
  const footerBlock = footerText
    ? `<p style="color: #546e66; font-size: 13px; margin-top: 28px; border-top: 1px solid ${borderColor}; padding-top: 14px; margin-bottom: 0;">${footerText}</p>`
    : '';

  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 580px; margin: 0 auto; padding: 26px; border: 1px solid ${borderColor}; border-top: 5px solid ${topColor}; border-radius: 8px; background: #ffffff;">
      <h2 style="color: ${headingColor}; margin-top: 0; font-size: 22px;">${logoHtml}${headingHtml}</h2>
      ${bodyHtml}
      ${ctaBlock}
      ${footerBlock}
    </div>
  `;
}

export async function dispatchEmail(env, { to, subject, text, html }) {
  const safeEnv = env || {};
  const appName = safeEnv.APP_NAME || 'Sunday Pickup Baseball';
  const from = safeEnv.FROM_EMAIL || `"${appName}" <games@pickupbaseballfoundation.org>`;
  const replyTo = safeEnv.REPLY_TO_EMAIL || 'pickupbaseballfoundation@gmail.com';
  const apiKey = safeEnv.RESEND_API_KEY;

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

  if (safeEnv.NODE_ENV !== 'test') {
    console.log(`[Email Dispatch (No Key)] To: ${to} | Subject: ${subject}`);
  }
  return { messageId: 'mock-' + Date.now() };
}

export async function sendAuthCode(env, origin, { email, name, code, token }) {
  const appName = (env && env.APP_NAME) || 'Sunday Pickup Baseball';
  const magicLink = `${origin}/api/auth/verify-magic?token=${encodeURIComponent(token)}`;
  const subject = `Your Sign-In Code for ${appName}: ${code}`;
  const text = `Hi ${name || 'there'},\n\nWelcome to ${appName}!\n\nYour 6-digit sign-in code is: ${code}\n\nOr click the link below to sign in automatically:\n${magicLink}\n\nThis code and link will expire in 10 minutes.\n\nPlay ball!\n- ${appName} Team`;

  const html = renderEmailLayout({
    origin,
    topColor: '#003831',
    headingHtml: escapeHtml(appName),
    bodyHtml: `
      <p style="color: #0c1f1a; font-size: 16px;">Hi <strong>${escapeHtml(name || 'there')}</strong>,</p>
      <p style="color: #546e66; font-size: 15px;">Use the code below to sign in to your account:</p>
      <div style="background: #f5f8f7; border: 1px solid #dbe4e0; padding: 18px; border-radius: 8px; text-align: center; margin: 24px 0;">
        <span style="font-size: 34px; font-weight: 800; letter-spacing: 6px; color: #003831;">${escapeHtml(code)}</span>
      </div>`,
    ctaUrl: magicLink,
    ctaLabel: 'Or Click to Sign In Instantly →',
    footerText: 'This code expires in 10 minutes and is invalidated after 5 failed attempts. If you did not request this, you can safely ignore this email.'
  });

  return dispatchEmail(env, { to: email, subject, text, html });
}

export async function sendRsvpConfirmation(env, origin, { email, name, event, dutyName, gearBringing, playersCount, spectatorsCount, guestNames, managementToken }) {
  const appName = (env && env.APP_NAME) || 'Sunday Pickup Baseball';
  const manageLink = `${origin}/event.html?id=${event.id}&token=${encodeURIComponent(managementToken || '')}`;
  const dateFormatted = formatEmailEventDate(event.event_date);

  const pCount = playersCount !== undefined ? Number(playersCount) : 1;
  const sCount = Number(spectatorsCount) || 0;
  const groupParts = [];
  if (pCount > 0) groupParts.push(`${pCount} ${pCount === 1 ? 'player' : 'players'}`);
  if (sCount > 0) groupParts.push(`${sCount} ${pCount === 0 && dutyName ? (sCount === 1 ? 'volunteer' : 'volunteers/spectators') : (sCount === 1 ? 'spectator' : 'spectators')}`);
  const groupSummary = groupParts.join(', ') || '1 attendee';
  const safeLocationUrl = sanitizeHttpUrl(event.location_url);

  const subject = pCount > 0
    ? `Confirmed: You're in for ${event.title} (${dateFormatted})`
    : `Confirmed: RSVP for ${event.title} (${dateFormatted})`;
  const text = `Hi ${name},\n\nYour group RSVP is confirmed for pickup baseball!\n\nEvent: ${event.title}\nDate & Time: ${dateFormatted}\nLocation: ${event.location}\nYour Group: ${groupSummary}${guestNames ? ` (${guestNames})` : ''}\n${dutyName ? `Group Task(s): ${dutyName}\n` : ''}${gearBringing ? `Shared Gear: ${gearBringing}\n` : ''}\nVisit the event page here:\n${manageLink}\n\nSee you at the field!\n- ${appName}`;

  const html = renderEmailLayout({
    origin,
    topColor: '#FD5A1E',
    headingHtml: 'RSVP Confirmed!',
    bodyHtml: `
      <p style="color: #0c1f1a; font-size: 16px;">Hi <strong>${escapeHtml(name)}</strong>,</p>
      <p style="color: #546e66; font-size: 15px;">Your group RSVP is confirmed for <strong>${escapeHtml(event.title)}</strong>.</p>
      <div style="background: #f5f8f7; border-left: 4px solid #003831; border: 1px solid #dbe4e0; padding: 18px; margin: 20px 0; border-radius: 6px;">
        <p style="margin: 4px 0; color: #0c1f1a;"><strong>📅 When:</strong> ${escapeHtml(dateFormatted)}</p>
        <p style="margin: 4px 0; color: #0c1f1a;"><strong>📍 Where:</strong> ${escapeHtml(event.location)}</p>
        <p style="margin: 4px 0; color: #003831;"><strong>👥 Your Group:</strong> ${escapeHtml(groupSummary)}${guestNames ? ` <em>(${escapeHtml(guestNames)})</em>` : ''}</p>
        ${safeLocationUrl ? `<p style="margin: 4px 0;"><a href="${escapeHtml(safeLocationUrl)}" target="_blank" rel="noopener noreferrer" style="color: #FD5A1E; font-weight: 700;">View Map / Directions ↗</a></p>` : ''}
        ${dutyName ? `<p style="margin: 6px 0 4px 0; color: #003831;"><strong>🛡️ Group Task(s):</strong> <span style="background: #e6f0ed; padding: 2px 8px; border-radius: 4px; font-weight: 700;">${escapeHtml(dutyName)}</span></p>` : ''}
        ${gearBringing ? `<p style="margin: 4px 0; color: #0c1f1a;"><strong>🎒 Shared Gear:</strong> <em>${escapeHtml(gearBringing)}</em></p>` : ''}
      </div>`,
    ctaUrl: manageLink,
    ctaLabel: 'View Live Roster & Update RSVP →',
    footerText: 'Plans changed? Use the button above to update your group count, tasks, or cancel your RSVP.'
  });

  return dispatchEmail(env, { to: email, subject, text, html });
}

export async function sendWaitlistConfirmation(env, origin, { email, name, event, waitlistPosition, playersCount, spectatorsCount, managementToken }) {
  const appName = (env && env.APP_NAME) || 'Sunday Pickup Baseball';
  const manageLink = `${origin}/event.html?id=${event.id}&token=${encodeURIComponent(managementToken || '')}`;
  const dateFormatted = formatEmailEventDate(event.event_date);
  const pCount = playersCount !== undefined ? Number(playersCount) : 1;
  const sCount = Number(spectatorsCount) || 0;

  const subject = `⏳ Waitlist Confirmed: ${event.title} (Position #${waitlistPosition})`;
  const text = `Hi ${name},\n\nThe active playing roster for ${event.title} is currently full at ${event.max_players || 'maximum'} players.\n\nYou are on the waitlist at position #${waitlistPosition}${pCount > 1 ? ` with ${pCount} players` : ''}${sCount > 0 ? ` (+ ${sCount} ${sCount === 1 ? 'spectator' : 'spectators'})` : ''}.\n\nIf active roster spots open up, you will be automatically promoted to the playing roster and notified immediately by email!\n\nCheck your waitlist status here:\n${manageLink}\n\n- ${appName}`;

  const html = renderEmailLayout({
    origin,
    showLogo: false,
    headingHtml: '⏳ Waitlist Confirmed',
    bodyHtml: `
      <p style="color: #0c1f1a; font-size: 16px;">Hi <strong>${escapeHtml(name)}</strong>,</p>
      <p style="color: #546e66; font-size: 15px;">The playing roster for <strong>${escapeHtml(event.title)}</strong> is currently full. Your group has been placed on the waitlist.</p>
      <div style="background: #f5f8f7; border-left: 4px solid #FD5A1E; border: 1px solid #dbe4e0; padding: 18px; margin: 20px 0; border-radius: 6px;">
        <p style="margin: 4px 0; color: #003831; font-size: 17px;"><strong>Your Waitlist Position:</strong> <span style="background: #FD5A1E; color: #fff; padding: 3px 10px; border-radius: 20px; font-weight: 700;">#${Number(waitlistPosition) || 1}</span></p>
        ${(pCount > 1 || sCount > 0) ? `<p style="margin: 6px 0 4px 0; color: #0c1f1a;"><strong>👥 Your Group:</strong> ${pCount} ${pCount === 1 ? 'player' : 'players'}${sCount > 0 ? `, ${sCount} ${sCount === 1 ? 'spectator' : 'spectators'}` : ''}</p>` : ''}
        <p style="margin: 8px 0 4px 0; color: #0c1f1a;"><strong>📅 Game Date:</strong> ${escapeHtml(dateFormatted)}</p>
        <p style="margin: 4px 0; color: #0c1f1a;"><strong>📍 Location:</strong> ${escapeHtml(event.location)}</p>
      </div>`,
    ctaUrl: manageLink,
    ctaLabel: 'Check Waitlist Status & Event Page →',
    ctaColor: '#003831'
  });

  return dispatchEmail(env, { to: email, subject, text, html });
}

export async function sendWaitlistPromotionEmail(env, origin, { email, name, event, managementToken }) {
  const appName = (env && env.APP_NAME) || 'Sunday Pickup Baseball';
  const manageLink = `${origin}/event.html?id=${event.id}&token=${encodeURIComponent(managementToken || '')}`;
  const dateFormatted = formatEmailEventDate(event.event_date);

  const subject = `⚾ A spot opened up! You're in for ${event.title} (${dateFormatted})`;
  const text = `Hi ${name},\n\nGreat news! A spot just opened up for pickup baseball!\n\nYou have been automatically promoted from the waitlist to the ACTIVE ROSTER for:\n${event.title}\n\nDate & Time: ${dateFormatted}\nLocation: ${event.location}\n\nVisit the event page to coordinate gear, sign up for tasks, or view the roster:\n${manageLink}\n\nSee you on the field!\n- ${appName}`;

  const html = renderEmailLayout({
    origin,
    showLogo: false,
    headingHtml: "⚾ You're Off the Waitlist — You're In!",
    bodyHtml: `
      <p style="color: #0c1f1a; font-size: 16px;">Hi <strong>${escapeHtml(name)}</strong>,</p>
      <p style="color: #546e66; font-size: 15px;">A spot just opened up! You have been <strong>automatically promoted from the waitlist to the confirmed roster</strong> for <strong>${escapeHtml(event.title)}</strong>.</p>
      <div style="background: #f5f8f7; border-left: 4px solid #003831; border: 1px solid #dbe4e0; padding: 18px; margin: 20px 0; border-radius: 6px;">
        <p style="margin: 4px 0; color: #0c1f1a;"><strong>📅 When:</strong> ${escapeHtml(dateFormatted)}</p>
        <p style="margin: 4px 0; color: #0c1f1a;"><strong>📍 Where:</strong> ${escapeHtml(event.location)}</p>
        <p style="margin: 6px 0 0 0; color: #003831; font-weight: 700;">Status: Confirmed Roster</p>
      </div>`,
    ctaUrl: manageLink,
    ctaLabel: 'View Roster & Claim Group Tasks →'
  });

  return dispatchEmail(env, { to: email, subject, text, html });
}

export async function sendEventReminder(env, origin, { email, name, event, dutyName, gearBringing, totalAttendees, managementToken }) {
  const appName = (env && env.APP_NAME) || 'Sunday Pickup Baseball';
  const manageLink = `${origin}/event.html?id=${event.id}&token=${encodeURIComponent(managementToken || '')}`;
  const dateFormatted = formatEmailEventDate(event.event_date);
  const safeLocationUrl = sanitizeHttpUrl(event.location_url);

  const subject = `Game Reminder: ${event.title} is coming up! (${dateFormatted})`;
  const text = `Hi ${name},\n\nThis is a reminder that you're signed up for pickup baseball:\n\nEvent: ${event.title}\nDate & Time: ${dateFormatted}\nLocation: ${event.location}\n${dutyName ? `Your Assigned Task: ${dutyName}\n` : ''}${gearBringing ? `Gear You're Bringing: ${gearBringing}\n` : ''}Total Players Confirmed: ${totalAttendees}\n\nView details & live roster:\n${manageLink}\n\nSee you on the diamond!\n- ${appName}`;

  const html = renderEmailLayout({
    origin,
    headingHtml: 'Game Day Reminder',
    bodyHtml: `
      <p style="color: #0c1f1a; font-size: 16px;">Hi <strong>${escapeHtml(name)}</strong>,</p>
      <p style="color: #546e66; font-size: 15px;">Get ready! <strong>${escapeHtml(event.title)}</strong> is coming up soon.</p>
      <div style="background: #f5f8f7; border-left: 4px solid #003831; border: 1px solid #dbe4e0; padding: 18px; margin: 20px 0; border-radius: 6px;">
        <p style="margin: 4px 0; color: #0c1f1a;"><strong>📅 When:</strong> ${escapeHtml(dateFormatted)}</p>
        <p style="margin: 4px 0; color: #0c1f1a;"><strong>📍 Where:</strong> ${escapeHtml(event.location)}</p>
        <p style="margin: 4px 0; color: #0c1f1a;"><strong>👥 Confirmed Players:</strong> ${Number(totalAttendees) || 0}</p>
        ${safeLocationUrl ? `<p style="margin: 4px 0;"><a href="${escapeHtml(safeLocationUrl)}" target="_blank" rel="noopener noreferrer" style="color: #FD5A1E; font-weight: 700;">View Map / Directions ↗</a></p>` : ''}
        ${dutyName ? `<p style="margin: 6px 0 4px 0; color: #003831;"><strong>🛡️ Your Task:</strong> <span style="background: #e6f0ed; padding: 2px 8px; border-radius: 4px; font-weight: 700;">${escapeHtml(dutyName)}</span></p>` : ''}
        ${gearBringing ? `<p style="margin: 4px 0; color: #0c1f1a;"><strong>🎒 Gear You're Bringing:</strong> <em>${escapeHtml(gearBringing)}</em></p>` : ''}
      </div>`,
    ctaUrl: manageLink,
    ctaLabel: 'Check Game Discussion & Roster →',
    ctaColor: '#003831'
  });

  return dispatchEmail(env, { to: email, subject, text, html });
}

export async function sendRainoutEmail(env, origin, { email, name, event, note, managementToken }) {
  const appName = (env && env.APP_NAME) || 'Sunday Pickup Baseball';
  const manageLink = `${origin}/event.html?id=${event.id}&token=${encodeURIComponent(managementToken || '')}`;
  const dateFormatted = formatEmailEventDate(event.event_date);

  const subject = `🌧️ Sunday Pickup Baseball Rained Out: ${event.title}`;
  const text = `Hi ${name},\n\nToday's pickup baseball game has been called due to rain and field conditions.\n\nEvent: ${event.title}\nOriginally Scheduled: ${dateFormatted}\nLocation: ${event.location}\n${note ? `Organizer Note:\n"${note}"\n\n` : ''}Any volunteer task or equipment commitments you made for today are excused.\n\nThe discussion board on the event page remains open:\n${manageLink}\n\nStay dry, and see you on the field next Sunday!\n- ${appName}`;

  const html = renderEmailLayout({
    origin,
    topColor: '#0284c7',
    borderColor: '#cbd5e1',
    headingColor: '#0f172a',
    headingHtml: '🌧️ Game Called Due to Rain',
    bodyHtml: `
      <p style="color: #0c1f1a; font-size: 16px;">Hi <strong>${escapeHtml(name)}</strong>,</p>
      <p style="color: #475569; font-size: 15px;">Today's pickup baseball game (<strong>${escapeHtml(event.title)}</strong>) has been called due to rain and wet field conditions.</p>
      ${note ? `<div style="background: #f1f5f9; border-left: 4px solid #0284c7; padding: 14px 18px; margin: 18px 0; border-radius: 6px;"><strong style="color: #0f172a; display: block; font-size: 13px; text-transform: uppercase; margin-bottom: 4px;">Organizer Note:</strong><p style="margin: 0; color: #334155; font-size: 15px; font-style: italic;">"${escapeHtml(note)}"</p></div>` : ''}
      <div style="background: #f8fafc; border: 1px solid #e2e8f0; padding: 16px; margin: 18px 0; border-radius: 6px;">
        <p style="margin: 3px 0; color: #64748b; font-size: 14px;"><strong>📅 Scheduled:</strong> ${escapeHtml(dateFormatted)}</p>
        <p style="margin: 3px 0; color: #64748b; font-size: 14px;"><strong>📍 Field:</strong> ${escapeHtml(event.location)}</p>
        <p style="margin: 6px 0 0; color: #0284c7; font-weight: 600; font-size: 14px;">✓ Your task and equipment commitments are excused for today.</p>
      </div>`,
    ctaUrl: manageLink,
    ctaLabel: 'Open Event Discussion Board →',
    ctaColor: '#0f172a',
    footerText: 'The discussion board is still active if you want to chat with teammates, coordinate batting cages, or catch up before next Sunday.'
  });

  return dispatchEmail(env, { to: email, subject, text, html });
}

export async function sendReopenEmail(env, origin, { email, name, event, note, managementToken }) {
  const appName = (env && env.APP_NAME) || 'Sunday Pickup Baseball';
  const manageLink = `${origin}/event.html?id=${event.id}&token=${encodeURIComponent(managementToken || '')}`;
  const dateFormatted = formatEmailEventDate(event.event_date);

  const subject = `⚾ Game is BACK ON! Sunday Pickup Baseball: ${event.title}`;
  const text = `Hi ${name},\n\nGreat news! The field or weather conditions have cleared up and today's pickup baseball game is BACK ON!\n\nEvent: ${event.title}\nWhen: ${dateFormatted}\nWhere: ${event.location}\n${note ? `Organizer Note:\n"${note}"\n\n` : ''}Your roster spot is active. Grab your gear and see you on the field!\n\nCheck the live roster & event page:\n${manageLink}\n\nPlay ball!\n- ${appName}`;

  const html = renderEmailLayout({
    origin,
    topColor: '#FD5A1E',
    headingHtml: '⚾ Game is BACK ON!',
    bodyHtml: `
      <p style="color: #0c1f1a; font-size: 16px;">Hi <strong>${escapeHtml(name)}</strong>,</p>
      <p style="color: #546e66; font-size: 15px;">Great news! Weather or field conditions have cleared up and today's game (<strong>${escapeHtml(event.title)}</strong>) is officially BACK ON!</p>
      ${note ? `<div style="background: #fff7ed; border-left: 4px solid #FD5A1E; padding: 14px 18px; margin: 18px 0; border-radius: 6px;"><strong style="color: #9a3412; display: block; font-size: 13px; text-transform: uppercase; margin-bottom: 4px;">Organizer Note:</strong><p style="margin: 0; color: #7c2d12; font-size: 15px; font-style: italic;">"${escapeHtml(note)}"</p></div>` : ''}
      <div style="background: #f5f8f7; border-left: 4px solid #003831; border: 1px solid #dbe4e0; padding: 16px; margin: 18px 0; border-radius: 6px;">
        <p style="margin: 3px 0; color: #0c1f1a; font-size: 14px;"><strong>📅 When:</strong> ${escapeHtml(dateFormatted)}</p>
        <p style="margin: 3px 0; color: #0c1f1a; font-size: 14px;"><strong>📍 Where:</strong> ${escapeHtml(event.location)}</p>
        <p style="margin: 6px 0 0; color: #003831; font-weight: 700; font-size: 14px;">✓ Your roster spot is active. Grab your glove and head out!</p>
      </div>`,
    ctaUrl: manageLink,
    ctaLabel: 'Check Live Roster & Tasks →'
  });

  return dispatchEmail(env, { to: email, subject, text, html });
}
