import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createChatSocket,
  sendChatMessage,
  getConversations,
  getMessages,
  type ChatClientEvent,
} from '@shannon/api-client';
import type { Conversation, Message } from '@/lib/types';
import { CONVERSATIONS } from '@/lib/fixtures/conversations';
import { useToastHelper } from './useToastHelper';

function extractText(blocks: Array<{ kind: string; text?: string }>): string {
  return blocks
    .filter((b) => b.kind === 'text')
    .map((b) => b.text ?? '')
    .join('\n');
}

export function useChatSession(token: string | null) {
  const [conversations, setConversations] = useState<Conversation[]>(CONVERSATIONS);
  const [activeId, setActiveIdState] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const { showToast } = useToastHelper();

  const wsRef = useRef<WebSocket | null>(null);
  const loadingRef = useRef(false);
  // A ref alongside the state: the WS effect's closure is only re-created on
  // [token], so reading `activeId` state directly inside it would be stale
  // the moment the user switches threads mid-stream. Route deltas by this
  // instead (falls back to the event's own conversation_id when unset).
  const activeIdRef = useRef<string | null>(null);

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
          model: 'm1',
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

  // Live streaming socket.
  useEffect(() => {
    if (!token) return;
    const ws = createChatSocket(token, (event: ChatClientEvent) => {
      if (event.type === 'chat.conversation') {
        setActiveId(event.conversation_id);
      } else if (event.type === 'chat.delta') {
        setStreaming(true);
        const targetId = activeIdRef.current ?? event.conversation_id;
        setConversations((prev) =>
          prev.map((c) => {
            if (c.id !== targetId) return c;
            const msgs = [...c.msgs];
            const last = msgs[msgs.length - 1];
            if (last && last.role === 'assistant' && last.id === event.message_id) {
              msgs[msgs.length - 1] = { ...last, text: last.text + event.delta };
            } else {
              msgs.push({ id: event.message_id, role: 'assistant', text: event.delta });
            }
            return { ...c, msgs };
          }),
        );
      } else if (event.type === 'chat.message_complete') {
        setStreaming(false);
        setConversations((prev) =>
          prev.map((c) => ({
            ...c,
            msgs: c.msgs.map((m) =>
              m.id === event.message_id
                ? {
                    ...m,
                    usage: {
                      in: event.usage.prompt_tokens,
                      out: event.usage.completion_tokens,
                      tps: 0,
                      cache: 0,
                    },
                  }
                : m,
            ),
          })),
        );
      } else if (event.type === 'chat.error') {
        setStreaming(false);
        showToast('Chat error — see server logs');
      }
    });
    wsRef.current = ws;
    return () => ws.close();
  }, [token, setActiveId, showToast]);

  const handleSend = useCallback(
    (text: string, model: string) => {
      if (!wsRef.current) return;
      if (!activeIdRef.current) {
        const newConv: Conversation = {
          id: `c${Date.now()}`,
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

  const activeConv = conversations.find((c) => c.id === activeId) ?? null;

  return {
    conversations,
    activeId,
    activeConv,
    setActiveId,
    streaming,
    handleSend,
    handleStop,
    handleNewChat,
    handleFork,
    handleDelete,
    handleRename,
  };
}
