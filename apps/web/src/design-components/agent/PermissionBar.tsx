import React from 'react'
import { Button } from '../primitives/Button'

export function PermissionBar({ onAllow, onDeny }: { onAllow: () => void; onDeny: () => void }) {
  return (
    <div className="permission-bar show">
      <div className="permission-prompt">Agent wants to write to <code>src/auth/middleware.ts</code></div>
      <div className="permission-actions">
        <Button variant="ghost" size="sm" onClick={onDeny}>Deny</Button>
        <Button variant="secondary" size="sm">Always allow</Button>
        <Button variant="primary" size="sm" onClick={onAllow}>Allow once</Button>
      </div>
    </div>
  )
}

export function PlanningBanner() {
  return (
    <div className="planning-banner show">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 2v6l4 2" stroke="currentColor" strokeWidth="1.4" /><circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.4" /></svg>
      Planning mode — writes are blocked. The agent will produce a plan for your review.
    </div>
  )
}
