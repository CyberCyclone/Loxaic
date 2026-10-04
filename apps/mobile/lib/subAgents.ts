import {
  SUBAGENT_TOOL_NAME,
  foldSubAgentEvent,
  sortSubAgents,
  type SubAgentEvent,
  type SubAgentLive,
} from '@loxaic/types';
import { localDeadline, type PendingApproval } from '@/lib/pendingWaits';
import { localRunStart } from '@/lib/runStart';

/**
 * A thread's sub-agents, as the client holds them.
 *
 * Everything a card, the Sub-agents list and a child's approval prompt show
 * comes from here, and it is fed from three places that must agree: the live
 * `subagent.*` events on the *parent's* stream, the `subagents` list a
 * `stream.sync` snapshot carries after a reconnect, and the REST listing after
 * a reload. The fold of the events themselves is the server's own
 * (`foldSubAgentEvent` in packages/types), so a snapshot and a live view cannot
 * describe a child differently; what this adds is the part only a device
 * knows — when things happened on *its* clock.
 *
 * Pure throughout: the hook around it (`useSubAgentState`) only holds the
 * state and the socket.
 */

/** One sub-agent, plus the two times a device has to convert for itself. */
export interface SubAgentView extends SubAgentLive {
  /**
   * When it started, on this device's clock — what the elapsed counter runs
   * from. The server's `started_at` is on its clock; a phone a minute fast
   * counting from that would show a minute too much.
   */
  startedLocal: number;
  /** Its pending approval with the deadline on this device's clock, ready for
   * the same components the parent's approval uses. */
  approval?: ChildApproval;
}

/** A sub-agent's tool call waiting on a person. `streamId` is the child's
 * run, which the answer has to name: a model's call ids repeat, and the
 * parent may be holding the same one. */
export interface ChildApproval extends PendingApproval {
  streamId: string;
}

/** A thread's sub-agents, in the order they were first heard of. Keyed by the
 * parent conversation in `SubAgentsByParent`. */
export type SubAgentsByParent = Partial<Record<string, SubAgentView[]>>;

/** The description a `subagent` tool call was given, or undefined for any
 * other tool. An unlabelled call is labelled by its task, as the server does. */
export function subAgentDescriptionOf(tool: string, args: Record<string, unknown>): string | undefined {
  if (tool !== SUBAGENT_TOOL_NAME) return undefined;
  const description = typeof args.description === 'string' ? args.description.trim() : '';
  if (description) return description;
  const prompt = typeof args.prompt === 'string' ? args.prompt.replace(/\s+/g, ' ').trim() : '';
  return prompt ? (prompt.length > 80 ? `${prompt.slice(0, 79)}…` : prompt) : 'Sub-agent';
}

export function isSubAgentEvent(event: { kind: string }): event is SubAgentEvent {
  return event.kind === 'subagent.started' || event.kind === 'subagent.progress' || event.kind === 'subagent.ended';
}

/** The approval a `SubAgentLive` carries, on this device's clock. `serverNow`
 * present means it came in a snapshot — see `localDeadline`. */
function approvalOf(live: SubAgentLive, now: number, serverNow?: number): ChildApproval | undefined {
  const src = live.pending_approval;
  if (!src) return undefined;
  const deadline = localDeadline(src, now, serverNow);
  return { streamId: src.stream_id, callId: src.call_id, tool: src.tool, args: src.args, ...(deadline ? { deadline } : {}) };
}

function toView(live: SubAgentLive, previous: SubAgentView | undefined, now: number, serverNow?: number): SubAgentView {
  // A start time already worked out is kept: recomputing it on every report
  // would make the elapsed counter jump by the delivery latency each time.
  const startedLocal = previous?.startedLocal ?? localRunStart(live.started_at, serverNow, now);
  // The same for an approval's deadline, while it is the same question.
  const sameQuestion =
    previous?.approval &&
    live.pending_approval?.call_id === previous.approval.callId &&
    live.pending_approval.stream_id === previous.approval.streamId;
  const approval = sameQuestion ? previous.approval : approvalOf(live, now, serverNow);
  const { approval: _dropped, ...rest } = { ...live, startedLocal, approval };
  return approval ? { ...rest, approval } : rest;
}

/** A live `subagent.*` event on a parent's stream. */
export function applySubAgentEvent(
  state: SubAgentsByParent,
  parentConvId: string,
  event: SubAgentEvent,
  now: number,
): SubAgentsByParent {
  const have = state[parentConvId] ?? [];
  const folded = foldSubAgentEvent(have, event);
  if (folded === have) return state;
  const byId = new Map(have.map((s) => [s.conversation_id, s]));
  return { ...state, [parentConvId]: folded.map((s) => toView(s, byId.get(s.conversation_id), now)) };
}

/**
 * The `subagents` of a `stream.sync` snapshot for a parent's run.
 *
 * A snapshot is that run's whole account of its children, so each child it
 * names replaces what was held — with one exception. A snapshot of a run that
 * is still going is read at a moment; a child the client has *since* seen end
 * (the live `subagent.ended` beat the snapshot's delivery) must not be brought
 * back to running by it. Ended is terminal.
 *
 * Children it does not name are left alone: they belong to the thread's other
 * runs.
 */
export function applySubAgentSnapshot(
  state: SubAgentsByParent,
  parentConvId: string,
  snapshot: readonly SubAgentLive[] | undefined,
  now: number,
  serverNow?: number,
): SubAgentsByParent {
  if (!snapshot || snapshot.length === 0) return state;
  const have = state[parentConvId] ?? [];
  const byId = new Map(have.map((s) => [s.conversation_id, s]));
  const next = [...have];
  for (const live of snapshot) {
    const previous = byId.get(live.conversation_id);
    if (previous && previous.status !== 'running' && live.status === 'running') continue;
    const view = toView(live, previous, now, serverNow);
    const at = next.findIndex((s) => s.conversation_id === live.conversation_id);
    if (at === -1) next.push(view);
    else next[at] = view;
  }
  return { ...state, [parentConvId]: next };
}

/**
 * The REST listing for a parent, merged into what is held.
 *
 * It is the stored record, read at some moment — older than anything live. So
 * it adds the children the client has never heard of, and it may *end* one the
 * client still holds as running (the end was missed while offline), but it
 * never overwrites a child's live figures and never brings an ended one back.
 * A finished child it already holds only takes the figures it is missing.
 */
export function mergeListedSubAgents(
  state: SubAgentsByParent,
  parentConvId: string,
  rows: readonly SubAgentLive[],
  now: number,
): SubAgentsByParent {
  if (rows.length === 0) return state;
  const have = state[parentConvId] ?? [];
  const byId = new Map(have.map((s) => [s.conversation_id, s]));
  const next = [...have];
  let changed = false;
  for (const row of rows) {
    const previous = byId.get(row.conversation_id);
    if (!previous) {
      // A finished child's elapsed time is its own start to its own end, both
      // on the server's clock, so `startedLocal` only matters while running.
      next.push(toView(row, undefined, now));
      changed = true;
      continue;
    }
    const at = next.findIndex((s) => s.conversation_id === row.conversation_id);
    if (previous.status === 'running' && row.status !== 'running') {
      // Ended while this device was not listening. It keeps what it measured
      // live and loses what only a running child has.
      const { state: _state, queue_position: _queue, pending_approval: _pending, approval: _approval, ...kept } = previous;
      next[at] = {
        ...kept,
        status: row.status,
        ...(row.ended_at === undefined ? {} : { ended_at: row.ended_at }),
        ...(row.error === undefined ? {} : { error: row.error }),
      };
      changed = true;
    } else if (previous.status !== 'running' && row.status !== 'running') {
      const filled: SubAgentView = {
        ...previous,
        context_used: previous.context_used ?? row.context_used,
        window_tokens: previous.window_tokens ?? row.window_tokens,
        last_gen_tps: previous.last_gen_tps ?? row.last_gen_tps,
        last_prompt_tps: previous.last_prompt_tps ?? row.last_prompt_tps,
        tokens_out: previous.tokens_out ?? row.tokens_out,
      };
      next[at] = filled;
      changed = true;
    }
  }
  return changed ? { ...state, [parentConvId]: next } : state;
}

/** The sub-agent a tool call started: by the message it belongs to and its
 * call id, or by call id alone when the message is not known (an optimistic
 * or older row) and only one child has it. */
export function subAgentForCall(
  list: readonly SubAgentView[] | undefined,
  callId: string | undefined,
  messageId: string | undefined,
): SubAgentView | undefined {
  if (!list || !callId) return undefined;
  const sameCall = list.filter((s) => s.call_id === callId);
  if (messageId) {
    const exact = sameCall.find((s) => s.message_id === messageId);
    if (exact) return exact;
  }
  return sameCall.length === 1 ? sameCall[0] : undefined;
}

/**
 * The child whose approval the parent's screen shows: the one that has been
 * waiting longest. One at a time, like the parent's own — answering it brings
 * up the next.
 */
export function firstChildApproval(list: readonly SubAgentView[] | undefined): SubAgentView | undefined {
  if (!list) return undefined;
  return [...list]
    .filter((s) => s.status === 'running' && s.approval)
    .sort((a, b) => a.started_at - b.started_at)
    .at(0);
}

/** Running first, then finished, newest first in each — the Sub-agents list. */
export function listedSubAgents(list: readonly SubAgentView[] | undefined): SubAgentView[] {
  return sortSubAgents(list ?? []) as SubAgentView[];
}

export function runningCount(list: readonly SubAgentView[] | undefined): number {
  return (list ?? []).filter((s) => s.status === 'running').length;
}

/** Every child conversation the state knows, for telling a child's own stream
 * messages from a thread's. */
export function childConversationIds(state: SubAgentsByParent): Set<string> {
  const out = new Set<string>();
  for (const list of Object.values(state)) for (const s of list ?? []) out.add(s.conversation_id);
  return out;
}

export function findSubAgent(state: SubAgentsByParent, childConvId: string): SubAgentView | undefined {
  for (const list of Object.values(state)) {
    const found = list?.find((s) => s.conversation_id === childConvId);
    if (found) return found;
  }
  return undefined;
}

/** "Running", "Queued · #2", "Waiting for approval", "Finished", "Stopped",
 * "Failed" — the one line that says how a sub-agent is going. */
export function subAgentStatusLabel(s: Pick<SubAgentLive, 'status' | 'state' | 'queue_position'>): string {
  if (s.status === 'complete') return 'Finished';
  if (s.status === 'cancelled') return 'Stopped';
  if (s.status === 'error') return 'Failed';
  if (s.state === 'awaiting_approval') return 'Waiting for approval';
  if (s.state === 'queued') return s.queue_position ? `Queued · #${String(s.queue_position)}` : 'Queued';
  return 'Running';
}

/** Which of the run-state dots a sub-agent shows — the header's vocabulary,
 * so a child reads the same as its parent. */
export function subAgentRunState(
  s: Pick<SubAgentLive, 'status' | 'state'>,
): 'queued' | 'running' | 'awaiting_approval' | 'done' | 'error' | 'stopped' {
  if (s.status === 'complete') return 'done';
  if (s.status === 'cancelled') return 'stopped';
  if (s.status === 'error') return 'error';
  return s.state ?? 'running';
}

/** How full the child's window is, 0-100, or null when either figure is
 * missing — never a guess, and never 0 for "unknown". */
export function subAgentContextPercent(s: Pick<SubAgentLive, 'context_used' | 'window_tokens'>): number | null {
  if (s.context_used == null || !s.window_tokens) return null;
  return Math.min(100, Math.round((s.context_used / s.window_tokens) * 100));
}

/** How long a finished child ran, in ms, from its own start and end — both on
 * the server's clock, so no conversion. Null while it is running. */
export function subAgentDurationMs(s: Pick<SubAgentLive, 'started_at' | 'ended_at'>): number | null {
  return s.ended_at == null ? null : Math.max(0, s.ended_at - s.started_at);
}

/** "12.3s", "4m 05s" — a finished run's length. */
export function formatDuration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes)}m ${String(seconds).padStart(2, '0')}s`;
}

/**
 * The speed line: the last request's generation rate, and its prompt rate when
 * the backend reported one. Both are the backend's own figures for one
 * finished request — nothing here is derived, and nothing is shown until a
 * request has finished. Null when there is nothing to say.
 */
export function subAgentSpeed(s: Pick<SubAgentLive, 'last_gen_tps' | 'last_prompt_tps'>): string | null {
  const parts: string[] = [];
  if (s.last_gen_tps != null && s.last_gen_tps > 0) parts.push(`${formatRate(s.last_gen_tps)} tok/s`);
  if (s.last_prompt_tps != null && s.last_prompt_tps > 0) parts.push(`${formatRate(s.last_prompt_tps)} tok/s prompt`);
  return parts.length ? parts.join(' · ') : null;
}

function formatRate(tps: number): string {
  return tps >= 100 ? String(Math.round(tps)) : tps.toFixed(1);
}
