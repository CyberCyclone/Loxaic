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
  /** Which configured backend serves this model. `"default"` is the one
   * INFERENCE_BASE_URL names; anything else is an admin-added provider row.
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
