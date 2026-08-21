import React, { useState } from 'react'
import type { ToolCall } from '../types'

const TOOL_ICONS: Record<string, string> = {
  fs_read: 'R', fs_write: 'W', fs_edit: 'E', bash: '$',
  grep: 'G', glob: 'L', web_fetch: 'F', todo_write: 'T',
}

export function ToolCallCard({ tool }: { tool: ToolCall }) {
  const [open, setOpen] = useState(false)
  const icon = TOOL_ICONS[tool.tool] || '?'

  return (
    <div className={`tool-row ${open ? 'open' : ''}`}>
      <div className="tool-row-head" onClick={() => setOpen(!open)}>
        <div className={`tool-icon ${tool.tool}`}>{icon}</div>
        <span className="tool-summary">{tool.summary}</span>
        {tool.duration && <span className="tool-duration">{tool.duration}</span>}
        <svg className="arrow" width="10" height="10" viewBox="0 0 16 16" fill="none" style={{ transition: 'transform .2s', transform: open ? 'rotate(90deg)' : 'none' }}>
          <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      </div>
      {open && (
        <div className="tool-detail">
          {tool.diff ? (
            tool.diff.map((line, i) => (
              <div key={i} className={`diff-line diff-${line.type === 'add' ? 'add' : line.type === 'del' ? 'del' : 'meta'}`}>
                {line.text}
              </div>
            ))
          ) : (
            <div className="tool-output">{tool.result}</div>
          )}
        </div>
      )}
    </div>
  )
}
