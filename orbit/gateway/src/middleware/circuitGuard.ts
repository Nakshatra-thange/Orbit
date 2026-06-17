import { Request, Response, NextFunction } from 'express';
import { isCircuitOpen } from '../reliability/circuitBreaker';
import { serveFallback }  from '../reliability/fallback';

/*
 * Circuit guard middleware
 * ─────────────────────────
 * Sits between rate limiting and proxy in the gateway pipeline.
 * Checks circuit state BEFORE attempting the proxy.
 *
 * Pipeline order:
 *   auth → rateLimitMiddleware → circuitGuard → proxy
 *
 * If circuit is OPEN:
 *   serveFallback() responds immediately. proxy never runs.
 *   Response time: <1ms instead of 2000ms timeout.
 *
 * If circuit is CLOSED or HALF_OPEN:
 *   next() — proxy runs normally.
 *   (HALF_OPEN lets one request through as the probe)
 */

export async function circuitGuard(
  req:  Request,
  res:  Response,
  next: NextFunction
): Promise<void> {
  const parts = req.path.split('/').filter(Boolean);
  const slug  = parts[0];

  if (!slug) return next();

  // Import registry lazily to avoid circular dependency
  const { registry } = await import('../services/registry');
  const entry = registry.getBySlug(slug);

  if (!entry) return next();

  const open = await isCircuitOpen(entry.service.id);

  if (open) {
    await serveFallback(req, res, entry.service.id, slug);
    return;
  }

  next();
}