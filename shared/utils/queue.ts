import { Queue, Worker, Job } from 'bullmq';
import IORedis from 'ioredis';

/*
 * BullMQ setup — shared queue configuration
 * ──────────────────────────────────────────
 * WHY BullMQ over raw Redis pub/sub?
 *
 * Redis pub/sub is fire-and-forget. If the notification service
 * is down when an order is created, the event is lost.
 *
 * BullMQ persists jobs in Redis. If the notification service
 * is down, jobs queue up and process when it recovers.
 * This is the decoupling that makes services independently deployable.
 *
 * WHY async messaging for notifications at all?
 * The user POSTs to /orders and expects a fast response.
 * Sending a notification email might take 200ms.
 * That 200ms should not be in the critical path of order creation.
 * Publish to queue → respond 201 immediately → notification sends async.
 */

export function createRedisConnection():any {
  return new IORedis({
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? 6379),
    maxRetriesPerRequest: null, // required by BullMQ
  });
}

export const QUEUES = {
  NOTIFICATIONS: 'orbit-notifications',
  ORDER_EVENTS:  'orbit-order-events',
} as const;

export interface NotificationJob {
  type:     'order_created' | 'order_updated' | 'order_cancelled';
  userId:   string;
  tenantId: string;
  orderId:  string;
  metadata: Record<string, unknown>;
  correlationId: string;
}

export function createNotificationQueue(): Queue<NotificationJob> {
  return new Queue<NotificationJob>(QUEUES.NOTIFICATIONS, {
    connection: createRedisConnection(),
    defaultJobOptions: {
      attempts:    3,
      backoff:     { type: 'exponential', delay: 1000 },
      removeOnComplete: { count: 100 },
      removeOnFail:     { count: 50  },
    },
  });
}

export function createNotificationWorker(
  processor: (job: Job<NotificationJob>) => Promise<void>
): Worker<NotificationJob> {
  return new Worker<NotificationJob>(
    QUEUES.NOTIFICATIONS,
    processor,
    {
      connection: createRedisConnection(),
      concurrency: 5,
    }
  );
}