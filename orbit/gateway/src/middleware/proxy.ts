import { Request, Response, NextFunction } from 'express';

import { registry } from '../services/registry';
import { writeMetric, writeFailedRequest } from '../utils/metrics';
import { sanitiseHeaders, redactBody } from '../utils/sanitise';
import type { OrbitRequest } from '../types';
import {
  createProxyMiddleware,
  fixRequestBody,
  Options,
} from 'http-proxy-middleware';
/*
 * Proxy middleware — the core of the gateway
 * ───────────────────────────────────────────
 * Reads the URL prefix, looks up the matching service in the registry,
 * strips the prefix, and proxies the request to the upstream URL.
 *
 * URL pattern: /:slug/* → upstream_url/*
 * Example:     /order/123 → http://order-service:3003/123
 *
 * On every response:
 *   - Write a metric row asynchronously (non-blocking)
 *   - If response is 5xx or timeout: write a failed_request row
 *
 * On proxy error (service unreachable):
 *   - Return 502 with correlation ID
 *   - Write metric and failed request
 *
 * The circuit breaker layer (Day 3) sits BEFORE this middleware
 * and short-circuits before we even attempt the proxy.
 */

export function proxyMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // Extract slug from URL: /order/123 → slug='order', rest='/123'
  const parts = req.path.split('/').filter(Boolean);
  const slug  = parts[0];

  if (!slug) {
    res.status(404).json({ success: false, error: 'No service slug in path' });
    return;
  }

  const entry = registry.getBySlug(slug);
  if (!entry) {
    res.status(404).json({
      success: false,
      error:   `No service registered for slug: ${slug}`,
      correlationId: req.headers['x-correlation-id'],
    });
    return;
  }

  const { service, policy } = entry;
  const startedAt      = Date.now();
  const correlationId  = req.headers['x-correlation-id'] as string;
  const tenantId       = req.headers['x-tenant-id'] as string ?? service.tenantId;
  const orbitReq       = req as OrbitRequest;

  // Stamp service context on request so downstream middleware can read it
  req.headers['x-service-id']   = service.id;
  req.headers['x-service-name'] = service.name;

  const proxyOptions: Options = {
    target: service.upstreamUrl,
    changeOrigin: true,
  
    pathRewrite: {
      [`^/${slug}`]: '',
    },
  
    headers: {
      'x-correlation-id': correlationId,
      'x-forwarded-by': 'orbit-gateway',
    },
  
    on: {
      proxyReq: fixRequestBody,
  
      proxyRes: (proxyRes) => {
        const responseTimeMs = Date.now() - startedAt;
        const statusCode = proxyRes.statusCode ?? 0;
  
        writeMetric({
          serviceId: service.id,
          tenantId,
          responseTimeMs,
          statusCode,
          method: req.method,
          path: req.path,
          correlationId,
          isFallback: false,
        });
  
        if (statusCode >= 500) {
          writeFailedRequest({
            serviceId: service.id,
            tenantId,
            method: req.method,
            path: req.path,
            sanitisedHeaders: orbitReq.orbitSanitisedHeaders ?? sanitiseHeaders(
              req.headers as Record<string, string>
            ),
            redactedBody: req.body
              ? redactBody(req.body, policy.sensitiveFields)
              : null,
            responseStatus: statusCode,
            errorReason: '5xx',
            correlationId,
          });
        }
      },
  
      error: (err, _req, _proxyRes) => {
        const responseTimeMs = Date.now() - startedAt;
  
        console.error(
          `[orbit:proxy] ${service.name} unreachable:`,
          err.message
        );
  
        writeMetric({
          serviceId: service.id,
          tenantId,
          responseTimeMs,
          statusCode: 502,
          method: req.method,
          path: req.path,
          correlationId,
          isFallback: false,
        });
  
        writeFailedRequest({
          serviceId: service.id,
          tenantId,
          method: req.method,
          path: req.path,
          sanitisedHeaders: orbitReq.orbitSanitisedHeaders ?? sanitiseHeaders(
            req.headers as Record<string, string>
          ),
          redactedBody: req.body
            ? redactBody(req.body, policy.sensitiveFields)
            : null,
          responseStatus: 502,
          errorReason: 'connection_refused',
          correlationId,
        });
  
        if (!res.headersSent) {
          res.status(502).json({
            success: false,
            error: 'Service unavailable',
            service: service.name,
            correlationId,
          });
        }
      },
    },
  };
  
  // THIS LINE IS CRITICAL
  createProxyMiddleware(proxyOptions)(req, res, next);
  }