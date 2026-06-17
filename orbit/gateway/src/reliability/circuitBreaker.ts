import { redis } from '../utils/redis';
import { registry } from '../services/registry';
import { getServiceHealth } from './healthScorer';
import { getActiveHealth } from './healthChecker';
import { writeIncidentEvent, resolveIncident } from './incidents';
import type { CircuitBreakerState, CircuitState } from '../../../shared/types';

/*
 * Per-service circuit breaker
 * ────────────────────────────
 * State machine per service:
 *
 *   CLOSED ──── threshold breached ──► OPEN
 *      ▲                                 │
 *      │                                 │ cooldownMs
 *      │                                 ▼
 *      └──── probe succeeds ────── HALF_OPEN
 *                                        │
 *                                        │ probe fails
 *                                        ▼
 *                                      OPEN (reset timer)
 *
 * State stored in Redis — not in Node.js memory.
 *
 * WHY Redis and not memory (unlike rediswall's circuit breaker)?
 * rediswall's circuit breaker tracks Redis failures — if Redis is down
 * it can't store state there. So in-memory makes sense.
 *
 * Orbit's circuit breaker tracks SERVICE failures — Redis is healthy.
 * Storing circuit state in Redis means all gateway instances share
 * the same circuit state. If one instance sees the order service
 * failing and opens the circuit, ALL instances stop sending traffic.
 * That's correct distributed behaviour.
 *
 * If Redis dies, getCircuitState() returns null → we default to CLOSED
 * (fail-open) — better to try the service than to block all traffic.
 */

const CIRCUIT_KEY = (serviceId: string) => `orbit:circuit:${serviceId}`;
const CIRCUIT_TTL = 300; // 5 minutes — auto-expire stale state

export async function getCircuitState(
  serviceId: string
): Promise<CircuitBreakerState | null> {
  const raw = await redis.get(CIRCUIT_KEY(serviceId));
  return raw ? JSON.parse(raw) : null;
}

async function setCircuitState(
  serviceId: string,
  state: CircuitBreakerState
): Promise<void> {
  await redis.setex(
    CIRCUIT_KEY(serviceId),
    CIRCUIT_TTL,
    JSON.stringify(state)
  );
}

export async function evaluateCircuits(): Promise<void> {
  const entries = registry.getAll();

  await Promise.allSettled(
    entries.map(async ({ service, policy }) => {
      const [passiveHealth, activeHealth, currentState] = await Promise.all([
        getServiceHealth(service.id),
        getActiveHealth(service.id),
        getCircuitState(service.id),
      ]);

      const state = currentState ?? {
        serviceId:     service.id,
        state:         'CLOSED' as CircuitState,
        failureCount:  0,
        lastFailureAt: null,
        nextProbeAt:   null,
        openedAt:      null,
      };

      // ── HALF_OPEN: check if probe succeeded ─────────────────────────────────
      if (state.state === 'HALF_OPEN') {
        const probeSucceeded =
          activeHealth?.ok &&
          (passiveHealth?.errorRate ?? 0) < policy.errorRateThreshold &&
          (passiveHealth?.p95LatencyMs ?? 0) < policy.latencyThresholdMs;

        if (probeSucceeded) {
          // Close the circuit — service recovered
          const newState: CircuitBreakerState = {
            ...state,
            state:         'CLOSED',
            failureCount:  0,
            lastFailureAt: null,
            nextProbeAt:   null,
            openedAt:      null,
          };
          await setCircuitState(service.id, newState);

          await writeIncidentEvent({
            serviceId:   service.id,
            tenantId:    service.tenantId,
            eventType:   'circuit_closed',
            description: `${service.name} recovered — circuit closed`,
            metadata: {
              errorRate:    passiveHealth?.errorRate,
              p95LatencyMs: passiveHealth?.p95LatencyMs,
            },
          });

          await writeIncidentEvent({
            serviceId:   service.id,
            tenantId:    service.tenantId,
            eventType:   'service_recovered',
            description: `${service.name} is healthy — normal traffic resumed`,
            metadata:    {},
          });

          await resolveIncident(service.id);

          console.log(`[orbit:circuit] ✅ ${service.name} — circuit CLOSED (recovered)`);
        } else {
          // Probe failed — reopen circuit, reset timer
          const newState: CircuitBreakerState = {
            ...state,
            state:        'OPEN',
            lastFailureAt: Date.now(),
            nextProbeAt:  Date.now() + policy.halfOpenRetryMs,
          };
          await setCircuitState(service.id, newState);

          await writeIncidentEvent({
            serviceId:   service.id,
            tenantId:    service.tenantId,
            eventType:   'circuit_opened',
            description: `${service.name} probe failed — circuit reopened`,
            metadata: {
              errorRate:    passiveHealth?.errorRate,
              p95LatencyMs: passiveHealth?.p95LatencyMs,
            },
          });

          console.log(`[orbit:circuit] 🔴 ${service.name} — probe FAILED, circuit reopened`);
        }
        return;
      }

      // ── OPEN: check if cooldown expired → HALF_OPEN ─────────────────────────
      if (state.state === 'OPEN') {
        if (state.nextProbeAt && Date.now() >= state.nextProbeAt) {
          const newState: CircuitBreakerState = {
            ...state,
            state: 'HALF_OPEN',
          };
          await setCircuitState(service.id, newState);

          await writeIncidentEvent({
            serviceId:   service.id,
            tenantId:    service.tenantId,
            eventType:   'circuit_half_open',
            description: `${service.name} cooldown expired — sending probe`,
            metadata:    { nextProbeAt: state.nextProbeAt },
          });

          console.log(`[orbit:circuit] 🟡 ${service.name} — HALF_OPEN (probe sent)`);
        }
        return; // Still open and not yet time to probe
      }

      // ── CLOSED: check if thresholds breached → OPEN ──────────────────────────
      if (state.state === 'CLOSED') {
        const activeDown      = activeHealth !== null && !activeHealth.ok;
        const errorBreached   = (passiveHealth?.errorRate ?? 0)   > policy.errorRateThreshold
          && (passiveHealth?.requestCount ?? 0) >= 5; // need at least 5 requests to judge
        const latencyBreached = (passiveHealth?.p95LatencyMs ?? 0) > policy.latencyThresholdMs
          && (passiveHealth?.requestCount ?? 0) >= 5;

        const shouldOpen = activeDown || errorBreached || latencyBreached;

        if (shouldOpen) {
          const reasons: string[] = [];
          if (activeDown)      reasons.push('health check failed');
          if (errorBreached)   reasons.push(`error rate ${((passiveHealth?.errorRate ?? 0) * 100).toFixed(1)}%`);
          if (latencyBreached) reasons.push(`p95 ${passiveHealth?.p95LatencyMs}ms`);

          const newState: CircuitBreakerState = {
            serviceId:     service.id,
            state:         'OPEN',
            failureCount:  (state.failureCount ?? 0) + 1,
            lastFailureAt: Date.now(),
            nextProbeAt:   Date.now() + policy.halfOpenRetryMs,
            openedAt:      Date.now(),
          };
          await setCircuitState(service.id, newState);

          await writeIncidentEvent({
            serviceId:   service.id,
            tenantId:    service.tenantId,
            eventType:   'circuit_opened',
            description: `${service.name} circuit opened — ${reasons.join(', ')}`,
            metadata: {
              reasons,
              errorRate:    passiveHealth?.errorRate,
              p95LatencyMs: passiveHealth?.p95LatencyMs,
              activeHealthOk: activeHealth?.ok,
              nextProbeAt:  newState.nextProbeAt,
              revenueImpact: service.revenueImpact,
            },
          });

          await writeIncidentEvent({
            serviceId:   service.id,
            tenantId:    service.tenantId,
            eventType:   'alert_triggered',
            description: `🚨 ${service.name} [${service.revenueImpact.toUpperCase()} IMPACT] — traffic protection active`,
            metadata:    { revenueImpact: service.revenueImpact },
          });

          console.log(
            `[orbit:circuit] 🔴 ${service.name} [${service.revenueImpact}] — ` +
            `circuit OPENED (${reasons.join(' | ')})`
          );
        }
      }
    })
  );
}

export async function isCircuitOpen(serviceId: string): Promise<boolean> {
  const state = await getCircuitState(serviceId);
  return state?.state === 'OPEN';
}

export async function getAllCircuitStates(): Promise<CircuitBreakerState[]> {
  const entries = registry.getAll();
  const states  = await Promise.all(
    entries.map(async ({ service }) => {
      const state = await getCircuitState(service.id);
      return state ?? {
        serviceId:     service.id,
        state:         'CLOSED' as CircuitState,
        failureCount:  0,
        lastFailureAt: null,
        nextProbeAt:   null,
        openedAt:      null,
      };
    })
  );
  return states;
}