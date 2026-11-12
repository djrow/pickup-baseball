import { Hono } from 'hono';
import { requireOrganizer, sanitizeHttpUrl } from '../security.js';
import { parseMediaType } from '../feeds.js';

export const postsRouter = new Hono();

postsRouter.get('/', async (c) => {
  try {
    const { results: posts } = await c.env.DB.prepare(`
      SELECT p.*, e.title as event_title, e.event_date
      FROM posts p
      LEFT JOIN events e ON p.event_id = e.id
      ORDER BY p.created_at DESC
      LIMIT 100
    `).all();
    c.header('Cache-Control', 'no-cache, no-store, must-revalidate');
    return c.json({ posts: posts || [] });
  } catch (err) {
    console.error('[Posts] Error fetching posts:', err);
    return c.json({ error: 'Failed to fetch community posts.' }, 500);
  }
});

postsRouter.get('/:id', async (c) => {
  try {
    const postId = parseInt(c.req.param('id'), 10);
    const post = await c.env.DB.prepare(`
      SELECT p.*, e.title as event_title, e.event_date
      FROM posts p
      LEFT JOIN events e ON p.event_id = e.id
      WHERE p.id = ?
    `).bind(postId).first();
    if (!post) return c.json({ error: 'Post not found.' }, 404);
    return c.json({ post });
  } catch (err) {
    console.error('[Posts] Error fetching post:', err);
    return c.json({ error: 'Failed to fetch post.' }, 500);
  }
});

postsRouter.post('/', requireOrganizer, async (c) => {
  const user = c.get('user');
  try {
    const { title, content, summary, media_url, media_type, event_id } = await c.req.json();
    if (!title || !String(title).trim()) return c.json({ error: 'Title is required.' }, 400);
    if (!content || !String(content).trim()) return c.json({ error: 'Story content is required.' }, 400);

    const cleanTitle = String(title).trim();
    const cleanContent = String(content).trim();
    let cleanMediaUrl = media_url ? String(media_url).trim() : null;
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

postsRouter.delete('/:id', requireOrganizer, async (c) => {
  try {
    const postId = parseInt(c.req.param('id'), 10);
    await c.env.DB.prepare('DELETE FROM posts WHERE id = ?').bind(postId).run();
    return c.json({ success: true, message: 'Post removed from feed.' });
  } catch (err) {
    console.error('[Posts] Error deleting post:', err);
    return c.json({ error: 'Failed to delete post.' }, 500);
  }
});
