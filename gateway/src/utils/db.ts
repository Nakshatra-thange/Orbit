import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

export const db = new Pool({
  host:     process.env.POSTGRES_HOST     ?? 'localhost',
  port:     Number(process.env.POSTGRES_PORT ?? 5432),
  user:     process.env.POSTGRES_USER     ?? 'orbit',
  password: process.env.POSTGRES_PASSWORD ?? 'orbit_secret',
  database: process.env.POSTGRES_DB       ?? 'orbit',
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 2_000,
});

db.on('error', (err) => {
  console.error('[orbit:db] Unexpected pool error:', err);
});

export async function dbHealthCheck(): Promise<boolean> {
  try {
    await db.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}