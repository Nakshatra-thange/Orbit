import { Request, Response } from 'express';
import { registry } from '../services/registry';
import { writeMetric } from '../utils/metrics';
import { redis } from '../utils/redis';
import { writeIncidentEvent } from './incidents';

export async function serveFallback(
  req: Request,
  res: Response,
  serviceId: string,
  slug: string
): Promise<void> {
  const entry = registry.getBySlug(slug);

  if (!entry) {
    res.status(503).json({
      error: 'Service unavailable',
      orbit: true,
      reason: 'circuit_open',
    });

    return;
  }

  const { service, policy } = entry;

  const correlationId =
    (req.headers['x-correlation-id'] as string) ?? 'unknown';

  const tenantId =
    (req.headers['x-tenant-id'] as string) ?? service.tenantId;

  let fallbackBody: unknown;

  try {
    fallbackBody = JSON.parse(policy.fallbackBody);
  } catch {
    fallbackBody = {
      error: 'Service temporarily unavailable',
      orbit: true,
    };
  }

  // Calculate Retry-After header from circuit state
  let retryAfter = 30;

  try {
    const raw = await redis.get(
      `orbit:circuit:${service.id}`
    );

    if (raw) {
      const state = JSON.parse(raw);

      const ms =
        (state.nextProbeAt ?? Date.now() + 30_000) -
        Date.now();

      retryAfter = Math.max(
        0,
        Math.ceil(ms / 1000)
      );
    }
  } catch (err) {
    console.error(
      '[orbit:fallback] retry-after calculation failed:',
      err
    );
  }

  res.setHeader('X-Orbit-Fallback', 'true');
  res.setHeader('X-Orbit-Circuit', 'open');
  res.setHeader('X-Orbit-Service', service.name);
  res.setHeader('X-Correlation-Id', correlationId);
  res.setHeader('Retry-After', retryAfter.toString());

  res.status(policy.fallbackStatus).json(fallbackBody);

  writeMetric({
    serviceId: service.id,
    tenantId,
    responseTimeMs: 0,
    statusCode: policy.fallbackStatus,
    method: req.method,
    path: req.path,
    correlationId,
    isFallback: true,
  });

  writeIncidentEvent({
    serviceId: service.id,
    tenantId,
    eventType: 'fallback_served',
    description: `Fallback response served for ${service.name} — circuit is open`,
    metadata: {
      method: req.method,
      path: req.path,
      correlationId,
      fallbackStatus: policy.fallbackStatus,
    },
  });
}