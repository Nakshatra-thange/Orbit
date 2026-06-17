import type { IncidentRow } from '../types';

const IMPACT_DOT: Record<string, string> = {
  high: 'var(--pastel-coral-dk)', medium: 'var(--pastel-pink-dk)',
  low:  'var(--pastel-sage-dk)',  none:   'var(--text-muted)',
};

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
}

function formatDuration(seconds: number | null) {
  if (seconds === null) return '—';
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function IncidentTimeline({ incidents }: { incidents: IncidentRow[] | null }) {
  if (!incidents) return null;

  return (
    <div style={{
      background: 'var(--bg-card)', borderRadius: 'var(--radius-card)',
      padding: 20, boxShadow: 'var(--shadow-card)',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h3 style={{ fontSize: 15, fontWeight: 700 }}>Incident timeline</h3>
        <span style={{
          fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)',
          background: 'var(--bg-page)', padding: '4px 10px', borderRadius: 'var(--radius-pill)',
        }}>
          {incidents.filter(i => i.status === 'active').length} active
        </span>
      </div>

      {incidents.length === 0 && (
        <p style={{ fontSize: 13, color: 'var(--text-muted)', padding: '20px 0', textAlign: 'center' }}>
          No incidents yet — everything's running smoothly.
        </p>
      )}

      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {incidents.slice(0, 8).map((incident, i) => (
          <div key={incident.id} style={{
            display: 'flex', gap: 12, padding: '12px 0',
            borderBottom: i < incidents.length - 1 ? '1px solid var(--border-soft)' : 'none',
          }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 4 }}>
              <span className={`dot ${incident.status === 'active' ? 'dot-pulse' : ''}`}
                style={{ background: IMPACT_DOT[incident.revenue_impact] }} />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{incident.service_name}</span>
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  {formatTime(incident.started_at)}
                </span>
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
                {incident.status === 'active'
                  ? `Active — ${incident.event_count} events logged`
                  : `Resolved · MTTD ${formatDuration(incident.mttd_seconds)} · MTTR ${formatDuration(incident.mttr_seconds)}`}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}