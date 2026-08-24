import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createAgentSocket,
  sendAgentMessage,
  setAgentMode,
  approveTool,
  denyTool,
  getConversations,
  getMessages,
  updateConversation,
  type AgentEvent,
  type ApiMessage,
  type PermissionMode,
  type Todo,
  type FileDiff,
} from '@shannon/api-client';
import type { ContentBlock } from '@shannon/types';
import type { Conversation, Message, ToolCall, ChangedFile } from '@/lib/types';
import { computeLineDiff } from '@/lib/diff';
import { useToastHelper } from './useToastHelper';

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

/** Rebuilds Message[] from stored blocks, joining tool_result rows back to their tool_call by call_id. */
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

/** Aggregates every file diff seen in the run into a per-path add/del summary. */
function computeChangedFiles(msgs: Message[]): ChangedFile[] {
  const byPath = new Map<string, { adds: number; dels: number }>();
  for (const msg of msgs) {
    for (const tool of msg.tools ?? []) {
      if (!tool.diff) continue;
      // diffLinesFor prefixes each file with a meta line carrying its path.
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

export function useAgentSession(token: string | null) {
  const [runs, setRuns] = useState<Conversation[]>([]);
  const [activeId, setActiveIdState] = useState<string | null>(null);
  const [mode, setModeState] = useState<PermissionMode>('manual');
  const [runState, setRunState] = useState<RunState>('done');
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
  const [iteration, setIteration] = useState<{ n: number; max: number } | null>(null);
  const [liveTodos, setLiveTodos] = useState<Todo[]>([]);
  const [loadingModel, setLoadingModel] = useState(false);
  const { showToast } = useToastHelper();

  const wsRef = useRef<WebSocket | null>(null);
  const loadingRef = useRef(false);
  const activeIdRef = useRef<string | null>(null);
  const pendingLocalIdRef = useRef<string | null>(null);
  const pendingModelRef = useRef<string | null>(null);
  /** Id of the assistant message currently being streamed into, for this iteration. Reset on agent.iteration. */
  const buildingMsgIdRef = useRef<string | null>(null);

  const setActiveId = useCallback((id: string | null) => {
    activeIdRef.current = id;
    setActiveIdState(id);
  }, []);

  const updateRunMsgs = useCallback((convId: string, updater: (msgs: Message[]) => Message[]) => {
    setRuns((prev) => prev.map((r) => (r.id === convId ? { ...r, msgs: updater(r.msgs) } : r)));
  }, []);

  const ensureIterationMessage = useCallback(
    (convId: string, preferredId?: string): string => {
      if (buildingMsgIdRef.current) {
        if (preferredId && buildingMsgIdRef.current !== preferredId) {
          const oldId = buildingMsgIdRef.current;
          updateRunMsgs(convId, (msgs) => msgs.map((m) => (m.id === oldId ? { ...m, id: preferredId } : m)));
          buildingMsgIdRef.current = preferredId;
        }
        return buildingMsgIdRef.current;
      }
      const id = preferredId ?? `local-${convId}-${Math.random().toString(36).slice(2)}`;
      buildingMsgIdRef.current = id;
      updateRunMsgs(convId, (msgs) => [...msgs, { id, role: 'assistant', text: '' }]);
      return id;
    },
    [updateRunMsgs],
  );

  // Reset thread-local UI state on a manual thread switch (not on the
  // internal id promotion that happens when a fresh run gets its real
  // server-assigned conversation id — see agent.conversation handling).
  const selectRun = useCallback(
    (id: string) => {
      setActiveId(id);
      setRunState('done');
      setPendingApproval(null);
      setIteration(null);
      setLiveTodos([]);
      setLoadingModel(false);
      buildingMsgIdRef.current = null;
    },
    [setActiveId],
  );

  const handleNewRun = useCallback(() => {
    setActiveId(null);
    setRunState('done');
    setPendingApproval(null);
    setIteration(null);
    setLiveTodos([]);
    setLoadingModel(false);
    buildingMsgIdRef.current = null;
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

  // Live agent socket.
  useEffect(() => {
    if (!token) return;
    const ws = createAgentSocket(token, (event: AgentEvent) => {
      switch (event.type) {
        case 'agent.conversation': {
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
            return [{ id: realId, title: 'New run', kind: 'agent', time: 'now', model: modelForPatch ?? 'default', location: 'server', msgs: [] }, ...prev];
          });
          setActiveId(realId);
          if (modelForPatch) {
            updateConversation(realId, { model_pref: { model: modelForPatch } }).catch(() => {});
          }
          break;
        }
        case 'agent.iteration': {
          buildingMsgIdRef.current = null;
          setRunState('running');
          setIteration({ n: event.iteration, max: event.max });
          setLoadingModel(false);
          break;
        }
        case 'agent.model_loading': {
          setLoadingModel(true);
          break;
        }
        case 'agent.delta': {
          setLoadingModel(false);
          const id = ensureIterationMessage(event.conversation_id, event.message_id);
          updateRunMsgs(event.conversation_id, (msgs) =>
            msgs.map((m) => (m.id === id ? { ...m, text: (m.text ?? '') + event.text } : m)),
          );
          break;
        }
        case 'agent.thinking': {
          setLoadingModel(false);
          const id = ensureIterationMessage(event.conversation_id, event.message_id);
          updateRunMsgs(event.conversation_id, (msgs) =>
            msgs.map((m) => (m.id === id ? { ...m, thinking: (m.thinking ?? '') + event.text } : m)),
          );
          break;
        }
        case 'agent.tool_call': {
          setLoadingModel(false);
          const id = ensureIterationMessage(event.conversation_id);
          const summary = toolSummary(event.tool, event.args);
          updateRunMsgs(event.conversation_id, (msgs) =>
            msgs.map((m) =>
              m.id === id
                ? { ...m, tools: [...(m.tools ?? []), { tool: event.tool, summary, result: '', callId: event.call_id }] }
                : m,
            ),
          );
          break;
        }
        case 'agent.approval_request': {
          setRunState('awaiting_approval');
          setPendingApproval({ callId: event.call_id, tool: event.tool, args: event.args });
          break;
        }
        case 'agent.tool_result': {
          setPendingApproval((prev) => (prev?.callId === event.call_id ? null : prev));
          setRunState('running');
          updateRunMsgs(event.conversation_id, (msgs) =>
            msgs.map((m) => {
              if (!m.tools?.some((t) => t.callId === event.call_id)) return m;
              return {
                ...m,
                tools: m.tools.map((t) =>
                  t.callId === event.call_id ? { ...t, result: event.output, diff: diffLinesFor(event.diff) } : t,
                ),
              };
            }),
          );
          break;
        }
        case 'agent.todos': {
          setLiveTodos(event.todos);
          break;
        }
        case 'agent.mode_changed': {
          setModeState(event.mode);
          break;
        }
        case 'agent.done': {
          const id = ensureIterationMessage(event.conversation_id, event.message_id);
          buildingMsgIdRef.current = null;
          setRunState('done');
          setIteration(null);
          setLoadingModel(false);
          if (event.usage) {
            updateRunMsgs(event.conversation_id, (msgs) =>
              msgs.map((m) =>
                m.id === id
                  ? {
                      ...m,
                      usage: {
                        in: event.usage!.prompt_tokens,
                        out: event.usage!.completion_tokens,
                        tps: event.usage!.gen_tps ?? 0,
                        promptTps: event.usage!.prompt_tps,
                        cache: 0,
                      },
                    }
                  : m,
              ),
            );
          }
          break;
        }
        case 'agent.error': {
          buildingMsgIdRef.current = null;
          setRunState('error');
          setIteration(null);
          setLoadingModel(false);
          showToast(`Agent error: ${event.error}`, 6000);
          break;
        }
      }
    });
    wsRef.current = ws;
    return () => ws.close();
  }, [token, ensureIterationMessage, updateRunMsgs, setActiveId, showToast]);

  const handleSend = useCallback(
    (text: string, model: string) => {
      if (!wsRef.current) return;
      buildingMsgIdRef.current = null;
      setRunState('running');
      setPendingApproval(null);
      setLoadingModel(false);

      const convId = activeIdRef.current;
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
          msgs: [{ role: 'user', text }],
        };
        setRuns((prev) => [newRun, ...prev]);
        setActiveId(localId);
        sendAgentMessage(wsRef.current, text, mode, undefined, undefined, model);
      } else {
        setRuns((prev) => prev.map((r) => (r.id === convId ? { ...r, msgs: [...r.msgs, { role: 'user', text }] } : r)));
        sendAgentMessage(wsRef.current, text, mode, convId, undefined, model);
      }
    },
    [mode, setActiveId],
  );

  // Closing the socket resolves every pending approval as denied server-side
  // (see ws/agent.ts), which is exactly what a mid-run "stop" should do. A
  // fresh connection replaces it so the next send still works.
  const handleStop = useCallback(() => {
    setRunState('done');
    setPendingApproval(null);
    setIteration(null);
    setLoadingModel(false);
    buildingMsgIdRef.current = null;
    wsRef.current?.close();
    if (token) {
      const ws = createAgentSocket(token, () => {});
      wsRef.current = ws;
    }
  }, [token]);

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
    setRuns((prev) => prev.map((r) => (r.id === id ? { ...r, model: modelId } : r)));
    updateConversation(id, { model_pref: { model: modelId } }).catch(() => {});
  }, []);

  const activeRun = runs.find((r) => r.id === activeId) ?? null;
  const changedFiles = useMemo(() => (activeRun ? computeChangedFiles(activeRun.msgs) : []), [activeRun]);
  const busy = runState === 'running' || runState === 'awaiting_approval';

  return {
    runs,
    activeId,
    activeRun,
    selectRun,
    mode,
    runState,
    busy,
    loadingModel,
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
