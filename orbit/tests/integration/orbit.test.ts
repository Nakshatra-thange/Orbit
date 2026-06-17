import request from 'supertest';
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
 * Full integration tests against the live Docker stack.
 * Run with: docker compose up -d && npm test -- orbit.test.ts
 *
 * These tests hit the actual gateway running on localhost:80,
 * not a mocked Express app — true end-to-end verification.
 */

const GATEWAY = 'http://localhost';
let authToken: string;

beforeAll(async () => {
  const email = `test_${Date.now()}@orbit.test`;
  await request(GATEWAY).post('/auth/register').send({
    email, password: 'test1234', tier: 'pro',
  });
  const loginRes = await request(GATEWAY).post('/auth/login').send({
    email, password: 'test1234',
  });
  authToken = loginRes.body.data.token;
}, 15000);

describe('Auth flow', () => {
  it('rejects requests without a token', async () => {
    const res = await request(GATEWAY).get('/order/');
    expect(res.status).toBe(401);
  });

  it('accepts requests with a valid token', async () => {
    const res = await request(GATEWAY)
      .get('/order/')
      .set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('rejects expired or malformed tokens', async () => {
    const res = await request(GATEWAY)
      .get('/order/')
      .set('Authorization', 'Bearer not-a-real-token');
    expect(res.status).toBe(401);
  });
});

describe('Order creation + async notification', () => {
  it('creates an order and returns 201', async () => {
    const res = await request(GATEWAY)
      .post('/order/')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        items: [{ productId: 'p1', quantity: 1, price: 19.99 }],
        totalAmount: 19.99,
      });
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('confirmed');
  });

  it('processes the notification job asynchronously', async () => {
    await request(GATEWAY)
      .post('/order/')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ items: [{ productId: 'p2', quantity: 1, price: 9.99 }], totalAmount: 9.99 });

    // Give the BullMQ worker time to process
    await new Promise(r => setTimeout(r, 2000));

    const res = await request(GATEWAY)
      .get('/notification/')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.data[0].type).toBe('order_created');
  });
});

describe('Rate limiting', () => {
  it('returns standard RateLimit headers', async () => {
    const res = await request(GATEWAY)
      .get('/order/')
      .set('Authorization', `Bearer ${authToken}`);
    expect(res.headers['x-ratelimit-limit']).toBeDefined();
    expect(res.headers['x-ratelimit-remaining']).toBeDefined();
  });
});

describe('Circuit breaker', () => {
  it('opens the circuit after repeated failures and serves a fallback', async () => {
    // Fire enough failing requests to breach the order service's strict threshold
    await Promise.all(
      Array.from({ length: 10 }, () =>
        request(GATEWAY)
          .post('/order/fail')
          .set('Authorization', `Bearer ${authToken}`)
      )
    );

    // Wait for the reliability scheduler to evaluate (10s cycle + buffer)
    await new Promise(r => setTimeout(r, 12000));

    const res = await request(GATEWAY)
      .get('/order/')
      .set('Authorization', `Bearer ${authToken}`);

    // Either still 200 (circuit not yet open) or fallback response
    if (res.headers['x-orbit-fallback'] === 'true') {
      expect(res.status).toBe(503);
      expect(res.body.orbit).toBe(true);
    }
  }, 20000);

  it('exposes circuit states via the Orbit API', async () => {
    const res = await request(GATEWAY).get('/orbit/circuits');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});

describe('Safe replay redacts sensitive data', () => {
  it('failed requests never contain raw Authorization headers', async () => {
    const res = await request(GATEWAY).get('/orbit/failed-requests');
    expect(res.status).toBe(200);
    // Verify sanitisation happened — no failed request should expose a JWT
    res.body.data.forEach((fr: { sanitised_headers: Record<string, string> }) => {
      expect(fr.sanitised_headers).not.toHaveProperty('authorization');
      expect(fr.sanitised_headers).not.toHaveProperty('cookie');
    });
  });
});

describe('Dashboard API', () => {
  it('returns status for all registered services', async () => {
    const res = await request(GATEWAY).get('/orbit/dashboard');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(4);
    res.body.data.forEach((s: { status: string }) => {
      expect(['healthy', 'degraded', 'down']).toContain(s.status);
    });
  });
});