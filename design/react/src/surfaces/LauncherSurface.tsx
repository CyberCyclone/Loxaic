import React from 'react'
import { Button, Card } from '../components/primitives'

interface LauncherSurfaceProps {
  onNavigate: (surface: string) => void
}

const SURFACES = [
  { id: 'chat', title: 'Chat', desc: 'Conversations with model selection, file attachments, context tracking, and conversation forks' },
  { id: 'agent', title: 'Agent', desc: 'Agentic coding console with tool calls, planning/manual/auto modes, and live inspector' },
  { id: 'routines', title: 'Routines', desc: 'Scheduled recurring agent runs with cron builder and run history' },
  { id: 'stats', title: 'Stats', desc: 'Usage and performance analytics — tokens, cache hit rate, TTFT, generation speeds' },
]

export function LauncherSurface({ onNavigate }: LauncherSurfaceProps) {
  return (
    <div className="shell" data-od-id="launcher-shell">
      <main className="main" data-od-id="launcher-main">
        <div className="main-content">
          <div style={{ maxWidth: 800, margin: '0 auto', padding: '60px 24px' }}>
            <div style={{ textAlign: 'center', marginBottom: 48 }}>
              <div style={{ width: 48, height: 48, borderRadius: 'var(--r-md)', background: 'var(--accent)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, fontWeight: 600, color: 'var(--on-accent)', marginBottom: 16 }}>OS</div>
              <h1 style={{ fontSize: 28, fontWeight: 600, marginBottom: 8 }}>Open-Shannon</h1>
              <p style={{ fontSize: 16, color: 'var(--fg-3)' }}>Self-hosted AI assistant with agent harness</p>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              {SURFACES.map(s => (
                <Card key={s.id} odId={`launch-${s.id}`} className="prompt-card" >
                  <div onClick={() => onNavigate(s.id)} style={{ cursor: 'pointer' }}>
                    <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>{s.title}</h3>
                    <p style={{ fontSize: 13, color: 'var(--fg-3)', margin: 0 }}>{s.desc}</p>
                  </div>
                </Card>
              ))}
            </div>
          </div>
        </div>
      </main>
    </div>
  )
}
