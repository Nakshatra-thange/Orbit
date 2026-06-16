import express  from 'express';
import { Pool } from 'pg';
import dotenv   from 'dotenv';
import { createNotificationWorker } from '../../../shared/utils/queue';
import type { NotificationJob }     from '../../../shared/utils/queue';
import type { Job }                 from 'bullmq';

dotenv.config();

const app  = express();
const PORT = 3004;

app.use(express.json());

const db = new Pool({
  host:     process.env.POSTGRES_HOST     ?? 'localhost',
  port:     Number(process.env.POSTGRES_PORT ?? 5432),
  user:     process.env.POSTGRES_USER     ?? 'orbit',
  password: process.env.POSTGRES_PASSWORD ?? 'orbit_secret',
  database: process.env.POSTGRES_DB       ?? 'orbit',
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', async (_req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({
      service:   'notification-service',
      status:    'ok',
      timestamp: new Date().toISOString(),
    });
  } catch {
    res.status(503).json({ service: 'notification-service', status: 'down' });
  }
});

// ── List notifications for a user ─────────────────────────────────────────────
app.get('/', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'] as string;
    if (!userId) {
      res.status(401).json({ success: false, error: 'Unauthenticated' });
      return;
    }

    const result = await db.query(
      `SELECT * FROM notifications
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 50`,
      [userId]
    );

    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Notification fetch failed' });
  }
});

// ── Mark notification as read ─────────────────────────────────────────────────
app.patch('/:notificationId/read', async (req, res) => {
  try {
    await db.query(
      'UPDATE notifications SET read = TRUE WHERE id = $1',
      [req.params.notificationId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Update failed' });
  }
});

// ── BullMQ worker ─────────────────────────────────────────────────────────────
/*
 * This worker runs in the same process as the HTTP server.
 * In production you'd separate them (worker process vs API process)
 * so a worker crash doesn't take down the API.
 * For this project, combined is fine and simpler to demo.
 *
 * WHY the notification service owns the worker?
 * Because notifications are the notification service's responsibility.
 * The order service publishes an event. The notification service decides
 * what to do with it. If you later want to add SMS notifications,
 * you change only the notification service.
 * The order service never knows or cares how notifications are delivered.
 */
async function processNotificationJob(
  job: Job<NotificationJob>
): Promise<void> {
  const { type, userId, orderId, correlationId, metadata } = job.data;

  console.log(
    `[notification-service] 📨 Processing job: ${type} ` +
    `for user ${userId} [correlation: ${correlationId}]`
  );

  // Build notification content based on event type
  const templates: Record<NotificationJob['type'], { title: string; message: string }> = {
    order_created: {
      title:   '✅ Order confirmed',
      message: `Your order #${orderId.slice(0, 8)} has been confirmed and is being processed.`,
    },
    order_updated: {
      title:   '📦 Order updated',
      message: `Your order #${orderId.slice(0, 8)} status has been updated.`,
    },
    order_cancelled: {
      title:   '❌ Order cancelled',
      message: `Your order #${orderId.slice(0, 8)} has been cancelled.`,
    },
  };

  const template = templates[type];

  // Store notification in DB
  await db.query(
    `INSERT INTO notifications
       (user_id, tenant_id, type, title, message, metadata)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      userId,
      job.data.tenantId,
      type,
      template.title,
      template.message,
      JSON.stringify({ orderId, correlationId, ...metadata }),
    ]
  );

  /*
   * In production this is where you'd call:
   * - SendGrid / Resend for email
   * - Twilio for SMS
   * - Firebase for push notifications
   * - Slack webhook for internal alerts
   *
   * For the demo: storing in DB is sufficient to prove the pattern.
   * The notification appears immediately in GET /notification/ after the job processes.
   */
  console.log(
    `[notification-service] ✅ Notification stored: "${template.title}" → user ${userId}`
  );
}

// Start the worker
const worker = createNotificationWorker(processNotificationJob);

worker.on('completed', (job) => {
  console.log(`[notification-service] ✅ Job ${job.id} completed`);
});

worker.on('failed', (job, err) => {
  console.error(`[notification-service] ❌ Job ${job?.id} failed:`, err.message);
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[notification-service] running on port ${PORT}`);
  console.log(`[notification-service] BullMQ worker listening on queue: orbit:notifications`);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  await worker.close();
  process.exit(0);
});