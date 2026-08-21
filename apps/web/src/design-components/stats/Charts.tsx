import React, { useMemo } from 'react'

function svgEl(tag: string, attrs: Record<string, any>, ...children: React.ReactNode[]): React.ReactElement {
  return React.createElement(tag, attrs, ...children)
}

interface SparklineProps {
  data: number[]
  width?: number
  height?: number
}

export function Sparkline({ data, width = 100, height = 40 }: SparklineProps) {
  const path = useMemo(() => {
    if (data.length === 0) return ''
    const max = Math.max(...data)
    const min = Math.min(...data)
    const range = max - min || 1
    const step = width / (data.length - 1 || 1)
    return data.map((v, i) => {
      const x = i * step
      const y = height - ((v - min) / range) * (height - 4) - 2
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
    }).join(' ')
  }, [data, width, height])

  const fillPath = path + ` L${width},${height} L0,${height} Z`

  return svgEl('svg', { viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'none' },
    svgEl('path', { d: fillPath, fill: 'var(--accent)', opacity: '0.15' }),
    svgEl('path', { d: path, fill: 'none', stroke: 'var(--accent)', 'strokeWidth': 1.5 }),
  )
}

interface KpiCardProps {
  label: string
  value: string
  delta: string
  deltaDir: 'up' | 'down'
  spark: number[]
}

export function KpiCard({ label, value, delta, deltaDir, spark }: KpiCardProps) {
  return (
    <div className="kpi-card">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      <div className="kpi-row">
        <span className={`kpi-delta ${deltaDir}`}>
          {deltaDir === 'up' ? '↑' : '↓'} {delta}
        </span>
      </div>
      <div className="kpi-spark">
        <Sparkline data={spark} />
      </div>
    </div>
  )
}

interface AreaChartProps {
  data: { label: string; values: Record<string, number> }[]
  series: string[]
  height?: number
}

const SERIES_COLORS = ['var(--accent)', 'var(--accent-2)', 'var(--fg-3)']

export function AreaChart({ data, series, height = 240 }: AreaChartProps) {
  const width = 600
  const padding = { top: 10, right: 10, bottom: 24, left: 40 }
  const plotW = width - padding.left - padding.right
  const plotH = height - padding.top - padding.bottom

  const allValues = data.flatMap(d => Object.values(d.values))
  const maxVal = Math.max(...allValues, 1)

  const xStep = plotW / (data.length - 1 || 1)

  return svgEl('svg', { viewBox: `0 0 ${width} ${height}`, style: 'width:100%;height:100%' },
    // Grid lines
    ...[0, 0.25, 0.5, 0.75, 1].map(f => svgEl('line', {
      x1: padding.left, x2: width - padding.right,
      y1: padding.top + plotH * (1 - f), y2: padding.top + plotH * (1 - f),
      stroke: 'var(--border)', 'strokeWidth': 1,
    })),
    // Y labels
    ...[0, 0.5, 1].map(f => svgEl('text', {
      x: padding.left - 6, y: padding.top + plotH * (1 - f) + 4,
      'textAnchor': 'end', fontSize: 10, fill: 'var(--fg-3)',
    }, formatNum(maxVal * f))),
    // Stacked areas
    ...series.map((s, si) => {
      let cumPath = ''
      const stacked: number[] = data.map(d => {
        let cum = 0
        for (let j = 0; j <= si; j++) cum += d.values[series[j]] || 0
        return cum
      })
      data.forEach((d, i) => {
        const x = padding.left + i * xStep
        const y = padding.top + plotH * (1 - stacked[i] / maxVal)
        cumPath += `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)} `
      })
      // Close path to bottom
      cumPath += `L${padding.left + (data.length - 1) * xStep},${padding.top + plotH} L${padding.left},${padding.top + plotH} Z`
      return svgEl('path', { key: si, d: cumPath, fill: SERIES_COLORS[si], opacity: 0.6 })
    }),
    // X labels
    ...data.map((d, i) => svgEl('text', {
      key: `x${i}`, x: padding.left + i * xStep, y: height - 6,
      'textAnchor': 'middle', fontSize: 10, fill: 'var(--fg-3)',
    }, d.label)),
  )
}

interface LineChartProps {
  data: { label: string; value: number }[]
  height?: number
}

export function LineChart({ data, height = 240 }: LineChartProps) {
  const width = 600
  const padding = { top: 10, right: 10, bottom: 24, left: 40 }
  const plotW = width - padding.left - padding.right
  const plotH = height - padding.top - padding.bottom
  const maxVal = Math.max(...data.map(d => d.value), 100)
  const xStep = plotW / (data.length - 1 || 1)

  const linePath = data.map((d, i) => {
    const x = padding.left + i * xStep
    const y = padding.top + plotH * (1 - d.value / maxVal)
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')

  const fillPath = linePath + ` L${padding.left + (data.length - 1) * xStep},${padding.top + plotH} L${padding.left},${padding.top + plotH} Z`

  return svgEl('svg', { viewBox: `0 0 ${width} ${height}`, style: 'width:100%;height:100%' },
    ...[0, 0.25, 0.5, 0.75, 1].map(f => svgEl('line', {
      key: `g${f}`, x1: padding.left, x2: width - padding.right,
      y1: padding.top + plotH * (1 - f), y2: padding.top + plotH * (1 - f),
      stroke: 'var(--border)', 'strokeWidth': 1,
    })),
    ...[0, 0.5, 1].map(f => svgEl('text', {
      key: `y${f}`, x: padding.left - 6, y: padding.top + plotH * (1 - f) + 4,
      'textAnchor': 'end', fontSize: 10, fill: 'var(--fg-3)',
    }, `${Math.round(maxVal * f)}%`)),
    svgEl('path', { d: fillPath, fill: 'var(--accent)', opacity: 0.15 }),
    svgEl('path', { d: linePath, fill: 'none', stroke: 'var(--accent)', 'strokeWidth': 2 }),
    ...data.map((d, i) => svgEl('text', {
      key: `x${i}`, x: padding.left + i * xStep, y: height - 6,
      'textAnchor': 'middle', fontSize: 10, fill: 'var(--fg-3)',
    }, d.label)),
  )
}

interface BarChartProps {
  data: { label: string; values: number[] }[]
  seriesLabels: string[]
  height?: number
}

export function BarChart({ data, seriesLabels, height = 240 }: BarChartProps) {
  const width = 600
  const padding = { top: 10, right: 10, bottom: 24, left: 40 }
  const plotW = width - padding.left - padding.right
  const plotH = height - padding.top - padding.bottom
  const maxVal = Math.max(...data.flatMap(d => d.values), 1)
  const barW = plotW / data.length / (seriesLabels.length + 1)

  return svgEl('svg', { viewBox: `0 0 ${width} ${height}`, style: 'width:100%;height:100%' },
    ...[0, 0.25, 0.5, 0.75, 1].map(f => svgEl('line', {
      key: `g${f}`, x1: padding.left, x2: width - padding.right,
      y1: padding.top + plotH * (1 - f), y2: padding.top + plotH * (1 - f),
      stroke: 'var(--border)', 'strokeWidth': 1,
    })),
    ...[0, 0.5, 1].map(f => svgEl('text', {
      key: `y${f}`, x: padding.left - 6, y: padding.top + plotH * (1 - f) + 4,
      'textAnchor': 'end', fontSize: 10, fill: 'var(--fg-3)',
    }, formatNum(maxVal * f))),
    ...data.flatMap((d, di) =>
      d.values.map((v, si) => svgEl('rect', {
        key: `b${di}${si}`,
        x: padding.left + di * (plotW / data.length) + si * barW + barW * 0.5,
        y: padding.top + plotH * (1 - v / maxVal),
        width: barW * 0.8,
        height: plotH * (v / maxVal),
        fill: SERIES_COLORS[si],
        rx: 2,
      }))
    ),
    ...data.map((d, i) => svgEl('text', {
      key: `x${i}`, x: padding.left + i * (plotW / data.length) + (plotW / data.length) / 2,
      y: height - 6, 'textAnchor': 'middle', fontSize: 10, fill: 'var(--fg-3)',
    }, d.label)),
  )
}

interface PercentileBarsProps {
  data: { model: string; p50: number; p95: number; p99: number }[]
}

export function PercentileBars({ data }: PercentileBarsProps) {
  const maxVal = Math.max(...data.flatMap(d => [d.p50, d.p95, d.p99]), 1)
  return (
    <div>
      {data.map((d, i) => (
        <div key={i} style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 4 }}>{d.model}</div>
          {[
            { label: 'p50', val: d.p50 },
            { label: 'p95', val: d.p95 },
            { label: 'p99', val: d.p99 },
          ].map((p, j) => (
            <div key={j} className="pct-row" style={{ marginBottom: 2 }}>
              <span style={{ fontSize: 12, color: 'var(--fg-3)', width: 30 }}>{p.label}</span>
              <div className="pct-bar">
                <div className="pct-fill" style={{ width: `${(p.val / maxVal) * 100}%` }} />
              </div>
              <span style={{ fontSize: 12, color: 'var(--fg-2)' }}>{p.val}ms</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(0)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`
  return Math.round(n).toString()
}
