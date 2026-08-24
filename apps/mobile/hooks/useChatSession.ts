import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createChatSocket,
  sendChatMessage,
  getConversations,
  getMessages,
  updateConversation,
  type ChatClientEvent,
} from '@shannon/api-client';
import type { Conversation, Message } from '@/lib/types';
import { CONVERSATIONS } from '@/lib/fixtures/conversations';
import { tickLiveTps } from '@/lib/liveTps';
import { useToastHelper } from './useToastHelper';

function extractText(blocks: Array<{ kind: string; text?: string }>): string {
  return blocks
    .filter((b) => b.kind === 'text')
    .map((b) => b.text ?? '')
    .join('\n');
}

function extractThinking(blocks: Array<{ kind: string; text?: string }>): string | undefined {
  const thinking = blocks
    .filter((b) => b.kind === 'thinking')
    .map((b) => b.text ?? '')
    .join('\n');
  return thinking || undefined;
}

export function useChatSession(token: string | null) {
  const [conversations, setConversations] = useState<Conversation[]>(CONVERSATIONS);
  const [activeId, setActiveIdState] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [loadingModel, setLoadingModel] = useState(false);
  const { showToast } = useToastHelper();

  const wsRef = useRef<WebSocket | null>(null);
  const loadingRef = useRef(false);
  // A ref alongside the state: the WS effect's closure is only re-created on
  // [token], so reading `activeId` state directly inside it would be stale
  // the moment the user switches threads mid-stream. Route deltas by this
  // instead (falls back to the event's own conversation_id when unset).
  const activeIdRef = useRef<string | null>(null);
  // Set together in handleSend when a brand-new conversation is created
  // locally (before the server has assigned a real id); consumed and
  // cleared by the chat.conversation handler once the real id arrives.
  const pendingLocalIdRef = useRef<string | null>(null);
  const pendingModelRef = useRef<string | null>(null);
  // Per in-flight message: { start, count } for the live tok/s estimate.
  const liveTokenStatsRef = useRef<Map<string, { start: number; count: number }>>(new Map());

  const setActiveId = useCallback((id: string | null) => {
    activeIdRef.current = id;
    setActiveIdState(id);
  }, []);

  // Load real conversations + latest thread's history on mount / token change.
  useEffect(() => {
    if (!token || loadingRef.current) return;
    loadingRef.current = true;
    getConversations()
      .then(async (convs) => {
        if (convs.length === 0) return;
        const apiConversations: Conversation[] = convs.map((c) => ({
          id: c.id,
          title: c.title,
          kind: (c.kind || 'chat') as Conversation['kind'],
          time: 'recent',
          model: c.modelPref?.model ?? '',
          location: 'server' as const,
          msgs: [],
        }));
        setConversations((prev) => {
          const existing = new Set(prev.map((c) => c.id));
          const fresh = apiConversations.filter((c) => !existing.has(c.id));
          return [...fresh, ...prev];
        });

        const latest = convs[0];
        setActiveId(latest.id);
        try {
          const { messages: rows } = await getMessages(latest.id);
          const msgs: Message[] = rows
            .filter((m) => m.authorType === 'user' || m.authorType === 'assistant')
            .map((m) => ({
              id: m.id,
              role: m.authorType === 'user' ? 'user' : 'assistant',
              model: m.model ?? undefined,
              text: extractText(m.content as Array<{ kind: string; text?: string }>),
              thinking: extractThinking(m.content as Array<{ kind: string; text?: string }>),
              error: m.status === 'error',
            }));
          if (msgs.length > 0) {
            setConversations((prev) =>
              prev.map((c) => (c.id === latest.id ? { ...c, msgs } : c)),
            );
          }
        } catch {
          // Non-fatal: thread list still loaded, just no history preview yet.
        }
      })
      .catch(() => {})
      .finally(() => {
        loadingRef.current = false;
      });
  }, [token, setActiveId]);

  // Live streaming socket. Mobile networks drop long-lived WS connections
  // often (backgrounding, wifi/cellular handoff) — without reconnect, a
  // dropped socket left `streaming` stuck true forever even though the
  // server had already finished and persisted the response, making the
  // chat look permanently hung. This reconnects with backoff and, on every
  // (re)connect, refreshes the active thread from the server so whatever
  // completed while disconnected actually shows up.
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const refreshActiveConversation = () => {
      const convId = activeIdRef.current;
      if (!convId) return;
      getMessages(convId)
        .then(({ messages: rows }) => {
          const msgs: Message[] = rows
            .filter((m) => m.authorType === 'user' || m.authorType === 'assistant')
            .map((m) => ({
              id: m.id,
              role: m.authorType === 'user' ? 'user' : 'assistant',
              model: m.model ?? undefined,
              text: extractText(m.content as Array<{ kind: string; text?: string }>),
              thinking: extractThinking(m.content as Array<{ kind: string; text?: string }>),
              error: m.status === 'error',
            }));
          setConversations((prev) => prev.map((c) => (c.id === convId ? { ...c, msgs } : c)));
        })
        .catch(() => {});
    };

    const onEvent = (event: ChatClientEvent) => {
      if (event.type === 'chat.conversation') {
        const realId = event.conversation_id;
        const localId = pendingLocalIdRef.current;
        const modelForPatch = pendingModelRef.current;
        pendingLocalIdRef.current = null;
        pendingModelRef.current = null;
        if (localId && localId !== realId) {
          setConversations((prev) =>
            prev.some((c) => c.id === localId)
              ? prev.map((c) => (c.id === localId ? { ...c, id: realId } : c))
              : prev,
          );
        }
        setActiveId(realId);
        if (modelForPatch) {
          updateConversation(realId, { model_pref: { model: modelForPatch } }).catch(() => {});
        }
      } else if (event.type === 'chat.model_loading') {
        setLoadingModel(true);
      } else if (event.type === 'chat.thinking') {
        setStreaming(true);
        setLoadingModel(false);
        const liveTps = tickLiveTps(liveTokenStatsRef.current, event.message_id);
        const targetId = activeIdRef.current ?? event.conversation_id;
        setConversations((prev) =>
          prev.map((c) => {
            if (c.id !== targetId) return c;
            const msgs = [...c.msgs];
            const last = msgs[msgs.length - 1];
            if (last && last.role === 'assistant' && last.id === event.message_id) {
              msgs[msgs.length - 1] = { ...last, thinking: (last.thinking ?? '') + event.delta, liveTps };
            } else {
              msgs.push({ id: event.message_id, role: 'assistant', text: '', thinking: event.delta, liveTps });
            }
            return { ...c, msgs };
          }),
        );
      } else if (event.type === 'chat.delta') {
        setStreaming(true);
        setLoadingModel(false);
        const liveTps = tickLiveTps(liveTokenStatsRef.current, event.message_id);
        const targetId = activeIdRef.current ?? event.conversation_id;
        setConversations((prev) =>
          prev.map((c) => {
            if (c.id !== targetId) return c;
            const msgs = [...c.msgs];
            const last = msgs[msgs.length - 1];
            if (last && last.role === 'assistant' && last.id === event.message_id) {
              msgs[msgs.length - 1] = { ...last, text: last.text + event.delta, liveTps };
            } else {
              msgs.push({ id: event.message_id, role: 'assistant', text: event.delta, liveTps });
            }
            return { ...c, msgs };
          }),
        );
      } else if (event.type === 'chat.message_complete') {
        setStreaming(false);
        setLoadingModel(false);
        liveTokenStatsRef.current.delete(event.message_id);
        setConversations((prev) =>
          prev.map((c) => ({
            ...c,
            msgs: c.msgs.map((m) =>
              m.id === event.message_id
                ? {
                    ...m,
                    liveTps: undefined,
                    usage: {
                      in: event.usage.prompt_tokens,
                      out: event.usage.completion_tokens,
                      tps: event.usage.gen_tps ?? 0,
                      promptTps: event.usage.prompt_tps,
                      cache: 0,
                    },
                  }
                : m,
            ),
          })),
        );
      } else if (event.type === 'chat.error') {
        setStreaming(false);
        setLoadingModel(false);
        const targetId = event.conversation_id ?? activeIdRef.current;
        // Protocol-level errors (bad JSON, missing content) have no
        // conversation/message to attach to — those still toast.
        if (targetId && event.message_id) {
          const messageId = event.message_id;
          liveTokenStatsRef.current.delete(messageId);
          setConversations((prev) =>
            prev.map((c) => {
              if (c.id !== targetId) return c;
              const msgs = [...c.msgs];
              const idx = msgs.findIndex((m) => m.id === messageId);
              if (idx >= 0) {
                msgs[idx] = { ...msgs[idx], text: event.error, error: true, liveTps: undefined };
              } else {
                msgs.push({ id: messageId, role: 'assistant', text: event.error, error: true });
              }
              return { ...c, msgs };
            }),
          );
        } else {
          showToast(event.error || 'Chat error', 6000);
        }
      }
    };

    const connect = () => {
      const ws = createChatSocket(token, onEvent);
      ws.onopen = () => {
        attempt = 0;
        refreshActiveConversation();
      };
      ws.onclose = () => {
        if (cancelled) return;
        // Whatever was in flight is now unknown client-side — the server may
        // well have finished it already (it doesn't stop on a dropped
        // socket). Stop showing "streaming" as if frozen and reconcile with
        // the server's actual state once reconnected (onopen, above).
        setStreaming(false);
        setLoadingModel(false);
        attempt += 1;
        const delay = Math.min(1000 * attempt, 5000);
        reconnectTimer = setTimeout(connect, delay);
      };
      wsRef.current = ws;
    };
    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      wsRef.current?.close();
    };
  }, [token, setActiveId, showToast]);

  const handleSend = useCallback(
    (text: string, model: string) => {
      if (!wsRef.current) return;
      setStreaming(true);
      setLoadingModel(false);
      if (!activeIdRef.current) {
        const localId = `c${Date.now()}`;
        pendingLocalIdRef.current = localId;
        pendingModelRef.current = model;
        const newConv: Conversation = {
          id: localId,
          title: text.slice(0, 40),
          kind: 'chat',
          time: 'now',
          model,
          location: 'server',
          msgs: [{ role: 'user', text }],
        };
        setConversations((prev) => [newConv, ...prev]);
        setActiveId(newConv.id);
        sendChatMessage(wsRef.current, text, model, undefined, undefined);
      } else {
        const id = activeIdRef.current;
        setConversations((prev) =>
          prev.map((c) => (c.id === id ? { ...c, msgs: [...c.msgs, { role: 'user', text }] } : c)),
        );
        sendChatMessage(wsRef.current, text, model, id, undefined);
      }
    },
    [setActiveId],
  );

  const handleStop = useCallback(() => {
    setStreaming(false);
    setLoadingModel(false);
    wsRef.current?.close();
  }, []);

  const handleNewChat = useCallback(() => setActiveId(null), [setActiveId]);

  const handleFork = useCallback(
    (id: string) => {
      setConversations((prev) => {
        const conv = prev.find((c) => c.id === id);
        if (!conv) return prev;
        const forked: Conversation = {
          ...conv,
          id: `c${Date.now()}`,
          title: `${conv.title} (fork)`,
          time: 'now',
          msgs: conv.msgs.slice(0, Math.ceil(conv.msgs.length / 2)),
        };
        setActiveId(forked.id);
        return [forked, ...prev];
      });
      showToast('Conversation forked');
    },
    [setActiveId, showToast],
  );

  const handleDelete = useCallback(
    (id: string) => {
      setConversations((prev) => prev.filter((c) => c.id !== id));
      if (activeIdRef.current === id) setActiveId(null);
      showToast('Conversation deleted');
    },
    [setActiveId, showToast],
  );

  const handleRename = useCallback(
    (id: string, name: string) => {
      setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, title: name } : c)));
    },
    [],
  );

  const setConversationModel = useCallback((id: string, modelId: string) => {
    setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, model: modelId } : c)));
    updateConversation(id, { model_pref: { model: modelId } }).catch(() => {});
  }, []);

  const activeConv = conversations.find((c) => c.id === activeId) ?? null;

  return {
    conversations,
    activeId,
    activeConv,
    setActiveId,
    streaming,
    loadingModel,
    handleSend,
    handleStop,
    handleNewChat,
    handleFork,
    handleDelete,
    handleRename,
    setConversationModel,
  };
}
