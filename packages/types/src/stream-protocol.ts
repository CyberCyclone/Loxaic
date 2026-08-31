import type { FileDiff } from "./index";

/** Duplicated (structurally, not nominally) from @shannon/agent so this
 * package stays dependency-free — packages/agent is the authority for
 * agent-loop *logic* (toolRequiresApproval etc.), this is only the wire shape. */
export type PermissionMode = "planning" | "manual" | "auto";

export interface Todo { id?: string; text: string; status: "pending" | "in_progress" | "completed" }

/** An uploaded image attached to a user message. `ref` is the id returned by
 * `POST /v1/files`; `mime` is advisory for rendering (the server's DB row is
 * the authority). */
export interface AttachmentRef { ref: string; mime: string }

/** Shared client/server limits for image attachments — one source so the
 * composer's caps and the upload route's rejections can't drift apart. */
export const MAX_ATTACHMENTS = 4;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const ATTACHMENT_MIMES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;

/**
 * The "is this send well-formed" gate shared word-for-word by `chat.send`
 * and `agent.send` — pure so it's testable without a live socket. An
 * image-only message is valid (empty text is only an error when nothing is
 * attached either); returns the error string to send back, or null to
 * proceed.
 */
export function validateSendAttachments(content: unknown, attachments: unknown): string | null {
  const atts: unknown = attachments ?? [];
  if (!Array.isArray(atts) || atts.length > MAX_ATTACHMENTS) {
    return `Attach at most ${String(MAX_ATTACHMENTS)} images`;
  }
  // Elements too, not just the array. TypeScript's `string[]` on the wire type
  // is a claim about a JSON payload, not a fact, and the downstream ref check
  // is a regex — `RegExp.test` stringifies, so `[["<uuid>"]]` would otherwise
  // read as a valid uuid and reach a uuid-typed query.
  if (!atts.every((a: unknown) => typeof a === "string")) {
    return `Attach at most ${String(MAX_ATTACHMENTS)} images`;
  }
  if (typeof content !== "string" || (!content.trim() && atts.length === 0)) {
    return "Content required";
  }
  return null;
}

/**
 * What a turn's prompt was made of. Attribution has to happen server-side:
 * the agent ships its tool schemas in `body.tools`, which never appears in
 * `messages` at all, so no client-side estimate can ever account for it —
 * and on a small window that's the single largest slice.
 */
export type ContextCategory =
  | "system" /** System prompt. */
  | "tools" /** JSON tool schemas, sent out-of-band in `body.tools`. */
  | "summary" /** The newest compaction summary, replayed in place of everything before it. */
  | "history" /** Prior user + assistant turns replayed into the prompt. */
  | "reasoning" /** Prior thinking blocks re-fed. Legacy category — always 0 now. */
  | "tool_io" /** tool_call args + tool_result output. Unbounded; the runaway one. */
  | "current" /** The user message that triggered this turn. */
  | "response"; /** The reply just generated — measured, never apportioned. */

export interface ContextPart { category: ContextCategory; tokens: number }

export interface ContextBreakdown {
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
}

export interface TurnUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tps: number | null;
  gen_tps: number | null;
  total_ms: number;
  context?: ContextBreakdown;
}

export type StreamStatus = "active" | "complete" | "error" | "cancelled";

/**
 * What a `/compact` did. `saved_tokens = before - after` (floored at 0):
 * `after` is the backend's own `completion_tokens` for the summary — exact —
 * and `before` is the previous turn's `prompt + completion`, i.e. exactly what
 * the next prompt would have replayed. When no prior usage record existed to
 * measure `before` from, it's estimated and `before_estimated` says so — the
 * UI renders a `~` rather than passing an estimate off as a measurement.
 */
export interface CompactionStats {
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
}

/**
 * Payload kinds appended to a stream's durable log. Chat and agent share one
 * envelope, and both surfaces are tool-capable — every kind can appear on
 * either stream. Every event that names a message carries `message_id`
 * (including tool calls/results — the client used to have to infer this via
 * a placeholder-promotion hack; it doesn't need to anymore).
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
      /** User messages only — images ride here the same way `text` does. */
      attachments?: AttachmentRef[];
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

export interface StreamSnapshotMessage {
  message_id: string;
  author_type: "user" | "assistant" | "tool" | "summary";
  parent_id: string | null;
  model?: string;
  text: string;
  thinking: string;
  /** Present on user messages that carried images (folded from `message.start`). */
  attachments?: AttachmentRef[];
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
}

/** Everything-so-far, folded server-side from the durable log. The client
 * renders this instantly on subscribe, then applies live `stream.event`s
 * with `seq` greater than this snapshot's `seq`. */
export interface StreamSnapshot {
  messages: StreamSnapshotMessage[];
  // agent-only:
  iteration?: { n: number; max: number };
  todos?: Todo[];
  pending_approval?: { call_id: string; tool: string; args: Record<string, unknown> };
}

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
  | { type: "error"; error: string; conversation_id?: string; stream_id?: string };

export type ClientMessage =
  | {
      type: "chat.send";
      content: string;
      model?: string;
      conversation_id?: string;
      parent_id?: string;
      incognito?: boolean;
      /** Refs from `POST /v1/files`. The server re-validates ownership. */
      attachments?: string[];
    }
  | {
      type: "agent.send";
      content: string;
      model?: string;
      mode?: PermissionMode;
      conversation_id?: string;
      parent_id?: string;
      incognito?: boolean;
      /** Refs from `POST /v1/files`. The server re-validates ownership. */
      attachments?: string[];
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
  | { type: "agent.deny"; call_id: string };
