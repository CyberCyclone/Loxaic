import React, { useState } from 'react'
import { AGENT_RUNS } from '../fixtures/agent-runs'
import { AppShell, ThreadList } from '../components/layout'
import { AgentStream, Inspector, PermissionBar, PlanningBanner } from '../components/agent'
import { Composer } from '../components/composer'
import { SettingsModal, ModelModal } from '../components/settings'
import { useSettings, useThinkingLevels } from '../hooks/useSettings'
import { Badge } from '../components/primitives/Badge'
import type { ThinkingLevel, AgentRun } from '../types'

interface AgentSurfaceProps {
  onNavigate: (surface: string) => void
}

export function AgentSurface({ onNavigate }: AgentSurfaceProps) {
  const [runs] = useState<AgentRun[]>(AGENT_RUNS)
  const [activeId, setActiveId] = useState<string | null>(AGENT_RUNS[0]?.id ?? null)
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [modelModalOpen, setModelModalOpen] = useState(false)
  const [selectedModel, setSelectedModel] = useState('m1')
  const [streaming, setStreaming] = useState(false)
  const [settings] = useSettings()
  const [thinkingLevels, setThinkingLevels] = useThinkingLevels()
  const thinkingLevel: ThinkingLevel = (activeId && thinkingLevels[activeId]) || settings.defaultThinkingLevel

  const activeRun = runs.find(r => r.id === activeId) ?? null
  const [runState, setRunState] = useState(activeRun?.state ?? 'done')

  const handleAllow = () => {
    setRunState('running')
    setTimeout(() => setRunState('done'), 2000)
  }

  const handleDeny = () => {
    setRunState('done')
  }

  const threadConvs = runs.map(r => ({
    id: r.id, title: r.title, kind: 'agent' as const,
    time: '2h ago', model: 'm1', location: 'server' as const,
    msgs: [],
  }))

  return (
    <AppShell
      activeSurface="agent"
      onNavigate={onNavigate}
      onOpenSettings={() => setSettingsOpen(true)}
      onNewChat={() => onNavigate('chat')}
      title="Agent"
      headerExtras={
        activeRun && (
          <button className="btn btn-ghost btn-sm" onClick={() => setInspectorOpen(!inspectorOpen)}>
            Inspector {activeRun.changedFiles.length > 0 && <Badge tone="warning">{activeRun.changedFiles.length}</Badge>}
          </button>
        )
      }
      threadList={
        <ThreadList
          conversations={threadConvs}
          activeId={activeId}
          onSelect={setActiveId}
          onNewChat={() => onNavigate('chat')}
          onContextMenu={() => {}}
          onRename={() => {}}
          onDelete={() => {}}
          title="Agent Runs"
        />
      }
    >
      {activeRun && (
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <AgentStream run={{ ...activeRun, state: runState }} onAllow={handleAllow} onDeny={handleDeny} />
            <Composer
              onSend={() => { setStreaming(true); setTimeout(() => setStreaming(false), 1000) }}
              onStop={() => setStreaming(false)}
              streaming={streaming}
              selectedModel={selectedModel}
              onSelectModel={setSelectedModel}
              thinkingLevel={thinkingLevel}
              onThinkingLevel={(level) => {
                if (activeId) setThinkingLevels(prev => ({ ...prev, [activeId]: level }))
              }}
              contextPercent={activeRun.contextPercent}
              contextStats={[
                { label: 'Tokens in', value: activeRun.messages.reduce((a, m) => a + (m.usage?.in ?? 0), 0).toLocaleString() },
                { label: 'Tokens out', value: activeRun.messages.reduce((a, m) => a + (m.usage?.out ?? 0), 0).toLocaleString() },
                { label: 'Context', value: `${activeRun.contextPercent}%` },
              ]}
              showModeDropdown
              mode={activeRun.mode}
              onModeChange={() => {}}
              smartRouting={false}
              onSmartRoutingChange={() => {}}
              onOpenModelModal={() => setModelModalOpen(true)}
              onOpenSettings={() => setSettingsOpen(true)}
            />
          </div>
          <Inspector open={inspectorOpen} run={activeRun} onClose={() => setInspectorOpen(false)} />
        </div>
      )}
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <ModelModal
        open={modelModalOpen}
        onClose={() => setModelModalOpen(false)}
        selectedModel={selectedModel}
        onSelect={setSelectedModel}
        thinkingLevel={thinkingLevel}
        onThinkingLevel={(level) => {
          if (activeId) setThinkingLevels(prev => ({ ...prev, [activeId]: level }))
        }}
        onOpenSettings={() => { setModelModalOpen(false); setSettingsOpen(true) }}
      />
    </AppShell>
  )
}
