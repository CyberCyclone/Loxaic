import React, { useState } from 'react'
import type { SurfaceId } from '../types'
import { Sidebar } from './Sidebar'
import { MobileBar } from './MainHeader'

interface AppShellProps {
  activeSurface: SurfaceId
  onNavigate: (surface: SurfaceId) => void
  onOpenSettings: () => void
  onNewChat: () => void
  threadList?: React.ReactNode
  children: React.ReactNode
  title: string
  headerExtras?: React.ReactNode
}

export function AppShell({ activeSurface, onNavigate, onOpenSettings, onNewChat, threadList, children, title, headerExtras }: AppShellProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false)

  return (
    <div className="shell" data-od-id={`${activeSurface}-shell`}>
      <div className={`sidebar-wrapper ${sidebarOpen ? 'open' : ''}`}>
        <Sidebar
          activeSurface={activeSurface}
          onNavigate={(s) => { onNavigate(s); setSidebarOpen(false) }}
          onOpenSettings={onOpenSettings}
          onNewChat={onNewChat}
        />
      </div>
      {threadList}
      <main className="main" data-od-id={`${activeSurface}-main`}>
        <MobileBar title={title} onToggleSidebar={() => setSidebarOpen(!sidebarOpen)} />
        <div className="main-header">
          <h1>{title}</h1>
          <div style={{ flex: 1 }} />
          {headerExtras}
        </div>
        <div className="main-content">
          {children}
        </div>
      </main>
    </div>
  )
}
