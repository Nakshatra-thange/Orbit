import Redis from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();

export const redis = new Redis({
  host: process.env.REDIS_HOST ?? 'localhost',
  port: Number(process.env.REDIS_PORT ?? 6379),
  lazyConnect: false,
  retryStrategy: (times) => Math.min(times * 100, 3000),
});

redis.on('connect',    () => console.log('[orbit:redis] connected'));
redis.on('error', (e) => console.error('[orbit:redis] error:', e.message));

export async function redisHealthCheck(): Promise<boolean> {
  try {
    await redis.ping();
    return true;
  } catch {
    return false;
  }
}