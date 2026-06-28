require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

// Only allow requests from your portfolio's origin (set this in Render's env vars)
const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
app.use(cors({ origin: allowedOrigin }));

// Neon (or any Postgres) connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Create tables on first boot if they don't exist yet
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS posts (
      id SERIAL PRIMARY KEY,
      category VARCHAR(50) NOT NULL,
      title VARCHAR(200) NOT NULL,
      summary VARCHAR(500) NOT NULL,
      content TEXT NOT NULL,
      read_time_minutes INTEGER NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS comments (
      id SERIAL PRIMARY KEY,
      post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
      name VARCHAR(50) NOT NULL,
      text VARCHAR(1000) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  // In case this is an existing database from before posts existed,
  // add the post_id column if it's missing (no-op otherwise).
  await pool.query(`ALTER TABLE comments ADD COLUMN IF NOT EXISTS post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE;`);
  console.log('Database ready.');
}
initDb().catch((err) => console.error('DB init failed:', err));

function checkAdmin(req, res) {
  const key = req.header('x-admin-key');
  if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

// Health check (also what Render pings to keep the service "alive enough")
app.get('/', (req, res) => res.send('Comments API is running.'));

/* ───────────────────────── POSTS ───────────────────────── */

// GET /api/posts — all posts, newest first, with a live comment count per post
app.get('/api/posts', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.id, p.category, p.title, p.summary, p.read_time_minutes, p.created_at,
             COUNT(c.id)::int AS comment_count
      FROM posts p
      LEFT JOIN comments c ON c.post_id = p.id
      GROUP BY p.id
      ORDER BY p.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch posts' });
  }
});

// GET /api/posts/:id — a single post's full content
app.get('/api/posts/:id', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, category, title, summary, content, read_time_minutes, created_at FROM posts WHERE id = $1',
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Post not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch post' });
  }
});

// POST /api/posts — create a new post. Admin only (x-admin-key header).
app.post('/api/posts', async (req, res) => {
  if (!checkAdmin(req, res)) return;

  const { category, title, summary, content } = req.body || {};
  if (!category || !title || !summary || !content) {
    return res.status(400).json({ error: 'category, title, summary, and content are all required.' });
  }

  const trimmedCategory = String(category).trim().slice(0, 50);
  const trimmedTitle = String(title).trim().slice(0, 200);
  const trimmedSummary = String(summary).trim().slice(0, 500);
  const trimmedContent = String(content).trim();

  if (!trimmedCategory || !trimmedTitle || !trimmedSummary || !trimmedContent) {
    return res.status(400).json({ error: 'Fields cannot be empty.' });
  }

  // Auto-estimate reading time at ~200 words per minute (minimum 1 minute)
  const wordCount = trimmedContent.split(/\s+/).filter(Boolean).length;
  const readTimeMinutes = Math.max(1, Math.round(wordCount / 200));

  try {
    const result = await pool.query(
      `INSERT INTO posts (category, title, summary, content, read_time_minutes)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, category, title, summary, content, read_time_minutes, created_at`,
      [trimmedCategory, trimmedTitle, trimmedSummary, trimmedContent, readTimeMinutes]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save post' });
  }
});

// DELETE /api/posts/:id — admin only. Also deletes that post's comments (ON DELETE CASCADE).
app.delete('/api/posts/:id', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    await pool.query('DELETE FROM posts WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete post' });
  }
});

/* ─────────────────────── COMMENTS ─────────────────────── */

// GET /api/comments?post_id=5 — comments for a specific post (or all, if post_id omitted)
app.get('/api/comments', async (req, res) => {
  try {
    const { post_id } = req.query;
    const result = post_id
      ? await pool.query(
          'SELECT id, post_id, name, text, created_at FROM comments WHERE post_id = $1 ORDER BY created_at DESC LIMIT 100',
          [post_id]
        )
      : await pool.query(
          'SELECT id, post_id, name, text, created_at FROM comments ORDER BY created_at DESC LIMIT 50'
        );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch comments' });
  }
});

// Basic anti-spam: max 5 posted comments per IP every 15 minutes
const postLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many comments from this IP. Please try again later.' },
});

// POST /api/comments — create a new comment, optionally scoped to a post via post_id
app.post('/api/comments', postLimiter, async (req, res) => {
  const { name, text, post_id } = req.body || {};

  if (!name || !text || typeof name !== 'string' || typeof text !== 'string') {
    return res.status(400).json({ error: 'Name and comment text are required.' });
  }

  const trimmedName = name.trim().slice(0, 50);
  const trimmedText = text.trim().slice(0, 1000);

  if (!trimmedName || !trimmedText) {
    return res.status(400).json({ error: 'Name and comment text cannot be empty.' });
  }

  try {
    const result = await pool.query(
      'INSERT INTO comments (name, text, post_id) VALUES ($1, $2, $3) RETURNING id, post_id, name, text, created_at',
      [trimmedName, trimmedText, post_id || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save comment' });
  }
});

// DELETE /api/comments/:id — moderation endpoint, protected by a secret key
// Call this with header  x-admin-key: <your ADMIN_KEY>  to remove spam/abuse
app.delete('/api/comments/:id', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    await pool.query('DELETE FROM comments WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete comment' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));