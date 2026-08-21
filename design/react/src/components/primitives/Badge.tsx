import React from 'react'
import type { ModelLocation } from '../../types'

type Tone = 'chat' | 'agent' | 'routine' | 'danger' | 'success' | 'warning' | 'server' | 'device'

interface BadgeProps {
  tone?: Tone
  children: React.ReactNode
}

export function Badge({ tone = 'routine', children }: BadgeProps) {
  return <span className={`badge badge-${tone}`}>{children}</span>
}

export function LocationBadge({ location }: { location: ModelLocation | 'server' | 'device' }) {
  if (location === 'device') return <span className="badge badge-device">On device</span>
  return <span className="badge badge-server">Server</span>
}
