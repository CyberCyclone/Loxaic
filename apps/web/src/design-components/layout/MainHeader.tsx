import React from 'react'

interface MainHeaderProps {
  children?: React.ReactNode
  title: string
  odId?: string
}

export function MainHeader({ children, title, odId }: MainHeaderProps) {
  return (
    <div className="main-header">
      <h1 data-od-id={odId}>{title}</h1>
      {children}
    </div>
  )
}

interface MobileBarProps {
  title: string
  onToggleSidebar: () => void
}

export function MobileBar({ title, onToggleSidebar }: MobileBarProps) {
  return (
    <div className="mobile-bar">
      <button className="btn btn-ghost btn-sm" onClick={onToggleSidebar}>
        <svg width="18" height="18" viewBox="0 0 16 16" fill="none"><path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" strokeWidth="1.5" /></svg>
      </button>
      <span style={{ fontSize: '14px', fontWeight: 600, flex: 1 }}>{title}</span>
    </div>
  )
}

interface SaveBarProps {
  show: boolean
  onSave: () => void
  onDiscard: () => void
}

export function SaveBar({ show, onSave, onDiscard }: SaveBarProps) {
  if (!show) return null
  return (
    <div className="save-bar show">
      <span style={{ fontSize: '13px', color: 'var(--fg-3)', alignSelf: 'center', marginRight: 'auto' }}>Unsaved changes</span>
      <button className="btn btn-ghost" onClick={onDiscard}>Discard</button>
      <button className="btn btn-primary" onClick={onSave}>Save changes</button>
    </div>
  )
}
