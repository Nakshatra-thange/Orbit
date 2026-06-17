import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { JaegerExporter } from '@opentelemetry/exporter-jaeger';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';

/*
 * OpenTelemetry setup — distributed tracing across the gateway
 * ────────────────────────────────────────────────────────────
 * Every HTTP request, every outgoing proxy call, every Postgres query,
 * and every Redis call gets wrapped in a trace span automatically via
 * auto-instrumentation. No manual span creation needed for the basics.
 *
 * Traces export to Jaeger, where you can see the full waterfall:
 *   gateway receives → auth check (5ms) → rate limit check (2ms) →
 *   proxy to order-service (1840ms) → response
 *
 * This is how you answer "where exactly did the 2-second request go?"
 * without grep-ing through five different container logs.
 */

const jaegerExporter = new JaegerExporter({
  endpoint: process.env.OTEL_EXPORTER_JAEGER_ENDPOINT
    ?? 'http://localhost:14268/api/traces',
});

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [SemanticResourceAttributes.SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? 'orbit-gateway',
  }),
  traceExporter: jaegerExporter,
  instrumentations: [
    getNodeAutoInstrumentations({
      // Reduce noise — don't trace fs operations, too verbose
      '@opentelemetry/instrumentation-fs': { enabled: false },
    }),
  ],
});

sdk.start();
console.log('[orbit:tracing] OpenTelemetry started — exporting to Jaeger');

process.on('SIGTERM', () => {
  sdk.shutdown()
    .then(() => console.log('[orbit:tracing] shut down cleanly'))
    .catch(err => console.error('[orbit:tracing] shutdown error:', err))
    .finally(() => process.exit(0));
});

export { sdk };