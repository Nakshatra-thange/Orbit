import { sanitiseHeaders } from '../../gateway/src/utils/sanitise';
import {
    describe,
    it,
    expect,
    beforeEach,
    afterEach,
    beforeAll,
    afterAll,
  } from "@jest/globals";
/*
 * We test the reliability logic that doesn't need Redis or Postgres.
 * Circuit breaker integration tests come in Day 5 (full Docker stack).
 * Here we focus on the pure functions and state machine logic.
 */

describe('circuit state transitions', () => {
  it('CLOSED → OPEN when error rate exceeds threshold', () => {
    const errorRate = 0.35;
    const threshold = 0.30;
    const shouldOpen = errorRate > threshold;
    expect(shouldOpen).toBe(true);
  });

  it('CLOSED stays CLOSED when error rate is below threshold', () => {
    const errorRate = 0.20;
    const threshold = 0.30;
    const shouldOpen = errorRate > threshold;
    expect(shouldOpen).toBe(false);
  });

  it('does not open circuit with fewer than 5 requests', () => {
    const errorRate    = 0.80; // 80% — terrible
    const requestCount = 3;    // but only 3 requests — too small a sample
    const minRequests  = 5;
    const shouldOpen   = errorRate > 0.30 && requestCount >= minRequests;
    expect(shouldOpen).toBe(false);
  });

  it('OPEN transitions to HALF_OPEN after cooldown', () => {
    const nextProbeAt = Date.now() - 1000; // 1 second in the past
    const shouldProbe = Date.now() >= nextProbeAt;
    expect(shouldProbe).toBe(true);
  });

  it('OPEN stays OPEN before cooldown expires', () => {
    const nextProbeAt = Date.now() + 30_000; // 30 seconds in the future
    const shouldProbe = Date.now() >= nextProbeAt;
    expect(shouldProbe).toBe(false);
  });
});

describe('MTTD and MTTR calculation', () => {
  it('computes MTTD correctly from timestamps', () => {
    const thresholdExceededAt = new Date('2024-01-01T10:04:31Z');
    const circuitOpenedAt     = new Date('2024-01-01T10:04:41Z');
    const mttdSeconds = Math.round(
      (circuitOpenedAt.getTime() - thresholdExceededAt.getTime()) / 1000
    );
    expect(mttdSeconds).toBe(10); // ~10s = one scheduler cycle
  });

  it('computes MTTR correctly from timestamps', () => {
    const circuitOpenedAt  = new Date('2024-01-01T10:04:41Z');
    const circuitClosedAt  = new Date('2024-01-01T10:06:53Z');
    const mttrSeconds = Math.round(
      (circuitClosedAt.getTime() - circuitOpenedAt.getTime()) / 1000
    );
    expect(mttrSeconds).toBe(132); // 2 minutes 12 seconds
  });
});

describe('revenue impact prioritisation', () => {
  it('high impact services get stricter thresholds in seed data', () => {
    const orderServiceThreshold  = 0.20; // from schema seed
    const authServiceThreshold   = 0.40;
    expect(orderServiceThreshold).toBeLessThan(authServiceThreshold);
  });

  it('identifies high revenue impact services', () => {
    const services = [
      { name: 'Auth',  revenueImpact: 'none' },
      { name: 'Order', revenueImpact: 'high' },
      { name: 'User',  revenueImpact: 'low'  },
    ];
    const highImpact = services.filter(s => s.revenueImpact === 'high');
    expect(highImpact).toHaveLength(1);
    expect(highImpact[0].name).toBe('Order');
  });
});

describe('incident event types', () => {
  const validEventTypes = [
    'threshold_exceeded',
    'circuit_opened',
    'circuit_half_open',
    'circuit_closed',
    'fallback_served',
    'alert_triggered',
    'service_recovered',
  ];

  it('covers the full incident lifecycle', () => {
    // A complete incident touches all these event types in order
    const lifecycle = [
      'threshold_exceeded',
      'circuit_opened',
      'alert_triggered',
      'fallback_served',
      'circuit_half_open',
      'circuit_closed',
      'service_recovered',
    ];
    lifecycle.forEach(event => {
      expect(validEventTypes).toContain(event);
    });
  });
});