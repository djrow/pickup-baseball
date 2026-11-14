/**
 * RSS 2.0 + Media RSS Feed Builder & Live iCalendar (.ics) Schedule Builder
 */

import { CURRENT_APP_VERSION } from './version.js';
import { parseAllowedEmails, canUserAccessEvent } from './policy.js';
import { sanitizeHttpUrl, getSafePublicOrigin } from './security.js';

function getSafeFeedMediaUrl(rawUrl, origin) {
  if (!rawUrl) return '';
  const trimmed = String(rawUrl).trim();
  if (trimmed.startsWith('/') && !trimmed.startsWith('//') && !trimmed.startsWith('/\\')) {
    return `${origin}${trimmed}`;
  }
  return sanitizeHttpUrl(trimmed) || '';
}

export function parseMediaType(url, explicitType) {
  if (explicitType && explicitType !== 'auto') return explicitType;
  if (!url) return 'none';
  const u = String(url).trim();
  if (/youtube\.com\/watch\?|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\//i.test(u)) return 'youtube';
  if (/\.(jpeg|jpg|png|webp|gif|svg)(\?.*)?$/i.test(u) || /imgur\.com\//i.test(u)) return 'image';
  if (/\.(mp4|webm|mov)(\?.*)?$/i.test(u)) return 'video';
  if (/\.(mp3|wav|ogg|m4a)(\?.*)?$/i.test(u)) return 'audio';
  return 'link';
}

export function getYouTubeId(url) {
  if (!url) return null;
  const match = String(url).match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=|shorts\/))([\w-]{11})/i);
  return match ? match[1] : null;
}

function escapeCdata(str) {
  return String(str || '').replace(/]]>/g, ']]]]><![CDATA[>');
}

function escapeXml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function formatRfc822Date(dateInput) {
  const d = new Date(dateInput);
  return isNaN(d.getTime()) ? new Date().toUTCString() : d.toUTCString();
}

export function buildRssFeedXml(posts, origin = 'https://www.pickupbaseballfoundation.org') {
  const nowRfc822 = new Date().toUTCString();
  const feedSelfUrl = `${origin}/feed.xml`;

  let itemsXml = '';
  for (const post of posts) {
    const postUrl = `${origin}/index.html#post-${post.id}`;
    const guid = `pickup-baseball-post-${post.id}@pickupbaseballfoundation.org`;
    const pubDate = formatRfc822Date(post.created_at);
    const mType = post.media_type || parseMediaType(post.media_url);
    const mUrl = getSafeFeedMediaUrl(post.media_url, origin);

    let mediaTags = '';
    let richHtmlDesc = `<p>${escapeXml(post.content).replace(/\n/g, '<br/>')}</p>`;

    if (mUrl) {
      if (mType === 'youtube') {
        const ytId = getYouTubeId(mUrl);
        if (ytId) {
          const embedUrl = `https://www.youtube-nocookie.com/embed/${ytId}`;
          const thumbUrl = `https://img.youtube.com/vi/${ytId}/hqdefault.jpg`;
          mediaTags = `
      <media:content url="https://www.youtube.com/watch?v=${ytId}" medium="video">
        <media:player url="${embedUrl}" />
        <media:thumbnail url="${thumbUrl}" />
      </media:content>`;
          richHtmlDesc = `<p><a href="${escapeXml(mUrl)}" target="_blank" rel="noopener noreferrer"><img src="${thumbUrl}" alt="${escapeXml(post.title)}" style="max-width:100%;border-radius:8px;" /><br/>▶ Watch on YouTube</a></p>` + richHtmlDesc;
        }
      } else if (mType === 'image') {
        mediaTags = `
      <media:content url="${escapeXml(mUrl)}" medium="image" />
      <enclosure url="${escapeXml(mUrl)}" type="image/jpeg" length="0" />`;
        richHtmlDesc = `<p><img src="${escapeXml(mUrl)}" alt="${escapeXml(post.title)}" style="max-width:100%;border-radius:8px;" /></p>` + richHtmlDesc;
      } else if (mType === 'video') {
        mediaTags = `
      <media:content url="${escapeXml(mUrl)}" medium="video" />
      <enclosure url="${escapeXml(mUrl)}" type="video/mp4" length="0" />`;
        richHtmlDesc = `<p><a href="${escapeXml(mUrl)}">▶ Watch Video Clip</a></p>` + richHtmlDesc;
      } else if (mType === 'audio') {
        mediaTags = `
      <media:content url="${escapeXml(mUrl)}" medium="audio" />
      <enclosure url="${escapeXml(mUrl)}" type="audio/mpeg" length="0" />`;
        richHtmlDesc = `<p><audio controls src="${escapeXml(mUrl)}"></audio></p>` + richHtmlDesc;
      }
    }

    if (post.event_id && post.event_title) {
      richHtmlDesc += `<p><small>⚾ Game: <a href="${origin}/event.html?id=${post.event_id}">${escapeXml(post.event_title)}</a></small></p>`;
    }

    itemsXml += `
    <item>
      <title><![CDATA[${escapeCdata(post.title)}]]></title>
      <link>${postUrl}</link>
      <guid isPermaLink="false">${guid}</guid>
      <pubDate>${pubDate}</pubDate>
      <author>games@pickupbaseballfoundation.org (${escapeXml(post.author_name || 'Pickup Baseball Foundation')})</author>
      <description><![CDATA[${escapeCdata(richHtmlDesc)}]]></description>
      ${mediaTags}
    </item>`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" 
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:atom="http://www.w3.org/2005/Atom"
  xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <title>Sunday Pickup Baseball — Highlights &amp; Updates</title>
    <link>${origin}</link>
    <description>Community pickup baseball highlights, game recaps, video clips, photos, and announcements from the Pickup Baseball Foundation.</description>
    <language>en-us</language>
    <lastBuildDate>${nowRfc822}</lastBuildDate>
    <atom:link href="${feedSelfUrl}" rel="self" type="application/rss+xml" />
    <image>
      <url>${origin}/logo.svg</url>
      <title>Sunday Pickup Baseball</title>
      <link>${origin}</link>
    </image>${itemsXml}
  </channel>
</rss>
`;
}

export async function renderFeedXmlResponse(db, requestUrl, env = null) {
  try {
    let posts = [];
    if (db) {
      try {
        const { results } = await db.prepare(`
          SELECT p.*, e.title as event_title, e.event_date, e.allowed_emails as event_allowed_emails
          FROM posts p
          LEFT JOIN events e ON p.event_id = e.id
          ORDER BY p.created_at DESC
          LIMIT 50
        `).all();
        posts = (results || []).filter(p => parseAllowedEmails(p.event_allowed_emails).length === 0);
      } catch (e) {
        posts = [];
      }
    }
    const runtimeEnv = env || (typeof process !== 'undefined' && process.env ? process.env : undefined);
    const origin = getSafePublicOrigin({ req: { url: requestUrl }, env: runtimeEnv });
    const xml = buildRssFeedXml(posts, origin);
    return new Response(xml, {
      status: 200,
      headers: {
        'Content-Type': 'application/rss+xml; charset=utf-8',
        'Cache-Control': 'public, max-age=60, s-maxage=300, stale-while-revalidate=600',
        'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
        'X-App-Version': CURRENT_APP_VERSION
      }
    });
  } catch (err) {
    return new Response('Failed to generate RSS feed.', {
      status: 500,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Content-Type-Options': 'nosniff'
      }
    });
  }
}

function escapeIcsText(str) {
  return String(str || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

function formatIcsUtcDate(d) {
  const pad = n => String(n).padStart(2, '0');
  return d.getUTCFullYear() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) + 'T' +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) + 'Z';
}

export function buildCalendarIcs(allEvents, origin = 'https://www.pickupbaseballfoundation.org', options = {}) {
  const viewerUser = (options && options.viewerUser) ? options.viewerUser : null;
  const visibleEvents = (allEvents || []).filter(ev => canUserAccessEvent(viewerUser, ev));
  const nowStamp = formatIcsUtcDate(new Date());
  const defaultCalName = viewerUser ? 'Sunday Pickup Baseball (Personal Feed)' : 'Sunday Pickup Baseball';
  const calendarName = (options && options.calendarName) ? String(options.calendarName) : defaultCalName;
  const calendarDesc = (options && options.calendarDesc)
    ? String(options.calendarDesc)
    : 'Live game schedule from Pickup Baseball Foundation (www.pickupbaseballfoundation.org)';

  const icsLines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Pickup Baseball Foundation//NONSGML Pickup Baseball Calendar//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeIcsText(calendarName)}`,
    `X-WR-CALDESC:${escapeIcsText(calendarDesc)}`,
    'X-WR-TIMEZONE:America/Los_Angeles',
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H'
  ];

  for (const ev of visibleEvents) {
    const startDate = new Date(ev.event_date);
    if (isNaN(startDate.getTime())) continue;
    const endDate = new Date(startDate.getTime() + 3 * 60 * 60 * 1000);
    const isRainout = ev.status === 'rainout';
    const baseTitle = ev.title || 'Sunday Pickup Baseball - Noon Game';
    const summary = isRainout ? `🌧️ RAINED OUT: ${baseTitle}` : baseTitle;
    const eventUrl = `${origin}/event.html?id=${ev.id}`;
    const descParts = [
      isRainout
        ? (ev.rainout_note ? `RAINED OUT — "${ev.rainout_note}"` : 'RAINED OUT — Check event page for field updates.')
        : 'Free community pickup baseball. Check live roster, coordinate gear & volunteer for tasks:',
      eventUrl
    ];
    if (ev.description && ev.description.trim()) {
      descParts.push(ev.description.trim());
    }

    icsLines.push(
      'BEGIN:VEVENT',
      `UID:pickup-baseball-event-${ev.id}@pickupbaseballfoundation.org`,
      `DTSTAMP:${nowStamp}`,
      `DTSTART:${formatIcsUtcDate(startDate)}`,
      `DTEND:${formatIcsUtcDate(endDate)}`,
      `SUMMARY:${escapeIcsText(summary)}`,
      `LOCATION:${escapeIcsText(ev.location || 'Bushrod Park Field 1, Oakland, CA')}`,
      `DESCRIPTION:${escapeIcsText(descParts.join('\n\n'))}`,
      `URL:${eventUrl}`,
      'STATUS:CONFIRMED',
      'END:VEVENT'
    );
  }

  icsLines.push('END:VCALENDAR');
  return icsLines.join('\r\n') + '\r\n';
}
