import type { CompactionStats, ContextBreakdown } from "./stream-protocol";

export type Result<T, E = Error> =
  | { ok: true; data: T }
  | { ok: false; error: E };

export type Id = string;

export type Origin = "server" | "device";

export type ConversationKind = "chat" | "agent" | "routine";

export type PermissionMode = "planning" | "manual" | "auto";

export type MessageStatus = "streaming" | "complete" | "error" | "cancelled";

export type AuthorType = "user" | "assistant" | "system" | "tool" | "summary";

export interface FileDiff {
  path: string;
  oldContent: string | null;
  newContent: string | null;
}

export type ContentBlock =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool_call"; call_id: string; tool: string; args: unknown }
  | { kind: "tool_result"; call_id: string; output: string; diff?: FileDiff[] }
  | { kind: "attachment"; ref: string; mime: string; name?: string }
  /** Rides alongside a summary message's text block so a cold REST load can
   * render the compaction card with its stats — the stream isn't the only
   * path to this data. */
  | ({ kind: "compaction" } & CompactionStats);

export interface ModelInfo {
  id: string;
  display_name: string;
  quant: string;
  /** Weight format, e.g. "gguf" or "mlx" — "—" when the backend doesn't expose it. */
  format: string;
  /** The window in force *right now* — `loaded_context_tokens` when the model
   * is loaded, else the best available upper bound. This is the only figure
   * that belongs in a "% of context used" denominator. */
  context_tokens: number;
  /** The largest window the model could be loaded at. Often vastly bigger than
   * what the backend actually allocated (e.g. 262,144 declared, 8,192 loaded). */
  max_context_tokens: number;
  /** The window the backend actually allocated. null when it isn't loaded, or
   * when the backend won't say — in which case `context_tokens` is a guess and
   * `context_source` says so. */
  loaded_context_tokens: number | null;
  /** Where `context_tokens` came from, so the UI can admit when it's estimating
   * instead of quietly reporting a wrong denominator as fact. */
  context_source: "loaded" | "max" | "trained" | "default";
  location: "server" | "device" | "remote";
  price: number;
  loaded: boolean;
}

export interface ModelPref { model?: string }

export * from "./stream-protocol";
export * from "./commands";

export interface UsageRecord {
  id: string;
  userId: string;
  deviceId: string | null;
  conversationId: string | null;
  messageId: string | null;
  runId: string | null;
  model: string;
  origin: Origin;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  ttftMs: number | null;
  promptMs: number | null;
  predictMs: number | null;
  totalMs: number | null;
  promptTps: number | null;
  predictedTps: number | null;
  /** null for rows written before the breakdown existed, and for any backend
   * that didn't report usage. The UI must handle that, not assume it. */
  contextBreakdown: ContextBreakdown | null;
  createdAt: string;
}
