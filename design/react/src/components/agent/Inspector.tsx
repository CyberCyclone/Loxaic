import React from 'react'
import type { AgentRun } from '../../types'

interface InspectorProps {
  open: boolean
  run: AgentRun
  onClose: () => void
}

export function Inspector({ open, run, onClose }: InspectorProps) {
  if (!open) return null
  return (
    <div className="agent-inspector open">
      <div className="inspector-header">
        <span style={{ fontSize: 14, fontWeight: 600 }}>Inspector</span>
        <button className="btn btn-ghost btn-sm" onClick={onClose}>✕</button>
      </div>
      {/* Todos */}
      <div className="inspector-section">
        <div className="inspector-title">Todo List</div>
        {run.todos.map((todo, i) => (
          <div key={i} className={`todo-item ${todo.done ? 'done' : ''}`}>
            <div className={`todo-check ${todo.done ? 'done' : ''}`}>
              {todo.done && '✓'}
            </div>
            <span className="todo-text">{todo.text}</span>
          </div>
        ))}
      </div>
      {/* Changed files */}
      <div className="inspector-section">
        <div className="inspector-title">Changed Files ({run.changedFiles.length})</div>
        {run.changedFiles.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--fg-3)' }}>No files changed yet</div>
        ) : (
          run.changedFiles.map((file, i) => (
            <div key={i} className="changed-file">
              <span style={{ flex: 1, fontSize: 13 }}>{file.path}</span>
              <span className="add">+{file.adds}</span>
              <span className="del">-{file.dels}</span>
            </div>
          ))
        )}
      </div>
      {/* Context */}
      <div className="inspector-section">
        <div className="inspector-title">Context</div>
        <div className="context-item">
          <span>Context window</span>
          <span className="tok">{run.contextPercent}%</span>
        </div>
        <div className="ctx-meter-mini">
          <div className="ctx-meter-mini-fill" style={{ width: `${run.contextPercent}%` }} />
        </div>
      </div>
    </div>
  )
}
