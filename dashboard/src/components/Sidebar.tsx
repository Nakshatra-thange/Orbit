import { LayoutGrid, Activity, AlertTriangle, History, SlidersHorizontal, LogOut } from 'lucide-react';

const navItems = [
  { icon: LayoutGrid,          label: 'Dashboard',  active: true },

];

export function Sidebar() {
  return (
    <aside style={{
      width: 220,
      background: 'var(--bg-sidebar)',
      borderRadius: 24,
      padding: '24px 16px',
      display: 'flex',
      flexDirection: 'column',
      height: 'calc(100vh - 48px)',
      flexShrink: 0,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 8px 32px' }}>
        <div style={{
          width: 28, height: 28, borderRadius: 10,
          background: 'linear-gradient(135deg, var(--pastel-blue), var(--pastel-sage))',
        }} />
        <span style={{
          fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 19,
          color: 'var(--text-on-dark)', letterSpacing: '-0.02em',
        }}>orbit</span>
      </div>

      <div style={{
        fontSize: 11, fontWeight: 600, textTransform: 'uppercase',
        letterSpacing: '0.06em', color: '#5C5A52', padding: '0 12px 10px',
      }}>
        Platform
      </div>

      <nav style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {navItems.map(({ icon: Icon, label, active }) => (
          <button key={label} style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '10px 12px', borderRadius: 12, border: 'none',
            background: active ? 'rgba(255,255,255,0.08)' : 'transparent',
            color: active ? 'var(--text-on-dark)' : '#9C998E',
            fontSize: 14, fontWeight: 500, fontFamily: 'var(--font-body)',
            cursor: 'pointer', textAlign: 'left', transition: 'background 0.15s',
          }}>
            <Icon size={17} strokeWidth={2} />
            {label}
          </button>
        ))}
      </nav>

      <div style={{ flex: 1 }} />

      <button style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '10px 12px', borderRadius: 12, border: 'none',
        background: 'transparent', color: '#9C998E',
        fontSize: 14, fontWeight: 500, fontFamily: 'var(--font-body)', cursor: 'pointer',
      }}>
        <LogOut size={17} strokeWidth={2} />
        Sign out
      </button>
    </aside>
  );
}