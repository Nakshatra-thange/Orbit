import { Search, Bell, Settings } from 'lucide-react';
import {Sidebar } from './components/Sidebar';
import { ServiceStatusCard } from './components/ServiceStatusCard';
import { QuotaPanel } from './components/QuotaPanel';
import { IncidentTimeline } from './components/IncidentTimeline';
import { ReplayList } from './components/ReplayList';
import { useOrbitPoll } from './hooks/useOrbitData';
import type { ServiceCard, IncidentRow, FailedRequest, QuotaTier } from './types';
import './theme.css';

export default function App() {
  const { data: services }  = useOrbitPoll<ServiceCard[]>('/dashboard', 5000);
  const { data: incidents } = useOrbitPoll<IncidentRow[]>('/incidents', 5000);
  const { data: failed }    = useOrbitPoll<FailedRequest[]>('/failed-requests', 5000);
  const { data: quota }     = useOrbitPoll<Record<string, QuotaTier>>('/quota', 8000);

  const downCount = services?.filter(s => s.status === 'down').length ?? 0;

  return (
    <div style={{
      display: 'flex', gap: 24, padding: 24,
      minHeight: '100vh', fontFamily: 'var(--font-body)',
    }}>
      <Sidebar />

      <main style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 24 }}>

        {/* ── Top bar ──────────────────────────────────────────────────── */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10,
            background: 'var(--bg-card)', borderRadius: 'var(--radius-pill)',
            padding: '10px 18px', boxShadow: 'var(--shadow-card)', width: 340,
          }}>
            <Search size={16} color="var(--text-muted)" />
            <input placeholder="Search services, incidents…" style={{
              border: 'none', outline: 'none', background: 'transparent',
              fontSize: 14, fontFamily: 'var(--font-body)', width: '100%',
            }} />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {[Bell, Settings].map((Icon, i) => (
              <button key={i} style={{
                width: 40, height: 40, borderRadius: '50%', border: 'none',
                background: 'var(--bg-card)', boxShadow: 'var(--shadow-card)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                cursor: 'pointer',
              }}>
                <Icon size={17} color="var(--text-primary)" />
              </button>
            ))}
          </div>
        </div>

        {/* ── Greeting ─────────────────────────────────────────────────── */}
        <div>
          <h1 style={{ fontSize: 28, fontWeight: 700, letterSpacing: '-0.02em' }}>
            Good morning, Engineer 👋
          </h1>
          <p style={{ fontSize: 14, color: 'var(--text-secondary)', marginTop: 4 }}>
            {downCount === 0
              ? "All systems are healthy. Orbit is watching everything for you."
              : `${downCount} service${downCount > 1 ? 's' : ''} need attention right now.`}
          </p>
        </div>

        {/* ── Service status grid (2x2 like the reference) ─────────────── */}
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 16,
        }}>
          {services?.map(card => (
            <ServiceStatusCard key={card.service.id} card={card} />
          ))}
        </div>

        {/* ── Bottom row: timeline + quota + replay ─────────────────────── */}
        <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 16 }}>
          <IncidentTimeline incidents={incidents} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <QuotaPanel quota={quota} />
            <ReplayList requests={failed} />
          </div>
        </div>

      </main>
    </div>
  );
}