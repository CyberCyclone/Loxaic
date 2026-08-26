import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import {
  createChatSocket,
  sendChatMessage,
  sendCommand,
  subscribeStreams,
  stopStream,
  getConversations,
  getMessages,
  updateConversation,
  type ServerMessage,
  type StreamEventKind,
  type StreamSnapshot,
  type ApiMessage,
} from '@shannon/api-client';
import type { CompactionStats, ContentBlock } from '@shannon/types';
import type { Conversation, Message } from '@/lib/types';
import { toMessageUsage, usageFromTurn } from '@/lib/usage';
import { CONVERSATIONS } from '@/lib/fixtures/conversations';
import { useToastHelper } from './useToastHelper';

/** Author types the client renders as a message row — everything else
 * (currently nothing else) is dropped. Kept as one list so the REST loader
 * and the two live paths (snapshot, message.start) agree on what counts. */
function roleOf(authorType: string): Message['role'] | null {
  if (authorType === 'user') return 'user';
  if (authorType === 'assistant') return 'assistant';
  if (authorType === 'summary') return 'summary';
  return null;
}

function extractCompaction(blocks: ContentBlock[]): CompactionStats | undefined {
  const block = blocks.find(
    (b): b is Extract<ContentBlock, { kind: 'compaction' }> => b.kind === 'compaction',
  );
  if (!block) return undefined;
  const { kind: _kind, ...stats } = block;
  return stats;
}

function extractText(blocks: { kind: string; text?: string }[]): string {
  return blocks
    .filter((b) => b.kind === 'text')
    .map((b) => b.text ?? '')
    .join('\n');
}

function extractThinking(blocks: { kind: string; text?: string }[]): string | undefined {
  const thinking = blocks
    .filter((b) => b.kind === 'thinking')
    .map((b) => b.text ?? '')
    .join('\n');
  return thinking || undefined;
}

/** Cold history load only (REST) — live state is driven entirely by the
 * stream protocol below, never by re-fetching and clobbering in place. */
function mapRows(rows: ApiMessage[]): Message[] {
  const out: Message[] = [];
  for (const m of rows) {
    const role = roleOf(m.authorType);
    if (!role) continue;
    const blocks = m.content;
    out.push({
      id: m.id,
      role,
      model: m.model ?? undefined,
      text: extractText(blocks),
      thinking: extractThinking(blocks),
      error: m.status === 'error',
      usage: toMessageUsage(m.usage),
      compaction: role === 'summary' ? extractCompaction(blocks) : undefined,
    });
  }
  return out;
}

/** A `stream.sync` snapshot is authoritative — unlike the old reconcile
 * poll, there's no risk of clobbering live content with a stale empty DB
 * row, because the snapshot itself *is* the live state, folded server-side
 * from the same durable log the deltas come from. */
function applySnapshotToMsgs(msgs: Message[], snapshot: StreamSnapshot): Message[] {
  const result = [...msgs];
  for (const sm of snapshot.messages) {
    const role = roleOf(sm.author_type) ?? 'assistant';
    const converted: Message = {
      id: sm.message_id,
      role,
      model: sm.model,
      text: sm.text,
      thinking: sm.thinking || undefined,
      usage: sm.usage ? usageFromTurn(sm.usage) : undefined,
      error: sm.status === 'error',
      stopped: sm.status === 'cancelled',
      compaction: role === 'summary' ? sm.compaction : undefined,
    };
    const idx = result.findIndex((m) => m.id === sm.message_id);
    if (idx >= 0) result[idx] = converted;
    else result.push(converted);
  }
  return result;
}

function applyEventToMsgs(msgs: Message[], event: StreamEventKind): Message[] {
  switch (event.kind) {
    case 'message.start': {
      if (msgs.some((m) => m.id === event.message_id)) return msgs;
      return [
        ...msgs,
        {
          id: event.message_id,
          role: roleOf(event.author_type) ?? 'assistant',
          model: event.model,
          text: event.text ?? '',
        },
      ];
    }
    case 'text.delta':
      return msgs.map((m) => (m.id === event.message_id ? { ...m, text: m.text + event.text } : m));
    case 'thinking.delta':
      return msgs.map((m) => (m.id === event.message_id ? { ...m, thinking: (m.thinking ?? '') + event.text } : m));
    case 'compaction': {
      const { message_id, messages_compacted, before_tokens, after_tokens, saved_tokens, before_estimated, skipped, guidance } =
        event;
      const stats = { messages_compacted, before_tokens, after_tokens, saved_tokens, before_estimated, skipped, guidance };
      return msgs.map((m) => (m.id === message_id ? { ...m, compaction: stats } : m));
    }
    case 'message.end':
      return msgs.map((m) =>
        m.id === event.message_id
          ? {
              ...m,
              usage: event.usage ? usageFromTurn(event.usage) : m.usage,
              error: event.status === 'error',
              stopped: event.status === 'cancelled',
            }
          : m,
      );
    default:
      // model.loading/iteration/tool.*/approval.request/todos — chat never
      // emits these; only the agent surface does.
      return msgs;
  }
}

/** Per-conversation in-flight stream state — keyed by conversation id so
 * switching threads mid-response can never show one conversation's stop
 * button, elapsed timer, or model label on another. Preserved across a
 * socket reconnect (not cleared on close): the seq cursor (tracked in a ref,
 * not here) is what makes resuming
 * exact, and clearing on every drop would also reset the elapsed timer for
 * no reason. It's only ever cleared by an authoritative terminal status —
 * `stream.sync.status !== "active"` (already finished by the time we
 * caught up) or a live `stream.end`. */
interface StreamState { streamId: string; loadingModel: boolean; responseStartedAt: number; model: string }

/** Minimum spacing between resync requests for the same stream. */
const RESYNC_COOLDOWN_MS = 500;

export function useChatSession(token: string | null, onStreamEnd?: () => void) {
  const [conversations, setConversations] = useState<Conversation[]>(CONVERSATIONS);
  const [activeId, setActiveIdState] = useState<string | null>(null);
  const [streamingByConv, setStreamingByConvState] = useState<Partial<Record<string, StreamState>>>({});
  const { showToast } = useToastHelper();

  const wsRef = useRef<WebSocket | null>(null);
  const loadingRef = useRef(false);
  // Held in a ref rather than read from the WS effect's closure: the effect
  // only re-runs on [token], and adding an inline callback to its deps would
  // tear down and rebuild the socket on every render of the parent screen.
  const onStreamEndRef = useRef(onStreamEnd);
  onStreamEndRef.current = onStreamEnd;
  // A ref alongside the state: the WS effect's closure is only re-created on
  // [token], so reading `activeId` state directly inside it would be stale
  // the moment the user switches threads mid-stream. Route deltas by this
  // instead (falls back to the event's own conversation_id when unset).
  const activeIdRef = useRef<string | null>(null);
  const streamingByConvRef = useRef<Partial<Record<string, StreamState>>>({});
  const pendingLocalIdRef = useRef<string | null>(null);
  const pendingModelRef = useRef<string | null>(null);
  // The optimistic user bubble pushed by handleSend has no server id yet;
  // the server's own `message.start` for that same message arrives moments
  // later with a real one. Without renaming the optimistic entry in place,
  // `message.start`'s id-based dedup never matches it and appends a second,
  // duplicate bubble for every single send.
  const pendingUserMsgIdRef = useRef<string | null>(null);
  /** Last time we asked the server to resync a given stream — see the gap
   * handler below for why this needs a floor. */
  const lastResyncAtRef = useRef<Record<string, number>>({});
  /**
   * Last applied seq per stream, tracked here rather than in React state.
   * This has to update the instant an event is handled: several deltas
   * routinely arrive within a single tick, and a cursor that only advances
   * when React flushes would still read as stale for the rest of that batch,
   * making every event after the first look like a gap and get dropped.
   */
  const cursorsRef = useRef<Partial<Record<string, number>>>({});

  const setStreamingByConv = useCallback(
    (
      updater: (
        prev: Partial<Record<string, StreamState>>,
      ) => Partial<Record<string, StreamState>>,
    ) => {
      setStreamingByConvState((prev) => {
        const next = updater(prev);
        streamingByConvRef.current = next;
        return next;
      });
    },
    [],
  );

  const clearStream = useCallback(
    (id: string) => {
      setStreamingByConv((prev) => {
        if (!(id in prev)) return prev;
        return Object.fromEntries(Object.entries(prev).filter(([key]) => key !== id));
      });
    },
    [setStreamingByConv],
  );

  const setActiveId = useCallback((id: string | null) => {
    activeIdRef.current = id;
    setActiveIdState(id);
  }, []);

  /** Renames the pending optimistic user bubble (if any) to its real
   * server-assigned id, in place — call this before any id-based upsert of
   * that same message, so it updates rather than duplicates. */
  const promotePendingUserMsg = useCallback((convId: string, realId: string) => {
    const pending = pendingUserMsgIdRef.current;
    if (!pending) return;
    pendingUserMsgIdRef.current = null;
    setConversations((prev) =>
      prev.map((c) =>
        c.id === convId ? { ...c, msgs: c.msgs.map((m) => (m.id === pending ? { ...m, id: realId } : m)) } : c,
      ),
    );
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
      .catch(() => undefined)
      .finally(() => {
        loadingRef.current = false;
      });
  }, [token, setActiveId]);

  // Live streaming socket. A dropped connection no longer needs a reconcile
  // poll: every event carries a monotonic per-stream `seq`, so reconnecting
  // is just re-sending `stream.subscribe` with the last-applied seq per
  // conversation — the server folds its durable log into one `stream.sync`
  // snapshot (covering both "still generating, catch me up" and "finished
  // while I was gone" in the same reply) and resumes live deltas from there.
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const resubscribeKnown = () => {
      const ws = wsRef.current;
      if (!ws) return;
      const targets = new Set(Object.keys(streamingByConvRef.current));
      if (activeIdRef.current) targets.add(activeIdRef.current);
      for (const convId of targets) {
        const tracked = streamingByConvRef.current[convId];
        subscribeStreams(
          ws,
          convId,
          tracked ? { [tracked.streamId]: cursorsRef.current[tracked.streamId] ?? 0 } : undefined,
        );
      }
    };

    const onEvent = (event: ServerMessage) => {
      if (event.type === 'turn.started') {
        const realId = event.conversation_id;
        const localId = pendingLocalIdRef.current;
        const modelForPatch = pendingModelRef.current;
        pendingLocalIdRef.current = null;
        pendingModelRef.current = null;
        if (localId && localId !== realId) {
          setConversations((prev) =>
            prev.some((c) => c.id === localId)
              ? prev.map((c) => (c.id === localId ? { ...c, id: realId, incognito: event.incognito } : c))
              : prev,
          );
        } else if (event.incognito) {
          setConversations((prev) => prev.map((c) => (c.id === realId ? { ...c, incognito: true } : c)));
        }
        setActiveId(realId);
        if (modelForPatch && !event.incognito) {
          updateConversation(realId, { model_pref: { model: modelForPatch } }).catch(() => undefined);
        }
      } else if (event.type === 'stream.sync') {
        const convId = event.conversation_id;
        const userMsg = event.snapshot.messages.find((m) => m.author_type === 'user');
        if (userMsg) promotePendingUserMsg(convId, userMsg.message_id);
        setConversations((prev) =>
          prev.map((c) => (c.id === convId ? { ...c, msgs: applySnapshotToMsgs(c.msgs, event.snapshot) } : c)),
        );
        if (event.status !== 'active') {
          // A reconnect's catch-up re-syncs the conversation's last few
          // runs, not just the current one — an older, already-finished
          // run's sync arriving here must not wipe tracking for a
          // genuinely still-active *different* run in the same
          // conversation. Only clear if this sync is for the stream we're
          // actually tracking (or nothing is tracked, so there's nothing to
          // protect).
          const tracked = streamingByConvRef.current[convId];
          if (!tracked || tracked.streamId === event.stream_id) clearStream(convId);
        } else {
          // Either updates a stream we already knew was in flight, or
          // discovers one we didn't (app restart mid-stream, another
          // device's send) — in the latter case there's no local record of
          // when it truly started or which model, so approximate from here
          // and the snapshot's own assistant message.
          // Synchronously, before any further event can be handled.
          cursorsRef.current[event.stream_id] = event.seq;
          const assistantMsg = event.snapshot.messages.find((m) => m.author_type === 'assistant');
          setStreamingByConv((prev) => ({
            ...prev,
            [convId]:
              prev[convId]?.streamId === event.stream_id
                ? prev[convId]
                : {
                    streamId: event.stream_id,
                    loadingModel: false,
                    responseStartedAt: Date.now(),
                    model: assistantMsg?.model ?? '',
                  },
          }));
        }
      } else if (event.type === 'stream.event') {
        const convId = event.conversation_id;
        const lastSeq = cursorsRef.current[event.stream_id];
        if (lastSeq !== undefined && event.seq !== lastSeq + 1) {
          // Gap — a delta was missed (backpressure drop, brief hiccup).
          // Re-subscribe from our last-known cursor to resync exactly rather
          // than silently rendering out-of-order/incomplete text.
          //
          // Rate-limited: a resync is not instantaneous, so without this every
          // event arriving in the meantime asks for another one. At streaming
          // rates that is hundreds of requests a second, and since each reply
          // carries a full snapshot it saturates the socket badly enough to
          // cause the very drops it is trying to repair.
          const now = Date.now();
          const lastAsk = lastResyncAtRef.current[event.stream_id] ?? 0;
          const ws = wsRef.current;
          if (ws && now - lastAsk > RESYNC_COOLDOWN_MS) {
            lastResyncAtRef.current[event.stream_id] = now;
            subscribeStreams(ws, convId, { [event.stream_id]: lastSeq });
          }
          return;
        }
        // Synchronously, before the next event in this same tick is handled.
        cursorsRef.current[event.stream_id] = event.seq;
        setStreamingByConv((prev) =>
          prev[convId]?.streamId === event.stream_id
            ? { ...prev, [convId]: { ...prev[convId], loadingModel: event.event.kind === 'model.loading' } }
            : prev,
        );
        if (event.event.kind === 'message.start' && event.event.author_type === 'user') {
          promotePendingUserMsg(convId, event.event.message_id);
        }
        setConversations((prev) =>
          prev.map((c) => (c.id === convId ? { ...c, msgs: applyEventToMsgs(c.msgs, event.event) } : c)),
        );
      } else if (event.type === 'stream.end') {
        // The message's own final state (text/usage/status) already landed
        // via its `message.end` stream.event, which is guaranteed to have
        // arrived first — WS delivery is ordered, and the server only sends
        // stream.end after the producer's last flush completes. This just
        // clears the "something is streaming" UI state.
        clearStream(event.conversation_id);
        // A run may have JIT-loaded the model, which changes the context
        // window out from under a model list fetched at mount.
        onStreamEndRef.current?.();
      } else if (event.type === 'error') {
        showToast(event.error || 'Chat error', 6000);
      }
    };

    const connect = () => {
      const ws = createChatSocket(token, onEvent);
      ws.onopen = () => {
        attempt = 0;
        resubscribeKnown();
      };
      ws.onclose = () => {
        if (cancelled) return;
        // The stream state itself is preserved (see StreamState comment) —
        // only the connection needs re-establishing.
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
    // stream.event that arrives while backgrounded can be lost to the
    // native WebSocket bridge losing sync across the pause. Verified on a
    // real iOS Simulator: this can leave the connection a "zombie" — it
    // delivers whatever was already buffered when the app resumes, then
    // never receives another byte, with no close event on either end.
    // Force-closing on every foreground resume guarantees a fresh
    // connection; resubscribing with real cursors on the new connection is
    // exact regardless of how the old one died.
    let appState: AppStateStatus = AppState.currentState;
    const appStateSub = AppState.addEventListener('change', (next) => {
      if (/inactive|background/.test(appState) && next === 'active') {
        wsRef.current?.close();
      }
      appState = next;
    });

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      appStateSub.remove();
      wsRef.current?.close();
    };
  }, [token, setActiveId, showToast, clearStream, setStreamingByConv, promotePendingUserMsg]);

  const handleSend = useCallback(
    (text: string, model: string, incognito?: boolean) => {
      if (!wsRef.current) return;
      const localMsgId = `lm${String(Date.now())}`;
      pendingUserMsgIdRef.current = localMsgId;
      if (!activeIdRef.current) {
        const localId = `c${String(Date.now())}`;
        pendingLocalIdRef.current = localId;
        pendingModelRef.current = model;
        const newConv: Conversation = {
          id: localId,
          title: text.slice(0, 40),
          kind: 'chat',
          time: 'now',
          model,
          location: 'server',
          msgs: [{ id: localMsgId, role: 'user', text }],
        };
        setConversations((prev) => [newConv, ...prev]);
        setActiveId(newConv.id);
        sendChatMessage(wsRef.current, text, model, undefined, undefined, incognito);
      } else {
        const id = activeIdRef.current;
        setConversations((prev) =>
          prev.map((c) => (c.id === id ? { ...c, msgs: [...c.msgs, { id: localMsgId, role: 'user', text }] } : c)),
        );
        sendChatMessage(wsRef.current, text, model, id, undefined, incognito);
      }
    },
    [setActiveId],
  );

  const handleStop = useCallback(() => {
    const id = activeIdRef.current;
    const stream = id ? streamingByConvRef.current[id] : undefined;
    if (wsRef.current && stream) stopStream(wsRef.current, stream.streamId);
  }, []);

  /** Runs a built-in slash command (currently just "compact") against the
   * active conversation. Unlike handleSend, there's no optimistic bubble to
   * push — the command has no user-authored message, only its result. */
  const handleCommand = useCallback((name: string, args: string, model: string) => {
    const id = activeIdRef.current;
    if (!wsRef.current || !id) return;
    sendCommand(wsRef.current, name, id, model, args || undefined);
  }, []);

  const handleNewChat = useCallback(() => { setActiveId(null); }, [setActiveId]);

  const handleFork = useCallback(
    (id: string) => {
      setConversations((prev) => {
        const conv = prev.find((c) => c.id === id);
        if (!conv) return prev;
        const forked: Conversation = {
          ...conv,
          id: `c${String(Date.now())}`,
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
    setConversations((prev) => {
      const conv = prev.find((c) => c.id === id);
      if (!conv?.incognito) updateConversation(id, { model_pref: { model: modelId } }).catch(() => undefined);
      return prev.map((c) => (c.id === id ? { ...c, model: modelId } : c));
    });
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
    handleCommand,
    handleNewChat,
    handleFork,
    handleDelete,
    handleRename,
    setConversationModel,
  };
}
