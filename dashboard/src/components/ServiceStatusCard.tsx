import type { ServiceCard } from '../types';

const STATUS_STYLES: Record<string, { bg: string; dot: string; label: string }> = {
  healthy:  { bg: 'var(--pastel-yellow)', dot: 'var(--pastel-yellow-dk)', label: 'Healthy' },
  degraded: { bg: 'var(--pastel-pink)',   dot: 'var(--pastel-pink-dk)',   label: 'Degraded' },
  down:     { bg: 'var(--pastel-coral)',  dot: 'var(--pastel-coral-dk)',  label: 'Down' },
};

const IMPACT_LABEL: Record<string, string> = {
  high: 'Revenue impact: High', medium: 'Revenue impact: Medium',
  low:  'Revenue impact: Low',  none:   'Revenue impact: None',
};

export function ServiceStatusCard({ card }: { card: ServiceCard }) {
  const style    = STATUS_STYLES[card.status];
  const errorPct = card.passiveHealth ? Math.round(card.passiveHealth.errorRate * 100) : 0;
  const latency  = Math.round(card.passiveHealth?.p95LatencyMs ?? 0);
  const isOpen   = card.circuit.state === 'OPEN';

  return (
    <div style={{
      background: style.bg,
      borderRadius: 'var(--radius-card)',
      padding: 20,
      display: 'flex',
      flexDirection: 'column',
      gap: 14,
      minHeight: 168,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h3 style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>
            {card.service.name}
          </h3>
          <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 3 }}>
            {IMPACT_LABEL[card.service.revenueImpact]}
          </p>
        </div>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6,
          background: 'rgba(255,255,255,0.55)', padding: '5px 10px',
          borderRadius: 'var(--radius-pill)',
        }}>
          <span
            className={`dot ${isOpen ? 'dot-pulse' : ''}`}
            style={{ background: style.dot }}
          />
          <span style={{ fontSize: 12, fontWeight: 600 }}>{style.label}</span>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 20, marginTop: 'auto' }}>
        <div>
          <div style={{ fontSize: 22, fontWeight: 700, fontFamily: 'var(--font-display)' }}>
            {errorPct}%
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>error rate</div>
        </div>
        <div>
          <div style={{ fontSize: 22, fontWeight: 700, fontFamily: 'var(--font-display)' }}>
            {latency}ms
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>p95 latency</div>
        </div>
        <div>
          <div style={{ fontSize: 22, fontWeight: 700, fontFamily: 'var(--font-display)' }}>
            {card.circuit.state === 'CLOSED' ? '—' : card.circuit.state.replace('_', ' ')}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>circuit</div>
        </div>
      </div>
    </div>
  );
}