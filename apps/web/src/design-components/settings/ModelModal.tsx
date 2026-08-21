import React, { useState } from 'react'
import type { ThinkingLevel } from '../types'
import { SHANNON_MODELS, THINKING_LEVELS } from '../fixtures/models'
import { Modal } from '../primitives/Modal'
import { Input } from '../primitives/Input'

interface ModelModalProps {
  open: boolean
  onClose: () => void
  selectedModel: string
  onSelect: (modelId: string) => void
  thinkingLevel: ThinkingLevel
  onThinkingLevel: (level: ThinkingLevel) => void
  onOpenSettings: () => void
}

export function ModelModal({ open, onClose, selectedModel, onSelect, thinkingLevel, onThinkingLevel, onOpenSettings }: ModelModalProps) {
  const [search, setSearch] = useState('')

  const filtered = SHANNON_MODELS.filter(m =>
    m.display_name.toLowerCase().includes(search.toLowerCase())
  )

  const groups: { label: string; models: typeof SHANNON_MODELS }[] = [
    { label: 'Server Models', models: filtered.filter(m => m.location === 'server') },
    { label: 'On-Device Models', models: filtered.filter(m => m.location === 'device') },
    { label: 'Remote Models', models: filtered.filter(m => m.location === 'remote') },
  ]

  return (
    <Modal open={open} onClose={onClose} className="model-modal" odId="model-modal">
      <div className="model-modal-search">
        <Input
          type="text"
          placeholder="Search models..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ background: 'var(--bg)' }}
        />
      </div>
      <div className="model-modal-list">
        {groups.map(group => group.models.length > 0 && (
          <React.Fragment key={group.label}>
            <div className="model-group">{group.label}</div>
            {group.models.map(m => (
              <div
                key={m.id}
                className={`model-option ${selectedModel === m.id ? 'selected' : ''}`}
                onClick={() => { onSelect(m.id); onClose() }}
              >
                <div>
                  <div className="model-option-name">{m.display_name}</div>
                  <div className="model-option-meta">
                    {m.quant} · {(m.context_tokens / 1000).toFixed(0)}K context
                    {m.price > 0 && ` · $${m.price.toFixed(2)}/1M`}
                  </div>
                </div>
                {selectedModel === m.id && <span className="check">✓</span>}
              </div>
            ))}
          </React.Fragment>
        ))}
      </div>
      <div className="model-modal-footer">
        <div className="thinking-levels">
          {THINKING_LEVELS.map(level => (
            <button
              key={level}
              className={`thinking-chip ${thinkingLevel === level ? 'active' : ''}`}
              onClick={() => onThinkingLevel(level)}
            >
              {level}
            </button>
          ))}
        </div>
        <button className="gear-btn" onClick={() => { onClose(); onOpenSettings() }} style={{ padding: 4, borderRadius: 'var(--r-sm)', color: 'var(--fg-3)', cursor: 'pointer' }}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.4" />
            <path d="M8 1v2M8 13v2M1 8h2M13 8h2" stroke="currentColor" strokeWidth="1.4" />
          </svg>
        </button>
      </div>
    </Modal>
  )
}
