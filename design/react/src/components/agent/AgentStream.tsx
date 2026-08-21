import React from 'react'
import type { AgentRun } from '../../types'
import { RunHeader } from './RunHeader'
import { Message } from '../chat/Message'
import { PermissionBar, PlanningBanner } from './PermissionBar'

interface AgentStreamProps {
  run: AgentRun
  onAllow: () => void
  onDeny: () => void
}

export function AgentStream({ run, onAllow, onDeny }: AgentStreamProps) {
  return (
    <>
      <RunHeader run={run} />
      <div className="agent-body">
        <div className="agent-stream">
          <div className="prompt-msg">{run.prompt}</div>
          {run.messages.map((msg, i) => (
            <React.Fragment key={i}>
              <Message msg={msg} />
              {i === 0 && run.messages.length > 1 && <CompactionMarker />}
            </React.Fragment>
          ))}
        </div>
      </div>
      {run.mode === 'planning' && <PlanningBanner />}
      {run.state === 'awaiting_approval' && <PermissionBar onAllow={onAllow} onDeny={onDeny} />}
    </>
  )
}

export function CompactionMarker() {
  return (
    <div className="compaction">
      ◇ Context compacted — earlier messages summarized
    </div>
  )
}
