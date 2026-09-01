import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import {
  createAgentSocket,
  sendAgentMessage,
  sendCommand,
  subscribeStreams,
  stopStream,
  setAgentMode,
  approveTool,
  denyTool,
  getConversations,
  getMessages,
  updateConversation,
  type ServerMessage,
  type AttachmentRef,
  type StreamSnapshot,
  type PermissionMode,
  type Todo,
} from '@shannon/api-client';
import { useEndpoint } from './useEndpoint';
import type { Conversation, Message, ChangedFile } from '@/lib/types';
import { applyEventToMsgs, applySnapshotToMsgs, isServerConvId, reconstructMessages } from '@/lib/streamMessages';
import { useToastHelper } from './useToastHelper';

export type RunState = 'running' | 'awaiting_approval' | 'done' | 'error';

export interface PendingApproval { callId: string; tool: string; args: Record<string, unknown> }

/** Per-conversation in-flight stream state — see useChatSession for why this
 * is preserved across a reconnect rather than cleared on close. */
interface StreamState { streamId: string; loadingModel: boolean; responseStartedAt: number; model: string }

/** Minimum spacing between resync requests for the same stream. */
const RESYNC_COOLDOWN_MS = 500;

export function useAgentSession(token: string | null, onStreamEnd?: () => void) {
  // Re-run the socket effect when the API endpoint changes, so a desktop
  // mode switch or a Settings change reconnects to the new host instead of
  // silently holding the old one until the app restarts.
  const endpoint = useEndpoint();
  const [runs, setRuns] = useState<Conversation[]>([]);
  const [activeId, setActiveIdState] = useState<string | null>(null);
  const [mode, setModeState] = useState<PermissionMode>('manual');
  const [runState, setRunState] = useState<RunState>('done');
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
  const [iteration, setIteration] = useState<{ n: number; max: number } | null>(null);
  const [liveTodos, setLiveTodos] = useState<Todo[]>([]);
  const [streamingByConv, setStreamingByConvState] = useState<Partial<Record<string, StreamState>>>({});
  const { showToast } = useToastHelper();

  const wsRef = useRef<WebSocket | null>(null);
  const loadingRef = useRef(false);
  // See useChatSession: a ref, not a dependency — the WS effect only re-runs
  // on [token], and an unstable callback in its deps would rebuild the socket
  // on every parent render.
  const onStreamEndRef = useRef(onStreamEnd);
  onStreamEndRef.current = onStreamEnd;
  const activeIdRef = useRef<string | null>(null);
  const streamingByConvRef = useRef<Partial<Record<string, StreamState>>>({});
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

  // Runs whose history has been fetched (or is in flight). The mount-time
  // load below only ever covered the single most recent run, so selecting any
  // older one left it permanently empty — nothing else backfills it
  // (stream.subscribe replays live runs, not cold history).
  const loadedConvIdsRef = useRef<Set<string>>(new Set());

  const setActiveId = useCallback((id: string | null) => {
    activeIdRef.current = id;
    setActiveIdState(id);
    // Optimistic local ids (created before the server assigns a real
    // one — see handleSend below) aren't fetchable: the server has never
    // heard of them, and the id gets swapped for the real one as soon as
    // turn.started arrives, no fetch required.
    if (!id || !isServerConvId(id) || loadedConvIdsRef.current.has(id)) return;
    loadedConvIdsRef.current.add(id);
    getMessages(id)
      .then(({ messages: rows }) => {
        const msgs = reconstructMessages(rows);
        if (msgs.length === 0) return;
        // Only fill a run that is still empty: one already streaming (or
        // already populated by this same fetch) must not be clobbered.
        setRuns((prev) => prev.map((r) => (r.id === id && r.msgs.length === 0 ? { ...r, msgs } : r)));
      })
      .catch(() => undefined);
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
      .then((convs) => {
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

        // History for this run — and any other the user selects — is fetched
        // lazily by setActiveId.
        setActiveId(agentConvs[0].id);
      })
      .catch(() => undefined)
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
            return prev.map((r) => (r.id === localId ? { ...r, id: realId } : r));
          }
          if (prev.some((r) => r.id === realId)) return prev;
          return [
            { id: realId, title: 'New run', kind: 'agent', time: 'now', model: modelForPatch ?? 'default', location: 'server', msgs: [] },
            ...prev,
          ];
        });
        setActiveId(realId);
        if (modelForPatch) {
          updateConversation(realId, { model_pref: { model: modelForPatch } }).catch(() => undefined);
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
          const ws = wsRef.current;
          if (ws && now - lastAsk > RESYNC_COOLDOWN_MS) {
            lastResyncAtRef.current[event.stream_id] = now;
            subscribeStreams(ws, convId, { [event.stream_id]: lastSeq });
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
        // A run may have JIT-loaded the model, changing the context window.
        onStreamEndRef.current?.();
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
  }, [token, endpoint, updateRunMsgs, setActiveId, showToast, clearStream, setStreamingByConv, promotePendingUserMsg]);

  const handleSend = useCallback(
    (text: string, model: string, attachments?: AttachmentRef[]) => {
      if (!wsRef.current) return;

      const convId = activeIdRef.current;
      const localMsgId = `lm${String(Date.now())}`;
      pendingUserMsgIdRef.current = localMsgId;
      // The optimistic bubble keeps the full refs so it can render a thumbnail
      // immediately; the wire only needs the ids.
      const refs = attachments?.map((a) => a.ref);
      if (!convId) {
        const localId = `pending-${Math.random().toString(36).slice(2)}`;
        pendingLocalIdRef.current = localId;
        pendingModelRef.current = model;
        const newRun: Conversation = {
          id: localId,
          title: text.slice(0, 40) || (attachments?.[0]?.name ?? 'Attachment'),
          kind: 'agent',
          time: 'now',
          model,
          location: 'server',
          msgs: [{ id: localMsgId, role: 'user', text, attachments }],
        };
        setRuns((prev) => [newRun, ...prev]);
        setActiveId(localId);
        sendAgentMessage(wsRef.current, text, mode, undefined, undefined, model, refs);
      } else {
        setRuns((prev) =>
          prev.map((r) =>
            r.id === convId
              ? { ...r, msgs: [...r.msgs, { id: localMsgId, role: 'user', text, attachments }] }
              : r,
          ),
        );
        sendAgentMessage(wsRef.current, text, mode, convId, undefined, model, refs);
      }
    },
    [mode, setActiveId],
  );

  const handleStop = useCallback(() => {
    const id = activeIdRef.current;
    const stream = id ? streamingByConvRef.current[id] : undefined;
    if (wsRef.current && stream) stopStream(wsRef.current, stream.streamId);
  }, []);

  /** See useChatSession's handleCommand: no optimistic bubble, since a
   * command has no user-authored message of its own. */
  const handleCommand = useCallback((name: string, args: string, model: string) => {
    const id = activeIdRef.current;
    if (!wsRef.current || !id) return;
    sendCommand(wsRef.current, name, id, model, args || undefined);
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
    updateConversation(id, { model_pref: { model: modelId } }).catch(() => undefined);
    setRuns((prev) => prev.map((r) => (r.id === id ? { ...r, model: modelId } : r)));
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
    handleCommand,
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
          const match = /^(?:\+\+\+|---(?: \/ \+\+\+)?) (.+?)(?: \(new file\))?$/.exec(line.text);
          path = match ? match[1] : null;
          if (path && !byPath.has(path)) byPath.set(path, { adds: 0, dels: 0 });
          continue;
        }
        if (!path) continue;
        const entry = byPath.get(path);
        if (!entry) continue;
        if (line.type === 'add') entry.adds++;
        else if (line.type === 'del') entry.dels++;
      }
    }
  }
  return [...byPath.entries()].map(([path, counts]) => ({ path, ...counts }));
}
