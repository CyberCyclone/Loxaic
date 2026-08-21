import React, { useState } from 'react'
import type { Conversation } from '../types'
import { Badge, LocationBadge } from '../primitives/Badge'

interface ThreadListProps {
  conversations: Conversation[]
  activeId: string | null
  onSelect: (id: string) => void
  onNewChat: () => void
  onContextMenu: (e: React.MouseEvent, conv: Conversation) => void
  onRename: (id: string) => void
  onDelete: (id: string) => void
  title: string
}

export function ThreadList({ conversations, activeId, onSelect, onNewChat, onContextMenu, onRename, onDelete, title }: ThreadListProps) {
  const [search, setSearch] = useState('')
  const filtered = conversations.filter(c => c.title.toLowerCase().includes(search.toLowerCase()))

  return (
    <div className="threadlist">
      <div className="threadlist-header">
        <div className="threadlist-header-new">
          <span className="threadlist-title">{title}</span>
          <button className="btn btn-ghost btn-sm" onClick={onNewChat}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
          </button>
        </div>
      </div>
      <div className="threadlist-search">
        <input
          type="text"
          placeholder="Search..."
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>
      <div className="threadlist-items">
        {filtered.map(conv => (
          <div
            key={conv.id}
            className={`thread-row ${activeId === conv.id ? 'active' : ''}`}
            onClick={() => onSelect(conv.id)}
            onContextMenu={e => { e.preventDefault(); onContextMenu(e, conv) }}
          >
            <div className="thread-row-title">{conv.title}</div>
            <div className="thread-row-meta">
              <LocationBadge location={conv.location} />
              <Badge tone={conv.kind}>{conv.kind}</Badge>
              <span>{conv.time}</span>
            </div>
            <div className="thread-row-actions">
              <button className="btn btn-ghost btn-sm" onClick={e => { e.stopPropagation(); onRename(conv.id) }} style={{ padding: '2px 4px', minHeight: 'auto' }}>✎</button>
              <button className="btn btn-ghost btn-sm" onClick={e => { e.stopPropagation(); onDelete(conv.id) }} style={{ padding: '2px 4px', minHeight: 'auto', color: 'var(--danger)' }}>✕</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
