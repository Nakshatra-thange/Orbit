import { Request, Response } from 'express';
import { registry } from '../services/registry';
import { writeMetric } from '../utils/metrics';
import { writeIncidentEvent } from './incidents';
/* 
 * Fallback engine
 * When the circuit is OPEN, we never proxy the request.
 * Instead we serve a fallback response immediately — in microseconds,
 * not after a 2-second timeout.
 * Fallback content comes from the service's policy in Postgres.
 * The ops team can update it from the dashboard without redeploying.
 * WHY this matters:
 * A 503 from the gateway in <1ms is infinitely better than:
 *   - A 30s timeout waiting for a dead service
 *   - A 502 after the proxy gives up
 *   - Other services hanging waiting for a response
 * We also write a fallback_served event to the incident timeline
 * so you can see exactly how many requests were protected.
 */
export async function serveFallback(
  req:       Request,
  res:       Response,
  serviceId: string,
  slug:      string
): Promise<void> {
  const entry = registry.getBySlug(slug);
  if (!entry) {
    res.status(503).json({
      error:  'Service unavailable',
      orbit:  true,
      reason: 'circuit_open',
    });
    return;
  }
  const { service, policy } = entry;
  const correlationId = req.headers['x-correlation-id'] as string;
  const tenantId      = req.headers['x-tenant-id'] as string ?? service.tenantId;
  let fallbackBody: unknown;
  try {
    fallbackBody = JSON.parse(policy.fallbackBody);
  } catch {
    fallbackBody = { error: 'Service temporarily unavailable', orbit: true };
  }
  res.setHeader('X-Orbit-Fallback',  'true');
  res.setHeader('X-Orbit-Circuit',   'open');
  res.setHeader('X-Orbit-Service',   service.name);
  res.setHeader('X-Correlation-Id',  correlationId);
  res.setHeader('Retry-After',        Math.ceil(
    (await import('../utils/redis')).then(async ({ redis }) => {
      const raw = await redis.get(`orbit:circuit:${service.id}`);
      if (!raw) return 30;
      const state = JSON.parse(raw);
      const ms    = (state.nextProbeAt ?? Date.now() + 30_000) - Date.now();
      return Math.max(0, Math.ceil(ms / 1000));
    })
  ));
  res.status(policy.fallbackStatus).json(fallbackBody);
  writeMetric({
    serviceId:      service.id,
    tenantId,
    responseTimeMs: 0, 
    statusCode:     policy.fallbackStatus,
    method:         req.method,
    path:           req.path,
    correlationId,
    isFallback:     true,
  });
  // Write to incident timeline
  writeIncidentEvent({
    serviceId:   service.id,
    tenantId,
    eventType:   'fallback_served',
    description: `Fallback response served for ${service.name} — circuit is open`,
    metadata: {
      method:        req.method,
      path:          req.path,
      correlationId,
      fallbackStatus: policy.fallbackStatus,
    },
  });
}