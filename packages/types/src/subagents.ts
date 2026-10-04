import type { WaitDeadlineFields } from "./stream-protocol";

/**
 * Sub-agents: a run handing a self-contained task to a child agent, which has
 * its own conversation, its own context window and its own stream, and reports
 * back once (apps/server/src/streams/runs/subagentRun.ts).
 *
 * What is here is the part the server and the clients must agree on: the tool's
 * wire name, what a child looks like on its parent's stream, and the one fold
 * both sides apply to those events.
 */

/** The wire name of the tool that spawns one. The client matches it to draw a
 * sub-agent card instead of a tool card. */
export const SUBAGENT_TOOL_NAME = "subagent";

/** How many sub-agents one assistant message may start. They run together, and
 * each is a whole agent run holding (or queueing for) an inference slot. */
export const MAX_SUBAGENTS_PER_MESSAGE = 4;

/** How a child ended. `running` until it has. */
export type SubAgentStatus = "running" | "complete" | "error" | "cancelled";

/** What a running child is doing right now. */
export type SubAgentState = "queued" | "running" | "awaiting_approval";

/**
 * Which model a sub-agent runs on, per user (`user_prefs.subagent_model_mode`).
 * - `choose`: the parent's model, unless the parent names another one it is offered.
 * - `parent`: always the parent's model.
 * - `fixed`: one model the user picked, whatever the parent is on.
 */
export type SubAgentModelMode = "choose" | "parent" | "fixed";
export const SUBAGENT_MODEL_MODES: readonly SubAgentModelMode[] = ["choose", "parent", "fixed"];
export const DEFAULT_SUBAGENT_MODEL_MODE: SubAgentModelMode = "choose";

export function isSubAgentModelMode(value: unknown): value is SubAgentModelMode {
  return typeof value === "string" && (SUBAGENT_MODEL_MODES as readonly string[]).includes(value);
}

/** What `conversations.subagent` stores for a child. */
export interface SubAgentInfo {
  description: string;
  model: string;
  /** The parent's permission mode, which the child inherits. */
  mode: "planning" | "manual" | "auto";
  /** The child's stream, so a client that learns of it from REST can still
   * subscribe to it or stop it. */
  streamId: string;
  status: SubAgentStatus;
  /** Server epoch ms. */
  startedAt: number;
  endedAt?: number;
  error?: string;
}

/** A child's approval, as its parent's stream carries it. `stream_id` is the
 * child's: call ids are the model's own and repeat, so an answer names the
 * stream it is for. */
export type SubAgentApproval = {
  stream_id: string;
  call_id: string;
  tool: string;
  args: Record<string, unknown>;
} & WaitDeadlineFields;

/**
 * One sub-agent as a parent's thread knows it: who it is, how it is going, and
 * what it last measured. The same shape on the stream snapshot, from
 * `GET /v1/conversations/:id/subagents`, and in the client's state.
 *
 * Every measured figure is null (or absent) until there is one — never 0.
 */
export interface SubAgentLive {
  /** The child's own conversation. */
  conversation_id: string;
  stream_id: string;
  /** The parent's assistant message and call that spawned it. */
  message_id: string;
  call_id: string;
  description: string;
  model: string;
  /** Server epoch ms. */
  started_at: number;
  status: SubAgentStatus;
  ended_at?: number;
  error?: string;
  /** Present while `status` is `running`. */
  state?: SubAgentState;
  iteration?: number;
  /** `queued` only: place in line, 1 = next. */
  queue_position?: number;
  /** Tokens in the child's window after its last request (prompt + reply). */
  context_used?: number | null;
  window_tokens?: number | null;
  /** The last request's generation and prompt-evaluation rates, as the backend
   * reported them. Null when it reported none. */
  last_gen_tps?: number | null;
  last_prompt_tps?: number | null;
  /** Tokens the child has generated so far, over all its requests. */
  tokens_out?: number;
  /** Present while the child is waiting for someone to allow a tool call. */
  pending_approval?: SubAgentApproval;
}

/** The fields of a `subagent.progress` event: whatever changed, and nothing
 * else. `pending_approval: null` clears one. */
export interface SubAgentProgress {
  conversation_id: string;
  state?: SubAgentState;
  iteration?: number;
  queue_position?: number;
  context_used?: number | null;
  window_tokens?: number | null;
  last_gen_tps?: number | null;
  last_prompt_tps?: number | null;
  tokens_out?: number;
  pending_approval?: SubAgentApproval | null;
}

export type SubAgentEvent =
  /** A child has been created and its run started. Emitted on the parent's
   * stream before the child does anything. */
  | {
      kind: "subagent.started";
      message_id: string;
      call_id: string;
      conversation_id: string;
      stream_id: string;
      description: string;
      model: string;
      started_at: number;
    }
  /** Something about a running child changed. Emitted when it does — there is
   * no timer behind it; elapsed time is the client's to count. */
  | ({ kind: "subagent.progress" } & SubAgentProgress)
  | {
      kind: "subagent.ended";
      conversation_id: string;
      status: Exclude<SubAgentStatus, "running">;
      ended_at: number;
      error?: string;
    };

/**
 * Applies one sub-agent event to a thread's list. Pure, and shared: the
 * server folds a snapshot with it and the client folds live events with it, so
 * a reconnect and a live view cannot describe a child differently.
 *
 * Progress or an end for a child the list does not hold is dropped — without
 * `subagent.started` there is no card to hang it on.
 */
export function foldSubAgentEvent(list: readonly SubAgentLive[], event: SubAgentEvent): SubAgentLive[] {
  if (event.kind === "subagent.started") {
    const next: SubAgentLive = {
      conversation_id: event.conversation_id,
      stream_id: event.stream_id,
      message_id: event.message_id,
      call_id: event.call_id,
      description: event.description,
      model: event.model,
      started_at: event.started_at,
      status: "running",
      state: "queued",
    };
    return [...list.filter((s) => s.conversation_id !== event.conversation_id), next];
  }
  const at = list.findIndex((s) => s.conversation_id === event.conversation_id);
  if (at === -1) return list as SubAgentLive[];
  const current = list[at];
  let updated: SubAgentLive;
  if (event.kind === "subagent.ended") {
    // An ended child keeps what it measured and loses what only a running one
    // has: a state, a place in line, a question waiting on someone.
    const { state: _state, queue_position: _queue, pending_approval: _approval, ...rest } = current;
    updated = {
      ...rest,
      status: event.status,
      ended_at: event.ended_at,
      ...(event.error === undefined ? {} : { error: event.error }),
    };
  } else {
    // A report that arrives after the end (it cannot, but a replayed log is
    // not trusted to be in order) must not bring a finished child back.
    if (current.status !== "running") return list as SubAgentLive[];
    const { kind: _kind, conversation_id: _id, pending_approval, ...fields } = event;
    updated = { ...current, ...fields };
    if (pending_approval === null) delete updated.pending_approval;
    else if (pending_approval !== undefined) updated.pending_approval = pending_approval;
    if (updated.state !== "queued") delete updated.queue_position;
  }
  const out = [...list];
  out[at] = updated;
  return out;
}

/** A parent stream that has ended cannot have a running child: stopping the
 * parent stops them, and it waits for them before it ends. So a child still
 * marked running in a finished parent's log is one whose end was never
 * recorded (a crash), and showing it as running would offer a Stop that does
 * nothing. */
export function endStaleSubAgents(list: readonly SubAgentLive[], endedAt: number): SubAgentLive[] {
  return list.map((s) =>
    s.status === "running"
      ? foldSubAgentEvent([s], {
          kind: "subagent.ended",
          conversation_id: s.conversation_id,
          status: "error",
          ended_at: endedAt,
          error: SUBAGENT_LOST_ERROR,
        })[0]
      : s,
  );
}

/** Said of a child whose run did not survive: the server restarted, or its
 * end was never recorded. */
export const SUBAGENT_LOST_ERROR = "The sub-agent did not finish: the server stopped while it was running.";

/** Running first (newest first), then finished (newest first) — the order of
 * the Sub-agents list. */
export function sortSubAgents(list: readonly SubAgentLive[]): SubAgentLive[] {
  const rank = (s: SubAgentLive) => (s.status === "running" ? 0 : 1);
  return [...list].sort((a, b) => rank(a) - rank(b) || b.started_at - a.started_at);
}
