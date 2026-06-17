import { db } from '../utils/db';
import { redis } from '../utils/redis';
import { registry } from '../services/registry';
import { writeIncidentEvent } from './incidents';
import type { ServiceHealth } from '../../../shared/types';

/*
 * Health scorer — passive monitoring from real traffic
 * ─────────────────────────────────────────────────────
 * Runs every 10 seconds. For each registered service:
 *   1. Query the last 60 seconds of service_metrics from Postgres
 *   2. Compute error rate and p95 latency
 *   3. Compare against the service's policy thresholds
 *   4. Write the health score to Redis (fast reads by circuit breaker)
 *   5. If thresholds are breached, write a threshold_exceeded event
 *
 * WHY two health signals (active + passive)?
 *
 * Active health check (Step 3) pings /health every 10s.
 * It catches: service is completely down, /health returns 500.
 * It misses: service is up but slow, service is up but returning errors
 *            on specific endpoints, database is slow under load.
 *
 * Passive health scoring reads real traffic metrics.
 * It catches: elevated error rates on any endpoint, latency spikes,
 *             partial degradation that doesn't affect /health.
 * It misses: service crash between health check intervals.
 *
 * Together they cover the full failure surface.
 * This is exactly how Datadog and New Relic work.
 */

const HEALTH_KEY = (serviceId: string) => `orbit:health:${serviceId}`;
const HEALTH_TTL = 120; // seconds — expire if scorer stops running

export async function computeServiceHealth(
  serviceId: string,
  tenantId:  string
): Promise<ServiceHealth> {
  // Rolling 60-second window query
  const result = await db.query<{
    total:       string;
    errors:      string;
    p95_latency: string | null;
  }>(
    `SELECT
       COUNT(*)                                            AS total,
       COUNT(*) FILTER (WHERE status_code >= 500)         AS errors,
       PERCENTILE_CONT(0.95) WITHIN GROUP
         (ORDER BY response_time_ms)                      AS p95_latency
     FROM service_metrics
     WHERE service_id = $1
       AND tenant_id  = $2
       AND timestamp  > NOW() - INTERVAL '60 seconds'
       AND is_fallback = FALSE`,
    [serviceId, tenantId]
  );

  const row          = result.rows[0];
  const total        = Number(row.total);
  const errors       = Number(row.errors);
  const errorRate    = total > 0 ? errors / total : 0;
  const p95LatencyMs = Number(row.p95_latency ?? 0);

  // Read current circuit state from Redis (written by circuit breaker)
  const circuitRaw = await redis.get(`orbit:circuit:${serviceId}`);
  const circuit    = circuitRaw
    ? JSON.parse(circuitRaw)
    : { state: 'CLOSED' };

  const health: ServiceHealth = {
    serviceId,
    errorRate:      Number(errorRate.toFixed(4)),
    p95LatencyMs,
    requestCount:   total,
    circuitState:   circuit.state,
    lastCheckedAt:  Date.now(),
  };

  // Write health score to Redis — circuit breaker reads this
  await redis.setex(
    HEALTH_KEY(serviceId),
    HEALTH_TTL,
    JSON.stringify(health)
  );

  return health;
}

export async function getServiceHealth(
  serviceId: string
): Promise<ServiceHealth | null> {
  const raw = await redis.get(HEALTH_KEY(serviceId));
  return raw ? JSON.parse(raw) : null;
}

export async function runHealthScorer(): Promise<void> {
  const entries = registry.getAll();
  if (entries.length === 0) return;

  await Promise.allSettled(
    entries.map(async ({ service, policy }) => {
      try {
        const health = await computeServiceHealth(
          service.id,
          service.tenantId
        );

        const errorBreached   = health.errorRate   > policy.errorRateThreshold;
        const latencyBreached = health.p95LatencyMs > policy.latencyThresholdMs
          && health.requestCount > 0; // ignore latency if no traffic

        if (errorBreached || latencyBreached) {
          const reasons: string[] = [];
          if (errorBreached)
            reasons.push(
              `error rate ${(health.errorRate * 100).toFixed(1)}% ` +
              `> threshold ${(policy.errorRateThreshold * 100).toFixed(0)}%`
            );
          if (latencyBreached)
            reasons.push(
              `p95 latency ${health.p95LatencyMs}ms ` +
              `> threshold ${policy.latencyThresholdMs}ms`
            );

          await writeIncidentEvent({
            serviceId:   service.id,
            tenantId:    service.tenantId,
            eventType:   'threshold_exceeded',
            description: `${service.name} threshold exceeded: ${reasons.join(', ')}`,
            metadata: {
              errorRate:         health.errorRate,
              p95LatencyMs:      health.p95LatencyMs,
              requestCount:      health.requestCount,
              thresholds: {
                errorRate:  policy.errorRateThreshold,
                latencyMs:  policy.latencyThresholdMs,
              },
            },
          });

          console.log(
            `[orbit:health] ⚠️  ${service.name} degraded — ${reasons.join(' | ')}`
          );
        }
      } catch (err) {
        console.error(
          `[orbit:health] scorer failed for ${service.name}:`, err
        );
      }
    })
  );
}