import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import {
  createAgentSocket,
  sendAgentMessage,
  subscribeStreams,
  stopStream,
  setAgentMode,
  approveTool,
  denyTool,
  getConversations,
  getMessages,
  updateConversation,
  type ServerMessage,
  type StreamEventKind,
  type StreamSnapshot,
  type StreamSnapshotMessage,
  type TurnUsage,
  type ApiMessage,
  type PermissionMode,
  type Todo,
  type ApiMessageUsage,
} from '@shannon/api-client';
import type { ContentBlock, FileDiff } from '@shannon/types';
import type { Conversation, Message, MessageUsage, ToolCall, ChangedFile } from '@/lib/types';
import { computeLineDiff } from '@/lib/diff';
import { useToastHelper } from './useToastHelper';

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

/** Same shape, from a live stream's TurnUsage instead of a persisted DB row. */
function usageFromTurn(u: TurnUsage): MessageUsage {
  return { in: u.prompt_tokens, out: u.completion_tokens, tps: u.gen_tps ?? 0, promptTps: u.prompt_tps, totalMs: u.total_ms, cache: 0 };
}

export type RunState = 'running' | 'awaiting_approval' | 'done' | 'error';

export type PendingApproval = { callId: string; tool: string; args: Record<string, unknown> };

function extractField(blocks: ContentBlock[], kind: 'text' | 'thinking'): string {
  return blocks
    .filter((b) => b.kind === kind)
    .map((b) => (b as { text: string }).text)
    .join('\n');
}

function toolSummary(tool: string, args: Record<string, unknown>): string {
  switch (tool) {
    case 'fs_read':
    case 'fs_write':
    case 'fs_edit':
      return typeof args.path === 'string' ? args.path : JSON.stringify(args);
    case 'bash':
      return typeof args.command === 'string' ? args.command : JSON.stringify(args);
    case 'grep': {
      const pattern = typeof args.pattern === 'string' ? args.pattern : '';
      const path = typeof args.path === 'string' ? ` in ${args.path}` : '';
      return `"${pattern}"${path}`;
    }
    case 'glob':
      return typeof args.pattern === 'string' ? args.pattern : JSON.stringify(args);
    case 'web_fetch':
      return typeof args.url === 'string' ? args.url : JSON.stringify(args);
    case 'todo_write': {
      const todos = args.todos;
      const n = Array.isArray(todos) ? todos.length : 0;
      return `${n} item${n === 1 ? '' : 's'}`;
    }
    default:
      return JSON.stringify(args);
  }
}

function diffLinesFor(diff: FileDiff[] | undefined): ToolCall['diff'] {
  if (!diff || diff.length === 0) return undefined;
  const out: ToolCall['diff'] = [];
  for (const f of diff) {
    out.push({
      type: 'meta',
      text: f.oldContent === null ? `+++ ${f.path} (new file)` : `--- / +++ ${f.path}`,
    });
    out.push(...computeLineDiff(f.oldContent, f.newContent));
  }
  return out;
}

/** Cold history load only (REST) — live state is driven entirely by the
 * stream protocol below. Rebuilds Message[] from stored blocks, joining
 * tool_result rows back to their tool_call by call_id. */
function reconstructMessages(rows: ApiMessage[]): Message[] {
  const out: Message[] = [];
  const byId = new Map<string, Message>();
  const callToMsgId = new Map<string, string>();

  for (const row of rows) {
    if (row.status === 'cancelled') continue;
    const blocks = row.content as ContentBlock[];

    if (row.authorType === 'user') {
      const msg: Message = { id: row.id, role: 'user', text: extractField(blocks, 'text') };
      out.push(msg);
      byId.set(row.id, msg);
      continue;
    }

    if (row.authorType === 'assistant') {
      const thinking = extractField(blocks, 'thinking');
      const tools: ToolCall[] = [];
      for (const b of blocks) {
        if (b.kind !== 'tool_call') continue;
        const callId = b.call_id;
        tools.push({
          tool: b.tool,
          summary: toolSummary(b.tool, (b.args ?? {}) as Record<string, unknown>),
          result: '',
          callId,
        });
        callToMsgId.set(callId, row.id);
      }
      const msg: Message = {
        id: row.id,
        role: 'assistant',
        model: row.model ?? undefined,
        text: extractField(blocks, 'text'),
        thinking: thinking || undefined,
        tools: tools.length > 0 ? tools : undefined,
        usage: toMessageUsage(row.usage),
      };
      out.push(msg);
      byId.set(row.id, msg);
      continue;
    }

    if (row.authorType === 'tool') {
      for (const b of blocks) {
        if (b.kind !== 'tool_result') continue;
        const msgId = callToMsgId.get(b.call_id);
        const msg = msgId ? byId.get(msgId) : undefined;
        const tc = msg?.tools?.find((t) => t.callId === b.call_id);
        if (tc) {
          tc.result = b.output;
          tc.diff = diffLinesFor(b.diff);
        }
      }
    }
  }
  return out;
}

/** A `stream.sync` snapshot is authoritative — folds tool_calls (which now
 * always carry their owning message_id directly) straight onto the
 * assistant message, same shape reconstructMessages produces from cold
 * storage. */
function snapshotMessageToMessage(sm: StreamSnapshotMessage): Message {
  return {
    id: sm.message_id,
    role: sm.author_type === 'user' ? 'user' : 'assistant',
    model: sm.model,
    text: sm.text,
    thinking: sm.thinking || undefined,
    tools:
      sm.tool_calls.length > 0
        ? sm.tool_calls.map((tc) => ({
            tool: tc.tool,
            summary: toolSummary(tc.tool, tc.args),
            result: tc.output ?? '',
            diff: diffLinesFor(tc.diff),
            callId: tc.call_id,
          }))
        : undefined,
    usage: sm.usage ? usageFromTurn(sm.usage) : undefined,
    error: sm.status === 'error',
    stopped: sm.status === 'cancelled',
  };
}

function applySnapshotToMsgs(msgs: Message[], snapshot: StreamSnapshot): Message[] {
  const result = [...msgs];
  for (const sm of snapshot.messages) {
    const converted = snapshotMessageToMessage(sm);
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
        { id: event.message_id, role: event.author_type === 'user' ? 'user' : 'assistant', model: event.model, text: event.text ?? '' },
      ];
    }
    case 'text.delta':
      return msgs.map((m) => (m.id === event.message_id ? { ...m, text: m.text + event.text } : m));
    case 'thinking.delta':
      return msgs.map((m) => (m.id === event.message_id ? { ...m, thinking: (m.thinking ?? '') + event.text } : m));
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
    case 'tool.call':
      return msgs.map((m) =>
        m.id === event.message_id
          ? {
              ...m,
              tools: [
                ...(m.tools ?? []),
                { tool: event.tool, summary: toolSummary(event.tool, event.args), result: '', callId: event.call_id },
              ],
            }
          : m,
      );
    case 'tool.result':
      return msgs.map((m) => {
        if (!m.tools?.some((t) => t.callId === event.call_id)) return m;
        return {
          ...m,
          tools: m.tools.map((t) =>
            t.callId === event.call_id ? { ...t, result: event.output, diff: diffLinesFor(event.diff) } : t,
          ),
        };
      });
    default:
      // model.loading/iteration/approval.request/todos — hook-level state,
      // not per-message; handled by the caller.
      return msgs;
  }
}

/** Per-conversation in-flight stream state — see useChatSession for why this
 * is preserved across a reconnect rather than cleared on close. */
type StreamState = { streamId: string; loadingModel: boolean; responseStartedAt: number; model: string };

/** Minimum spacing between resync requests for the same stream. */
const RESYNC_COOLDOWN_MS = 500;

export function useAgentSession(token: string | null) {
  const [runs, setRuns] = useState<Conversation[]>([]);
  const [activeId, setActiveIdState] = useState<string | null>(null);
  const [mode, setModeState] = useState<PermissionMode>('manual');
  const [runState, setRunState] = useState<RunState>('done');
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
  const [iteration, setIteration] = useState<{ n: number; max: number } | null>(null);
  const [liveTodos, setLiveTodos] = useState<Todo[]>([]);
  const [streamingByConv, setStreamingByConvState] = useState<Record<string, StreamState>>({});
  const { showToast } = useToastHelper();

  const wsRef = useRef<WebSocket | null>(null);
  const loadingRef = useRef(false);
  const activeIdRef = useRef<string | null>(null);
  const streamingByConvRef = useRef<Record<string, StreamState>>({});
  const pendingLocalIdRef = useRef<string | null>(null);
  const pendingModelRef = useRef<string | null>(null);
  // See useChatSession: the optimistic user bubble has no server id yet, so
  // it must be renamed in place once the real `message.start` arrives, or
  // the id-based dedup below never matches it and duplicates the bubble.
  const pendingUserMsgIdRef = useRef<string | null>(null);
  /** Last time we asked the server to resync a given stream. */
  const lastResyncAtRef = useRef<Record<string, number>>({});
  /**
   * Last applied seq per stream, tracked here rather than in React state so
   * it advances the instant an event is handled — see useChatSession: a
   * cursor that only advances on React flush reads as stale for the rest of
   * the tick, so every batched event after the first looks like a gap.
   */
  const cursorsRef = useRef<Record<string, number>>({});

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

  const updateRunMsgs = useCallback((convId: string, updater: (msgs: Message[]) => Message[]) => {
    setRuns((prev) => prev.map((r) => (r.id === convId ? { ...r, msgs: updater(r.msgs) } : r)));
  }, []);

  const promotePendingUserMsg = useCallback(
    (convId: string, realId: string) => {
      const pending = pendingUserMsgIdRef.current;
      if (!pending) return;
      pendingUserMsgIdRef.current = null;
      updateRunMsgs(convId, (msgs) => msgs.map((m) => (m.id === pending ? { ...m, id: realId } : m)));
    },
    [updateRunMsgs],
  );

  // Reset thread-local UI state on a manual thread switch. Iteration/todos/
  // pendingApproval are still flat hook state, not scoped per conversation
  // (GitHub issue #1) — switching threads clears the display; a resync (on
  // reconnect, not on a plain manual switch) is what would restore them for
  // whichever conversation actually has an active run.
  const selectRun = useCallback(
    (id: string) => {
      setActiveId(id);
      setRunState('done');
      setPendingApproval(null);
      setIteration(null);
      setLiveTodos([]);
    },
    [setActiveId],
  );

  const handleNewRun = useCallback(() => {
    setActiveId(null);
    setRunState('done');
    setPendingApproval(null);
    setIteration(null);
    setLiveTodos([]);
  }, [setActiveId]);

  // Load real runs + latest run's history on mount / token change.
  useEffect(() => {
    if (!token || loadingRef.current) return;
    loadingRef.current = true;
    getConversations()
      .then(async (convs) => {
        const agentConvs = convs.filter((c) => c.kind === 'agent');
        if (agentConvs.length === 0) return;
        const apiRuns: Conversation[] = agentConvs.map((c) => ({
          id: c.id,
          title: c.title,
          kind: 'agent',
          time: 'recent',
          model: c.modelPref?.model ?? '',
          location: 'server' as const,
          msgs: [],
        }));
        setRuns((prev) => {
          const existing = new Set(prev.map((r) => r.id));
          const fresh = apiRuns.filter((r) => !existing.has(r.id));
          return [...fresh, ...prev];
        });

        const latest = agentConvs[0];
        setActiveId(latest.id);
        try {
          const { messages: rows } = await getMessages(latest.id);
          const msgs = reconstructMessages(rows);
          if (msgs.length > 0) {
            setRuns((prev) => prev.map((r) => (r.id === latest.id ? { ...r, msgs } : r)));
          }
        } catch {
          // Non-fatal: run list still loaded, just no history preview yet.
        }
      })
      .catch(() => {})
      .finally(() => {
        loadingRef.current = false;
      });
  }, [token, setActiveId]);

  // Live agent socket — see useChatSession for the full rationale (shared
  // between both hooks): resumable via per-stream seq + stream.subscribe
  // instead of a reconcile poll, stream state preserved across reconnect,
  // socket force-closed on foreground resume to dodge the "zombie socket"
  // failure mode.
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const resubscribeKnown = () => {
      const targets = new Set(Object.keys(streamingByConvRef.current));
      if (activeIdRef.current) targets.add(activeIdRef.current);
      for (const convId of targets) {
        const tracked = streamingByConvRef.current[convId];
        subscribeStreams(
          wsRef.current!,
          convId,
          tracked ? { [tracked.streamId]: cursorsRef.current[tracked.streamId] ?? 0 } : undefined,
        );
      }
    };

    const applyRunLevelState = (
      convId: string,
      streamId: string,
      snapshot: StreamSnapshot,
      status: 'active' | 'complete' | 'error' | 'cancelled',
    ) => {
      if (convId !== activeIdRef.current) return;
      // A reconnect's catch-up re-syncs the conversation's last few runs,
      // not just the current one — an older, already-finished run's sync
      // must not overwrite run-level state (iteration/todos/approval/
      // runState) for a genuinely still-active *different* run. Only apply
      // if this sync is for the stream we're actually tracking, or nothing
      // is tracked yet.
      const tracked = streamingByConvRef.current[convId];
      if (tracked && tracked.streamId !== streamId) return;
      setIteration(snapshot.iteration ?? null);
      setLiveTodos(snapshot.todos ?? []);
      setPendingApproval(
        snapshot.pending_approval
          ? { callId: snapshot.pending_approval.call_id, tool: snapshot.pending_approval.tool, args: snapshot.pending_approval.args }
          : null,
      );
      if (status === 'active') setRunState(snapshot.pending_approval ? 'awaiting_approval' : 'running');
      else setRunState(status === 'error' ? 'error' : 'done');
    };

    const onEvent = (event: ServerMessage) => {
      if (event.type === 'turn.started') {
        const realId = event.conversation_id;
        const localId = pendingLocalIdRef.current;
        const modelForPatch = pendingModelRef.current;
        pendingLocalIdRef.current = null;
        pendingModelRef.current = null;
        setRuns((prev) => {
          if (localId && localId !== realId && prev.some((r) => r.id === localId)) {
            return prev.map((r) => (r.id === localId ? { ...r, id: realId, incognito: event.incognito } : r));
          }
          if (prev.some((r) => r.id === realId)) return prev;
          return [
            { id: realId, title: 'New run', kind: 'agent', time: 'now', model: modelForPatch ?? 'default', location: 'server', msgs: [] },
            ...prev,
          ];
        });
        setActiveId(realId);
        if (modelForPatch && !event.incognito) {
          updateConversation(realId, { model_pref: { model: modelForPatch } }).catch(() => {});
        }
      } else if (event.type === 'stream.sync') {
        const convId = event.conversation_id;
        const userMsg = event.snapshot.messages.find((m) => m.author_type === 'user');
        if (userMsg) promotePendingUserMsg(convId, userMsg.message_id);
        updateRunMsgs(convId, (msgs) => applySnapshotToMsgs(msgs, event.snapshot));
        applyRunLevelState(convId, event.stream_id, event.snapshot, event.status);
        if (event.status !== 'active') {
          const tracked = streamingByConvRef.current[convId];
          if (!tracked || tracked.streamId === event.stream_id) clearStream(convId);
        } else {
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
          // Gap — resync, but rate-limited: see useChatSession for why an
          // unthrottled request-per-event turns one dropped delta into a
          // socket-saturating storm.
          const now = Date.now();
          const lastAsk = lastResyncAtRef.current[event.stream_id] ?? 0;
          if (now - lastAsk > RESYNC_COOLDOWN_MS) {
            lastResyncAtRef.current[event.stream_id] = now;
            subscribeStreams(wsRef.current!, convId, { [event.stream_id]: lastSeq });
          }
          return;
        }
        // Synchronously, before the next event in this same tick is handled.
        cursorsRef.current[event.stream_id] = event.seq;
        if (event.event.kind === 'message.start' && event.event.author_type === 'user') {
          promotePendingUserMsg(convId, event.event.message_id);
        }
        updateRunMsgs(convId, (msgs) => applyEventToMsgs(msgs, event.event));

        const isActive = convId === activeIdRef.current;
        const inner = event.event;
        if (inner.kind === 'iteration') {
          if (isActive) {
            setRunState('running');
            setIteration({ n: inner.n, max: inner.max });
          }
          setStreamingByConv((prev) => (prev[convId]?.streamId === event.stream_id ? { ...prev, [convId]: { ...prev[convId], loadingModel: false } } : prev));
        } else if (inner.kind === 'model.loading') {
          setStreamingByConv((prev) => (prev[convId]?.streamId === event.stream_id ? { ...prev, [convId]: { ...prev[convId], loadingModel: true } } : prev));
        } else if (inner.kind === 'text.delta' || inner.kind === 'thinking.delta') {
          setStreamingByConv((prev) => (prev[convId]?.streamId === event.stream_id ? { ...prev, [convId]: { ...prev[convId], loadingModel: false } } : prev));
        } else if (inner.kind === 'approval.request') {
          if (isActive) {
            setRunState('awaiting_approval');
            setPendingApproval({ callId: inner.call_id, tool: inner.tool, args: inner.args });
          }
        } else if (inner.kind === 'tool.result') {
          if (isActive) {
            setPendingApproval((prev) => (prev?.callId === inner.call_id ? null : prev));
            setRunState('running');
          }
        } else if (inner.kind === 'todos') {
          if (isActive) setLiveTodos(inner.todos);
        }
      } else if (event.type === 'stream.end') {
        clearStream(event.conversation_id);
        if (event.conversation_id === activeIdRef.current) {
          setRunState(event.status === 'error' ? 'error' : 'done');
          setIteration(null);
          setPendingApproval(null);
        }
      } else if (event.type === 'agent.mode_changed') {
        setModeState(event.mode);
      } else if (event.type === 'error') {
        showToast(`Agent error: ${event.error}`, 6000);
      }
    };

    const connect = () => {
      const ws = createAgentSocket(token, onEvent);
      ws.onopen = () => {
        attempt = 0;
        resubscribeKnown();
      };
      ws.onclose = () => {
        if (cancelled) return;
        attempt += 1;
        const delay = Math.min(1000 * attempt, 5000);
        reconnectTimer = setTimeout(connect, delay);
      };
      wsRef.current = ws;
    };
    connect();

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
  }, [token, updateRunMsgs, setActiveId, showToast, clearStream, setStreamingByConv, promotePendingUserMsg]);

  const handleSend = useCallback(
    (text: string, model: string, incognito?: boolean) => {
      if (!wsRef.current) return;

      const convId = activeIdRef.current;
      const localMsgId = `lm${Date.now()}`;
      pendingUserMsgIdRef.current = localMsgId;
      if (!convId) {
        const localId = `pending-${Math.random().toString(36).slice(2)}`;
        pendingLocalIdRef.current = localId;
        pendingModelRef.current = model;
        const newRun: Conversation = {
          id: localId,
          title: text.slice(0, 40),
          kind: 'agent',
          time: 'now',
          model,
          location: 'server',
          msgs: [{ id: localMsgId, role: 'user', text }],
        };
        setRuns((prev) => [newRun, ...prev]);
        setActiveId(localId);
        sendAgentMessage(wsRef.current, text, mode, undefined, undefined, model, incognito);
      } else {
        setRuns((prev) => prev.map((r) => (r.id === convId ? { ...r, msgs: [...r.msgs, { id: localMsgId, role: 'user', text }] } : r)));
        sendAgentMessage(wsRef.current, text, mode, convId, undefined, model, incognito);
      }
    },
    [mode, setActiveId],
  );

  const handleStop = useCallback(() => {
    const id = activeIdRef.current;
    const stream = id ? streamingByConvRef.current[id] : undefined;
    if (wsRef.current && stream) stopStream(wsRef.current, stream.streamId);
  }, []);

  const handleModeChange = useCallback((next: PermissionMode) => {
    setModeState(next);
    if (wsRef.current) setAgentMode(wsRef.current, next);
  }, []);

  const handleApprove = useCallback((callId: string) => {
    if (wsRef.current) approveTool(wsRef.current, callId);
    setPendingApproval(null);
  }, []);

  const handleDeny = useCallback((callId: string) => {
    if (wsRef.current) denyTool(wsRef.current, callId);
    setPendingApproval(null);
  }, []);

  const handleFork = useCallback(
    (id: string) => {
      setRuns((prev) => {
        const run = prev.find((r) => r.id === id);
        if (!run) return prev;
        const forked: Conversation = {
          ...run,
          id: `fork-${Math.random().toString(36).slice(2)}`,
          title: `${run.title} (fork)`,
          time: 'now',
          msgs: run.msgs.slice(0, Math.ceil(run.msgs.length / 2)),
        };
        setActiveId(forked.id);
        return [forked, ...prev];
      });
      showToast('Run forked');
    },
    [setActiveId, showToast],
  );

  const handleDelete = useCallback(
    (id: string) => {
      setRuns((prev) => prev.filter((r) => r.id !== id));
      if (activeIdRef.current === id) handleNewRun();
      showToast('Run deleted');
    },
    [handleNewRun, showToast],
  );

  const handleRename = useCallback((id: string, name: string) => {
    setRuns((prev) => prev.map((r) => (r.id === id ? { ...r, title: name } : r)));
  }, []);

  const setRunModel = useCallback((id: string, modelId: string) => {
    setRuns((prev) => {
      const run = prev.find((r) => r.id === id);
      if (!run?.incognito) updateConversation(id, { model_pref: { model: modelId } }).catch(() => {});
      return prev.map((r) => (r.id === id ? { ...r, model: modelId } : r));
    });
  }, []);

  const activeRun = runs.find((r) => r.id === activeId) ?? null;
  const changedFiles = useMemo(() => (activeRun ? computeChangedFiles(activeRun.msgs) : []), [activeRun]);
  const activeStream = activeId ? streamingByConv[activeId] : undefined;
  const busy = runState === 'running' || runState === 'awaiting_approval';

  return {
    runs,
    activeId,
    activeRun,
    selectRun,
    mode,
    runState,
    busy,
    loadingModel: activeStream?.loadingModel ?? false,
    responseStartedAt: activeStream?.responseStartedAt ?? null,
    pendingApproval,
    iteration,
    todos: liveTodos,
    changedFiles,
    handleSend,
    handleStop,
    handleNewRun,
    handleModeChange,
    handleApprove,
    handleDeny,
    handleFork,
    handleDelete,
    handleRename,
    setRunModel,
  };
}

/** Aggregates every file diff seen in the run into a per-path add/del summary. */
function computeChangedFiles(msgs: Message[]): ChangedFile[] {
  const byPath = new Map<string, { adds: number; dels: number }>();
  for (const msg of msgs) {
    for (const tool of msg.tools ?? []) {
      if (!tool.diff) continue;
      let path: string | null = null;
      for (const line of tool.diff) {
        if (line.type === 'meta') {
          const match = line.text.match(/^(?:\+\+\+|---(?: \/ \+\+\+)?) (.+?)(?: \(new file\))?$/);
          path = match ? match[1] : null;
          if (path && !byPath.has(path)) byPath.set(path, { adds: 0, dels: 0 });
          continue;
        }
        if (!path) continue;
        const entry = byPath.get(path)!;
        if (line.type === 'add') entry.adds++;
        else if (line.type === 'del') entry.dels++;
      }
    }
  }
  return [...byPath.entries()].map(([path, counts]) => ({ path, ...counts }));
}
