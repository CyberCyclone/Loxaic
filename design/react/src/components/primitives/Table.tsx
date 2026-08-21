import React from 'react'

interface TableProps {
  headers: React.ReactNode[]
  children: React.ReactNode
  odId?: string
}

export function Table({ headers, children, odId }: TableProps) {
  return (
    <table data-od-id={odId}>
      <thead>
        <tr>{headers.map((h, i) => <th key={i}>{h}</th>)}</tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  )
}

export function StatusDot({ color = 'success' }: { color?: string }) {
  return <span className="status-dot" style={{ background: `var(--${color})` }} />
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return <span className="kbd">{children}</span>
}

interface ProgressBarProps {
  value: number
  max?: number
  className?: string
}

export function ProgressBar({ value, max = 100, className = '' }: ProgressBarProps) {
  return (
    <div className={`download-progress ${className}`}>
      <div className="download-fill" style={{ width: `${(value / max) * 100}%` }} />
    </div>
  )
}
