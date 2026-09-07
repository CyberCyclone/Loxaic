import type { CompactionStats, ContextBreakdown } from "./stream-protocol";

export type Result<T, E = Error> =
  | { ok: true; data: T }
  | { ok: false; error: E };

export type Id = string;

export type Origin = "server" | "device";

export type ConversationKind = "chat" | "agent" | "routine";

export type PermissionMode = "planning" | "manual" | "auto";

/**
 * Where an agent conversation's files live and what is in them. Chosen when
 * the conversation is created and **immutable afterwards** — the agent's
 * system prompt is derived from it, and a prompt that changed mid-conversation
 * would invalidate the backend's cached prefix from the first token onward
 * (see AGENTS.md, "Prompt caching").
 *
 * - `scratch`: an empty directory in a sandbox on the server. The default, and
 *   what every conversation created before workspaces existed resolves to.
 * - `github`: a clone of a repo the user's GitHub connection can reach, on a
 *   fresh branch cut from `baseBranch`. `cloneUrl` is what GitHub reported for
 *   the repo, never something the client supplied. `pr` is written by the
 *   server once a pull request has been opened (a later stage) and is never
 *   client-settable.
 * - `local`: a directory on the user's own machine, executed by that machine's
 *   desktop app (a later stage). Rejected until then.
 */
export type WorkspaceIsolation = "direct" | "container";
export type Workspace =
  | { kind: "scratch" }
  | {
      kind: "github";
      /** `owner/name`. */
      repo: string;
      baseBranch: string;
      /** The branch the agent works on, created from `baseBranch` at clone time. */
      branch: string;
      cloneUrl: string;
      pr?: { number: number; url: string };
    }
  | {
      kind: "local";
      executorId: string;
      executorName: string;
      path: string;
      isolation: WorkspaceIsolation;
    };

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
  /** Which host in the cluster serves this model, and the name that host's
   * owner chose for it. Null when the instance has no registered identity (a
   * dev server, a Compose deployment) — the picker then shows no host label
   * rather than inventing one. With one host it is already how a user names
   * the machine they are talking to; phase 4 (#78) only makes the list
   * longer. */
  host_id: string | null;
  host_name: string | null;
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
