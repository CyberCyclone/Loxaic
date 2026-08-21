import React, { useState, useCallback } from 'react'
import type { Conversation, ThinkingLevel } from '../types'
import { CONVERSATIONS } from '../fixtures/conversations'
import { AppShell, ThreadList } from '../components/layout'
import { MessageList, ContextMenu, PromptSuggestions } from '../components/chat'
import { Composer } from '../components/composer'
import { SettingsModal, ModelModal } from '../components/settings'
import { useSettings, useThinkingLevels } from '../hooks/useSettings'
import { useToast } from '../hooks/useToast'
import { getModelContext } from '../fixtures/models'
import type { Conversation as ConvType } from '../types'

interface ChatSurfaceProps {
  onNavigate: (surface: string) => void
  autoOpenSettings?: boolean
}

export function ChatSurface({ onNavigate, autoOpenSettings }: ChatSurfaceProps) {
  const [conversations, setConversations] = useState<ConvType[]>(CONVERSATIONS)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [streaming, setStreaming] = useState(false)
  const [selectedModel, setSelectedModel] = useState('m1')
  const [settingsOpen, setSettingsOpen] = useState(autoOpenSettings ?? false)
  const [modelModalOpen, setModelModalOpen] = useState(false)
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; conv: ConvType } | null>(null)
  const [settings] = useSettings()
  const [thinkingLevels, setThinkingLevels] = useThinkingLevels()
  const { showToast } = useToast()

  const activeConv = conversations.find(c => c.id === activeId) ?? null
  const thinkingLevel = (activeId && thinkingLevels[activeId]) || settings.defaultThinkingLevel

  const handleSend = useCallback((text: string) => {
    if (!activeId) {
      const newConv: ConvType = {
        id: `c${Date.now()}`, title: text.slice(0, 40), kind: 'chat',
        time: 'now', model: selectedModel, location: 'server',
        msgs: [{ role: 'user', text }],
      }
      setConversations(prev => [newConv, ...prev])
      setActiveId(newConv.id)
    } else {
      setConversations(prev => prev.map(c =>
        c.id === activeId ? { ...c, msgs: [...c.msgs, { role: 'user', text }] } : c
      ))
    }
    setStreaming(true)
    setTimeout(() => {
      setConversations(prev => prev.map(c =>
        c.id === (activeId || conversations[0]?.id) ? {
          ...c,
          msgs: [...c.msgs, {
            role: 'assistant', model: selectedModel,
            text: 'This is a simulated response. The real implementation will stream from llama.cpp.',
            usage: { in: 1200, out: 180, tps: 38, cache: 65 },
            thinking: 'Analyzing the user request...',
          }],
        } : c
      ))
      setStreaming(false)
    }, 1500)
  }, [activeId, selectedModel, conversations])

  const handleNewChat = () => { setActiveId(null) }

  const handleFork = (id: string) => {
    const conv = conversations.find(c => c.id === id)
    if (!conv) return
    const forked: ConvType = {
      ...conv, id: `c${Date.now()}`, title: `${conv.title} (fork)`, time: 'now',
      msgs: conv.msgs.slice(0, Math.ceil(conv.msgs.length / 2)),
    }
    setConversations(prev => [forked, ...prev])
    setActiveId(forked.id)
    showToast('Conversation forked')
  }

  const handleDelete = (id: string) => {
    setConversations(prev => prev.filter(c => c.id !== id))
    if (activeId === id) setActiveId(null)
    showToast('Conversation deleted')
  }

  const handleExport = (id: string) => {
    const conv = conversations.find(c => c.id === id)
    if (!conv) return
    const md = `# ${conv.title}\n\n${conv.msgs.map(m => `**${m.role}**: ${m.text}`).join('\n\n')}`
    navigator.clipboard.writeText(md)
    showToast('Exported to clipboard')
  }

  const handleRename = (id: string) => {
    const conv = conversations.find(c => c.id === id)
    if (!conv) return
    const name = prompt('Rename conversation', conv.title)
    if (name) {
      setConversations(prev => prev.map(c => c.id === id ? { ...c, title: name } : c))
    }
  }

  const contextPercent = activeConv ? Math.min(95, Math.round(activeConv.msgs.reduce((acc, m) => acc + (m.usage?.in ?? 0), 0) / getModelContext(activeConv.model) * 100)) : 0
  const contextStats = activeConv ? [
    { label: 'Tokens in', value: activeConv.msgs.reduce((a, m) => a + (m.usage?.in ?? 0), 0).toLocaleString() },
    { label: 'Tokens out', value: activeConv.msgs.reduce((a, m) => a + (m.usage?.out ?? 0), 0).toLocaleString() },
    { label: 'Cache %', value: `${Math.round(activeConv.msgs.reduce((a, m) => a + (m.usage?.cache ?? 0), 0) / activeConv.msgs.filter(m => m.usage).length || 0)}%` },
    { label: 'Context', value: `${contextPercent}% of ${getModelContext(activeConv.model).toLocaleString()}` },
  ] : []

  return (
    <AppShell
      activeSurface="chat"
      onNavigate={onNavigate}
      onOpenSettings={() => setSettingsOpen(true)}
      onNewChat={handleNewChat}
      title="Chat"
      threadList={
        <ThreadList
          conversations={conversations}
          activeId={activeId}
          onSelect={setActiveId}
          onNewChat={handleNewChat}
          onContextMenu={(e, conv) => setCtxMenu({ x: e.clientX, y: e.clientY, conv })}
          onRename={handleRename}
          onDelete={handleDelete}
          title="Chats"
        />
      }
    >
      {activeConv ? (
        <>
          <MessageList conversation={activeConv} />
          <Composer
            onSend={handleSend}
            onStop={() => setStreaming(false)}
            streaming={streaming}
            selectedModel={selectedModel}
            onSelectModel={setSelectedModel}
            thinkingLevel={thinkingLevel}
            onThinkingLevel={(level) => {
              if (activeId) setThinkingLevels(prev => ({ ...prev, [activeId]: level }))
            }}
            contextPercent={contextPercent}
            contextStats={contextStats}
            onOpenModelModal={() => setModelModalOpen(true)}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        </>
      ) : (
        <PromptSuggestions onPick={() => {}} />
      )}
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          conversation={ctxMenu.conv}
          onClose={() => setCtxMenu(null)}
          onOpen={setActiveId}
          onFork={handleFork}
          onRewind={(id) => { showToast('Rewind not implemented in prototype') }}
          onRename={handleRename}
          onExport={handleExport}
          onDelete={handleDelete}
        />
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
