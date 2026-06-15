// ─── Tenant & Service ─────────────────────────────────────────────────────────

export type Plan = 'starter' | 'pro' | 'enterprise';
export type RevenueImpact = 'high' | 'medium' | 'low' | 'none';
export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';
export type IncidentStatus = 'active' | 'resolved';
export type ErrorReason = 'timeout' | 'circuit_open' | '5xx' | 'connection_refused';

export type EventType =
  | 'threshold_exceeded'
  | 'circuit_opened'
  | 'circuit_half_open'
  | 'circuit_closed'
  | 'fallback_served'
  | 'alert_triggered'
  | 'service_recovered';

export interface Tenant {
  id: string;
  name: string;
  plan: Plan;
  apiKey: string;
  serviceLimit: number;
  createdAt: Date;
}

export interface Service {
  id: string;
  tenantId: string;
  name: string;
  slug: string;
  upstreamUrl: string;
  revenueImpact: RevenueImpact;
  healthCheckPath: string;
  isActive: boolean;
  createdAt: Date;
}

export interface Policy {
  id: string;
  serviceId: string;
  errorRateThreshold: number;
  latencyThresholdMs: number;
  halfOpenRetryMs: number;
  failureCountThreshold: number;
  fallbackStatus: number;
  fallbackBody: string;
  sensitiveFields: string[];
  updatedAt: Date;
}

// ─── Health & Circuit ─────────────────────────────────────────────────────────

export interface ServiceHealth {
  serviceId: string;
  errorRate: number;         // 0-1 rolling 60s
  p95LatencyMs: number;      // rolling 60s
  requestCount: number;      // rolling 60s
  circuitState: CircuitState;
  lastCheckedAt: number;     // unix ms
}

export interface CircuitBreakerState {
  serviceId: string;
  state: CircuitState;
  failureCount: number;
  lastFailureAt: number | null;
  nextProbeAt: number | null;
  openedAt: number | null;
}

// ─── Incidents ────────────────────────────────────────────────────────────────

export interface Incident {
  id: string;
  serviceId: string;
  tenantId: string;
  startedAt: Date;
  resolvedAt: Date | null;
  mttdSeconds: number | null;
  mttrSeconds: number | null;
  status: IncidentStatus;
}

export interface IncidentEvent {
  id: string;
  incidentId: string;
  serviceId: string;
  eventType: EventType;
  description: string;
  metadata: Record<string, unknown>;
  timestamp: Date;
}

// ─── Metrics & SLA ────────────────────────────────────────────────────────────

export interface ServiceMetric {
  serviceId: string;
  tenantId: string;
  responseTimeMs: number;
  statusCode: number;
  method: string;
  path: string;
  correlationId: string;
  isFallback: boolean;
  timestamp: Date;
}

export interface ServiceSla {
  serviceId: string;
  tenantId: string;
  uptimePercent: number;
  avgMttdSeconds: number | null;
  avgMttrSeconds: number | null;
  incidentCount: number;
  periodStart: Date;
  periodEnd: Date;
}

// ─── Gateway request context ──────────────────────────────────────────────────

export interface OrbitRequest {
  correlationId: string;
  userId?: string;
  userTier?: string;
  tenantId?: string;
  serviceId?: string;
  startedAt: number;
}

// ─── API responses ────────────────────────────────────────────────────────────

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  correlationId?: string;
}

export interface DashboardServiceStatus {
  service: Service;
  health: ServiceHealth;
  circuit: CircuitBreakerState;
  activeIncident: Incident | null;
  sla: ServiceSla | null;
}