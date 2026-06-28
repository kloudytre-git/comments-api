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

// Create the comments table on first boot if it doesn't exist yet
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS comments (
      id SERIAL PRIMARY KEY,
      name VARCHAR(50) NOT NULL,
      text VARCHAR(1000) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('Database ready.');
}
initDb().catch((err) => console.error('DB init failed:', err));

// Health check (also what Render pings to keep the service "alive enough")
app.get('/', (req, res) => res.send('Comments API is running.'));

// GET /api/comments — most recent 50 comments, newest first
app.get('/api/comments', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, text, created_at FROM comments ORDER BY created_at DESC LIMIT 50'
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

// POST /api/comments — create a new comment
app.post('/api/comments', postLimiter, async (req, res) => {
  const { name, text } = req.body || {};

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
      'INSERT INTO comments (name, text) VALUES ($1, $2) RETURNING id, name, text, created_at',
      [trimmedName, trimmedText]
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
  const key = req.header('x-admin-key');
  if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
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

