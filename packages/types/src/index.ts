import type { CompactionStats, ContextBreakdown } from "./stream-protocol";
import type { ModelThinking } from "./thinking";

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

/**
 * The project's own instructions file (AGENTS.md, else CLAUDE.md) at the root
 * of an agent conversation's workspace, as read once — before the first
 * request — and then frozen. Stored on `conversations.instructions`; null
 * there means nobody has looked yet.
 *
 * `decision` is how the file is presented to the model, fixed per model so the
 * system prompt stays byte-identical between turns (AGENTS.md, "Project
 * instructions"): `full` is the whole text, `outline` its opening and headings
 * with line ranges for the model to page through with fs_read.
 */
export type InstructionsMode = "full" | "outline";
export interface InstructionsDecision {
  model: string;
  /** The window the decision was made against; null when it was unknown. */
  windowTokens: number | null;
  mode: InstructionsMode;
}
/** A file the instructions file pulls in with `@path` (CLAUDE.md, GEMINI.md). */
export interface ImportedInstructions {
  /** Relative to the workspace root. */
  path: string;
  /** The file whose `@path` mention brought this one in. */
  importedBy: string;
  text: string;
  sourceBytes: number;
  sourceTruncated: boolean;
}
/**
 * The project's instructions as last read from the workspace — kept apart
 * from the version in the system prompt so a change can reach the model in
 * the chat (a notice on that run's user message) without rewriting the front
 * of the prompt. It replaces the system-prompt version only when the front of
 * the prompt changes anyway: a compaction, or the history window moving.
 */
export interface InstructionsVersion {
  /** Null when the workspace no longer has one. */
  path: string | null;
  text: string;
  imports?: ImportedInstructions[];
  /** Each document's `cksum` ("CRC SIZE") as the workspace reported it, by
   * path. Absent for a version read through GitHub's API. */
  cksums?: Record<string, string>;
  sourceBytes: number;
  sourceTruncated: boolean;
}
/** Fields every settled snapshot carries for change tracking. */
export interface InstructionsTracking {
  /** The version the chat was last told about, when it differs from the one
   * in the system prompt. Cleared when it is folded in. */
  latest?: InstructionsVersion;
  /** Which prompt front the last run was built on (compaction point and
   * history-window anchor). A new one is what allows a fold. */
  frontKey?: string;
}
export type ProjectInstructions =
  | ({
      status: "found";
      /** Relative to the workspace root, e.g. `AGENTS.md`. */
      path: string;
      text: string;
      /** Bytes read — equal to the file's size unless `sourceTruncated`. */
      sourceBytes: number;
      sourceTruncated: boolean;
      fetchedAt: string;
      decision?: InstructionsDecision;
      /** Estimated tokens, measured once when the snapshot is written, so a
       * listing never re-measures megabytes it is about to throw away. */
      tokens?: number;
      /** What `text` imports, in order; absent when it imports nothing. */
      imports?: ImportedInstructions[];
      /** `imports.length`, stored so a listing that leaves the texts out still
       * knows how many there are. */
      importCount?: number;
      /** `cksum` of each document in this version, by path — see `InstructionsVersion`. */
      cksums?: Record<string, string>;
    } & InstructionsTracking)
  | ({ status: "none"; fetchedAt: string } & InstructionsTracking)
  /** Looked, and could not find out: kept so the next run does not pay the
   * lookup again until `retryAfter`, and so the client can say why. */
  | { status: "unavailable"; reason: InstructionsUnavailableReason; checkedAt: string; retryAfter: string; attempts: number };

export type InstructionsUnavailableReason = "no-github-connection" | "machine-offline" | "error";

/** What a client is told about a conversation's instructions — never the text. */
export type ProjectInstructionsSummary =
  | {
      status: "found";
      path: string;
      mode: InstructionsMode | null;
      /** The file and everything it imports. */
      tokens: number;
      sourceBytes: number;
      sourceTruncated: boolean;
      /** How many files it imports; absent on an older server. */
      imports?: number;
      /** The file has changed since the version in the system prompt, and the
       * agent was told in the chat. */
      pendingUpdate?: boolean;
    }
  | { status: "none"; pendingUpdate?: boolean }
  | { status: "unavailable"; reason: InstructionsUnavailableReason };

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
  /** `ok` is optional only because rows written before it existed do not carry
   * it — every result persisted now sets it, including successes. Absence
   * therefore means "this row predates the field", never "it succeeded", and
   * the client tints on a positive `false` for exactly that reason. Without it
   * a failed call was indistinguishable from a successful one the moment the
   * live stream ended and history was rebuilt from REST. */
  | { kind: "tool_result"; call_id: string; output: string; ok?: boolean; diff?: FileDiff[] }
  | { kind: "attachment"; ref: string; mime: string; name?: string }
  /** Rides alongside a summary message's text block so a cold REST load can
   * render the compaction card with its stats — the stream isn't the only
   * path to this data. */
  | ({ kind: "compaction" } & CompactionStats)
  /** On a user message: the project's instructions file changed before this
   * run, and `text` is the notice the model was given ahead of the message.
   * Stored so every replay sends exactly what the live request sent; `summary`
   * is the one line a client shows. */
  | { kind: "instructions_update"; path: string; text: string; summary: string };

export interface ModelContextStage {
  /** The stage the model loads at now; 0 is its standard context. */
  active: number;
  /** Per-request window of every stage, standard first. */
  windows: (number | null)[];
  /** A switch waiting for other replies to finish, or null. */
  pending: number | null;
  who_may_change: "everyone" | "admins";
  /** What happens when a conversation fills the window. */
  when_full: "compact" | "extend";
}

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
  /** A host model the router is loading right now. Absent on other models and
   * from an older server. */
  loading?: boolean;
  /** A host model an admin pinned: kept loaded, never unloaded to make room.
   * Absent on other models and from an older server. */
  pinned?: boolean;
  /**
   * A host model with YaRN context stages (see the server's
   * llama/context-stages.ts). Absent on every other model and from an older
   * server. Enough for the client to decide whether to ask anything; the
   * details a modal shows come from `GET /v1/models/context-stage`.
   */
  context_stage?: ModelContextStage;
  /** How hard the model can be asked to think (see thinking.ts). Absent on a
   * model that takes no level, and from an older server. */
  thinking?: ModelThinking;
  /** Which configured backend serves this model. `"default"` is the
   * local llama.cpp runtime; anything else is an admin-added provider row.
   * The picker groups on this. */
  provider_id: string;
  /** The admin's label for that provider — the group header. Renameable, so
   * never treat it as an identity. */
  provider_name: string;
  /** The id the *provider* knows this model by, with no `slug::` prefix. What
   * goes on the wire to the backend, and what the allowlist matches. Equal to
   * `id` for the default provider. */
  upstream_id: string;
}

export interface ModelPref { model?: string }

/**
 * A model reference is one opaque string everywhere it is stored or sent —
 * `conversations.model_pref`, `messages.model`, `usage_records.model`, the
 * `model` field on every WS send. The default backend's models keep their bare
 * upstream id, so every row written before providers existed stays valid; an
 * added provider's models are `slug::upstreamId`.
 *
 * `::` rather than `/` or `:` because both of those appear inside real model
 * ids (`openai/gpt-4o`, `qwen2.5:7b`), and a separator that can occur in the
 * right-hand side would make the split ambiguous.
 *
 * One string rather than a second `provider` field on the wire: a native build
 * that predates this feature treats the id as opaque and keeps working, where
 * it would silently drop an unknown field and have the server route its
 * request to the local model instead.
 */
export const MODEL_REF_SEPARATOR = "::";

/** The one slug an added provider may not take: `ws/chat.ts` sends the literal
 * `"default"` when a client names no model, and `DEFAULT_PROVIDER_ID` is what
 * the synthesized built-in provider reports. */
export const DEFAULT_PROVIDER_ID = "default";

/**
 * How full a conversation's window is when the client offers to extend its
 * model's context (YaRN stages) or compact. Below the server's automatic
 * compaction (0.85), so the choice comes before compaction does; the server
 * also uses it for "the smallest stage this conversation fits in comfortably".
 */
export const CONTEXT_STAGE_PROMPT_AT = 0.75;

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** True for a syntactically valid provider slug. Shared by the ref parser and
 * the admin route's validation so the two cannot disagree about what a slug is. */
export function isProviderSlug(value: string): boolean {
  return SLUG_RE.test(value);
}

/**
 * Split a stored reference into the provider that serves it and the id that
 * provider knows it by. `providerSlug` is null for the default backend.
 *
 * A `::` whose left side is not slug-shaped is *not* a provider reference —
 * the whole string belongs to the default backend, which is the conservative
 * reading for an id some future backend invents.
 */
export function parseModelRef(ref: string): { providerSlug: string | null; upstreamModel: string } {
  const at = ref.indexOf(MODEL_REF_SEPARATOR);
  if (at <= 0) return { providerSlug: null, upstreamModel: ref };
  const slug = ref.slice(0, at);
  if (!isProviderSlug(slug)) return { providerSlug: null, upstreamModel: ref };
  return { providerSlug: slug, upstreamModel: ref.slice(at + MODEL_REF_SEPARATOR.length) };
}

export function formatModelRef(providerSlug: string | null, upstreamModel: string): string {
  return providerSlug === null ? upstreamModel : `${providerSlug}${MODEL_REF_SEPARATOR}${upstreamModel}`;
}

/**
 * What to show when the model list has nothing to say about a ref — a message
 * from a provider that has since been deleted, or a stats row for one. The
 * slug is dropped rather than shown, because it is an internal identifier the
 * user never chose; a live model renders its `display_name` instead and never
 * reaches this.
 */
export function displayModelRef(ref: string): string {
  return parseModelRef(ref).upstreamModel;
}

export * from "./stream-protocol";
export * from "./waits";
export * from "./commands";
export * from "./mcp-state";
export * from "./thinking";

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
