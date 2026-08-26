import type { FileDiff } from "./index";

/** Duplicated (structurally, not nominally) from @shannon/agent so this
 * package stays dependency-free — packages/agent is the authority for
 * agent-loop *logic* (toolRequiresApproval etc.), this is only the wire shape. */
export type PermissionMode = "planning" | "manual" | "auto";

export type Todo = { id?: string; text: string; status: "pending" | "in_progress" | "completed" };

/**
 * What a turn's prompt was made of. Attribution has to happen server-side:
 * the agent ships its tool schemas in `body.tools`, which never appears in
 * `messages` at all, so no client-side estimate can ever account for it —
 * and on a small window that's the single largest slice.
 */
export type ContextCategory =
  | "system" /** System prompt. Agent only — chat sends none. */
  | "tools" /** JSON tool schemas, sent out-of-band in `body.tools`. */
  | "summary" /** The newest compaction summary, replayed in place of everything before it. */
  | "history" /** Prior user + assistant turns replayed into the prompt. */
  | "reasoning" /** Prior thinking blocks re-fed. Chat-only, and now always 0. */
  | "tool_io" /** tool_call args + tool_result output. Unbounded; the runaway one. */
  | "current" /** The user message that triggered this turn. */
  | "response"; /** The reply just generated — measured, never apportioned. */

export type ContextPart = { category: ContextCategory; tokens: number };

export type ContextBreakdown = {
  /** `parts` sum to exactly this. Includes the response: it's in the window
   * now and will be in the next prompt, so the bar and the ring agree. */
  used_tokens: number;
  parts: ContextPart[];
  /** How many prior messages were actually replayed, and the cap that applied. */
  history_messages: number;
  history_limit: number;
  /** True when older turns had already been dropped by the cap. */
  history_truncated: boolean;
  /** The window the prompt was actually assembled against. Belt-and-braces on
   * top of the client's model-list refresh: it closes the races refresh can't
   * (refresh in flight, model changed mid-conversation, MOCK_INFERENCE). */
  window_tokens?: number | null;
};

export type TurnUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tps: number | null;
  gen_tps: number | null;
  total_ms: number;
  context?: ContextBreakdown;
};

export type StreamStatus = "active" | "complete" | "error" | "cancelled";

/**
 * What a `/compact` did. `saved_tokens = before - after` (floored at 0):
 * `after` is the backend's own `completion_tokens` for the summary — exact —
 * and `before` is the previous turn's `prompt + completion`, i.e. exactly what
 * the next prompt would have replayed. When no prior usage record existed to
 * measure `before` from, it's estimated and `before_estimated` says so — the
 * UI renders a `~` rather than passing an estimate off as a measurement.
 */
export type CompactionStats = {
  messages_compacted: number;
  before_tokens: number;
  after_tokens: number;
  saved_tokens: number;
  before_estimated: boolean;
  /** Set when the run refused without calling the model: a summary with
   * nothing after it, or a thread too short to bother. Costs zero tokens. */
  skipped?: "already_compacted" | "too_short";
  /** The user's steering text ("make sure to include …"), verbatim. */
  guidance?: string;
};

/**
 * Payload kinds appended to a stream's durable log. Chat and agent share one
 * envelope — the agent-only kinds (iteration, tool.*, approval.request,
 * todos) simply never appear on a chat stream. Every event that names a
 * message carries `message_id` (including tool calls/results — the client
 * used to have to infer this via a placeholder-promotion hack; it doesn't
 * need to anymore).
 */
export type StreamEventKind =
  | {
      kind: "message.start";
      message_id: string;
      author_type: "user" | "assistant" | "tool" | "summary";
      parent_id: string | null;
      model?: string;
      /** User messages arrive already-complete and carry their full text here. */
      text?: string;
    }
  | { kind: "text.delta"; message_id: string; text: string }
  | { kind: "thinking.delta"; message_id: string; text: string }
  | {
      kind: "message.end";
      message_id: string;
      status: "complete" | "error" | "cancelled";
      usage?: TurnUsage;
      error?: string;
    }
  | { kind: "model.loading"; message_id: string }
  | { kind: "iteration"; n: number; max: number }
  | { kind: "tool.call"; message_id: string; call_id: string; tool: string; args: Record<string, unknown> }
  | { kind: "approval.request"; call_id: string; tool: string; args: Record<string, unknown> }
  | {
      kind: "tool.result";
      message_id: string;
      call_id: string;
      tool: string;
      output: string;
      ok: boolean;
      diff?: FileDiff[];
    }
  | { kind: "todos"; todos: Todo[] }
  /** Emitted once by a compact run, before its message.end — the stats the
   * card renders, attached to the summary message. */
  | ({ kind: "compaction"; message_id: string } & CompactionStats);

export type StreamSnapshotMessage = {
  message_id: string;
  author_type: "user" | "assistant" | "tool" | "summary";
  parent_id: string | null;
  model?: string;
  text: string;
  thinking: string;
  /** Present on summary messages once their compaction event has landed. */
  compaction?: CompactionStats;
  tool_calls: {
    call_id: string;
    tool: string;
    args: Record<string, unknown>;
    output?: string;
    ok?: boolean;
    diff?: FileDiff[];
  }[];
  status: "streaming" | "complete" | "error" | "cancelled";
  usage?: TurnUsage;
  error?: string;
};

/** Everything-so-far, folded server-side from the durable log. The client
 * renders this instantly on subscribe, then applies live `stream.event`s
 * with `seq` greater than this snapshot's `seq`. */
export type StreamSnapshot = {
  messages: StreamSnapshotMessage[];
  // agent-only:
  iteration?: { n: number; max: number };
  todos?: Todo[];
  pending_approval?: { call_id: string; tool: string; args: Record<string, unknown> };
};

/**
 * Dev-mode telemetry. Deliberately NOT a `StreamEventKind`: debug traffic is
 * live-only and rides its own ephemeral bus, so it never enters the durable
 * stream log, never consumes a `seq`, and can't bloat a reconnect's catch-up
 * read. A client that never subscribes receives none of it, and one that
 * doesn't understand it ignores an unknown `type` like any other.
 *
 * Discriminated on `channel` so the payload narrows with it.
 */
export type DebugEvent =
  /** The exact JSON body sent to the inference backend, pretty-printed. */
  | { channel: "model.request"; stream_id: string; model: string; body: string; truncated?: boolean }
  /** Raw SSE lines as they arrived, including reasoning frames and [DONE]. */
  | { channel: "model.raw"; stream_id: string; lines: string[] }
  | {
      channel: "model.done";
      stream_id: string;
      finish_reason?: string | null;
      usage?: TurnUsage;
      duration_ms: number;
    }
  | {
      channel: "tool.call";
      stream_id: string;
      call_id: string;
      tool: string;
      source: { kind: "builtin" | "mcp"; server?: string };
      args: string;
      truncated?: boolean;
    }
  /** The tool's result *before* sanitization/wrapping (secrets redacted). */
  | {
      channel: "tool.result_raw";
      stream_id: string;
      call_id: string;
      tool: string;
      ok: boolean;
      raw: string;
      duration_ms: number;
      truncated?: boolean;
    }
  | { channel: "mcp.lifecycle"; server: string; event: "connect_failed" | "unavailable"; message: string };

export type DebugChannel = DebugEvent["channel"];

export type ServerMessage =
  | { type: "turn.started"; stream_id: string; conversation_id: string; user_message_id: string; incognito: boolean }
  | {
      type: "conv.streams";
      conversation_id: string;
      streams: { stream_id: string; status: StreamStatus; last_seq: number }[];
    }
  | {
      type: "stream.sync";
      stream_id: string;
      conversation_id: string;
      seq: number;
      status: StreamStatus;
      snapshot: StreamSnapshot;
    }
  | { type: "stream.event"; stream_id: string; conversation_id: string; seq: number; event: StreamEventKind }
  | {
      type: "stream.end";
      stream_id: string;
      conversation_id: string;
      seq: number;
      status: "complete" | "error" | "cancelled";
      usage?: TurnUsage;
      error?: string;
    }
  | { type: "agent.mode_changed"; mode: PermissionMode }
  /** Dev mode only — sent solely to sockets that asked for it. */
  | { type: "debug.event"; conversation_id: string; ts: number; event: DebugEvent }
  | { type: "error"; error: string; conversation_id?: string; stream_id?: string };

export type ClientMessage =
  | {
      type: "chat.send";
      content: string;
      model?: string;
      conversation_id?: string;
      parent_id?: string;
      incognito?: boolean;
    }
  | {
      type: "agent.send";
      content: string;
      model?: string;
      mode?: PermissionMode;
      conversation_id?: string;
      parent_id?: string;
      incognito?: boolean;
    }
  /** Run a built-in slash command against an existing conversation. The
   * surface is implied by which socket this arrives on (chat vs agent), which
   * decides whose history loader the command sees. */
  | { type: "command.run"; command: string; conversation_id: string; model?: string; args?: string }
  /** cursors = last seq the client has already applied, per stream_id it knows about. */
  | { type: "stream.subscribe"; conversation_id: string; cursors?: Record<string, number> }
  | { type: "stream.stop"; stream_id: string }
  | { type: "agent.mode"; mode: PermissionMode }
  | { type: "agent.approve"; call_id: string }
  | { type: "agent.deny"; call_id: string }
  /** Dev mode: start/stop receiving `debug.event`s for a conversation. Capture
   * lives only as long as the subscription — nothing is buffered server-side. */
  | { type: "debug.subscribe"; conversation_id: string }
  | { type: "debug.unsubscribe"; conversation_id: string };
