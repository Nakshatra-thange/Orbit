import { db } from './db';

/*
 * Async metrics writer
 * ─────────────────────
 * Called after every proxied request.
 * Does NOT block the response — fire and forget with error swallowing.
 *
 * Why async fire-and-forget?
 * Writing a DB row on every request path would add 5-10ms latency.
 * The metric is not needed synchronously — the health scorer reads
 * it in a background job every 10 seconds. Async write costs nothing.
 *
 * Why Postgres and not Redis?
 * Metrics need to be queryable for p95 computation, time-windowed
 * aggregation, and incident timelines. Redis is fast but not a
 * good fit for analytical queries. Postgres with an index on
 * (service_id, timestamp DESC) handles 60-second rolling windows fast.
 */

export interface MetricInput {
  serviceId:      string;
  tenantId:       string;
  responseTimeMs: number;
  statusCode:     number;
  method:         string;
  path:           string;
  correlationId:  string;
  isFallback:     boolean;
}

export function writeMetric(input: MetricInput): void {
  db.query(
    `INSERT INTO service_metrics
       (service_id, tenant_id, response_time_ms, status_code,
        method, path, correlation_id, is_fallback)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      input.serviceId,
      input.tenantId,
      input.responseTimeMs,
      input.statusCode,
      input.method,
      input.path,
      input.correlationId,
      input.isFallback,
    ]
  ).catch(err =>
    console.error('[orbit:metrics] write failed:', err.message)
  );
}

export interface FailedRequestInput {
  serviceId:         string;
  tenantId:          string;
  method:            string;
  path:              string;
  sanitisedHeaders:  Record<string, string>;
  redactedBody:      Record<string, unknown> | null;
  responseStatus:    number;
  errorReason:       string;
  correlationId:     string;
}

export function writeFailedRequest(input: FailedRequestInput): void {
  db.query(
    `INSERT INTO failed_requests
       (service_id, tenant_id, method, path, sanitised_headers,
        redacted_body, response_status, error_reason, correlation_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      input.serviceId,
      input.tenantId,
      input.method,
      input.path,
      input.sanitisedHeaders,
      input.redactedBody,
      input.responseStatus,
      input.errorReason,
      input.correlationId,
    ]
  ).catch(err =>
    console.error('[orbit:metrics] failed request write error:', err.message)
  );
}