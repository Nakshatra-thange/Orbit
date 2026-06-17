import express  from 'express';
import { Pool } from 'pg';
import http     from 'http';
import dotenv   from 'dotenv';
import { createNotificationQueue } from '../../../shared/utils/queue';
import type { NotificationJob }    from '../../../shared/utils/queue';

dotenv.config();

const app  = express();
const PORT = 3003;

app.use(express.json());

const db = new Pool({
  host:     process.env.POSTGRES_HOST     ?? 'localhost',
  port:     Number(process.env.POSTGRES_PORT ?? 5432),
  user:     process.env.POSTGRES_USER     ?? 'orbit',
  password: process.env.POSTGRES_PASSWORD ?? 'orbit_secret',
  database: process.env.POSTGRES_DB       ?? 'orbit',
});

const notificationQueue = createNotificationQueue();

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', async (_req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ service: 'order-service', status: 'ok', timestamp: new Date().toISOString() });
  } catch {
    res.status(503).json({ service: 'order-service', status: 'down' });
  }
});

// ── Inter-service: validate user exists ───────────────────────────────────────
/*
 * Order service calls user service directly on the internal Docker network.
 * NOT through the public gateway — that would add unnecessary auth overhead
 * and create a circular dependency.
 *
 * Internal traffic pattern:
 *   order-service → http://user-service:3002/internal/:userId
 *
 * External traffic pattern (via gateway):
 *   client → nginx → gateway (auth+ratelimit) → order-service
 *
 * The distinction: external traffic needs auth. Internal traffic trusts
 * the X-User-Id header already stamped by the gateway on the original request.
 */
function validateUserExists(userId: string): Promise<boolean> {
  return new Promise((resolve) => {
    const options = {
      hostname: process.env.USER_SERVICE_HOST ?? 'user-service',
      port:     3002,
      path:     `/internal/${userId}`,
      method:   'GET',
      timeout:  3000,
    };

    const req = http.request(options, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });

    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error',   () => resolve(false));
    req.end();
  });
}

// ── Create order ──────────────────────────────────────────────────────────────
app.post('/', async (req, res) => {
  try {
    const userId        = req.headers['x-user-id'] as string;
    const tenantId      = req.headers['x-tenant-id'] as string;
    const correlationId = req.headers['x-correlation-id'] as string;

    if (!userId) {
      res.status(401).json({ success: false, error: 'Unauthenticated' });
      return;
    }

    const { items, totalAmount } = req.body as {
      items: Array<{ productId: string; quantity: number; price: number }>;
      totalAmount: number;
    };

    if (!items?.length) {
      res.status(400).json({ success: false, error: 'items required' });
      return;
    }

    // Validate user exists via inter-service call
    const userExists = await validateUserExists(userId);
    if (!userExists) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }

    // Create order
    const result = await db.query(
      `INSERT INTO orders (user_id, tenant_id, items, total_amount, status)
       VALUES ($1, $2, $3, $4, 'confirmed')
       RETURNING *`,
      [userId, tenantId ?? 'a0000000-0000-0000-0000-000000000001',
       JSON.stringify(items), totalAmount ?? 0]
    );

    const order = result.rows[0];

    /*
     * Publish notification job — fire and forget.
     * Order creation succeeds regardless of notification queue state.
     * If Redis is down, this throws — we catch and log but still return 201.
     */
    const notificationJob: NotificationJob = {
      type:     'order_created',
      userId,
      tenantId: tenantId ?? 'a0000000-0000-0000-0000-000000000001',
      orderId:  order.id,
      metadata: { items, totalAmount, correlationId },
      correlationId,
    };

    try {
      await notificationQueue.add('order_created', notificationJob);
      console.log(
        `[order-service] 📬 notification queued for order ${order.id} ` +
        `[correlation: ${correlationId}]`
      );
    } catch (queueErr) {
      // Queue failure does NOT fail the order
      console.error('[order-service] notification queue error:', queueErr);
    }

    res.status(201).json({ success: true, data: order });
  } catch (err) {
    console.error('[order-service] create error:', err);
    res.status(500).json({ success: false, error: 'Order creation failed' });
  }
});

// ── List my orders ────────────────────────────────────────────────────────────
app.get('/', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'] as string;
    if (!userId) {
      res.status(401).json({ success: false, error: 'Unauthenticated' });
      return;
    }

    const result = await db.query(
      `SELECT * FROM orders WHERE user_id = $1
       ORDER BY created_at DESC LIMIT 50`,
      [userId]
    );

    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Order list failed' });
  }
});

// ── Get order by ID ───────────────────────────────────────────────────────────
app.get('/:orderId', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'] as string;
    const result = await db.query(
      'SELECT * FROM orders WHERE id = $1 AND user_id = $2',
      [req.params.orderId, userId]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Order not found' });
      return;
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Order fetch failed' });
  }
});

// ── Update order status ───────────────────────────────────────────────────────
app.patch('/:orderId/status', async (req, res) => {
  try {
    const { status } = req.body as { status: string };
    const validStatuses = ['confirmed','processing','shipped','delivered','cancelled'];

    if (!validStatuses.includes(status)) {
      res.status(400).json({ success: false, error: `Invalid status. Must be: ${validStatuses.join(', ')}` });
      return;
    }

    const result = await db.query(
      `UPDATE orders SET status = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [status, req.params.orderId]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Order not found' });
      return;
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Status update failed' });
  }
});

/*
 * Slow endpoint — used to simulate latency for circuit breaker demo.
 * Hit /slow repeatedly to push p95 latency above the threshold
 * and watch the circuit open on the order service.
 *
 * curl -X POST http://localhost/order/slow -H "Authorization: Bearer <token>"
 */
app.post('/slow', async (_req, res) => {
  const delay = 2500 + Math.random() * 1000; // 2.5-3.5s
  await new Promise(r => setTimeout(r, delay));
  res.json({ success: true, message: `Responded after ${Math.round(delay)}ms` });
});

/*
 * Error endpoint — used to simulate failures for circuit breaker demo.
 * Hit /fail 5+ times to push error rate above threshold.
 *
 * curl -X POST http://localhost/order/fail -H "Authorization: Bearer <token>"
 */
app.post('/fail', (_req, res) => {
  res.status(500).json({ success: false, error: 'Simulated service failure' });
});

app.listen(PORT, () =>
  console.log(`[order-service] running on port ${PORT}`)
);