-- ─── Tenants (SaaS multi-tenancy) ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  plan VARCHAR(50) NOT NULL DEFAULT 'starter',  -- starter | pro | enterprise
  api_key VARCHAR(255) NOT NULL UNIQUE,
  service_limit INT NOT NULL DEFAULT 3,          -- enforced per plan
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Users ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  tier VARCHAR(50) NOT NULL DEFAULT 'free',     -- free | pro | enterprise
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Services (registered by tenants) ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS services (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(100) NOT NULL,                   -- used in URL prefix /slug/*
  upstream_url VARCHAR(500) NOT NULL,           -- where gateway proxies to
  revenue_impact VARCHAR(20) NOT NULL DEFAULT 'medium', -- high|medium|low|none
  health_check_path VARCHAR(255) NOT NULL DEFAULT '/health',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id, slug)
);

-- ─── Policies (configurable per service, no redeploy) ────────────────────────
CREATE TABLE IF NOT EXISTS policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id UUID REFERENCES services(id) ON DELETE CASCADE UNIQUE,
  error_rate_threshold FLOAT NOT NULL DEFAULT 0.30,    -- 30% error rate opens circuit
  latency_threshold_ms INT NOT NULL DEFAULT 2000,      -- 2s p95 opens circuit
  half_open_retry_ms INT NOT NULL DEFAULT 30000,       -- 30s cooldown
  failure_count_threshold INT NOT NULL DEFAULT 5,      -- consecutive failures
  fallback_status INT NOT NULL DEFAULT 503,
  fallback_body TEXT NOT NULL DEFAULT '{"error":"Service temporarily unavailable","orbit":true}',
  sensitive_fields TEXT[] NOT NULL DEFAULT ARRAY['password','token','secret','card','cvv','ssn','authorization'],
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Incidents ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS incidents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id UUID REFERENCES services(id) ON DELETE CASCADE,
  tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  mttd_seconds INT,                             -- time from first signal to circuit open
  mttr_seconds INT,                             -- time from circuit open to circuit closed
  status VARCHAR(20) NOT NULL DEFAULT 'active'  -- active | resolved
);

-- ─── Incident events (the timeline) ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS incident_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id UUID REFERENCES incidents(id) ON DELETE CASCADE,
  service_id UUID REFERENCES services(id) ON DELETE CASCADE,
  event_type VARCHAR(50) NOT NULL,
  -- threshold_exceeded | circuit_opened | circuit_half_open |
  -- circuit_closed | fallback_served | alert_triggered | service_recovered
  description TEXT NOT NULL,
  metadata JSONB,                               -- error rate, latency, count etc
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Service metrics (every proxied request) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS service_metrics (
  id BIGSERIAL PRIMARY KEY,
  service_id UUID REFERENCES services(id) ON DELETE CASCADE,
  tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
  response_time_ms INT NOT NULL,
  status_code INT NOT NULL,
  method VARCHAR(10) NOT NULL,
  path VARCHAR(500) NOT NULL,
  correlation_id VARCHAR(100) NOT NULL,
  is_fallback BOOLEAN NOT NULL DEFAULT FALSE,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for fast rolling window queries (used by health scorer every 10s)
CREATE INDEX IF NOT EXISTS idx_metrics_service_timestamp
  ON service_metrics(service_id, timestamp DESC);

-- ─── Failed requests (safe replay) ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS failed_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id UUID REFERENCES services(id) ON DELETE CASCADE,
  tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
  method VARCHAR(10) NOT NULL,
  path VARCHAR(500) NOT NULL,
  sanitised_headers JSONB NOT NULL,             -- Authorization stripped
  redacted_body JSONB,                          -- sensitive values replaced with ***
  response_status INT NOT NULL,
  error_reason VARCHAR(100) NOT NULL,           -- timeout | circuit_open | 5xx
  correlation_id VARCHAR(100) NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Service SLA (computed by background job) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS service_sla (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id UUID REFERENCES services(id) ON DELETE CASCADE,
  tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
  uptime_percent FLOAT NOT NULL,
  avg_mttd_seconds INT,
  avg_mttr_seconds INT,
  incident_count INT NOT NULL DEFAULT 0,
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Seed: demo tenant ────────────────────────────────────────────────────────
INSERT INTO tenants (id, name, plan, api_key, service_limit)
VALUES (
  'a0000000-0000-0000-0000-000000000001',
  'Demo Company',
  'pro',
  'orbit_demo_key_123',
  10
) ON CONFLICT DO NOTHING;

-- ─── Seed: demo services ──────────────────────────────────────────────────────
INSERT INTO services (id, tenant_id, name, slug, upstream_url, revenue_impact, health_check_path)
VALUES
  ('b0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001',
   'Auth Service',   'auth',   'http://auth-service:3001',         'none',   '/health'),
  ('b0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001',
   'User Service',   'user',   'http://user-service:3002',         'low',    '/health'),
  ('b0000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000001',
   'Order Service',  'order',  'http://order-service:3003',        'high',   '/health'),
  ('b0000000-0000-0000-0000-000000000004', 'a0000000-0000-0000-0000-000000000001',
   'Notification Service', 'notification', 'http://notification-service:3004', 'low', '/health')
ON CONFLICT DO NOTHING;

-- ─── Seed: default policies per service ──────────────────────────────────────
INSERT INTO policies (service_id, error_rate_threshold, latency_threshold_ms, half_open_retry_ms, failure_count_threshold)
VALUES
  ('b0000000-0000-0000-0000-000000000001', 0.40, 2000, 30000, 5),
  ('b0000000-0000-0000-0000-000000000002', 0.30, 2000, 30000, 5),
  ('b0000000-0000-0000-0000-000000000003', 0.20, 1500, 15000, 3),  -- stricter: high revenue impact
  ('b0000000-0000-0000-0000-000000000004', 0.40, 3000, 30000, 5)
ON CONFLICT DO NOTHING;

-- ─── Orders ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS orders (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL,
  tenant_id    UUID REFERENCES tenants(id) ON DELETE CASCADE,
  items        JSONB NOT NULL DEFAULT '[]',
  total_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
  status       VARCHAR(50) NOT NULL DEFAULT 'pending',
  -- pending | confirmed | processing | shipped | delivered | cancelled
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orders_user_id
  ON orders(user_id, created_at DESC);

-- ─── Notifications ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL,
  tenant_id    UUID REFERENCES tenants(id) ON DELETE CASCADE,
  type         VARCHAR(50) NOT NULL,   -- order_created | order_shipped | etc
  title        VARCHAR(255) NOT NULL,
  message      TEXT NOT NULL,
  metadata     JSONB,
  read         BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);