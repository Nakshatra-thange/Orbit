import http from 'http';

/*
 * Traffic generator — creates real metrics for the reliability layer
 * ──────────────────────────────────────────────────────────────────
 * Run this after docker compose up to populate service_metrics
 * so the health scorer has data to work with and the dashboard
 * shows real graphs instead of empty charts.
 *
 * Usage:
 *   npx ts-node scripts/generateTraffic.ts
 *
 * Modes:
 *   normal  — healthy traffic, low error rate
 *   degrade — high latency on order service (triggers circuit)
 *   fail    — high error rate on order service (triggers circuit)
 */

const GATEWAY = 'localhost';
const PORT    = 80;
let   TOKEN   = ''; // set after login

function request(
  method: string,
  path:   string,
  body?:  unknown
): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const bodyStr = body ? JSON.stringify(body) : '';
    const options = {
      hostname: GATEWAY,
      port:     PORT,
      path,
      method,
      headers: {
        'Content-Type':  'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
        ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
      },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.setTimeout(5000, () => { req.destroy(); resolve({ status: 0, body: 'timeout' }); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function registerAndLogin(): Promise<void> {
  const email = `demo_${Date.now()}@orbit.test`;
  await request('POST', '/auth/register', { email, password: 'demo1234', tier: 'pro' });
  const loginRes = await request('POST', '/auth/login', { email, password: 'demo1234' });
  const parsed   = JSON.parse(loginRes.body);
  TOKEN = parsed?.data?.token ?? '';
  console.log(`[traffic] Logged in as ${email}`);
}

async function sendNormalTraffic(iterations = 20): Promise<void> {
  console.log('\n[traffic] Sending normal traffic...');
  for (let i = 0; i < iterations; i++) {
    await Promise.all([
      request('GET',  '/user/profile'),
      request('GET',  '/order/'),
      request('POST', '/order/', {
        items: [{ productId: `prod-${i}`, quantity: 1, price: 29.99 }],
        totalAmount: 29.99,
      }),
      request('GET', '/notification/'),
    ]);
    process.stdout.write('.');
    await new Promise(r => setTimeout(r, 500));
  }
  console.log('\n[traffic] Normal traffic done.');
}

async function simulateOrderDegradation(iterations = 15): Promise<void> {
  console.log('\n[traffic] Simulating order service DEGRADATION (high latency)...');
  console.log('[traffic] This will push p95 latency above threshold and open the circuit.\n');

  for (let i = 0; i < iterations; i++) {
    // Mix of slow and normal requests
    await Promise.all([
      request('POST', '/order/slow'),  // ~2.5s latency
      request('GET',  '/order/'),
      request('GET',  '/user/profile'),
    ]);
    process.stdout.write('⏱ ');
    await new Promise(r => setTimeout(r, 200));
  }
  console.log('\n[traffic] Degradation traffic done. Check /orbit/circuits for circuit state.');
}

async function simulateOrderFailures(iterations = 15): Promise<void> {
  console.log('\n[traffic] Simulating order service FAILURES (high error rate)...');
  console.log('[traffic] This will push error rate above threshold and open the circuit.\n');

  for (let i = 0; i < iterations; i++) {
    await Promise.all([
      request('POST', '/order/fail'),  // 500 response
      request('POST', '/order/fail'),
      request('GET',  '/order/'),
    ]);
    process.stdout.write('❌ ');
    await new Promise(r => setTimeout(r, 300));
  }
  console.log('\n[traffic] Failure traffic done. Check /orbit/circuits for circuit state.');
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? 'normal';

  console.log('╔══════════════════════════════════╗');
  console.log('║   Orbit traffic generator         ║');
  console.log(`║   Mode: ${mode.padEnd(24)}║`);
  console.log('╚══════════════════════════════════╝\n');

  await registerAndLogin();

  switch (mode) {
    case 'normal':
      await sendNormalTraffic(20);
      break;
    case 'degrade':
      await sendNormalTraffic(5);
      await simulateOrderDegradation(15);
      break;
    case 'fail':
      await sendNormalTraffic(5);
      await simulateOrderFailures(15);
      break;
    default:
      console.log('Usage: npx ts-node scripts/generateTraffic.ts [normal|degrade|fail]');
  }

  console.log('\n[traffic] Done. Dashboard: http://localhost/orbit/dashboard');
}

main().catch(console.error);