import express from 'express';
import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const app  = express();
const PORT = 3002;

app.use(express.json());

const db = new Pool({
  host:     process.env.POSTGRES_HOST     ?? 'localhost',
  port:     Number(process.env.POSTGRES_PORT ?? 5432),
  user:     process.env.POSTGRES_USER     ?? 'orbit',
  password: process.env.POSTGRES_PASSWORD ?? 'orbit_secret',
  database: process.env.POSTGRES_DB       ?? 'orbit',
});

app.get('/health', async (_req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({
      service: 'user-service',
      status: 'ok',
      port: PORT,
      timestamp: new Date().toISOString(),
    });
  } catch {
    res.status(503).json({ service: 'user-service', status: 'down' });
  }
});

// Inter-service lookup — called by order-service, not exposed via gateway
app.get('/internal/:userId', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT id, email, tier FROM users WHERE id = $1',
      [req.params.userId]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error('[user-service] internal lookup error:', err);
    res.status(500).json({ success: false, error: 'User lookup failed' });
  }
});

app.get('/users/me', (_req, res) =>
  res.json({ service: 'user', endpoint: 'me', stub: true })
);

app.listen(PORT, () => console.log(`[user-service] running on port ${PORT}`));
