import { Router, Request, Response } from 'express';
import { db } from '../utils/db';
import { registry } from '../services/registry';
import { redis } from '../utils/redis';
import { getIncidentTimeline } from '../reliability/incidents';
import { getAllCircuitStates }  from '../reliability/circuitBreaker';
import { getServiceHealth }    from '../reliability/healthScorer';
import { getActiveHealth }     from '../reliability/healthChecker';
/*
 * Orbit internal API — consumed by the dashboard
 * ────────────────────────────────────────────────
 * These routes expose the gateway's state: registered services,
 * live health scores, quota consumption, recent metrics.
 *
 * In production you'd put these behind X-Api-Key auth.
 * For the demo they're open so the dashboard can poll without a token.
 */

const router = Router();

// ── Registered services + policies ───────────────────────────────────────────
router.get('/services', (_req: Request, res: Response) => {
  const services = registry.getAll().map(e => ({
    id:            e.service.id,
    name:          e.service.name,
    slug:          e.service.slug,
    upstreamUrl:   e.service.upstreamUrl,
    revenueImpact: e.service.revenueImpact,
    policy:        e.policy,
  }));
  res.json({ success: true, data: services });
});

// ── Service metrics — last 60 seconds per service ─────────────────────────────
router.get('/metrics/:serviceId', async (req: Request, res: Response) => {
  try {
    const { serviceId } = req.params;
    const result = await db.query(
      `SELECT
         COUNT(*)                                              AS total,
         COUNT(*) FILTER (WHERE status_code >= 500)           AS errors,
         PERCENTILE_CONT(0.95) WITHIN GROUP
           (ORDER BY response_time_ms)                        AS p95_latency,
         AVG(response_time_ms)                                AS avg_latency
       FROM service_metrics
       WHERE service_id = $1
         AND timestamp > NOW() - INTERVAL '60 seconds'`,
      [serviceId]
    );

    const row       = result.rows[0];
    const total     = Number(row.total);
    const errors    = Number(row.errors);
    const errorRate = total > 0 ? errors / total : 0;

    res.json({
      success: true,
      data: {
        serviceId,
        windowSeconds:  60,
        totalRequests:  total,
        errorCount:     errors,
        errorRate:      Number(errorRate.toFixed(4)),
        p95LatencyMs:   Number(row.p95_latency ?? 0),
        avgLatencyMs:   Number(Number(row.avg_latency ?? 0).toFixed(2)),
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Metrics query failed' });
  }
});

// ── Quota consumption — reads from Redis ──────────────────────────────────────
router.get('/quota', async (_req: Request, res: Response) => {
  try {
    const tiers  = ['free', 'pro', 'enterprise'];
    const limits = { free: 100, pro: 1000, enterprise: 10000 };

    // rediswall stores keys as rw:sw:<identifier> for sliding window
    // For quota display we scan for all tier keys
    const quotaData: Record<string, { limit: number; used: number; percent: number }> = {};

    for (const tier of tiers) {
      // Count unique users in this tier hitting the API in the last minute
      // In a real system you'd have a dedicated quota key per user
      // For demo: approximate from a pattern scan
      const keys = await redis.keys(`rw:sw:user:*`);
      const used = keys.length; // approximate: one key per active user
      const limit = limits[tier as keyof typeof limits];
      quotaData[tier] = {
        limit,
        used:    Math.min(used, limit),
        percent: Math.min(Math.round((used / limit) * 100), 100),
      };
    }

    res.json({ success: true, data: quotaData });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Quota query failed' });
  }
});

// ── Recent failed requests ────────────────────────────────────────────────────
router.get('/failed-requests', async (req: Request, res: Response) => {
  try {
    const limit = Number(req.query.limit ?? 20);
    const result = await db.query(
      `SELECT
         fr.id, fr.method, fr.path, fr.response_status,
         fr.error_reason, fr.correlation_id, fr.timestamp,
         s.name AS service_name, s.revenue_impact
       FROM failed_requests fr
       JOIN services s ON s.id = fr.service_id
       ORDER BY fr.timestamp DESC
       LIMIT $1`,
      [limit]
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed requests query failed' });
  }
});

// ── Replay a failed request ───────────────────────────────────────────────────
router.post('/replay/:requestId', async (req: Request, res: Response) => {
  try {
    const result = await db.query(
      `SELECT * FROM failed_requests WHERE id = $1`,
      [req.params.requestId]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Request not found' });
      return;
    }

    const stored = result.rows[0];
    const entry  = registry.getBySlug(stored.path.split('/')[1]);

    if (!entry) {
      res.status(404).json({ success: false, error: 'Service no longer registered' });
      return;
    }

    // Re-execute the stored request against the live upstream
    const http    = await import('http');
    const url     = new URL(stored.path, entry.service.upstreamUrl);
    const options = {
      hostname: url.hostname,
      port:     url.port || 80,
      path:     url.pathname,
      method:   stored.method,
      headers:  {
        ...stored.sanitised_headers,
        'x-orbit-replay':    'true',
        'x-correlation-id':  `replay-${stored.correlation_id}`,
      },
    };

    const replayReq = http.request(options, (replayRes) => {
      let body = '';
      replayRes.on('data', chunk => body += chunk);
      replayRes.on('end', () => {
        res.json({
          success:        true,
          originalStatus: stored.response_status,
          replayStatus:   replayRes.statusCode,
          replayBody:     body,
          correlationId:  `replay-${stored.correlation_id}`,
        });
      });
    });

    replayReq.on('error', (err) => {
      res.status(502).json({
        success: false,
        error:   `Replay failed: ${err.message}`,
      });
    });

    replayReq.end();
  } catch (err) {
    res.status(500).json({ success: false, error: 'Replay failed' });
  }
});

// ── Update policy (no redeploy) ───────────────────────────────────────────────
router.put('/policies/:serviceId', async (req: Request, res: Response) => {
  try {
    const { serviceId } = req.params;
    const {
      errorRateThreshold,
      latencyThresholdMs,
      halfOpenRetryMs,
      failureCountThreshold,
      fallbackStatus,
      fallbackBody,
    } = req.body;

    await db.query(
      `UPDATE policies SET
         error_rate_threshold    = COALESCE($1, error_rate_threshold),
         latency_threshold_ms    = COALESCE($2, latency_threshold_ms),
         half_open_retry_ms      = COALESCE($3, half_open_retry_ms),
         failure_count_threshold = COALESCE($4, failure_count_threshold),
         fallback_status         = COALESCE($5, fallback_status),
         fallback_body           = COALESCE($6, fallback_body),
         updated_at              = NOW()
       WHERE service_id = $7`,
      [
        errorRateThreshold,
        latencyThresholdMs,
        halfOpenRetryMs,
        failureCountThreshold,
        fallbackStatus,
        fallbackBody,
        serviceId,
      ]
    );

    // Trigger immediate registry refresh so new policy is active
    await registry.load();

    res.json({
      success: true,
      message: 'Policy updated. Active on next health evaluation cycle.',
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Policy update failed' });
  }
});


// ── Circuit breaker states (all services) ─────────────────────────────────────
router.get('/circuits', async (_req: Request, res: Response) => {
  try {
    const states = await getAllCircuitStates();
    res.json({ success: true, data: states });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Circuit state query failed' });
  }
});

// ── Full dashboard status (one call, all data) ────────────────────────────────
router.get('/dashboard', async (_req: Request, res: Response) => {
  try {
    const entries = registry.getAll();

    const serviceStatuses = await Promise.all(
      entries.map(async ({ service, policy }) => {
        const [passiveHealth, activeHealth, circuitState] = await Promise.all([
          getServiceHealth(service.id),
          getActiveHealth(service.id),
          import('../reliability/circuitBreaker').then(m =>
            m.getCircuitState(service.id)
          ),
        ]);

        // Determine overall status
        let status: 'healthy' | 'degraded' | 'down' = 'healthy';
        if (circuitState?.state === 'OPEN')       status = 'down';
        else if (circuitState?.state === 'HALF_OPEN') status = 'degraded';
        else if (passiveHealth && (
          passiveHealth.errorRate   > policy.errorRateThreshold * 0.7 ||
          passiveHealth.p95LatencyMs > policy.latencyThresholdMs * 0.7
        )) status = 'degraded';

        return {
          service: {
            id:            service.id,
            name:          service.name,
            slug:          service.slug,
            revenueImpact: service.revenueImpact,
          },
          status,
          passiveHealth,
          activeHealth,
          circuit:  circuitState ?? { state: 'CLOSED', failureCount: 0 },
          policy: {
            errorRateThreshold: policy.errorRateThreshold,
            latencyThresholdMs: policy.latencyThresholdMs,
            halfOpenRetryMs:    policy.halfOpenRetryMs,
          },
        };
      })
    );

    res.json({ success: true, data: serviceStatuses, timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Dashboard query failed' });
  }
});

// ── Incident timeline per service ─────────────────────────────────────────────
router.get('/incidents/:serviceId', async (req: Request, res: Response) => {
  try {
    const timeline = await getIncidentTimeline(req.params.serviceId as string);
    res.json({ success: true, data: timeline });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Incident query failed' });
  }
});

// ── All incidents across all services ─────────────────────────────────────────
router.get('/incidents', async (_req: Request, res: Response) => {
  try {
    const result = await db.query(
      `SELECT
         i.*,
         s.name          AS service_name,
         s.revenue_impact,
         s.slug,
         COUNT(ie.id)    AS event_count
       FROM incidents i
       JOIN services s     ON s.id = i.service_id
       LEFT JOIN incident_events ie ON ie.incident_id = i.id
       GROUP BY i.id, s.name, s.revenue_impact, s.slug
       ORDER BY i.started_at DESC
       LIMIT 50`
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Incidents query failed' });
  }
});

export default router;