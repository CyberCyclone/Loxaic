import React, { useState, useEffect } from 'react'
import { AppShell } from '../components/layout'
import { SettingsModal } from '../components/settings'
import { KpiCard, AreaChart, LineChart, BarChart, PercentileBars } from '../components/stats'
import { Badge, Table } from '../components/primitives'
import { KPIS, TOKENS_OVER_TIME, CACHE_HIT_RATE, MODEL_SPEEDS, PER_CONV_STATS, RANGES } from '../fixtures/stats'
import type { PerModelStat, PerConvStat } from '../types'

interface StatsSurfaceProps {
  onNavigate: (surface: string) => void
}

const SERIES = ['Llama 3.1 8B', 'Qwen 2.5 14B', 'Phi 3 Mini']

export function StatsSurface({ onNavigate }: StatsSurfaceProps) {
  const [range, setRange] = useState<string>('today')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [, forceRender] = useState(0)

  useEffect(() => {
    const handler = () => forceRender(n => n + 1)
    window.addEventListener('themechange', handler)
    return () => window.removeEventListener('themechange', handler)
  }, [])

  const kpis = KPIS[range] || KPIS.today
  const tokensData = TOKENS_OVER_TIME[range] || TOKENS_OVER_TIME.today
  const cacheData = CACHE_HIT_RATE[range] || CACHE_HIT_RATE.today

  return (
    <AppShell
      activeSurface="stats"
      onNavigate={onNavigate}
      onOpenSettings={() => setSettingsOpen(true)}
      onNewChat={() => onNavigate('chat')}
      title="Usage & Performance"
      headerExtras={<Badge tone="success">Live</Badge>}
    >
      <div className="range-tabs" data-od-id="range-tabs" style={{ paddingTop: 24 }}>
        {RANGES.map(r => (
          <button
            key={r}
            className={`range-tab ${range === r ? 'active' : ''}`}
            onClick={() => setRange(r)}
          >
            {r.charAt(0).toUpperCase() + r.slice(1)}
          </button>
        ))}
      </div>

      <div className="stats-grid" data-od-id="kpi-row">
        {kpis.map((kpi, i) => (
          <KpiCard key={i} {...kpi} />
        ))}
      </div>

      <div className="charts-row">
        <div className="chart-card">
          <div className="card-header">
            <span className="card-title">Tokens Over Time</span>
            <div className="chart-legend">
              {SERIES.map((s, i) => (
                <span key={s} className="legend-item">
                  <span className="legend-dot" style={{ background: ['var(--accent)', 'var(--accent-2)', 'var(--fg-3)'][i] }} />
                  {s}
                </span>
              ))}
            </div>
          </div>
          <div className="chart-area">
            <AreaChart data={tokensData} series={SERIES} />
          </div>
        </div>
        <div className="chart-card">
          <div className="card-header"><span className="card-title">Cache Hit Rate</span></div>
          <div className="chart-area">
            <LineChart data={cacheData} />
          </div>
        </div>
      </div>

      <div className="charts-row">
        <div className="chart-card">
          <div className="card-header"><span className="card-title">Processing Speeds (tok/s)</span></div>
          <div className="chart-area">
            <BarChart
              data={MODEL_SPEEDS.map(m => ({ label: m.model.split(' ')[0], values: [m.ppSpeed, m.tgSpeed] }))}
              seriesLabels={['Pre-fill (pp)', 'Generation (tg)']}
            />
          </div>
        </div>
        <div className="chart-card">
          <div className="card-header"><span className="card-title">TTFT Percentiles</span></div>
          <PercentileBars
            data={MODEL_SPEEDS.map(m => ({ model: m.model, p50: m.ttftP50, p95: m.ttftP95, p99: m.ttftP99 }))}
          />
        </div>
      </div>

      <div className="tables-row">
        <div className="chart-card">
          <div className="card-header"><span className="card-title">Per-Model Usage</span></div>
          <Table headers={['Model', 'Convs', 'Tokens', 'Cache %', 'pp', 'tg']}>
            {MODEL_SPEEDS.map((m, i) => (
              <tr key={i}>
                <td>{m.model}</td>
                <td>{m.conversations}</td>
                <td>{m.tokens.toLocaleString()}</td>
                <td>{m.cachePct}%</td>
                <td>{m.ppSpeed}</td>
                <td>{m.tgSpeed}</td>
              </tr>
            ))}
          </Table>
        </div>
        <div className="chart-card">
          <div className="card-header"><span className="card-title">Per-Conversation Usage</span></div>
          <Table headers={['Title', 'Model', 'Tokens', 'Cache %', 'Time']}>
            {PER_CONV_STATS.map((c, i) => (
              <tr key={i}>
                <td>{c.title}</td>
                <td>{c.model}</td>
                <td>{c.tokens.toLocaleString()}</td>
                <td>{c.cachePct}%</td>
                <td>{c.time}</td>
              </tr>
            ))}
          </Table>
        </div>
      </div>

      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </AppShell>
  )
}
