import http from 'http';
import { registry } from '../services/registry';
import { redis } from '../utils/redis';
import { writeIncidentEvent } from './incidents';

/*
 * Active health checker — probes each service's /health endpoint
 * ──────────────────────────────────────────────────────────────
 * Runs every 10 seconds. Unlike the passive scorer which reads
 * historical metrics, this makes a live HTTP request to /health.
 *
 * Result stored in Redis as orbit:active-health:<serviceId>
 * The circuit breaker reads both active and passive health signals.
 *
 * Timeout: 3 seconds. If /health doesn't respond in 3s, the service
 * is considered unhealthy — even if it's technically running.
 * A service that can't answer /health in 3s is not serving traffic well.
 */

const ACTIVE_HEALTH_KEY = (id: string) => `orbit:active-health:${id}`;
const PROBE_TIMEOUT_MS  = 3000;

function probeService(
  url: string,
  path: string
): Promise<{ ok: boolean; statusCode: number; latencyMs: number }> {
  return new Promise((resolve) => {
    const start = Date.now();

    try {
      const parsed  = new URL(url);
      const options = {
        hostname: parsed.hostname,
        port:     Number(parsed.port) || 80,
        path,
        method:   'GET',
        timeout:  PROBE_TIMEOUT_MS,
      };

      const req = http.request(options, (res) => {
        // Drain the response body so the socket closes cleanly
        res.resume();
        resolve({
          ok:         (res.statusCode ?? 500) < 400,
          statusCode: res.statusCode ?? 0,
          latencyMs:  Date.now() - start,
        });
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({ ok: false, statusCode: 0, latencyMs: PROBE_TIMEOUT_MS });
      });

      req.on('error', () => {
        resolve({ ok: false, statusCode: 0, latencyMs: Date.now() - start });
      });

      req.end();
    } catch {
      resolve({ ok: false, statusCode: 0, latencyMs: Date.now() - start });
    }
  });
}

export async function runActiveHealthChecks(): Promise<void> {
  const entries = registry.getAll();

  await Promise.allSettled(
    entries.map(async ({ service }) => {
      const result = await probeService(
        service.upstreamUrl,
        service.healthCheckPath
      );

      const payload = {
        ok:        result.ok,
        statusCode: result.statusCode,
        latencyMs:  result.latencyMs,
        checkedAt:  Date.now(),
      };

      await redis.setex(
        ACTIVE_HEALTH_KEY(service.id),
        30, // expire after 30s — if checker stops, stale data doesn't mislead
        JSON.stringify(payload)
      );

      if (!result.ok) {
        console.log(
          `[orbit:health-check] ❌ ${service.name} — ` +
          `status ${result.statusCode}, ${result.latencyMs}ms`
        );

        await writeIncidentEvent({
          serviceId:   service.id,
          tenantId:    service.tenantId,
          eventType:   'threshold_exceeded',
          description: `${service.name} health check failed — ` +
                       `status ${result.statusCode || 'timeout'}`,
          metadata: {
            statusCode: result.statusCode,
            latencyMs:  result.latencyMs,
            probeUrl:   service.upstreamUrl + service.healthCheckPath,
          },
        });
      }
    })
  );
}

export async function getActiveHealth(
  serviceId: string
): Promise<{ ok: boolean; statusCode: number; latencyMs: number; checkedAt: number } | null> {
  const raw = await redis.get(ACTIVE_HEALTH_KEY(serviceId));
  return raw ? JSON.parse(raw) : null;
}