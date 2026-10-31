const express = require('express');
const router = express.Router();
const { db } = require('../db');
const { optionalUser, requireEventCreator } = require('../auth');

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

/**
 * List all posts
 */
router.get('/', (req, res) => {
  try {
    const posts = db.prepare(`
      SELECT p.*, e.title as event_title, e.event_date
      FROM posts p
      LEFT JOIN events e ON p.event_id = e.id
      ORDER BY p.created_at DESC
    `).all();

    res.json({ posts });
  } catch (err) {
    console.error('[Posts] Error fetching posts:', err);
    res.status(500).json({ error: 'Failed to fetch community posts.' });
  }
});

/**
 * Get single post
 */
router.get('/:id', (req, res) => {
  try {
    const post = db.prepare(`
      SELECT p.*, e.title as event_title, e.event_date
      FROM posts p
      LEFT JOIN events e ON p.event_id = e.id
      WHERE p.id = ?
    `).get(req.params.id);

    if (!post) {
      return res.status(404).json({ error: 'Post not found.' });
    }

    res.json({ post });
  } catch (err) {
    console.error('[Posts] Error fetching post:', err);
    res.status(500).json({ error: 'Failed to fetch post.' });
  }
});

/**
 * Create new post (Organizer or Admin)
 */
router.post('/', requireEventCreator, (req, res) => {
  try {
    const { title, content, summary, media_url, media_type, event_id } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({ error: 'Title is required.' });
    }
    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'Story content is required.' });
    }

    const cleanTitle = title.trim();
    const cleanContent = content.trim();
    const cleanMediaUrl = media_url ? media_url.trim() : null;
    const finalMediaType = parseMediaType(cleanMediaUrl, media_type);
    const cleanSummary = summary ? summary.trim() : (cleanContent.slice(0, 160) + (cleanContent.length > 160 ? '…' : ''));
    const authorId = req.user.id;
    const authorName = req.user.name || 'Organizer';
    const eventId = event_id ? parseInt(event_id, 10) : null;

    const result = db.prepare(`
      INSERT INTO posts (title, content, summary, media_url, media_type, author_id, author_name, event_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(cleanTitle, cleanContent, cleanSummary, cleanMediaUrl, finalMediaType, authorId, authorName, eventId);

    const newPost = db.prepare(`
      SELECT p.*, e.title as event_title, e.event_date
      FROM posts p
      LEFT JOIN events e ON p.event_id = e.id
      WHERE p.id = ?
    `).get(result.lastInsertRowid);

    res.json({
      success: true,
      post: newPost,
      message: 'Post published to feed and RSS successfully!'
    });
  } catch (err) {
    console.error('[Posts] Error creating post:', err);
    res.status(500).json({ error: 'Failed to publish post.' });
  }
});

/**
 * Delete post (Organizer or Admin)
 */
router.delete('/:id', requireEventCreator, (req, res) => {
  try {
    const postId = req.params.id;
    const existing = db.prepare('SELECT id FROM posts WHERE id = ?').get(postId);
    if (!existing) {
      return res.status(404).json({ error: 'Post not found.' });
    }

    db.prepare('DELETE FROM posts WHERE id = ?').run(postId);
    res.json({ success: true, message: 'Post removed from feed.' });
  } catch (err) {
    console.error('[Posts] Error deleting post:', err);
    res.status(500).json({ error: 'Failed to delete post.' });
  }
});

/**
 * Serve RSS 2.0 XML with Media RSS extensions
 */
function serveFeedXml(req, res) {
  try {
    const posts = db.prepare(`
      SELECT p.*, e.title as event_title, e.event_date
      FROM posts p
      LEFT JOIN events e ON p.event_id = e.id
      ORDER BY p.created_at DESC
      LIMIT 50
    `).all();

    const host = req.get('host') || 'www.pickupbaseballfoundation.org';
    const proto = req.get('x-forwarded-proto') || (req.secure ? 'https' : 'http');
    const origin = `${proto}://${host}`;

    const xml = buildRssFeedXml(posts, origin);
    res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.send(xml);
  } catch (err) {
    console.error('[RSS Feed] Error generating feed:', err);
    res.status(500).send('Failed to generate RSS feed.');
  }
}

module.exports = {
  router,
  serveFeedXml,
  buildRssFeedXml,
  parseMediaType,
  getYouTubeId
};
