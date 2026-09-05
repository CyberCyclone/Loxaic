import React, { useState } from 'react'
import { ROUTINES, ROUTINE_RUNS } from '../fixtures/routines'
import { RoutineTable, RoutineModal } from '../components/routines'
import { AppShell } from '../components/layout'
import { SettingsModal } from '../components/settings'
import { Button, Badge, Switch } from '../components/primitives'
import { useToast } from '../hooks/useToast'
import { useLocalStorage } from '../hooks/useLocalStorage'
import type { Routine } from '../types'

interface RoutinesSurfaceProps {
  onNavigate: (surface: string) => void
}

export function RoutinesSurface({ onNavigate }: RoutinesSurfaceProps) {
  const [routines, setRoutines] = useLocalStorage<Routine[]>('loxaic-routines-data', ROUTINES)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<Routine | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [drawerRoutine, setDrawerRoutine] = useState<Routine | null>(null)
  const { showToast } = useToast()

  const handleSave = (routine: Routine) => {
    setRoutines(prev => {
      const exists = prev.find(r => r.id === routine.id)
      if (exists) return prev.map(r => r.id === routine.id ? routine : r)
      return [routine, ...prev]
    })
    showToast(editing ? 'Routine updated' : 'Routine created')
  }

  const handleToggle = (id: string, enabled: boolean) => {
    setRoutines(prev => prev.map(r => r.id === id ? { ...r, enabled } : r))
    showToast(enabled ? 'Routine enabled' : 'Routine disabled')
  }

  const handleRunNow = (id: string) => {
    showToast('Routine triggered — running now')
    setRoutines(prev => prev.map(r => r.id === id ? { ...r, lastRun: 'now', lastRunStatus: 'success' } : r))
  }

  const handleDelete = (id: string) => {
    setRoutines(prev => prev.filter(r => r.id !== id))
    showToast('Routine deleted')
  }

  return (
    <AppShell
      activeSurface="routines"
      onNavigate={onNavigate}
      onOpenSettings={() => setSettingsOpen(true)}
      onNewChat={() => onNavigate('chat')}
      title="Routines"
      headerExtras={
        <Button variant="primary" size="sm" odId="cta-new-routine" onClick={() => { setEditing(null); setModalOpen(true) }}>
          + New routine
        </Button>
      }
    >
      <div className="routines-content">
        {routines.length === 0 ? (
          <div className="empty-routines">
            <p style={{ fontSize: 16, marginBottom: 8 }}>No routines yet</p>
            <p style={{ fontSize: 14, marginBottom: 16 }}>Schedule recurring agent runs — daily summaries, code reviews, health checks.</p>
            <Button variant="primary" onClick={() => { setEditing(null); setModalOpen(true) }}>Create your first routine</Button>
          </div>
        ) : (
          <RoutineTable
            routines={routines}
            onToggle={handleToggle}
            onRunNow={handleRunNow}
            onDelete={handleDelete}
          />
        )}
      </div>
      <RoutineModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onSave={handleSave}
        editing={editing}
      />
      {drawerRoutine && (
        <div className="drawer-overlay open" onClick={() => setDrawerRoutine(null)}>
          <div className="drawer" onClick={e => e.stopPropagation()}>
            <div className="drawer-header">
              <span style={{ fontSize: 16, fontWeight: 600 }}>{drawerRoutine.name}</span>
              <button className="btn btn-ghost btn-sm" onClick={() => setDrawerRoutine(null)}>✕</button>
            </div>
            <div className="drawer-body">
              <p style={{ fontSize: 14, color: 'var(--fg-2)', marginBottom: 16 }}>{drawerRoutine.prompt}</p>
              <div style={{ marginBottom: 16 }}>
                <Badge tone="routine">{drawerRoutine.humanized}</Badge>
                <span style={{ marginLeft: 8, fontSize: 13, color: 'var(--fg-3)' }}>{drawerRoutine.nextRun}</span>
              </div>
              <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Run History</h3>
              {(ROUTINE_RUNS[drawerRoutine.id] || []).map(run => (
                <div key={run.id} className="run-history-item">
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                    <span style={{ fontSize: 13, fontWeight: 500 }}>{run.startedAt}</span>
                    <Badge tone={run.status === 'error' ? 'danger' : 'success'}>{run.status}</Badge>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--fg-3)' }}>
                    {run.duration} · {run.tokens.toLocaleString()} tokens
                  </div>
                </div>
              ))}
              {(ROUTINE_RUNS[drawerRoutine.id] || []).length === 0 && (
                <p style={{ fontSize: 13, color: 'var(--fg-3)' }}>No runs yet</p>
              )}
            </div>
          </div>
        </div>
      )}
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </AppShell>
  )
}
