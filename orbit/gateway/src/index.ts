import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
import { startReliabilityScheduler } from './reliability/scheduler';
import { circuitGuard }              from './middleware/circuitGuard';
import { db, dbHealthCheck } from './utils/db';
import { redis, redisHealthCheck } from './utils/redis';
import { registry } from './services/registry';
import { authMiddleware } from './middleware/auth';
import { rateLimitMiddleware } from './middleware/rateLimit';
import { proxyMiddleware } from './middleware/proxy';
import orbitRoutes from './routes/orbit';

dotenv.config();

const app  = express();
const PORT = Number(process.env.GATEWAY_PORT ?? 3000);

// ── Standard middleware ───────────────────────────────────────────────────────
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Stamp correlation ID immediately — before anything else runs
app.use((req, _res, next) => {
  req.headers['x-correlation-id'] =
    req.headers['x-correlation-id'] ?? uuidv4();
  next();
});

// Structured logging
app.use(morgan((tokens, req, res) =>
  JSON.stringify({
    method:        tokens.method(req, res),
    url:           tokens.url(req, res),
    status:        tokens.status(req, res),
    responseTime:  tokens['response-time'](req, res) + 'ms',
    correlationId: req.headers['x-correlation-id'],
    userId:        req.headers['x-user-id'],
    tier:          req.headers['x-user-tier'],
    timestamp:     new Date().toISOString(),
  })
));

// ── Health (public, no auth, no rate limit) ───────────────────────────────────
app.get('/health', async (_req, res) => {
  const [dbOk, redisOk] = await Promise.all([
    dbHealthCheck(),
    redisHealthCheck(),
  ]);
  res.status(dbOk && redisOk ? 200 : 503).json({
    status:    dbOk && redisOk ? 'healthy' : 'degraded',
    services:  { db: dbOk ? 'ok' : 'down', redis: redisOk ? 'ok' : 'down' },
    registry:  registry.getAll().length,
    uptime:    process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// ── Orbit internal API (dashboard) ───────────────────────────────────────────
app.use('/orbit', orbitRoutes);

// ── Gateway pipeline for all other routes ────────────────────────────────────
// Order matters: auth → rate limit → proxy
// ── Gateway pipeline ──────────────────────────────────────────────────────────
// Order: auth → rate limit → circuit guard → proxy
app.use(authMiddleware);
app.use(rateLimitMiddleware as express.RequestHandler);
app.use(circuitGuard);
app.use(proxyMiddleware);

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ success: false, error: 'Route not found' });
});

// ── Startup ───────────────────────────────────────────────────────────────────
async function start(): Promise<void> {
  console.log('\n[orbit] Starting Orbit gateway...\n');

  let dbReady = false;
  for (let i = 0; i < 10; i++) {
    dbReady = await dbHealthCheck();
    if (dbReady) break;
    console.log(`[orbit] Waiting for Postgres... (${i + 1}/10)`);
    await new Promise(r => setTimeout(r, 2000));
  }
  if (!dbReady) {
    console.error('[orbit] Postgres not available. Exiting.');
    process.exit(1);
  }

  await registry.load();
  registry.startAutoRefresh(30_000);

  // Start the reliability loop
startReliabilityScheduler();
console.log('[orbit] Reliability scheduler started (10s interval)');

  app.listen(PORT, () => {
    console.log(`[orbit] Gateway          → http://localhost:${PORT}`);
    console.log(`[orbit] Health           → http://localhost:${PORT}/health`);
    console.log(`[orbit] Services         → http://localhost:${PORT}/orbit/services`);
    console.log(`[orbit] Failed requests  → http://localhost:${PORT}/orbit/failed-requests`);
    console.log(`[orbit] Metrics (sample) → http://localhost:${PORT}/orbit/metrics/<serviceId>`);
    console.log('\n[orbit] Registered services:');
    registry.getAll().forEach(e =>
      console.log(`  /${e.service.slug}/* → ${e.service.upstreamUrl} [${e.service.revenueImpact}]`)
    );
    console.log('');
  });
}

start().catch(err => {
  console.error('[orbit] Fatal startup error:', err);
  process.exit(1);
});

export { app };