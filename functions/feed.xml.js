function parseMediaType(url, explicitType) {
  if (explicitType && explicitType !== 'auto') return explicitType;
  if (!url) return 'none';
  const u = String(url).trim();
  if (/youtube\.com\/watch\?|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\//i.test(u)) {
    return 'youtube';
  }
  if (/\.(jpeg|jpg|png|webp|gif|svg)(\?.*)?$/i.test(u) || /imgur\.com\//i.test(u)) {
    return 'image';
  }
  if (/\.(mp4|webm|mov)(\?.*)?$/i.test(u)) {
    return 'video';
  }
  if (/\.(mp3|wav|ogg|m4a)(\?.*)?$/i.test(u)) {
    return 'audio';
  }
  return 'link';
}

function getYouTubeId(url) {
  if (!url) return null;
  const match = String(url).match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=|shorts\/))([\w-]{11})/i);
  return match ? match[1] : null;
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

function buildRssFeedXml(posts, origin = 'https://www.pickupbaseballfoundation.org') {
  const nowRfc822 = new Date().toUTCString();
  const feedSelfUrl = `${origin}/feed.xml`;

  let itemsXml = '';
  for (const post of posts) {
    const postUrl = `${origin}/index.html#post-${post.id}`;
    const guid = `pickup-baseball-post-${post.id}@pickupbaseballfoundation.org`;
    const pubDate = formatRfc822Date(post.created_at);
    const mType = post.media_type || parseMediaType(post.media_url);
    const mUrl = post.media_url ? String(post.media_url).trim() : '';

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
      <title><![CDATA[${post.title}]]></title>
      <link>${postUrl}</link>
      <guid isPermaLink="false">${guid}</guid>
      <pubDate>${pubDate}</pubDate>
      <author>games@pickupbaseballfoundation.org (${escapeXml(post.author_name || 'Pickup Baseball Foundation')})</author>
      <description><![CDATA[${richHtmlDesc}]]></description>
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

export async function onRequest(context) {
  try {
    let posts = [];
    if (context.env && context.env.DB) {
      try {
        const { results } = await context.env.DB.prepare(`
          SELECT p.*, e.title as event_title, e.event_date
          FROM posts p
          LEFT JOIN events e ON p.event_id = e.id
          ORDER BY p.created_at DESC
          LIMIT 50
        `).all();
        posts = results || [];
      } catch (e) {
        posts = [];
      }
    }

    const origin = new URL(context.request.url).origin || 'https://www.pickupbaseballfoundation.org';
    const xml = buildRssFeedXml(posts, origin);

    return new Response(xml, {
      status: 200,
      headers: {
        'Content-Type': 'application/rss+xml; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'X-Content-Type-Options': 'nosniff',
        'X-App-Version': '31'
      }
    });
  } catch (err) {
    return new Response('Failed to generate RSS feed: ' + (err && err.message ? err.message : String(err)), {
      status: 500,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
}
