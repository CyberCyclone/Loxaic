import React, { useState } from 'react'
import type { Message as MessageType } from '../../types'
import { getModelName, getModelPrice } from '../../fixtures/models'
import { ThinkingBlock } from './ThinkingBlock'
import { CodeBlock } from './CodeBlock'
import { ToolCallCard } from './ToolCallCard'
import { LocationBadge } from '../primitives/Badge'

interface MessageProps {
  msg: MessageType
}

function renderText(text: string) {
  const parts: React.ReactNode[] = []
  const codeRegex = /```(\w+)?\n([\s\S]*?)```/g
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = codeRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(<span key={lastIndex}>{text.slice(lastIndex, match.index)}</span>)
    }
    parts.push(<CodeBlock key={match.index} code={match[2]} lang={match[1]} />)
    lastIndex = match.index + match[0].length
  }
  if (lastIndex < text.length) {
    parts.push(<span key={lastIndex}>{text.slice(lastIndex)}</span>)
  }
  return parts
}

export function Message({ msg }: MessageProps) {
  const [showActions, setShowActions] = useState(false)
  const isUser = msg.role === 'user'

  return (
    <div
      className={`msg ${isUser ? 'user' : 'assistant'}`}
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => setShowActions(false)}
    >
      <div className="msg-head">
        <div className={`msg-avatar ${isUser ? 'user' : 'assistant'}`}>
          {isUser ? 'U' : 'S'}
        </div>
        {!isUser && msg.model && <span>{getModelName(msg.model)}</span>}
        {msg.origin && <LocationBadge location={msg.origin} />}
      </div>
      <div className="msg-body">
        {msg.thinking && <ThinkingBlock text={msg.thinking} />}
        {msg.tools?.map((tool, i) => <ToolCallCard key={i} tool={tool} />)}
        {renderText(msg.text)}
      </div>
      {!isUser && msg.usage && (
        <div className="msg-usage">
          <span>{msg.usage.tps} tok/s</span>
          <span>cached {msg.usage.cache}%</span>
          <span>{msg.usage.in.toLocaleString()} in / {msg.usage.out.toLocaleString()} out</span>
          {msg.model && getModelPrice(msg.model) > 0 && (
            <span>${((msg.usage.in + msg.usage.out) * getModelPrice(msg.model) / 1_000_000).toFixed(4)}</span>
          )}
        </div>
      )}
      {msg.forks && msg.forks.length > 1 && (
        <div className="fork-chips">
          {msg.forks.map((fork, i) => (
            <span key={i} className={`fork-chip ${i === 0 ? 'active' : ''}`}>{fork}</span>
          ))}
        </div>
      )}
      {!isUser && showActions && (
        <div className="msg-actions" style={{ paddingLeft: 32, marginTop: 4, display: 'flex', gap: 8 }}>
          <button className="btn btn-ghost btn-sm" style={{ padding: '2px 8px' }}>Copy</button>
          <button className="btn btn-ghost btn-sm" style={{ padding: '2px 8px' }}>Fork here</button>
          <button className="btn btn-ghost btn-sm" style={{ padding: '2px 8px' }}>Rewind</button>
          <button className="btn btn-ghost btn-sm" style={{ padding: '2px 8px' }}>Regenerate</button>
        </div>
      )}
    </div>
  )
}
