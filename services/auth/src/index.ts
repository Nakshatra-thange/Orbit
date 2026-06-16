import express        from 'express';
import bcrypt         from 'bcryptjs';
import jwt            from 'jsonwebtoken';
import { Pool }       from 'pg';
import dotenv         from 'dotenv';

dotenv.config();

const app  = express();
const PORT = 3001;

app.use(express.json());

const db = new Pool({
  host:     process.env.POSTGRES_HOST     ?? 'localhost',
  port:     Number(process.env.POSTGRES_PORT ?? 5432),
  user:     process.env.POSTGRES_USER     ?? 'orbit',
  password: process.env.POSTGRES_PASSWORD ?? 'orbit_secret',
  database: process.env.POSTGRES_DB       ?? 'orbit',
});

const JWT_SECRET     = process.env.JWT_SECRET     ?? 'orbit_jwt_secret';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN ?? '24h';

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', async (_req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ service: 'auth-service', status: 'ok', timestamp: new Date().toISOString() });
  } catch {
    res.status(503).json({ service: 'auth-service', status: 'down' });
  }
});

// ── Register ──────────────────────────────────────────────────────────────────
app.post('/register', async (req, res) => {
  try {
    const { email, password, tier = 'free' } = req.body as {
      email: string; password: string; tier?: string;
    };

    if (!email || !password) {
      res.status(400).json({ success: false, error: 'email and password required' });
      return;
    }

    const existing = await db.query(
      'SELECT id FROM users WHERE email = $1', [email]
    );
    if (existing.rows.length > 0) {
      res.status(409).json({ success: false, error: 'Email already registered' });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const result = await db.query(
      `INSERT INTO users (tenant_id, email, password_hash, tier)
       VALUES ($1, $2, $3, $4) RETURNING id, email, tier, created_at`,
      ['a0000000-0000-0000-0000-000000000001', email, passwordHash, tier]
    );

    const user  = result.rows[0];
    const token = jwt.sign(
      {
        sub:      user.id,
        email:    user.email,
        tier:     user.tier,
        tenantId: 'a0000000-0000-0000-0000-000000000001',
      },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN as any }
    );

    res.status(201).json({
      success: true,
      data: { token, user: { id: user.id, email: user.email, tier: user.tier } },
    });
  } catch (err) {
    console.error('[auth] register error:', err);
    res.status(500).json({ success: false, error: 'Registration failed' });
  }
});

// ── Login ─────────────────────────────────────────────────────────────────────
app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body as { email: string; password: string };

    if (!email || !password) {
      res.status(400).json({ success: false, error: 'email and password required' });
      return;
    }

    const result = await db.query(
      'SELECT id, email, password_hash, tier FROM users WHERE email = $1',
      [email]
    );

    if (result.rows.length === 0) {
      res.status(401).json({ success: false, error: 'Invalid credentials' });
      return;
    }

    const user  = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);

    if (!valid) {
      res.status(401).json({ success: false, error: 'Invalid credentials' });
      return;
    }

    const token = jwt.sign(
      {
        sub:      user.id,
        email:    user.email,
        tier:     user.tier,
        tenantId: 'a0000000-0000-0000-0000-000000000001',
      },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN as any }
    );

    res.json({
      success: true,
      data: { token, user: { id: user.id, email: user.email, tier: user.tier } },
    });
  } catch (err) {
    console.error('[auth] login error:', err);
    res.status(500).json({ success: false, error: 'Login failed' });
  }
});

// ── Me (verify token — called by gateway to validate) ─────────────────────────
app.get('/me', async (req, res) => {
  try {
    // Gateway strips Authorization before forwarding
    // but stamps X-User-Id — use that
    const userId = req.headers['x-user-id'] as string;
    if (!userId) {
      res.status(401).json({ success: false, error: 'Unauthenticated' });
      return;
    }

    const result = await db.query(
      'SELECT id, email, tier, created_at FROM users WHERE id = $1',
      [userId]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to fetch user' });
  }
});

app.listen(PORT, () =>
  console.log(`[auth-service] running on port ${PORT}`)
);