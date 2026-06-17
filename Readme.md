# Orbit

> A developer reliability platform for microservices — automatic circuit breaking, incident timelines, safe request replay, and policy-driven traffic protection.

---

## The story

A service starts degrading. Without Orbit: users hit errors, support tickets trickle in, an engineer manually pieces together logs across five containers, 40 minutes pass before anyone understands what happened.

With Orbit: the platform detects the degradation in ~10 seconds, automatically opens a circuit breaker, serves fallback responses instead of timeouts, and writes a full incident timeline — threshold exceeded, circuit opened, fallback served, alert triggered, service recovered, circuit closed — with MTTD and MTTR computed automatically. An engineer opens the dashboard, sees exactly what happened and when, replays a failed request to confirm the fix, and moves on. Total time: under 10 minutes.

---

## How it works

```
Client → nginx → Orbit Gateway
                    ├── JWT auth + API keys
                    ├── Multi-tier rate limiting (rediswall)
                    ├── Circuit breaker guard
                    └── Proxy → Microservices (auth, user, order, notification)

                  Reliability layer (10s loop)
                    ├── Active health checks
                    ├── Passive health scoring (real traffic)
                    ├── Circuit breaker evaluation
                    └── Incident event sourcing
```

Every request is authenticated once, rate limited per tier, checked against the target service's circuit state, and proxied — or served a fallback instantly if the circuit is open. Every significant reliability event (threshold exceeded, circuit opened, fallback served, service recovered) is written as an immutable event, building a complete incident timeline with zero manual postmortem work.

---

## Core features

**Adaptive circuit breakers** — per-service policies stored in Postgres, editable from the dashboard with zero redeploy. Three-state machine (closed/open/half-open) evaluated every 10 seconds from both active health checks and passive traffic metrics.

**Incident timeline** — every state transition is an event. MTTD (time to detection) and MTTR (time to recovery) computed automatically from event timestamps, not estimated.

**Safe request replay** — failed requests stored with sensitive fields redacted (passwords, tokens, card numbers) and auth headers stripped entirely. Replay re-executes the sanitised request against the live system to reproduce bugs without exposing production secrets.

**Multi-tier rate limiting** — built on [`@nakshatrathange/rediswall`](https://npmjs.com/package/@nakshatrathange/rediswall), a sliding-window rate limiter I published separately. Free/pro/enterprise quotas enforced per user.

**Business impact awareness** — every service carries a revenue impact tag (high/medium/low/none) surfaced throughout the dashboard, so an "order service down" alert is visually distinct from a "background job service degraded" alert.

**Distributed tracing** — OpenTelemetry instrumentation across the gateway and every service, exported to Jaeger. Click any failed request in the dashboard to see the full trace waterfall.

**SaaS plan enforcement** — starter (3 services), pro (10 services, policy editor, replay), enterprise (unlimited). Feature gating enforced at the middleware layer.

---

## Quickstart

```bash
git clone https://github.com/yourusername/orbit
cd orbit
docker compose up --build
```

```bash
# Register and log in
curl -X POST http://localhost/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"yourpassword","tier":"pro"}'

# Generate demo traffic
npm run traffic:normal

# Trigger a circuit breaker opening
npm run traffic:fail

# Open the dashboard
cd dashboard && npm run dev
# → http://localhost:5173

# Open Jaeger for distributed traces
open http://localhost:16686
```

---

## The demo that matters

1. Open the dashboard — all four services show healthy, pastel yellow cards
2. Run `npm run traffic:fail` — watch the order service card flip to coral with a pulsing dot within ~10 seconds
3. Check the incident timeline — `threshold_exceeded → circuit_opened → alert_triggered → fallback_served`
4. Hit `/order/` directly — get a 503 fallback in under 1ms, not a timeout
5. Stop sending failure traffic, wait for the half-open probe — watch the circuit close and the card return to yellow with MTTD/MTTR displayed
6. Click "replay" on a stored failed request — watch it re-execute against the live, recovered service

---

## Architecture decisions

**Why circuit state lives in Redis, not memory.** Multiple gateway instances need to share circuit state — if one instance detects a failing service, all instances should stop sending it traffic. Redis gives shared, fast state across instances. If Redis itself fails, circuits default to closed (fail-open) — better to attempt the service than block all traffic on a Redis outage.

**Why two health signals (active + passive).** Active checks (`/health` pings) catch a fully crashed service. Passive scoring (real traffic error rate and latency) catches partial degradation that a `/health` endpoint wouldn't reflect — slow database queries on specific endpoints, for example.

**Why sensitive data is redacted before storage, not after.** Real companies cannot store JWTs, passwords, or card numbers verbatim, even for debugging. Redaction happens at write time based on a configurable field list per service policy, so replay is safe by construction rather than safe by discipline.

**Why inter-service calls bypass the gateway.** The order service calling the user service to validate a user ID goes directly over the internal Docker network, not through the public gateway. External traffic needs auth and rate limiting; internal traffic trusts headers the gateway already verified on the original request. Routing internal calls through the gateway would add latency and a circular dependency for no security benefit.

**Why polling instead of WebSockets for the dashboard.** The reliability scheduler updates state every 10 seconds. A 5-second poll catches every meaningful change with margin. WebSockets would add connection lifecycle complexity without a corresponding UX improvement at this update frequency.

---

## Tech stack

Gateway: Node.js, Express, TypeScript, `http-proxy-middleware`
Reliability: custom circuit breaker engine, Redis-backed shared state
Rate limiting: `@nakshatrathange/rediswall` (sliding window, published separately)
Async messaging: BullMQ (order events → notification processing)
Database: Postgres (relational state: services, policies, incidents, metrics)
Tracing: OpenTelemetry → Jaeger
Dashboard: React, TypeScript, Recharts, Lucide icons
Infrastructure: Docker Compose, nginx

---

## Testing

```bash
npm test                    # unit tests — pure logic, circuit state machine
npm test -- orbit.test.ts   # integration — full Docker stack required
```

---

## License

MIT