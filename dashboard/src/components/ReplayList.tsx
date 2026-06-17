import { useState } from 'react';
import { RotateCcw } from 'lucide-react';
import type { FailedRequest } from '../types';

export function ReplayList({ requests }: { requests: FailedRequest[] | null }) {
  const [replayingId, setReplayingId] = useState<string | null>(null);
  const [replayResult, setReplayResult] = useState<Record<string, string>>({});

  async function handleReplay(id: string) {
    setReplayingId(id);
    try {
      const res  = await fetch(`http://localhost/orbit/replay/${id}`, { method: 'POST' });
      const json = await res.json();
      setReplayResult(prev => ({
        ...prev,
        [id]: json.success ? `Replayed → ${json.replayStatus}` : 'Replay failed',
      }));
    } catch {
      setReplayResult(prev => ({ ...prev, [id]: 'Replay failed' }));
    } finally {
      setReplayingId(null);
    }
  }

  if (!requests) return null;

  return (
    <div style={{
      background: 'var(--bg-card)', borderRadius: 'var(--radius-card)',
      padding: 20, boxShadow: 'var(--shadow-card)',
    }}>
      <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 16 }}>Safe replay</h3>

      {requests.length === 0 && (
        <p style={{ fontSize: 13, color: 'var(--text-muted)', padding: '12px 0' }}>
          No failed requests recently.
        </p>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {requests.slice(0, 6).map(req => (
          <div key={req.id} style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            background: 'var(--bg-page)', borderRadius: 12, padding: '10px 14px',
          }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600 }}>
                {req.method} {req.path}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
                {req.service_name} · {req.error_reason} · {req.response_status}
                {replayResult[req.id] && (
                  <span style={{ color: 'var(--pastel-sage-dk)', fontWeight: 600 }}>
                    {' '}· {replayResult[req.id]}
                  </span>
                )}
              </div>
            </div>
            <button
              onClick={() => handleReplay(req.id)}
              disabled={replayingId === req.id}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                border: 'none', background: 'var(--pastel-blue)',
                color: 'var(--text-primary)', fontSize: 12, fontWeight: 600,
                padding: '7px 12px', borderRadius: 'var(--radius-pill)',
                cursor: 'pointer', opacity: replayingId === req.id ? 0.6 : 1,
              }}
            >
              <RotateCcw size={13} />
              {replayingId === req.id ? 'Replaying…' : 'Replay'}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}