/**
 * Email template layouts and renderers.
 * Consolidates HTML/Text templates via a shared email card layout helper.
 */

import { escapeHtml, sanitizeHttpUrl } from '../security.js';
import { resolveConfig, PRESET_PICKUP_BASEBALL } from '../config.js';

export function formatEmailEventDate(dateStr) {
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

export function renderEmailLayout({
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

export function buildAuthCodeEmail(env, origin, { email, name, code, token, sharedDevice = false }) {
  const cfg = resolveConfig(env);
  const appName = cfg.COMMUNITY_NAME;
  const magicLink = `${origin}/api/auth/verify-magic?token=${encodeURIComponent(token)}`;
  const subject = `Your Sign-In Code for ${appName}: ${code}`;
  const sharedNote = sharedDevice
    ? '\n\nNote: Shared-device temporary mode was selected — this session will automatically expire when the browser closes or after 4 hours.'
    : '';
  const sharedHtmlNote = sharedDevice
    ? '<p style="color: #9a3412; background: #fff7ed; border: 1px solid #fed7aa; padding: 10px 12px; border-radius: 6px; font-size: 13px; margin: 14px 0 0;">Shared-device temporary sign-in selected: expires when the browser closes or after 4 hours.</p>'
    : '';
  const signOff = cfg.COMMUNITY_PRESET === PRESET_PICKUP_BASEBALL ? 'Play ball!' : 'Thanks!';
  const text = `Hi ${name || 'there'},\n\nWelcome to ${appName}!\n\nYour 6-digit sign-in code is: ${code}\n\nOr click the link below to sign in automatically:\n${magicLink}${sharedNote}\n\nThis code and link will expire in 10 minutes.\n\n${signOff}\n- ${appName} Team`;

  const html = renderEmailLayout({
    origin,
    topColor: '#003831',
    headingHtml: escapeHtml(appName),
    bodyHtml: `
      <p style="color: #0c1f1a; font-size: 16px;">Hi <strong>${escapeHtml(name || 'there')}</strong>,</p>
      <p style="color: #546e66; font-size: 15px;">Use the code below to sign in to your account:</p>
      <div style="background: #f5f8f7; border: 1px solid #dbe4e0; padding: 18px; border-radius: 8px; text-align: center; margin: 24px 0;">
        <span style="font-size: 34px; font-weight: 800; letter-spacing: 6px; color: #003831;">${escapeHtml(code)}</span>
      </div>
      ${sharedHtmlNote}`,
    ctaUrl: magicLink,
    ctaLabel: 'Or Click to Sign In Instantly →',
    footerText: 'This code expires in 10 minutes and is invalidated after 5 failed attempts. If you did not request this, you can safely ignore this email.'
  });

  return { to: email, subject, text, html, priority: 'auth' };
}

export function buildRsvpConfirmationEmail(env, origin, { email, name, event, dutyName, gearBringing, playersCount, spectatorsCount, guestNames, managementToken }) {
  const appName = resolveConfig(env).COMMUNITY_NAME;
  const manageLink = managementToken
    ? `${origin}/event.html?id=${event.id}&token=${encodeURIComponent(managementToken)}`
    : `${origin}/event.html?id=${event.id}`;
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

  return { to: email, subject, text, html, priority: 'rsvp_confirm' };
}

export function buildWaitlistConfirmationEmail(env, origin, { email, name, event, waitlistPosition, playersCount, spectatorsCount, managementToken }) {
  const appName = resolveConfig(env).COMMUNITY_NAME;
  const manageLink = managementToken
    ? `${origin}/event.html?id=${event.id}&token=${encodeURIComponent(managementToken)}`
    : `${origin}/event.html?id=${event.id}`;
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

  return { to: email, subject, text, html, priority: 'waitlist' };
}

export function buildWaitlistPromotionEmail(env, origin, { email, name, event }) {
  const appName = resolveConfig(env).COMMUNITY_NAME;
  const eventLink = `${origin}/event.html?id=${event.id}`;
  const dateFormatted = formatEmailEventDate(event.event_date);

  const subject = `⚾ A spot opened up! You're in for ${event.title} (${dateFormatted})`;
  const text = `Hi ${name},\n\nGreat news! A spot just opened up for pickup baseball!\n\nYou have been automatically promoted from the waitlist to the ACTIVE ROSTER for:\n${event.title}\n\nDate & Time: ${dateFormatted}\nLocation: ${event.location}\n\nVisit the event page to coordinate gear, sign up for tasks, or view the roster:\n${eventLink}\n\nSee you on the field!\n- ${appName}`;

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
    ctaUrl: eventLink,
    ctaLabel: 'View Roster & Claim Group Tasks →'
  });

  return { to: email, subject, text, html, priority: 'waitlist' };
}

export function buildEventReminderEmail(env, origin, { email, name, event, dutyName, gearBringing, totalAttendees }) {
  const appName = resolveConfig(env).COMMUNITY_NAME;
  const eventLink = `${origin}/event.html?id=${event.id}`;
  const dateFormatted = formatEmailEventDate(event.event_date);
  const safeLocationUrl = sanitizeHttpUrl(event.location_url);

  const subject = `Game Reminder: ${event.title} is coming up! (${dateFormatted})`;
  const text = `Hi ${name},\n\nThis is a reminder that you're signed up for pickup baseball:\n\nEvent: ${event.title}\nDate & Time: ${dateFormatted}\nLocation: ${event.location}\n${dutyName ? `Your Assigned Task: ${dutyName}\n` : ''}${gearBringing ? `Gear You're Bringing: ${gearBringing}\n` : ''}Total Players Confirmed: ${totalAttendees}\n\nView details & live roster:\n${eventLink}\n\nSee you on the diamond!\n- ${appName}`;

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
    ctaUrl: eventLink,
    ctaLabel: 'Check Game Discussion & Roster →',
    ctaColor: '#003831'
  });

  return { to: email, subject, text, html, priority: 'reminder' };
}

export function buildRainoutEmail(env, origin, { email, name, event, note }) {
  const appName = resolveConfig(env).COMMUNITY_NAME;
  const eventLink = `${origin}/event.html?id=${event.id}`;
  const dateFormatted = formatEmailEventDate(event.event_date);

  const subject = `🌧️ ${appName} Rained Out: ${event.title}`;
  const text = `Hi ${name},\n\nThe pickup baseball game scheduled for ${dateFormatted} (${event.title}) has been called due to rain and field conditions.\n\nEvent: ${event.title}\nOriginally Scheduled: ${dateFormatted}\nLocation: ${event.location}\n${note ? `Organizer Note:\n"${note}"\n\n` : ''}Any volunteer task or equipment commitments you made for this game are excused.\n\nThe discussion board on the event page remains open:\n${eventLink}\n\nStay dry, and see you on the field next Sunday!\n- ${appName}`;

  const html = renderEmailLayout({
    origin,
    topColor: '#0284c7',
    borderColor: '#cbd5e1',
    headingColor: '#0f172a',
    headingHtml: '🌧️ Game Called Due to Rain',
    bodyHtml: `
      <p style="color: #0c1f1a; font-size: 16px;">Hi <strong>${escapeHtml(name)}</strong>,</p>
      <p style="color: #475569; font-size: 15px;">The pickup baseball game scheduled for <strong>${escapeHtml(dateFormatted)}</strong> (<strong>${escapeHtml(event.title)}</strong>) has been called due to rain and wet field conditions.</p>
      ${note ? `<div style="background: #f1f5f9; border-left: 4px solid #0284c7; padding: 14px 18px; margin: 18px 0; border-radius: 6px;"><strong style="color: #0f172a; display: block; font-size: 13px; text-transform: uppercase; margin-bottom: 4px;">Organizer Note:</strong><p style="margin: 0; color: #334155; font-size: 15px; font-style: italic;">"${escapeHtml(note)}"</p></div>` : ''}
      <div style="background: #f8fafc; border: 1px solid #e2e8f0; padding: 16px; margin: 18px 0; border-radius: 6px;">
        <p style="margin: 3px 0; color: #64748b; font-size: 14px;"><strong>📅 Scheduled:</strong> ${escapeHtml(dateFormatted)}</p>
        <p style="margin: 3px 0; color: #64748b; font-size: 14px;"><strong>📍 Field:</strong> ${escapeHtml(event.location)}</p>
        <p style="margin: 6px 0 0; color: #0284c7; font-weight: 600; font-size: 14px;">✓ Your task and equipment commitments are excused for this game.</p>
      </div>`,
    ctaUrl: eventLink,
    ctaLabel: 'Open Event Discussion Board →',
    ctaColor: '#0f172a',
    footerText: 'The discussion board is still active if you want to chat with teammates, coordinate batting cages, or catch up before next Sunday.'
  });

  return { to: email, subject, text, html, priority: 'rainout_reopen' };
}

export function buildReopenEmail(env, origin, { email, name, event, note }) {
  const appName = resolveConfig(env).COMMUNITY_NAME;
  const eventLink = `${origin}/event.html?id=${event.id}`;
  const dateFormatted = formatEmailEventDate(event.event_date);

  const subject = `⚾ Game is BACK ON! ${appName}: ${event.title}`;
  const text = `Hi ${name},\n\nGreat news! The field or weather conditions have cleared up and the pickup baseball game scheduled for ${dateFormatted} (${event.title}) is BACK ON!\n\nEvent: ${event.title}\nWhen: ${dateFormatted}\nWhere: ${event.location}\n${note ? `Organizer Note:\n"${note}"\n\n` : ''}Your roster spot is active. Grab your gear and see you on the field!\n\nCheck the live roster & event page:\n${eventLink}\n\nPlay ball!\n- ${appName}`;

  const html = renderEmailLayout({
    origin,
    topColor: '#FD5A1E',
    headingHtml: '⚾ Game is BACK ON!',
    bodyHtml: `
      <p style="color: #0c1f1a; font-size: 16px;">Hi <strong>${escapeHtml(name)}</strong>,</p>
      <p style="color: #546e66; font-size: 15px;">Great news! Weather or field conditions have cleared up and the pickup baseball game scheduled for <strong>${escapeHtml(dateFormatted)}</strong> (<strong>${escapeHtml(event.title)}</strong>) is officially BACK ON!</p>
      ${note ? `<div style="background: #fff7ed; border-left: 4px solid #FD5A1E; padding: 14px 18px; margin: 18px 0; border-radius: 6px;"><strong style="color: #9a3412; display: block; font-size: 13px; text-transform: uppercase; margin-bottom: 4px;">Organizer Note:</strong><p style="margin: 0; color: #7c2d12; font-size: 15px; font-style: italic;">"${escapeHtml(note)}"</p></div>` : ''}
      <div style="background: #f5f8f7; border-left: 4px solid #003831; border: 1px solid #dbe4e0; padding: 16px; margin: 18px 0; border-radius: 6px;">
        <p style="margin: 3px 0; color: #0c1f1a; font-size: 14px;"><strong>📅 When:</strong> ${escapeHtml(dateFormatted)}</p>
        <p style="margin: 3px 0; color: #0c1f1a; font-size: 14px;"><strong>📍 Where:</strong> ${escapeHtml(event.location)}</p>
        <p style="margin: 6px 0 0; color: #003831; font-weight: 700; font-size: 14px;">✓ Your roster spot is active. Grab your glove and head out!</p>
      </div>`,
    ctaUrl: eventLink,
    ctaLabel: 'Check Live Roster & Tasks →'
  });

  return { to: email, subject, text, html, priority: 'rainout_reopen' };
}

export function buildRsvpEditLinkEmail(env, origin, { email, name, event, managementToken }) {
  const appName = resolveConfig(env).COMMUNITY_NAME;
  const manageLink = `${origin}/event.html?id=${event.id}&token=${encodeURIComponent(managementToken || '')}`;
  const dateFormatted = formatEmailEventDate(event.event_date);

  const subject = `Your Fresh RSVP Edit Link: ${event.title}`;
  const text = `Hi ${name || 'there'},\n\nYou requested a fresh link to manage your RSVP for ${event.title} (${dateFormatted} at ${event.location}).\n\nUse this link to update or cancel your RSVP (any previous edit links have been deactivated):\n${manageLink}\n\nIf you did not request this link, you can safely ignore this email.\n\n- ${appName}`;

  const html = renderEmailLayout({
    origin,
    topColor: '#003831',
    headingHtml: '🔗 Fresh RSVP Edit Link',
    bodyHtml: `
      <p style="color: #0c1f1a; font-size: 16px;">Hi <strong>${escapeHtml(name || 'there')}</strong>,</p>
      <p style="color: #546e66; font-size: 15px;">Use the button below to manage your RSVP for <strong>${escapeHtml(event.title)}</strong>.</p>
      <div style="background: #f5f8f7; border-left: 4px solid #003831; border: 1px solid #dbe4e0; padding: 16px; margin: 18px 0; border-radius: 6px;">
        <p style="margin: 3px 0; color: #0c1f1a; font-size: 14px;"><strong>📅 When:</strong> ${escapeHtml(dateFormatted)}</p>
        <p style="margin: 3px 0; color: #0c1f1a; font-size: 14px;"><strong>📍 Where:</strong> ${escapeHtml(event.location)}</p>
      </div>`,
    ctaUrl: manageLink,
    ctaLabel: 'Manage My RSVP →',
    footerText: 'For your security, issuing this link deactivated any older edit link for this RSVP. If you did not request this, you can safely ignore this email.'
  });

  return { to: email, subject, text, html, priority: 'auth' };
}

export function buildWaiverConfirmationEmail(env, origin, { email, printedName, signedDate, certificateId, documentSha256 }) {
  const cfg = resolveConfig(env);
  const appName = cfg.COMMUNITY_NAME;
  const isPickupPreset = cfg.COMMUNITY_PRESET === PRESET_PICKUP_BASEBALL;
  const certUrl = `${origin}/api/waiver/certificate/${encodeURIComponent(certificateId)}?format=html`;

  const subject = `🔏 Signed Waiver Receipt (${certificateId}) - ${appName}`;
  const waiverTitleText = isPickupPreset
    ? 'Pickup Baseball Foundation Consent, Waiver and Indemnity (Form 41335\\14760738.1)'
    : `${appName} Consent, Waiver and Indemnity`;
  const signOff = isPickupPreset ? 'Play ball!' : 'Thank you!';
  const text = `Hi ${printedName},\n\nThank you for signing the ${waiverTitleText}.\n\nCertificate ID: ${certificateId}\nPrinted Name: ${printedName}\nDate Signed: ${signedDate}\nDocument SHA-256 Hash: ${documentSha256}\n\nView or print your signed waiver certificate anytime:\n${certUrl}\n\n${signOff}\n- ${appName}`;

  const formHtmlSuffix = isPickupPreset ? ' (Form <code>41335\\14760738.1</code>)' : '';
  const html = renderEmailLayout({
    origin,
    topColor: '#003831',
    headingHtml: '🔏 Signed Waiver &amp; Provenance Receipt',
    bodyHtml: `
      <p style="color: #0c1f1a; font-size: 16px;">Hi <strong>${escapeHtml(printedName)}</strong>,</p>
      <p style="color: #546e66; font-size: 15px;">Your digital signature for the <strong>${escapeHtml(appName)} Consent, Waiver and Indemnity</strong>${formHtmlSuffix} has been recorded and cryptographically sealed on file.</p>
      <div style="background: #f5f8f7; border-left: 4px solid #003831; border: 1px solid #dbe4e0; padding: 16px; margin: 18px 0; border-radius: 6px;">
        <p style="margin: 3px 0; color: #0c1f1a; font-size: 14px;"><strong>📄 Certificate ID:</strong> <code>${escapeHtml(certificateId)}</code></p>
        <p style="margin: 3px 0; color: #0c1f1a; font-size: 14px;"><strong>✍️ Printed Name:</strong> ${escapeHtml(printedName)}</p>
        <p style="margin: 3px 0; color: #0c1f1a; font-size: 14px;"><strong>📅 Dated:</strong> ${escapeHtml(signedDate)}</p>
        <p style="margin: 6px 0 0; color: #546e66; font-size: 12px; word-break: break-all;"><strong>🔒 SHA-256 Digest:</strong> <code>${escapeHtml(documentSha256)}</code></p>
      </div>`,
    ctaUrl: certUrl,
    ctaLabel: 'View / Print Signed Waiver Certificate →'
  });

  return { to: email, subject, text, html, priority: 'auth' };
}

export function buildErasureVerificationCode(env, origin, { email, name, code }) {
  const cfg = resolveConfig(env);
  const appName = cfg.COMMUNITY_NAME;
  const subject = `Data Erasure Verification Code for ${appName}: ${code}`;
  const text = `Hi ${name || 'there'},\n\nYou requested permanent erasure of your personal data and RSVPs from ${appName}.\n\nYour 6-digit erasure verification code is: ${code}\n\nThis code expires in 10 minutes and is invalidated after 5 failed attempts.\n\nImportant: Confirming this code permanently deletes your profile, consent records, future RSVPs, task assignments, and batting practice slots, and anonymizes past attendance counts and comments. Any signed liability waiver remains sealed in restricted Admin-only legal-defense quarantine for 3 years before permanent deletion.\n\nIf you did not request data erasure, you can safely ignore this email — no data has been deleted.\n\n- ${appName} Team`;

  const html = renderEmailLayout({
    origin,
    topColor: '#b91c1c',
    headingColor: '#991b1b',
    headingHtml: 'Confirm Data Erasure',
    bodyHtml: `
      <p style="color: #0c1f1a; font-size: 16px;">Hi <strong>${escapeHtml(name || 'there')}</strong>,</p>
      <p style="color: #546e66; font-size: 15px;">Enter the 6-digit verification code below to confirm permanent erasure of your personal data and RSVPs from <strong>${escapeHtml(appName)}</strong>:</p>
      <div style="background: #fef2f2; border: 1px solid #fecaca; padding: 18px; border-radius: 8px; text-align: center; margin: 24px 0;">
        <span style="font-size: 34px; font-weight: 800; letter-spacing: 6px; color: #991b1b;">${escapeHtml(code)}</span>
      </div>
      <p style="color: #7f1d1d; background: #fef2f2; border-left: 4px solid #b91c1c; padding: 10px 12px; border-radius: 4px; font-size: 13px; margin: 14px 0 0;">
        <strong>Legal Waiver Retention Notice:</strong> Future RSVPs, tasks, consent records, and any member account are deleted immediately, while past attendance headcounts and comments are anonymized. Any signed liability waiver stays sealed in restricted Admin-only quarantine for 3 years before automatic purge.
      </p>`,
    ctaUrl: '',
    ctaLabel: '',
    footerText: 'This code expires in 10 minutes and is invalidated after 5 failed attempts. If you did not request erasure, ignore this email — no changes have been made.'
  });

  return { to: email, subject, text, html, priority: 'auth' };
}
