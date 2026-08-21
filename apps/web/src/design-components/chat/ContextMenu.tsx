import React, { useState, useEffect } from 'react'
import type { Conversation } from '../types'

interface ContextMenuProps {
  x: number
  y: number
  conversation: Conversation
  onClose: () => void
  onOpen: (id: string) => void
  onFork: (id: string) => void
  onRewind: (id: string) => void
  onRename: (id: string) => void
  onExport: (id: string) => void
  onDelete: (id: string) => void
}

export function ContextMenu({ x, y, conversation, onClose, onOpen, onFork, onRewind, onRename, onExport, onDelete }: ContextMenuProps) {
  useEffect(() => {
    const handler = () => onClose()
    document.addEventListener('click', handler)
    return () => document.removeEventListener('click', handler)
  }, [onClose])

  const items = [
    { label: 'Open', icon: '→', action: () => onOpen(conversation.id) },
    { label: 'Fork conversation', icon: '⑂', action: () => onFork(conversation.id) },
    { label: 'Rewind to...', icon: '↶', action: () => onRewind(conversation.id) },
    { label: 'Rename', icon: '✎', action: () => onRename(conversation.id) },
    { label: 'Pin', icon: '📌', action: () => {} },
    { sep: true },
    { label: 'Export as Markdown', icon: '⤓', action: () => onExport(conversation.id) },
    { label: 'Delete', icon: '✕', danger: true, action: () => onDelete(conversation.id) },
  ]

  return (
    <div className="ctx-menu open" style={{ left: x, top: y }} onClick={e => e.stopPropagation()}>
      {items.map((item, i) => (
        item.sep ? (
          <div key={i} className="ctx-menu-sep" />
        ) : (
          <div
            key={i}
            className={`ctx-menu-item ${item.danger ? 'danger' : ''}`}
            onClick={() => { item.action?.(); onClose() }}
          >
            <span style={{ width: 14, textAlign: 'center' }}>{item.icon ?? ''}</span>
            {item.label}
          </div>
        )
      ))}
    </div>
  )
}
