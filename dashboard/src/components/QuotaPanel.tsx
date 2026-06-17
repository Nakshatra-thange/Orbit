import type { QuotaTier } from '../types';

const TIER_COLOR: Record<string, string> = {
  free:       'var(--pastel-sage)',
  pro:        'var(--pastel-blue)',
  enterprise: 'var(--pastel-yellow)',
};

export function QuotaPanel({ quota }: { quota: Record<string, QuotaTier> | null }) {
  if (!quota) return null;

  return (
    <div style={{
      background: 'var(--bg-card)', borderRadius: 'var(--radius-card)',
      padding: 20, boxShadow: 'var(--shadow-card)',
    }}>
      <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 16 }}>Quota usage</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {Object.entries(quota).map(([tier, data]) => (
          <div key={tier}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
              <span style={{ fontSize: 13, fontWeight: 600, textTransform: 'capitalize' }}>{tier}</span>
              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                {data.used} / {data.limit}
              </span>
            </div>
            <div style={{
              height: 8, borderRadius: 'var(--radius-pill)',
              background: 'var(--border-soft)', overflow: 'hidden',
            }}>
              <div style={{
                height: '100%', width: `${data.percent}%`,
                background: TIER_COLOR[tier], borderRadius: 'var(--radius-pill)',
                transition: 'width 0.4s ease',
              }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}