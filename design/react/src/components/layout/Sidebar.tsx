import React from 'react'
import type { SurfaceId } from '../../types'

interface SidebarProps {
  activeSurface: SurfaceId
  onNavigate: (surface: SurfaceId) => void
  onOpenSettings: () => void
  onNewChat: () => void
}

const NAV_ITEMS: { id: SurfaceId; label: string; icon: React.ReactNode }[] = [
  { id: 'chat', label: 'Chat', icon: <path d="M2 4a1 1 0 011-1h10a1 1 0 011 1v6a1 1 0 01-1 1H6l-3 3v-3H3a1 1 0 01-1-1V4z" stroke="currentColor" strokeWidth="1.4" /> },
  { id: 'agent', label: 'Agent', icon: <path d="M5 7V5a3 3 0 016 0v2M3 7h10v6a1 1 0 01-1 1H4a1 1 0 01-1-1V7zM6 10v1M10 10v1" stroke="currentColor" strokeWidth="1.4" /> },
  { id: 'routines', label: 'Routines', icon: <><circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.4" /><path d="M8 4v4l3 2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></> },
  { id: 'stats', label: 'Stats', icon: <path d="M2 13h12M4 13V7M7 13V4M10 13V8M13 13V6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /> },
]

function SettingsIcon() {
  return <path d="M8 5a3 3 0 100 6 3 3 0 000-6zM8 1v2M8 13v2M1 8h2M13 8h2M3.5 3.5l1.4 1.4M11.1 11.1l1.4 1.4M3.5 12.5l1.4-1.4M11.1 4.9l1.4-1.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
}

function PlusIcon() {
  return <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
}

export function Sidebar({ activeSurface, onNavigate, onOpenSettings, onNewChat }: SidebarProps) {
  return (
    <aside className="sidebar" data-od-id="sidebar">
      <div className="sidebar-brand">
        <div className="logo">OS</div>
        <div className="name">Open-Shannon</div>
      </div>
      <button className="sidebar-new" onClick={onNewChat}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><PlusIcon /></svg>
        New chat
      </button>
      <nav className="sidebar-nav">
        <div className="nav-label">Workspace</div>
        {NAV_ITEMS.map(item => (
          <a
            key={item.id}
            className={`nav-item ${activeSurface === item.id ? 'active' : ''}`}
            data-od-id={`nav-${item.id}`}
            onClick={() => onNavigate(item.id)}
          >
            <svg viewBox="0 0 16 16" fill="none">{item.icon}</svg>
            {item.label}
          </a>
        ))}
        <a
          className="nav-item"
          data-od-id="nav-settings"
          onClick={onOpenSettings}
        >
          <svg viewBox="0 0 16 16" fill="none"><SettingsIcon /></svg>
          Settings
        </a>
      </nav>
      <div className="sidebar-footer">
        <div className="status-line">
          <span className="status-dot" />
          Server connected · llama.cpp
        </div>
        <div className="account-row">
          <div className="account-avatar">CG</div>
          <div className="account-info">
            <div className="account-name">Casey Gibson</div>
            <div className="account-plan">shannon.tailscale.com</div>
          </div>
        </div>
      </div>
    </aside>
  )
}
