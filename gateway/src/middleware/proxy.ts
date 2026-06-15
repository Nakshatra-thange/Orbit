import { Request, Response, NextFunction } from 'express';
import { createProxyMiddleware, Options } from 'http-proxy-middleware';
import { registry } from '../services/registry';
import { writeMetric, writeFailedRequest } from '../utils/metrics';
import { sanitiseHeaders, redactBody } from '../utils/sanitise';

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

  // Stamp service context on request so downstream middleware can read it
  req.headers['x-service-id']   = service.id;
  req.headers['x-service-name'] = service.name;

  const proxyOptions: Options = {
    target:      service.upstreamUrl,
    changeOrigin: true,

    // Strip the slug prefix before forwarding
    // /order/123 becomes /123 at the upstream
    pathRewrite: { [`^/${slug}`]: '' },

    // Forward the correlation ID to the upstream service
    headers: {
      'x-correlation-id': correlationId,
      'x-forwarded-by':   'orbit-gateway',
    },

    on: {
      proxyRes: (proxyRes, _req, _res) => {
        const responseTimeMs = Date.now() - startedAt;
        const statusCode     = proxyRes.statusCode ?? 0;

        // Write metric asynchronously — never blocks the response
        writeMetric({
          serviceId:      service.id,
          tenantId,
          responseTimeMs,
          statusCode,
          method:         req.method,
          path:           req.path,
          correlationId,
          isFallback:     false,
        });

        // Store failed requests for safe replay
        if (statusCode >= 500) {
          writeFailedRequest({
            serviceId:        service.id,
            tenantId,
            method:           req.method,
            path:             req.path,
            sanitisedHeaders: sanitiseHeaders(req.headers as Record<string, string>),
            redactedBody:     req.body
              ? redactBody(req.body, policy.sensitiveFields)
              : null,
            responseStatus:   statusCode,
            errorReason:      '5xx',
            correlationId,
          });
        }
      },

      error: (err, _req, res) => {
        const responseTimeMs = Date.now() - startedAt;
        console.error(`[orbit:proxy] ${service.name} unreachable:`, err.message);

        writeMetric({
          serviceId: service.id,
          tenantId,
          responseTimeMs,
          statusCode:   502,
          method:       req.method,
          path:         req.path,
          correlationId,
          isFallback:   false,
        });

        writeFailedRequest({
          serviceId:        service.id,
          tenantId,
          method:           req.method,
          path:             req.path,
          sanitisedHeaders: sanitiseHeaders(req.headers as Record<string, string>),
          redactedBody:     req.body
            ? redactBody(req.body, policy.sensitiveFields)
            : null,
          responseStatus:   502,
          errorReason:      'connection_refused',
          correlationId,
        });

        // res here is the http.ServerResponse, not Express Response
        if (!('headersSent' in res && res.headersSent)) {
          (res as Response).status(502).json({
            success: false,
            error:   'Service unavailable',
            service: service.name,
            correlationId,
          });
        }
      },
    },
  };

  createProxyMiddleware(proxyOptions)(req, res, next);
}