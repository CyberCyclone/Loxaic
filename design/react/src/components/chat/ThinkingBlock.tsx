import React, { useState } from 'react'

interface ThinkingBlockProps {
  text: string
}

export function ThinkingBlock({ text }: ThinkingBlockProps) {
  const [open, setOpen] = useState(false)

  return (
    <div className={`thinking-block ${open ? 'open' : ''}`}>
      <div className="thinking-header" onClick={() => setOpen(!open)}>
        <svg className="arrow" width="10" height="10" viewBox="0 0 16 16" fill="none" style={{ transition: 'transform .2s', transform: open ? 'rotate(90deg)' : 'none' }}>
          <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.4" />
        </svg>
        Thinking...
      </div>
      {open && <div className="thinking-body">{text}</div>}
    </div>
  )
}
