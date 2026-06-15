import { db } from '../utils/db';
import type { Service, Policy } from '../../../shared/types';

/*
 * Service registry — in-memory cache of services and policies
 * loaded from Postgres on startup and refreshed every 30 seconds.
 *
 * Why cache instead of querying on every request?
 * The gateway processes thousands of requests per second.
 * A DB query per request to look up the service config would add
 * 5-10ms latency and put unnecessary load on Postgres.
 * The cache is fast (Map lookup) and fresh (30s refresh cycle).
 *
 * Why not use Redis for this?
 * Services and policies are structured relational data with
 * join queries. Postgres is the right home. Redis holds
 * time-sensitive state (health scores, circuit states) that
 * changes every few seconds and needs sub-millisecond access.
 */

interface RegistryEntry {
  service: Service;
  policy: Policy;
}

class ServiceRegistry {
  private entries = new Map<string, RegistryEntry>(); // keyed by slug
  private byId   = new Map<string, RegistryEntry>(); // keyed by service id
  private refreshInterval: NodeJS.Timeout | null = null;

  async load(): Promise<void> {
    const result = await db.query<{
      s_id: string; s_tenant_id: string; s_name: string; s_slug: string;
      s_upstream_url: string; s_revenue_impact: string;
      s_health_check_path: string; s_is_active: boolean; s_created_at: Date;
      p_id: string; p_error_rate_threshold: number; p_latency_threshold_ms: number;
      p_half_open_retry_ms: number; p_failure_count_threshold: number;
      p_fallback_status: number; p_fallback_body: string;
      p_sensitive_fields: string[]; p_updated_at: Date;
    }>(`
      SELECT
        s.id                    AS s_id,
        s.tenant_id             AS s_tenant_id,
        s.name                  AS s_name,
        s.slug                  AS s_slug,
        s.upstream_url          AS s_upstream_url,
        s.revenue_impact        AS s_revenue_impact,
        s.health_check_path     AS s_health_check_path,
        s.is_active             AS s_is_active,
        s.created_at            AS s_created_at,
        p.id                    AS p_id,
        p.error_rate_threshold  AS p_error_rate_threshold,
        p.latency_threshold_ms  AS p_latency_threshold_ms,
        p.half_open_retry_ms    AS p_half_open_retry_ms,
        p.failure_count_threshold AS p_failure_count_threshold,
        p.fallback_status       AS p_fallback_status,
        p.fallback_body         AS p_fallback_body,
        p.sensitive_fields      AS p_sensitive_fields,
        p.updated_at            AS p_updated_at
      FROM services s
      JOIN policies p ON p.service_id = s.id
      WHERE s.is_active = TRUE
    `);

    this.entries.clear();
    this.byId.clear();

    for (const row of result.rows) {
      const entry: RegistryEntry = {
        service: {
          id:              row.s_id,
          tenantId:        row.s_tenant_id,
          name:            row.s_name,
          slug:            row.s_slug,
          upstreamUrl:     row.s_upstream_url,
          revenueImpact:   row.s_revenue_impact as Service['revenueImpact'],
          healthCheckPath: row.s_health_check_path,
          isActive:        row.s_is_active,
          createdAt:       row.s_created_at,
        },
        policy: {
          id:                     row.p_id,
          serviceId:              row.s_id,
          errorRateThreshold:     row.p_error_rate_threshold,
          latencyThresholdMs:     row.p_latency_threshold_ms,
          halfOpenRetryMs:        row.p_half_open_retry_ms,
          failureCountThreshold:  row.p_failure_count_threshold,
          fallbackStatus:         row.p_fallback_status,
          fallbackBody:           row.p_fallback_body,
          sensitiveFields:        row.p_sensitive_fields,
          updatedAt:              row.p_updated_at,
        },
      };
      this.entries.set(row.s_slug, entry);
      this.byId.set(row.s_id, entry);
    }

    console.log(`[orbit:registry] loaded ${this.entries.size} services`);
  }

  startAutoRefresh(intervalMs = 30_000): void {
    this.refreshInterval = setInterval(async () => {
      try {
        await this.load();
      } catch (err) {
        console.error('[orbit:registry] refresh failed:', err);
      }
    }, intervalMs);
    this.refreshInterval.unref();
  }

  stopAutoRefresh(): void {
    if (this.refreshInterval) clearInterval(this.refreshInterval);
  }

  getBySlug(slug: string): RegistryEntry | undefined {
    return this.entries.get(slug);
  }

  getById(id: string): RegistryEntry | undefined {
    return this.byId.get(id);
  }

  getAll(): RegistryEntry[] {
    return Array.from(this.entries.values());
  }
}

export const registry = new ServiceRegistry();