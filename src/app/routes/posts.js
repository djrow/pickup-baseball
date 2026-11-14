import { Hono } from 'hono';
import { requireOrganizer, sanitizeHttpUrl, getClientIp, checkRateLimit } from '../security.js';
import { canUserAccessEvent } from '../policy.js';
import { parseMediaType } from '../feeds.js';

export const postsRouter = new Hono();

postsRouter.get('/', async (c) => {
  try {
    const user = c.get('user');
    const { results: posts } = await c.env.DB.prepare(`
      SELECT p.*, e.title as event_title, e.event_date, e.allowed_emails as event_allowed_emails
      FROM posts p
      LEFT JOIN events e ON p.event_id = e.id
      ORDER BY p.created_at DESC
      LIMIT 100
    `).all();
    const visiblePosts = (posts || [])
      .filter((p) => !p.event_id || !p.event_allowed_emails || canUserAccessEvent(user, { allowed_emails: p.event_allowed_emails }))
      .map(({ event_allowed_emails, ...rest }) => rest);
    c.header('Cache-Control', user ? 'private, no-store' : 'public, max-age=60, s-maxage=300, stale-while-revalidate=600');
    return c.json({ posts: visiblePosts });
  } catch (err) {
    console.error('[Posts] Error fetching posts:', err);
    return c.json({ error: 'Failed to fetch community posts.' }, 500);
  }
});

postsRouter.get('/:id', async (c) => {
  try {
    const postId = parseInt(c.req.param('id'), 10);
    if (!postId || isNaN(postId) || postId <= 0) {
      return c.json({ error: 'Invalid post ID.' }, 400);
    }
    const user = c.get('user');
    const post = await c.env.DB.prepare(`
      SELECT p.*, e.title as event_title, e.event_date, e.allowed_emails as event_allowed_emails
      FROM posts p
      LEFT JOIN events e ON p.event_id = e.id
      WHERE p.id = ?
    `).bind(postId).first();
    if (!post) return c.json({ error: 'Post not found.' }, 404);
    if (post.event_id && post.event_allowed_emails && !canUserAccessEvent(user, { allowed_emails: post.event_allowed_emails })) {
      return c.json({ error: 'Post not found.' }, 404);
    }
    const { event_allowed_emails, ...safePost } = post;
    return c.json({ post: safePost });
  } catch (err) {
    console.error('[Posts] Error fetching post:', err);
    return c.json({ error: 'Failed to fetch post.' }, 500);
  }
});

postsRouter.post('/', requireOrganizer, async (c) => {
  const user = c.get('user');
  try {
    const postLimit = await checkRateLimit(c.env.DB, 'posts_' + getClientIp(c), 20, 3600, c.env);
    if (!postLimit.allowed) {
      return c.json({ error: 'Too many community posts submitted. Please try again later.' }, 429);
    }

    const { title, content, summary, media_url, media_type, event_id } = await c.req.json();
    if (!title || !String(title).trim()) return c.json({ error: 'Title is required.' }, 400);
    if (!content || !String(content).trim()) return c.json({ error: 'Story content is required.' }, 400);

    const cleanTitle = String(title).trim();
    const cleanContent = String(content).trim();
    if (cleanTitle.length > 200) return c.json({ error: 'Title must not exceed 200 characters.' }, 400);
    if (cleanContent.length > 10000) return c.json({ error: 'Story content must not exceed 10,000 characters.' }, 400);

    let cleanMediaUrl = media_url ? String(media_url).trim() : null;
    if (cleanMediaUrl && cleanMediaUrl.length > 2048) {
      return c.json({ error: 'Media URL must not exceed 2048 characters.' }, 400);
    }
    if (cleanMediaUrl) {
      if (cleanMediaUrl.startsWith('/') && !cleanMediaUrl.startsWith('//') && !cleanMediaUrl.startsWith('/\\')) {
        // Allow same-origin relative media URLs
      } else {
        const sanitized = sanitizeHttpUrl(cleanMediaUrl);
        if (!sanitized) {
          return c.json({ error: 'Media URL must be an http://, https://, or relative / path.' }, 400);
        }
        cleanMediaUrl = sanitized;
      }
    }
    const finalMediaType = parseMediaType(cleanMediaUrl, media_type);
    const cleanSummary = summary ? String(summary).trim() : (cleanContent.slice(0, 160) + (cleanContent.length > 160 ? '…' : ''));
    const eventId = event_id ? parseInt(event_id, 10) : null;

    const result = await c.env.DB.prepare(`
      INSERT INTO posts (title, content, summary, media_url, media_type, author_id, author_name, event_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(cleanTitle, cleanContent, cleanSummary, cleanMediaUrl, finalMediaType, user.id, user.name || 'Organizer', eventId).run();

    const newPost = await c.env.DB.prepare(`
      SELECT p.*, e.title as event_title, e.event_date
      FROM posts p
      LEFT JOIN events e ON p.event_id = e.id
      WHERE p.id = ?
    `).bind(result.meta.last_row_id).first();

    return c.json({
      success: true,
      post: newPost,
      message: 'Post published to feed and RSS successfully!'
    });
  } catch (err) {
    console.error('[Posts] Error creating post:', err);
    return c.json({ error: 'Failed to publish post.' }, 500);
  }
});

postsRouter.put('/:id', requireOrganizer, async (c) => {
  try {
    const postId = parseInt(c.req.param('id'), 10);
    if (isNaN(postId) || postId <= 0) {
      return c.json({ error: 'Invalid post ID.' }, 400);
    }

    const existing = await c.env.DB.prepare('SELECT * FROM posts WHERE id = ?').bind(postId).first();
    if (!existing) {
      return c.json({ error: 'Post not found.' }, 404);
    }

    const { title, content, summary, media_url, media_type, event_id } = await c.req.json();
    const cleanTitle = title !== undefined ? String(title).trim() : existing.title;
    const cleanContent = content !== undefined ? String(content).trim() : existing.content;
    if (!cleanTitle) return c.json({ error: 'Title is required.' }, 400);
    if (!cleanContent) return c.json({ error: 'Story content is required.' }, 400);
    if (cleanTitle.length > 200) return c.json({ error: 'Title must not exceed 200 characters.' }, 400);
    if (cleanContent.length > 10000) return c.json({ error: 'Story content must not exceed 10,000 characters.' }, 400);

    let cleanMediaUrl = media_url !== undefined ? (media_url ? String(media_url).trim() : null) : existing.media_url;
    if (cleanMediaUrl && cleanMediaUrl.length > 2048) {
      return c.json({ error: 'Media URL must not exceed 2048 characters.' }, 400);
    }
    if (cleanMediaUrl) {
      if (cleanMediaUrl.startsWith('/') && !cleanMediaUrl.startsWith('//') && !cleanMediaUrl.startsWith('/\\')) {
        // Allow same-origin relative media URLs
      } else {
        const sanitized = sanitizeHttpUrl(cleanMediaUrl);
        if (!sanitized) {
          return c.json({ error: 'Media URL must be an http://, https://, or relative / path.' }, 400);
        }
        cleanMediaUrl = sanitized;
      }
    }
    const finalMediaType = parseMediaType(cleanMediaUrl, media_type !== undefined ? media_type : existing.media_type);
    const cleanSummary = summary !== undefined
      ? String(summary).trim()
      : (cleanContent.slice(0, 160) + (cleanContent.length > 160 ? '…' : ''));
    const eventId = event_id !== undefined ? (event_id ? parseInt(event_id, 10) : null) : existing.event_id;

    await c.env.DB.prepare(`
      UPDATE posts
      SET title = ?, content = ?, summary = ?, media_url = ?, media_type = ?, event_id = ?
      WHERE id = ?
    `).bind(cleanTitle, cleanContent, cleanSummary, cleanMediaUrl, finalMediaType, eventId, postId).run();

    const updatedPost = await c.env.DB.prepare(`
      SELECT p.*, e.title as event_title, e.event_date
      FROM posts p
      LEFT JOIN events e ON p.event_id = e.id
      WHERE p.id = ?
    `).bind(postId).first();

    return c.json({ success: true, post: updatedPost, message: 'Post updated successfully.' });
  } catch (err) {
    console.error('[Posts] Error updating post:', err);
    return c.json({ error: 'Failed to update post.' }, 500);
  }
});

postsRouter.delete('/:id', requireOrganizer, async (c) => {
  try {
    const postId = parseInt(c.req.param('id'), 10);
    if (isNaN(postId) || postId <= 0) {
      return c.json({ error: 'Invalid post ID.' }, 400);
    }
    const res = await c.env.DB.prepare('DELETE FROM posts WHERE id = ?').bind(postId).run();
    if (!res.meta || res.meta.changes === 0) {
      return c.json({ error: 'Post not found.' }, 404);
    }
    return c.json({ success: true, message: 'Post removed from feed.' });
  } catch (err) {
    console.error('[Posts] Error deleting post:', err);
    return c.json({ error: 'Failed to delete post.' }, 500);
  }
});
