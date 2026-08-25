import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import {
  createChatSocket,
  sendChatMessage,
  getConversations,
  getMessages,
  updateConversation,
  type ChatClientEvent,
  type ApiMessage,
  type ApiMessageUsage,
} from '@shannon/api-client';
import type { Conversation, Message, MessageUsage } from '@/lib/types';
import { CONVERSATIONS } from '@/lib/fixtures/conversations';
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

/** Persisted usage row (if any) → the shape Message/MessageList render — real, backend-measured, never guessed. */
function toMessageUsage(usage: ApiMessageUsage | null): MessageUsage | undefined {
  if (!usage) return undefined;
  return {
    in: usage.inputTokens,
    out: usage.outputTokens,
    tps: usage.predictedTps ?? 0,
    promptTps: usage.promptTps,
    totalMs: usage.totalMs,
    cache: 0,
  };
}

function mapRows(rows: ApiMessage[]): Message[] {
  return rows
    .filter((m) => m.authorType === 'user' || m.authorType === 'assistant')
    .map((m) => ({
      id: m.id,
      role: m.authorType === 'user' ? 'user' : 'assistant',
      model: m.model ?? undefined,
      text: extractText(m.content as Array<{ kind: string; text?: string }>),
      thinking: extractThinking(m.content as Array<{ kind: string; text?: string }>),
      error: m.status === 'error',
      usage: toMessageUsage(m.usage),
    }));
}

/** Like mapRows, but never lets a reconciliation fetch clobber live-streamed
 * content: the DB row for a message that's still `status: "streaming"` is
 * only ever the initial empty placeholder — real content is written once,
 * at the very end. Reconciliation can run while a response is still
 * perfectly healthy (e.g. a foreground-resume catch-up check), so if the
 * client already has live-accumulated text/thinking for that message id,
 * keep it instead of overwriting it with the stale empty snapshot. */
function mergeRows(existing: Message[], rows: ApiMessage[]): Message[] {
  const existingById = new Map<string, Message>();
  for (const m of existing) if (m.id) existingById.set(m.id, m);
  return rows
    .filter((m) => m.authorType === 'user' || m.authorType === 'assistant')
    .map((m): Message => {
      if (m.status === 'streaming') {
        const local = existingById.get(m.id);
        if (local && (local.text || local.thinking)) return local;
      }
      return {
        id: m.id,
        role: m.authorType === 'user' ? 'user' : 'assistant',
        model: m.model ?? undefined,
        text: extractText(m.content as Array<{ kind: string; text?: string }>),
        thinking: extractThinking(m.content as Array<{ kind: string; text?: string }>),
        error: m.status === 'error',
        usage: toMessageUsage(m.usage),
      };
    });
}

// How long to keep re-polling a conversation whose socket died mid-response,
// waiting for the DB row to resolve to "complete"/"error". A dropped mobile
// connection often looks alive to the server (no clean close, so
// socket.send() on the dead connection never throws) — the response finishes
// generating and gets persisted, but the send-outs silently go nowhere, and
// the client never gets a chat.message_complete/chat.error to act on. This
// is the only thing that later fetches the true DB state instead of leaving
// the message permanently stuck exactly as it looked at the moment of drop.
const RECONCILE_ATTEMPTS = 5;
const RECONCILE_DELAY_MS = 3000;

/** Per-conversation in-flight state — keyed by conversation id so switching
 * threads mid-response can never show one conversation's stop button,
 * elapsed timer, or model label on another. Only the conversation(s) that
 * actually have a request in flight get an entry; everything else reads as
 * "not streaming" regardless of which thread is currently being viewed. */
type StreamState = { loadingModel: boolean; responseStartedAt: number; model: string };

export function useChatSession(token: string | null) {
  const [conversations, setConversations] = useState<Conversation[]>(CONVERSATIONS);
  const [activeId, setActiveIdState] = useState<string | null>(null);
  const [streamingByConv, setStreamingByConvState] = useState<Record<string, StreamState>>({});
  const { showToast } = useToastHelper();

  const wsRef = useRef<WebSocket | null>(null);
  const loadingRef = useRef(false);
  // A ref alongside the state: the WS effect's closure is only re-created on
  // [token], so reading `activeId` state directly inside it would be stale
  // the moment the user switches threads mid-stream. Route deltas by this
  // instead (falls back to the event's own conversation_id when unset).
  const activeIdRef = useRef<string | null>(null);
  // Same staleness problem applies to streamingByConv — the WS effect reads
  // it synchronously to attribute a live message to its in-flight model, so
  // it needs a ref mirror alongside the state, kept in sync by every setter
  // below rather than read from the (potentially stale) closed-over state.
  const streamingByConvRef = useRef<Record<string, StreamState>>({});
  // Set together in handleSend when a brand-new conversation is created
  // locally (before the server has assigned a real id); consumed and
  // cleared by the chat.conversation handler once the real id arrives.
  const pendingLocalIdRef = useRef<string | null>(null);
  const pendingModelRef = useRef<string | null>(null);

  const setStreamingByConv = useCallback(
    (updater: (prev: Record<string, StreamState>) => Record<string, StreamState>) => {
      setStreamingByConvState((prev) => {
        const next = updater(prev);
        streamingByConvRef.current = next;
        return next;
      });
    },
    [],
  );

  const patchStream = useCallback(
    (id: string, patch: Partial<StreamState>) => {
      setStreamingByConv((prev) => (id in prev ? { ...prev, [id]: { ...prev[id], ...patch } } : prev));
    },
    [setStreamingByConv],
  );

  const clearStream = useCallback(
    (id: string) => {
      setStreamingByConv((prev) => {
        if (!(id in prev)) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      });
    },
    [setStreamingByConv],
  );

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
          const msgs = mapRows(rows);
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
  // (re)connect, reconciles the server's actual state for the active
  // conversation *and* every conversation that had a response in flight
  // when the drop happened (which may not be the one currently being
  // viewed — the user could easily have switched threads first). A dropped
  // mobile socket often isn't a clean close on either end, so the server's
  // in-progress response finishes and gets persisted, but the events
  // announcing that never arrive on a connection that's already gone —
  // reconciliation is what actually catches that up instead of leaving the
  // message frozen exactly as it looked at the moment of the drop.
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    // Conversation ids whose in-flight response we lost the live connection
    // to and haven't yet confirmed a terminal (complete/error) status for.
    const pendingReconcile = new Set<string>();
    const reconcileTimers = new Map<string, ReturnType<typeof setTimeout>>();

    const clearReconcileTimer = (convId: string) => {
      const timer = reconcileTimers.get(convId);
      if (timer) {
        clearTimeout(timer);
        reconcileTimers.delete(convId);
      }
    };

    const reconcileConversation = (convId: string, retriesLeft: number) => {
      if (cancelled) return;
      getMessages(convId)
        .then(({ messages: rows }) => {
          if (cancelled) return;
          setConversations((prev) =>
            prev.map((c) => (c.id === convId ? { ...c, msgs: mergeRows(c.msgs, rows) } : c)),
          );
          const lastRow = rows[rows.length - 1];
          const stillUnresolved = lastRow?.authorType === 'assistant' && lastRow.status === 'streaming';
          if (stillUnresolved && retriesLeft > 0) {
            clearReconcileTimer(convId);
            reconcileTimers.set(
              convId,
              setTimeout(() => reconcileConversation(convId, retriesLeft - 1), RECONCILE_DELAY_MS),
            );
          } else {
            pendingReconcile.delete(convId);
            clearReconcileTimer(convId);
          }
        })
        .catch(() => {
          // Left in pendingReconcile — the next reconnect's onopen will retry.
        });
    };

    const refreshActiveConversation = () => {
      const targets = new Set(pendingReconcile);
      if (activeIdRef.current) targets.add(activeIdRef.current);
      for (const convId of targets) reconcileConversation(convId, RECONCILE_ATTEMPTS);
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
          setStreamingByConv((prev) => {
            if (!(localId in prev)) return prev;
            const next = { ...prev };
            next[realId] = next[localId];
            delete next[localId];
            return next;
          });
        }
        setActiveId(realId);
        if (modelForPatch) {
          updateConversation(realId, { model_pref: { model: modelForPatch } }).catch(() => {});
        }
      } else if (event.type === 'chat.model_loading') {
        const targetId = event.conversation_id ?? activeIdRef.current;
        if (targetId) patchStream(targetId, { loadingModel: true });
      } else if (event.type === 'chat.thinking') {
        // The event's own conversation_id is authoritative — it names the
        // conversation this token actually belongs to. Falling back to
        // activeIdRef (only relevant for the brand-new-conversation window
        // before chat.conversation remaps it) must never override that,
        // or switching threads mid-stream misroutes the old thread's
        // still-arriving tokens into whatever the user is now viewing.
        const targetId = event.conversation_id ?? activeIdRef.current;
        if (targetId) patchStream(targetId, { loadingModel: false });
        const streamModel = targetId ? streamingByConvRef.current[targetId]?.model : undefined;
        setConversations((prev) =>
          prev.map((c) => {
            if (c.id !== targetId) return c;
            const msgs = [...c.msgs];
            const last = msgs[msgs.length - 1];
            if (last && last.role === 'assistant' && last.id === event.message_id) {
              msgs[msgs.length - 1] = { ...last, thinking: (last.thinking ?? '') + event.delta };
            } else {
              msgs.push({
                id: event.message_id,
                role: 'assistant',
                text: '',
                thinking: event.delta,
                model: streamModel,
              });
            }
            return { ...c, msgs };
          }),
        );
      } else if (event.type === 'chat.delta') {
        // See chat.thinking above: event.conversation_id must win.
        const targetId = event.conversation_id ?? activeIdRef.current;
        if (targetId) patchStream(targetId, { loadingModel: false });
        const streamModel = targetId ? streamingByConvRef.current[targetId]?.model : undefined;
        setConversations((prev) =>
          prev.map((c) => {
            if (c.id !== targetId) return c;
            const msgs = [...c.msgs];
            const last = msgs[msgs.length - 1];
            if (last && last.role === 'assistant' && last.id === event.message_id) {
              msgs[msgs.length - 1] = { ...last, text: last.text + event.delta };
            } else {
              msgs.push({
                id: event.message_id,
                role: 'assistant',
                text: event.delta,
                model: streamModel,
              });
            }
            return { ...c, msgs };
          }),
        );
      } else if (event.type === 'chat.message_complete') {
        if (event.conversation_id) clearStream(event.conversation_id);
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
                      tps: event.usage.gen_tps ?? 0,
                      promptTps: event.usage.prompt_tps,
                      totalMs: event.usage.total_ms,
                      cache: 0,
                    },
                  }
                : m,
            ),
          })),
        );
      } else if (event.type === 'chat.error') {
        const targetId = event.conversation_id ?? activeIdRef.current;
        if (targetId) clearStream(targetId);
        // Protocol-level errors (bad JSON, missing content) have no
        // conversation/message to attach to — those still toast.
        if (targetId && event.message_id) {
          const messageId = event.message_id;
          const streamModel = streamingByConvRef.current[targetId]?.model;
          setConversations((prev) =>
            prev.map((c) => {
              if (c.id !== targetId) return c;
              const msgs = [...c.msgs];
              const idx = msgs.findIndex((m) => m.id === messageId);
              if (idx >= 0) {
                msgs[idx] = { ...msgs[idx], text: event.error, error: true };
              } else {
                msgs.push({
                  id: messageId,
                  role: 'assistant',
                  text: event.error,
                  error: true,
                  model: streamModel,
                });
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
        // socket). Stop showing "streaming" as if frozen; every conversation
        // that had an entry gets queued for reconciliation once reconnected
        // (onopen, above) instead of being silently forgotten.
        for (const convId of Object.keys(streamingByConvRef.current)) pendingReconcile.add(convId);
        setStreamingByConv(() => ({}));
        attempt += 1;
        const delay = Math.min(1000 * attempt, 5000);
        reconnectTimer = setTimeout(connect, delay);
      };
      wsRef.current = ws;
    };
    connect();

    // A short background spell (switching apps for a few seconds) rarely
    // closes the socket outright — mobile OSes give a grace period before
    // suspending network activity — but it does freeze the JS thread, so a
    // chat.thinking/chat.delta/chat.message_complete that arrives while
    // backgrounded can be lost to the native WebSocket bridge losing sync
    // across the JS-context pause, even though the socket itself is still
    // fine. onclose-driven reconciliation above never fires in that case
    // because nothing actually closed. Do a merge-safe reconcile pass on
    // every foreground resume instead — deliberately *not* closing the
    // socket, since that would sever an otherwise-healthy live stream's
    // future tokens for no reason; mergeRows means this is safe to run
    // even while a response is still genuinely, successfully in flight.
    let appState: AppStateStatus = AppState.currentState;
    const appStateSub = AppState.addEventListener('change', (next) => {
      if (/inactive|background/.test(appState) && next === 'active') {
        const targets = new Set(pendingReconcile);
        if (activeIdRef.current) targets.add(activeIdRef.current);
        for (const convId of targets) {
          pendingReconcile.add(convId);
          reconcileConversation(convId, RECONCILE_ATTEMPTS);
        }
      }
      appState = next;
    });

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      for (const timer of reconcileTimers.values()) clearTimeout(timer);
      appStateSub.remove();
      wsRef.current?.close();
    };
  }, [token, setActiveId, showToast, patchStream, clearStream, setStreamingByConv]);

  const handleSend = useCallback(
    (text: string, model: string) => {
      if (!wsRef.current) return;
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
        setStreamingByConv((prev) => ({
          ...prev,
          [localId]: { loadingModel: false, responseStartedAt: Date.now(), model },
        }));
        sendChatMessage(wsRef.current, text, model, undefined, undefined);
      } else {
        const id = activeIdRef.current;
        setConversations((prev) =>
          prev.map((c) => (c.id === id ? { ...c, msgs: [...c.msgs, { role: 'user', text }] } : c)),
        );
        setStreamingByConv((prev) => ({
          ...prev,
          [id]: { loadingModel: false, responseStartedAt: Date.now(), model },
        }));
        sendChatMessage(wsRef.current, text, model, id, undefined);
      }
    },
    [setActiveId, setStreamingByConv],
  );

  const handleStop = useCallback(() => {
    // Closing the socket kills every in-flight response on it, not just the
    // one for the active conversation.
    setStreamingByConv(() => ({}));
    wsRef.current?.close();
  }, [setStreamingByConv]);

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
  // Scoped to the active conversation on purpose — a background thread that's
  // still streaming must never light up the stop button, elapsed timer, or
  // typing indicator for whichever conversation the user has switched to.
  const activeStream = activeId ? streamingByConv[activeId] : undefined;

  return {
    conversations,
    activeId,
    activeConv,
    setActiveId,
    streaming: !!activeStream,
    loadingModel: activeStream?.loadingModel ?? false,
    responseStartedAt: activeStream?.responseStartedAt ?? null,
    handleSend,
    handleStop,
    handleNewChat,
    handleFork,
    handleDelete,
    handleRename,
    setConversationModel,
  };
}
