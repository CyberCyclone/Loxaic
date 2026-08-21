import React, { useState } from 'react'
import type { Routine } from '../../types'
import { Table, Switch, Badge, Button } from '../primitives'
import { CRON_PRESETS, humanizeCron, validateCron } from '../../fixtures/routines'
import { SHANNON_MODELS } from '../../fixtures/models'
import { SHANNON_WORKSPACES } from '../../fixtures/models'
import { Modal } from '../primitives/Modal'
import { Input, Select, Label, Hint } from '../primitives/Input'

interface RoutinesContentProps {
  routines: Routine[]
  onToggle: (id: string, enabled: boolean) => void
  onRunNow: (id: string) => void
  onDelete: (id: string) => void
  onSave: (routine: Routine) => void
}

export function RoutineTable({ routines, onToggle, onRunNow, onDelete }: Omit<RoutinesContentProps, 'onSave'>) {
  return (
    <table className="routine-table" data-od-id="routine-table">
      <thead><tr><th>Name</th><th>Schedule</th><th>Target</th><th>Model</th><th>Last Run</th><th>Next Run</th><th>Enabled</th><th></th></tr></thead>
      <tbody>
        {routines.map(r => (
          <tr key={r.id}>
            <td>{r.name}</td>
            <td>{r.humanized}</td>
            <td>{r.target}</td>
            <td>{SHANNON_MODELS.find(m => m.id === r.model)?.display_name ?? r.model}</td>
            <td>
              {r.lastRun ? (
                <React.Fragment>
                  {r.lastRun} <Badge tone={r.lastRunStatus === 'error' ? 'danger' : 'success'}>{r.lastRunStatus}</Badge>
                </React.Fragment>
              ) : '—'}
            </td>
            <td>{r.nextRun ?? '—'}</td>
            <td><Switch checked={r.enabled} onChange={v => onToggle(r.id, v)} /></td>
            <td>
              <div className="routine-actions">
                <Button variant="ghost" size="sm" onClick={() => onRunNow(r.id)}>Run</Button>
                <Button variant="ghost" size="sm" onClick={() => onDelete(r.id)}>✕</Button>
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

interface RoutineModalProps {
  open: boolean
  onClose: () => void
  onSave: (routine: Routine) => void
  editing?: Routine | null
}

export function RoutineModal({ open, onClose, onSave, editing }: RoutineModalProps) {
  const [name, setName] = useState(editing?.name ?? '')
  const [prompt, setPrompt] = useState(editing?.prompt ?? '')
  const [cron, setCron] = useState(editing?.cron ?? '0 9 * * 1-5')
  const [target, setTarget] = useState(editing?.target ?? 'agent')
  const [directory, setDirectory] = useState(editing?.directory ?? '')
  const [model, setModel] = useState(editing?.model ?? 'm3')
  const [error, setError] = useState<string | null>(null)

  React.useEffect(() => {
    if (open) {
      setName(editing?.name ?? '')
      setPrompt(editing?.prompt ?? '')
      setCron(editing?.cron ?? '0 9 * * 1-5')
      setTarget(editing?.target ?? 'agent')
      setDirectory(editing?.directory ?? '')
      setModel(editing?.model ?? 'm3')
      setError(null)
    }
  }, [open, editing])

  const handleSave = () => {
    const err = validateCron(cron)
    if (err) { setError(err); return }
    if (!name.trim()) { setError('Name is required'); return }
    onSave({
      id: editing?.id ?? `r${Date.now()}`,
      name, prompt, cron,
      humanized: humanizeCron(cron),
      target, directory, model,
      lastRun: editing?.lastRun ?? null,
      lastRunStatus: editing?.lastRunStatus ?? null,
      nextRun: editing?.nextRun ?? null,
      enabled: editing?.enabled ?? true,
    })
    onClose()
  }

  return (
    <Modal open={open} onClose={onClose} odId="routine-modal">
      <div className="modal-header">
        <span style={{ fontSize: 16, fontWeight: 600 }}>{editing ? 'Edit Routine' : 'New Routine'}</span>
        <button className="btn btn-ghost btn-sm" onClick={onClose}>✕</button>
      </div>
      <div className="modal-body">
        <div className="form-group"><Label>Name</Label><Input value={name} onChange={e => setName(e.target.value)} placeholder="Daily standup summary" /></div>
        <div className="form-group"><Label>Prompt</Label><textarea className="input" rows={4} value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="Summarize yesterday's commits..." /></div>
        <div className="form-group">
          <Label>Directory</Label>
          <Select value={directory} onChange={e => setDirectory(e.target.value)}>
            <option value="">— None —</option>
            {SHANNON_WORKSPACES.map(ws => <option key={ws.name} value={ws.name}>{ws.name}</option>)}
          </Select>
          <Hint>Run the agent in this workspace, or pull data from it.</Hint>
        </div>
        <div className="form-group">
          <Label>Schedule</Label>
          <div className="cron-presets">
            {CRON_PRESETS.map(p => (
              <button key={p.cron} className={`cron-preset ${cron === p.cron ? 'active' : ''}`} onClick={() => { setCron(p.cron); setError(null) }}>
                {p.label}
              </button>
            ))}
          </div>
          <Input value={cron} onChange={e => { setCron(e.target.value); setError(validateCron(e.target.value)) }} placeholder="0 9 * * 1-5" style={{ fontFamily: 'ui-monospace, monospace', marginTop: 8 }} />
          <div className="cron-preview">{cron}</div>
          <div className="cron-humanized">{humanizeCron(cron)}</div>
          {error && <div className="error-text">{error}</div>}
        </div>
        <div className="form-group">
          <Label>Target</Label>
          <Select value={target} onChange={e => setTarget(e.target.value)}>
            <option value="agent">Agent run</option>
            <option value="chat">Chat</option>
          </Select>
        </div>
        <div className="form-group">
          <Label>Model</Label>
          <Select value={model} onChange={e => setModel(e.target.value)}>
            {SHANNON_MODELS.map(m => <option key={m.id} value={m.id}>{m.display_name}</option>)}
          </Select>
        </div>
      </div>
      <div className="modal-footer">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={handleSave} disabled={!name.trim() || !!error}>Save routine</Button>
      </div>
    </Modal>
  )
}
