import React, { useState, useRef, useCallback } from 'react'
import type { ModelInfo, ThinkingLevel } from '../../types'
import { SHANNON_MODELS, SHANNON_WORKSPACES, THINKING_LEVELS } from '../../fixtures/models'
import { getModelContext } from '../../fixtures/models'

interface ComposerProps {
  onSend: (text: string) => void
  onStop?: () => void
  streaming?: boolean
  selectedModel: string
  onSelectModel: (modelId: string) => void
  thinkingLevel: ThinkingLevel
  onThinkingLevel: (level: ThinkingLevel) => void
  contextPercent?: number
  contextStats?: { label: string; value: string }[]
  showModeDropdown?: boolean
  mode?: string
  onModeChange?: (mode: string) => void
  smartRouting?: boolean
  onSmartRoutingChange?: (enabled: boolean) => void
  onOpenModelModal?: () => void
  onOpenSettings?: () => void
}

export function Composer({
  onSend, onStop, streaming, selectedModel, onSelectModel,
  thinkingLevel, onThinkingLevel, contextPercent = 0, contextStats = [],
  showModeDropdown, mode = 'manual', onModeChange,
  smartRouting, onSmartRoutingChange, onOpenModelModal, onOpenSettings,
}: ComposerProps) {
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<{ name: string; size: string }[]>([])
  const [workspaces, setWorkspaces] = useState<string[]>([])
  const [dragOver, setDragOver] = useState(false)
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [ctxPopupOpen, setCtxPopupOpen] = useState(false)
  const [modeMenuOpen, setModeMenuOpen] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const handleSend = useCallback(() => {
    const trimmed = text.trim()
    if (!trimmed || streaming) return
    onSend(trimmed)
    setText('')
    if (inputRef.current) inputRef.current.style.height = 'auto'
  }, [text, streaming, onSend])

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value)
    const el = e.target
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 200) + 'px'
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const files = Array.from(e.dataTransfer.files)
    setAttachments(prev => [...prev, ...files.map(f => ({ name: f.name, size: `${(f.size / 1024).toFixed(0)}KB` }))])
  }

  const removeAttachment = (idx: number) => setAttachments(prev => prev.filter((_, i) => i !== idx))

  const toggleWorkspace = (name: string) => {
    setWorkspaces(prev => prev.includes(name) ? prev.filter(w => w !== name) : [...prev, name])
  }

  const modelName = SHANNON_MODELS.find(m => m.id === selectedModel)?.display_name ?? selectedModel

  return (
    <div className={`composer ${dragOver ? 'drag-over' : ''}`}>
      <div className="composer-inner">
        {attachments.length > 0 || workspaces.length > 0 ? (
          <div className="composer-chips">
            {attachments.map((att, i) => (
              <span key={i} className="att-chip">
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M4 2v12l4-3 4 3V2z" stroke="currentColor" strokeWidth="1.4" /></svg>
                {att.name} <span style={{ color: 'var(--fg-3)' }}>{att.size}</span>
                <span className="remove" onClick={() => removeAttachment(i)}>✕</span>
              </span>
            ))}
            {workspaces.map(ws => (
              <span key={ws} className="ws-chip" onClick={() => toggleWorkspace(ws)}>
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M2 4a1 1 0 011-1h3l1 1h6a1 1 0 011 1v6a1 1 0 01-1 1H3a1 1 0 01-1-1V4z" stroke="currentColor" strokeWidth="1.4" /></svg>
                {ws}
                <span className="remove" style={{ marginLeft: 4 }}>✕</span>
              </span>
            ))}
          </div>
        ) : null}
        <textarea
          ref={inputRef}
          className="composer-input"
          placeholder="Type a message... (Enter does not send)"
          value={text}
          onChange={handleInput}
          onDragOver={e => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
        />
        <div className="composer-bar">
          <button className="btn btn-ghost" onClick={() => {
            const input = document.createElement('input')
            input.type = 'file'
            input.multiple = true
            input.onchange = () => {
              if (input.files) setAttachments(prev => [...prev, ...Array.from(input.files!).map(f => ({ name: f.name, size: `${(f.size / 1024).toFixed(0)}KB` }))])
            }
            input.click()
          }}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 2v12l4-3 4 3V2z" stroke="currentColor" strokeWidth="1.4" /></svg>
          </button>
          {SHANNON_WORKSPACES.length > 0 && (
            <div style={{ position: 'relative' }}>
              <button className="btn btn-ghost" onClick={() => {}}>
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 4a1 1 0 011-1h3l1 1h6a1 1 0 011 1v6a1 1 0 01-1 1H3a1 1 0 01-1-1V4z" stroke="currentColor" strokeWidth="1.4" /></svg>
              </button>
            </div>
          )}
          {/* Model selector */}
          <div className="model-selector">
            <button className="btn btn-ghost" onClick={() => setModelMenuOpen(!modelMenuOpen)}>
              {modelName}
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.4" /></svg>
            </button>
            {modelMenuOpen && (
              <div className="model-menu open">
                <div className="model-group">Server Models</div>
                {SHANNON_MODELS.filter(m => m.location === 'server').map(m => (
                  <div key={m.id} className={`model-option ${selectedModel === m.id ? 'selected' : ''}`} onClick={() => { onSelectModel(m.id); setModelMenuOpen(false) }}>
                    <div>
                      <div className="model-option-name">{m.display_name}</div>
                      <div className="model-option-meta">{m.quant} · {(m.context_tokens / 1000).toFixed(0)}K context</div>
                    </div>
                    {selectedModel === m.id && <span className="check">✓</span>}
                  </div>
                ))}
                <div className="model-group">On-Device Models</div>
                {SHANNON_MODELS.filter(m => m.location === 'device').map(m => (
                  <div key={m.id} className={`model-option ${selectedModel === m.id ? 'selected' : ''}`} onClick={() => { onSelectModel(m.id); setModelMenuOpen(false) }}>
                    <div>
                      <div className="model-option-name">{m.display_name}</div>
                      <div className="model-option-meta">{m.quant} · {(m.context_tokens / 1000).toFixed(0)}K context</div>
                    </div>
                    {selectedModel === m.id && <span className="check">✓</span>}
                  </div>
                ))}
                <div className="model-group">Remote Models</div>
                {SHANNON_MODELS.filter(m => m.location === 'remote').map(m => (
                  <div key={m.id} className={`model-option ${selectedModel === m.id ? 'selected' : ''}`} onClick={() => { onSelectModel(m.id); setModelMenuOpen(false) }}>
                    <div>
                      <div className="model-option-name">{m.display_name}</div>
                      <div className="model-option-meta">${m.price.toFixed(2)}/1M · {(m.context_tokens / 1000).toFixed(0)}K context</div>
                    </div>
                    {selectedModel === m.id && <span className="check">✓</span>}
                  </div>
                ))}
                <div style={{ padding: '8px 12px', borderTop: '1px solid var(--border)' }}>
                  <button className="btn btn-ghost btn-sm" onClick={() => { setModelMenuOpen(false); onOpenModelModal?.() }}>
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.4" /><path d="M11 11l3 3" stroke="currentColor" strokeWidth="1.4" /></svg>
                    Search models...
                  </button>
                </div>
              </div>
            )}
          </div>
          {/* Thinking level */}
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
          {/* Context indicator */}
          <div className="ctx-indicator" onClick={() => setCtxPopupOpen(!ctxPopupOpen)}>
            <div className="ctx-indicator-ring">
              <div className="ctx-indicator-ring-fill" style={{ clipPath: `inset(0 0 ${100 - contextPercent}% 0)` }} />
            </div>
            <span>{contextPercent}%</span>
            {ctxPopupOpen && (
              <div className="ctx-stats-popup open">
                {contextStats.map((s, i) => (
                  <div key={i} className="stat-row">
                    <span>{s.label}</span>
                    <span className="val">{s.value}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          {/* Agent-only: mode dropdown */}
          {showModeDropdown && (
            <div className="mode-dropdown">
              <button className="mode-dropdown-btn" onClick={() => setModeMenuOpen(!modeMenuOpen)}>
                {mode}
                <svg width="10" height="10" viewBox="0 0 16 16" fill="none"><path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.4" /></svg>
              </button>
              {modeMenuOpen && (
                <div className="mode-dropdown-menu open">
                  {['planning', 'manual', 'auto'].map(m => (
                    <div key={m} className={`mode-dropdown-item ${mode === m ? 'active' : ''}`} onClick={() => { onModeChange?.(m); setModeMenuOpen(false) }}>
                      {m.charAt(0).toUpperCase() + m.slice(1)}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {/* Agent-only: smart routing toggle */}
          {smartRouting !== undefined && (
            <div className={`smart-route-toggle ${smartRouting ? 'active' : ''}`}>
              <button className="btn btn-ghost" onClick={() => onSmartRoutingChange?.(!smartRouting)}>
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 1l2 4 4 .5-3 3 1 4-4-2-4 2 1-4-3-3 4-.5z" stroke="currentColor" strokeWidth="1.2" /></svg>
                <span className="toggle-label">Smart route</span>
              </button>
              <button className="gear-btn" onClick={onOpenSettings}>
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.4" /><path d="M8 1v2M8 13v2M1 8h2M13 8h2" stroke="currentColor" strokeWidth="1.4" /></svg>
              </button>
            </div>
          )}
          <div style={{ flex: 1 }} />
          {/* Send / Stop */}
          {streaming ? (
            <button className="send-btn stop" onClick={onStop}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><rect x="3" y="3" width="10" height="10" rx="1" /></svg>
            </button>
          ) : (
            <button className="send-btn" onClick={handleSend} disabled={!text.trim()}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M2 8l12-6-4 14-3-5-5-3z" stroke="currentColor" strokeWidth="1.4" fill="currentColor" /></svg>
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
