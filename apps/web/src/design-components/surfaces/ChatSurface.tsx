import React, { useState, useCallback, useEffect, useRef } from 'react'
import type { Conversation, ThinkingLevel } from '../types'
import { CONVERSATIONS } from '../fixtures/conversations'
import { AppShell, ThreadList } from '../layout'
import { MessageList, ContextMenu, PromptSuggestions } from '../chat'
import { Composer } from '../composer'
import { SettingsModal, ModelModal } from '../settings'
import { useSettings, useThinkingLevels } from '../hooks/useSettings'
import { useToast } from '../hooks/useToast'
import { getModelContext } from '../fixtures/models'
import type { Conversation as ConvType } from '../types'
import { createChatSocket, sendChatMessage, getConversations, type ChatClientEvent } from '@shannon/api-client'

interface ChatSurfaceProps {
  onNavigate: (surface: string) => void
  autoOpenSettings?: boolean
  token: string
}

export function ChatSurface({ onNavigate, autoOpenSettings, token }: ChatSurfaceProps) {
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
  const wsRef = useRef<WebSocket | null>(null)
  const loadingRef = useRef(false)

  const activeConv = conversations.find(c => c.id === activeId) ?? null
  const thinkingLevel = (activeId && thinkingLevels[activeId]) || settings.defaultThinkingLevel

  // Load real conversations from API on mount
  useEffect(() => {
    if (loadingRef.current) return
    loadingRef.current = true
    getConversations().then(async (convs) => {
      if (convs.length > 0) {
        const apiConversations: ConvType[] = convs.map(c => ({
          id: c.id,
          title: c.title,
          kind: (c.kind || 'chat') as ConvType['kind'],
          time: 'recent',
          model: 'm1',
          location: 'server' as const,
          msgs: [],
        }))
        setConversations(prev => {
          // Merge with fixtures: keep fixture data, add API convs that don't exist
          const existing = new Set(prev.map(c => c.id))
          const newConvs = apiConversations.filter(c => !existing.has(c.id))
          return [...newConvs, ...prev]
        })
        // Load messages for latest conversation
        const latest = convs[0]
        setActiveId(latest.id)
        try {
          const res = await fetch(`http://localhost:4000/v1/conversations/${latest.id}/messages`, {
            headers: { Authorization: `Bearer ${token}` },
          })
          if (res.ok) {
            const data = await res.json()
            const msgs = (data.messages || []).map((m: any) => ({
              role: m.authorType === 'user' ? 'user' as const : 'assistant' as const,
              text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
              usage: m.usage ? { in: m.usage.input || 0, out: m.usage.output || 0, tps: 30, cache: 0 } : undefined,
            }))
            if (msgs.length > 0) {
              setConversations(prev => prev.map(c =>
                c.id === latest.id ? { ...c, msgs } : c
              ))
            }
          }
        } catch {}
      }
    }).catch(() => {})
  }, [token])

  // WebSocket for streaming
  useEffect(() => {
    const ws = createChatSocket(token, (event: ChatClientEvent) => {
      if (event.type === 'chat.conversation') {
        setActiveId(event.conversation_id)
      } else if (event.type === 'chat.delta') {
        setStreaming(true)
        setConversations(prev => {
          const activeIdVar = activeId
          const targetId = activeIdVar || event.conversation_id
          return prev.map(c => {
            if (c.id !== targetId) return c
            const msgs = [...c.msgs]
            const last = msgs[msgs.length - 1]
            if (last && last.role === 'assistant' && last.id === event.message_id) {
              msgs[msgs.length - 1] = { ...last, text: last.text + event.delta }
            } else {
              msgs.push({ role: 'assistant', model: selectedModel, text: event.delta, id: event.message_id })
            }
            return { ...c, msgs }
          })
        })
      } else if (event.type === 'chat.message_complete') {
        setStreaming(false)
        setConversations(prev => prev.map(c => ({
          ...c,
          msgs: c.msgs.map(m =>
            m.id === event.message_id ? {
              ...m,
              usage: { in: 1200, out: 380, tps: 38, cache: 64 }
            } : m
          )
        })))
      } else if (event.type === 'chat.error') {
        setStreaming(false)
      }
    })
    wsRef.current = ws
    return () => ws.close()
  }, [token])

  const handleSend = useCallback((text: string) => {
    if (!wsRef.current) return
    if (!activeId) {
      const newConv: ConvType = {
        id: `c${Date.now()}`, title: text.slice(0, 40), kind: 'chat',
        time: 'now', model: selectedModel, location: 'server',
        msgs: [{ role: 'user', text }],
      }
      setConversations(prev => [newConv, ...prev])
      setActiveId(newConv.id)
      sendChatMessage(wsRef.current, text, selectedModel, undefined, undefined)
    } else {
      setConversations(prev => prev.map(c =>
        c.id === activeId ? { ...c, msgs: [...c.msgs, { role: 'user', text }] } : c
      ))
      sendChatMessage(wsRef.current, text, selectedModel, activeId, undefined)
    }
  }, [activeId, selectedModel])

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
            onStop={() => { setStreaming(false); wsRef.current?.close() }}
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
          onRewind={() => { showToast('Rewind not implemented') }}
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