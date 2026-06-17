export type RevenueImpact = 'high' | 'medium' | 'low' | 'none';
export type CircuitState  = 'CLOSED' | 'OPEN' | 'HALF_OPEN';
export type ServiceStatus = 'healthy' | 'degraded' | 'down';

export interface ServiceCard {
  service: {
    id: string;
    name: string;
    slug: string;
    revenueImpact: RevenueImpact;
  };
  status: ServiceStatus;
  passiveHealth: {
    errorRate: number;
    p95LatencyMs: number;
    requestCount: number;
  } | null;
  activeHealth: {
    ok: boolean;
    statusCode: number;
    latencyMs: number;
  } | null;
  circuit: {
    state: CircuitState;
    failureCount: number;
    nextProbeAt: number | null;
  };
  policy: {
    errorRateThreshold: number;
    latencyThresholdMs: number;
    halfOpenRetryMs: number;
  };
}

export interface IncidentRow {
  id: string;
  service_name: string;
  revenue_impact: RevenueImpact;
  slug: string;
  started_at: string;
  resolved_at: string | null;
  mttd_seconds: number | null;
  mttr_seconds: number | null;
  status: 'active' | 'resolved';
  event_count: string;
}

export interface FailedRequest {
  id: string;
  method: string;
  path: string;
  response_status: number;
  error_reason: string;
  correlation_id: string;
  timestamp: string;
  service_name: string;
  revenue_impact: RevenueImpact;
}

export interface QuotaTier {
  limit: number;
  used: number;
  percent: number;
}