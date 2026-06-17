import { runHealthScorer }      from './healthScorer';
import { runActiveHealthChecks } from './healthChecker';
import { evaluateCircuits }     from './circuitBreaker';

/*
 * Reliability scheduler
 * ──────────────────────
 * Runs three jobs on a fixed interval.
 * Order matters:
 *   1. Active health checks — probe /health endpoints
 *   2. Passive health scorer — compute metrics from DB
 *   3. Circuit evaluator — read both signals, open/close circuits
 *
 * All three run sequentially so the circuit evaluator always has
 * fresh data from steps 1 and 2.
 *
 * Interval: 10 seconds.
 * This means worst-case detection time is ~10 seconds from when
 * a service starts failing. That's your MTTD floor.
 *
 * In production you'd tune this per service urgency — high-revenue
 * services checked every 5s, background services every 30s.
 * For Orbit the policy table already has per-service thresholds;
 * per-service check intervals would be the next feature.
 */

const INTERVAL_MS = 10_000;

let schedulerTimer: NodeJS.Timeout | null = null;

async function runReliabilityLoop(): Promise<void> {
  try {
    // Run all three in sequence so circuit evaluator has fresh data
    await runActiveHealthChecks();
    await runHealthScorer();
    await evaluateCircuits();
  } catch (err) {
    // Never let a scheduler error crash the gateway
    console.error('[orbit:scheduler] loop error:', err);
  }
}

export function startReliabilityScheduler(): void {
  console.log('[orbit:scheduler] Starting reliability loop (10s interval)');

  // Run immediately on startup — don't wait 10s for first check
  runReliabilityLoop();

  schedulerTimer = setInterval(runReliabilityLoop, INTERVAL_MS);
  schedulerTimer.unref(); // Don't prevent Node.js from exiting cleanly
}

export function stopReliabilityScheduler(): void {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}