import React, { useState, useEffect } from 'react'
import type { SurfaceId } from './types'
import { ChatSurface } from './surfaces/ChatSurface'
import { AgentSurface } from './surfaces/AgentSurface'
import { RoutinesSurface } from './surfaces/RoutinesSurface'
import { StatsSurface } from './surfaces/StatsSurface'
import { LauncherSurface } from './surfaces/LauncherSurface'

export function App() {
  const [surface, setSurface] = useState<SurfaceId>(() => {
    const hash = window.location.hash.slice(1)
    return (hash as SurfaceId) || 'chat'
  })
  const [autoOpenSettings, setAutoOpenSettings] = useState(false)

  useEffect(() => {
    const handler = () => {
      const hash = window.location.hash.slice(1)
      if (hash === 'settings') {
        setSurface('chat')
        setAutoOpenSettings(true)
      } else if (hash) {
        setSurface(hash as SurfaceId)
      }
    }
    window.addEventListener('hashchange', handler)
    return () => window.removeEventListener('hashchange', handler)
  }, [])

  const navigate = (s: string) => {
    setSurface(s as SurfaceId)
    window.location.hash = s
    setAutoOpenSettings(false)
  }

  switch (surface) {
    case 'chat':
      return <ChatSurface onNavigate={navigate} autoOpenSettings={autoOpenSettings} />
    case 'agent':
      return <AgentSurface onNavigate={navigate} />
    case 'routines':
      return <RoutinesSurface onNavigate={navigate} />
    case 'stats':
      return <StatsSurface onNavigate={navigate} />
    case 'launcher':
      return <LauncherSurface onNavigate={navigate} />
    default:
      return <ChatSurface onNavigate={navigate} />
  }
}
