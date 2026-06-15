import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
import { db, dbHealthCheck } from './utils/db';
import { redis, redisHealthCheck } from './utils/redis';
import { registry } from './services/registry';

dotenv.config();

const app  = express();
const PORT = Number(process.env.GATEWAY_PORT ?? 3000);

// ── Standard middleware ───────────────────────────────────────────────────────
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Stamp every request with a correlation ID immediately
app.use((req, _res, next) => {
  req.headers['x-correlation-id'] = req.headers['x-correlation-id'] ?? uuidv4();
  next();
});

// Structured request logging — includes correlation ID
app.use(morgan((tokens, req, res) => {
  return JSON.stringify({
    method:        tokens.method(req, res),
    url:           tokens.url(req, res),
    status:        tokens.status(req, res),
    responseTime:  tokens['response-time'](req, res) + 'ms',
    correlationId: req.headers['x-correlation-id'],
    timestamp:     new Date().toISOString(),
  });
}));

// ── Health endpoint (not rate limited, not proxied) ───────────────────────────
app.get('/health', async (_req, res) => {
  const [dbOk, redisOk] = await Promise.all([
    dbHealthCheck(),
    redisHealthCheck(),
  ]);

  const status = dbOk && redisOk ? 'healthy' : 'degraded';

  res.status(dbOk && redisOk ? 200 : 503).json({
    status,
    services: { db: dbOk ? 'ok' : 'down', redis: redisOk ? 'ok' : 'down' },
    registry: registry.getAll().length,
    uptime:   process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// ── Orbit internal API (dashboard reads from here) ───────────────────────────
app.get('/orbit/services', (_req, res) => {
  const services = registry.getAll().map(e => ({
    id:            e.service.id,
    name:          e.service.name,
    slug:          e.service.slug,
    revenueImpact: e.service.revenueImpact,
    upstreamUrl:   e.service.upstreamUrl,
    policy:        e.policy,
  }));
  res.json({ success: true, data: services });
});

// ── 404 catch-all ─────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ success: false, error: 'Route not found' });
});

// ── Startup ───────────────────────────────────────────────────────────────────
async function start(): Promise<void> {
  console.log('\n[orbit] Starting gateway...');

  // Wait for Postgres
  let dbReady = false;
  for (let i = 0; i < 10; i++) {
    dbReady = await dbHealthCheck();
    if (dbReady) break;
    console.log(`[orbit] Waiting for Postgres... (${i + 1}/10)`);
    await new Promise(r => setTimeout(r, 2000));
  }
  if (!dbReady) {
    console.error('[orbit] Postgres not available after 10 retries. Exiting.');
    process.exit(1);
  }

  // Load service registry from DB
  await registry.load();
  registry.startAutoRefresh(30_000);

  app.listen(PORT, () => {
    console.log(`[orbit] Gateway running on port ${PORT}`);
    console.log(`[orbit] Health  → http://localhost:${PORT}/health`);
    console.log(`[orbit] Services → http://localhost:${PORT}/orbit/services\n`);
  });
}

start().catch(err => {
  console.error('[orbit] Fatal startup error:', err);
  process.exit(1);
});

export { app };