import React from 'react'
import type { AgentRun } from '../types'
import { Badge } from '../primitives/Badge'

interface RunHeaderProps {
  run: AgentRun
}

export function RunHeader({ run }: RunHeaderProps) {
  const stateClass = run.state === 'running' ? 'running' : run.state === 'awaiting_approval' ? 'awaiting' : run.state === 'done' ? 'done' : 'error'
  const stateLabel = run.state === 'awaiting_approval' ? 'Awaiting approval' : run.state.charAt(0).toUpperCase() + run.state.slice(1)

  return (
    <div className="run-header">
      <span className="run-title">{run.title}</span>
      <span className="run-target">{run.target}</span>
      <span className={`run-state ${stateClass}`}>
        <span className="dot" />
        {stateLabel}
      </span>
      <Badge tone="warning">{run.mode}</Badge>
    </div>
  )
}
