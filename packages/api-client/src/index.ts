let BASE_URL = "http://localhost:4000";
let AUTH_TOKEN: string | null = null;

/** Point the client at a different server (LAN IP, tailnet HTTPS URL, …). */
/**
 * An HTTP response the server actually sent, as opposed to a request that
 * never got one. Callers deciding "is the server down?" must branch on this:
 * `fetch` rejects with a TypeError when the host is unreachable, but a 404 for
 * a deleted row or a 500 for one bad query is a *reachable* server saying no,
 * and flipping an app into offline mode over it locks the user out of a
 * perfectly healthy host.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** True when the failure was the network, not the server's answer. */
export function isUnreachableError(err: unknown): boolean {
  return !(err instanceof ApiError);
}

export function setApiBaseUrl(url: string) {
  BASE_URL = url.replace(/\/+$/, "");
}

export function getApiBaseUrl(): string {
  return BASE_URL;
}

/**
 * Store the session token for Bearer auth. Native apps have no cookie jar, so
 * they must call this after signIn/signUp (the returned Session carries the
 * token); web can rely on cookies and skip it.
 */
export function setAuthToken(token: string | null) {
  AUTH_TOKEN = token;
}

export interface HealthResponse {
  status: string;
  timestamp: string;
  services: {
    database: "ok" | "error";
    inference: "ok" | "error" | "unavailable";
  };
}

export async function getHealth(): Promise<HealthResponse> {
  const res = await fetch(`${BASE_URL}/health`);
  if (!res.ok) throw new Error(`GET /health ${String(res.status)}`);
  return res.json() as Promise<HealthResponse>;
}

export type SandboxMode = "container" | "host" | "off";
export type SandboxEngine = "auto" | "docker" | "podman" | "custom";

/** How long an agent workspace survives. Milliseconds, because that is the one
 * unit that needs no conversion anywhere in the stack; the UI renders hours and
 * days from it. */
export interface SandboxRetention {
  /** Unused for this long and the sandbox is paused — contents kept. */
  idleStopMs: number;
  /** Whether long-unused sandboxes are eventually deleted at all. */
  reapEnabled: boolean;
  /** Unused for this long and the sandbox is deleted, if reaping is on. */
  reapAfterMs: number;
}

export interface ConfigResponse {
  /** False while the server refuses new accounts (Funnel is on). */
  signUpOpen: boolean;
  sandbox: {
    mode: SandboxMode;
    available: boolean;
    /** Whether sandboxes can reach the network. Always true in host mode. */
    allowNetwork: boolean;
    retention: SandboxRetention;
    reason?: string;
  };
  /**
   * How long this deployment keeps a deleted conversation for an admin to
   * audit, or null when deleting erases it outright (the default).
   *
   * Read before the delete, so the confirm dialog can say which of the two is
   * about to happen — a delete that silently leaves a readable copy behind,
   * and one that silently erases what the user thought was recoverable, are
   * the same failure in two directions.
   */
  deletedChatRetentionDays: number | null;
  /** This server's build version, or null when nothing reported one (a bare
   * `node dist/index.js`, a hand-rolled Docker image, an unstamped desktop
   * build) or the call was not signed in — render as "—". */
  version: string | null;
}

/** `GET /v1/cluster`, projected to what a client shows: which host it is
 * talking to, by the name its owner chose. Unauthenticated on the server —
 * the onboarding join screen reads it before an account exists. */
export interface ClusterInfo {
  cluster: { id: string; name: string };
  hosts: { id: string; name: string; online: boolean; self: boolean }[];
}

export async function getCluster(): Promise<ClusterInfo | null> {
  const res = await fetch(`${BASE_URL}/v1/cluster`);
  // 503 while identity is still being minted at boot — not an error, just
  // "not yet". A dev server with no LOXAIC_INSTANCE_ID has an empty host list.
  if (!res.ok) return null;
  return res.json() as Promise<ClusterInfo>;
}

export async function getConfig(): Promise<ConfigResponse> {
  // The bearer rides along when there is one: `version` is returned only to
  // a signed-in caller, and the route stays reachable without it.
  const headers = new Headers();
  if (AUTH_TOKEN) headers.set("Authorization", `Bearer ${AUTH_TOKEN}`);
  const res = await fetch(`${BASE_URL}/v1/config`, { headers });
  if (!res.ok) throw new Error(`GET /v1/config ${String(res.status)}`);
  const body = (await res.json()) as Partial<ConfigResponse> & Pick<ConfigResponse, "sandbox">;
  // Absent — an older server, or an unauthenticated call — is the same
  // answer as null, and the declared type promises one or the other. For
  // retention that fallback is also the safe one: a server too old to report
  // it is one that cannot keep anything.
  return {
    ...body,
    signUpOpen: body.signUpOpen ?? true,
    deletedChatRetentionDays: body.deletedChatRetentionDays ?? null,
    version: body.version ?? null,
  };
}

// ── Admin: server-level sandbox settings ──────────────────

export interface EngineProbe {
  id: "docker" | "podman";
  available: boolean;
  socketPath?: string;
  detectedAs?: "docker" | "podman";
}

export interface SandboxSettings extends SandboxRetention {
  mode: SandboxMode;
  engine: SandboxEngine;
  customSocket: string | null;
  allowNetwork: boolean;
  /** Fields pinned by an environment variable — render read-only; PATCHing
   * one returns 409. */
  envOverrides: {
    mode: boolean;
    socket: boolean;
    allowNetwork: boolean;
    idleStop: boolean;
    reapEnabled: boolean;
    reapAfter: boolean;
  };
  available: boolean;
  reason?: string;
  /** Which engines are installed/running, for greying out the picker. Empty
   * outside container mode. */
  engines: EngineProbe[];
}

export type SandboxSettingsPatch = Partial<
  Pick<
    SandboxSettings,
    "mode" | "engine" | "customSocket" | "allowNetwork" | "idleStopMs" | "reapEnabled" | "reapAfterMs"
  >
>;

/** Carries the server's error body so the UI can tell "you typed something
 * invalid" apart from "an admin can't change this — it's pinned by an
 * environment variable" (409, `envOverride: true`). */
export class AdminSettingsError extends Error {
  status: number;
  envOverride: boolean;
  constructor(message: string, status: number, envOverride: boolean) {
    super(message);
    this.status = status;
    this.envOverride = envOverride;
  }
}

async function adminFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await getAuthToken();
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${String(token)}`);
  const res = await fetch(`${BASE_URL}${path}`, { ...init, headers });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; envOverride?: boolean };
    throw new AdminSettingsError(
      body.error ?? `${init?.method ?? "GET"} ${path} failed: ${String(res.status)}`,
      res.status,
      body.envOverride === true,
    );
  }
  return res.json() as Promise<T>;
}

/** Admin: how many runs may hold the inference backend at once. */
export interface InferenceSettings {
  /** null = follow the backend's own slot count. */
  maxConcurrentRuns: number | null;
  envOverrides: { maxConcurrentRuns: boolean };
  /** What `maxConcurrentRuns` actually resolves to right now — the number null
   * stands for. Shown alongside the setting because the two routinely differ
   * and the resolved one is what an admin needs to see. */
  effectiveMaxConcurrentRuns: number;
}

export async function getInferenceSettings(): Promise<InferenceSettings> {
  return adminFetch("/v1/admin/settings/inference");
}

export async function updateInferenceSettings(
  patch: { maxConcurrentRuns: number | null },
): Promise<InferenceSettings> {
  return adminFetch("/v1/admin/settings/inference", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
}

export async function getSandboxSettings(): Promise<SandboxSettings> {
  return adminFetch("/v1/admin/settings/sandbox");
}

export async function updateSandboxSettings(patch: SandboxSettingsPatch): Promise<SandboxSettings> {
  return adminFetch("/v1/admin/settings/sandbox", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
}

export type { ModelInfo, ModelPref } from "@loxaic/types";

export async function getModels(): Promise<import("@loxaic/types").ModelInfo[]> {
  return (await authedFetch("/v1/models")).json() as Promise<import("@loxaic/types").ModelInfo[]>;
}

// ── Auth ──────────────────────────────────────────────────
export interface Session {
  token: string;
  user: {
    id: string;
    email: string;
    name: string;
    emailVerified: boolean;
    image: string | null;
    createdAt: string;
    updatedAt: string;
    role?: string | null;
  };
  redirect?: boolean;
}

export async function signUp(email: string, password: string, name?: string): Promise<Session> {
  const res = await fetch(`${BASE_URL}/api/auth/sign-up`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ email, password, name }),
  });
  if (!res.ok) throw new Error(`Sign up failed: ${String(res.status)}`);
  return res.json() as Promise<Session>;
}

export async function signIn(email: string, password: string): Promise<Session> {
  const res = await fetch(`${BASE_URL}/api/auth/sign-in`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`Sign in failed: ${String(res.status)}`);
  return res.json() as Promise<Session>;
}

/** Shape of `GET /api/auth/session` — distinct from the sign-in/sign-up
 * response (`Session`, above): better-auth's getSession returns the session
 * row alongside the user, not the raw token. */
export interface SessionInfo {
  session: { id: string; expiresAt: string; token: string };
  user: Session["user"];
}

export async function getSession(): Promise<SessionInfo | null> {
  const headers = new Headers();
  if (AUTH_TOKEN) headers.set("Authorization", `Bearer ${AUTH_TOKEN}`);
  const res = await fetch(`${BASE_URL}/api/auth/session`, {
    credentials: "include",
    headers,
  });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`Session fetch failed: ${String(res.status)}`);
  return res.json() as Promise<SessionInfo>;
}

export async function getAuthToken(): Promise<string | null> {
  if (AUTH_TOKEN) return AUTH_TOKEN;
  // Web fallback: recover the token from the session cookie round-trip.
  try {
    const res = await fetch(`${BASE_URL}/api/auth/token`, {
      credentials: "include",
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { token: string | null };
    return data.token;
  } catch {
    return null;
  }
}

// ── Conversations ─────────────────────────────────────────
export type ConversationRole = "viewer" | "editor" | "owner";

export interface Conversation {
  id: string;
  ownerId: string;
  title: string;
  kind: string;
  activeLeafId: string | null;
  modelPref: import("@loxaic/types").ModelPref | null;
  mcpOverrides: { disabledServerIds?: string[] } | null;
  /** Where an agent conversation's files live. Null is scratch. Fixed at
   * creation — see `createConversation`. */
  workspace?: import("@loxaic/types").Workspace | null;
  /** Only on the single-conversation read: whether a run is going right now. */
  active_run?: boolean;
  createdAt: string;
  updatedAt: string;
  /** What the caller may do here. Present on list and single-conversation
   * reads; absent on rows returned by create/update, where the caller is the
   * owner by construction. */
  role?: ConversationRole;
}

export interface ConversationShare {
  userId: string;
  role: "viewer" | "editor";
  name: string;
  email: string;
  createdAt: string;
  createdBy: string;
}

export interface AdminConversation {
  id: string;
  title: string;
  kind: string;
  ownerId: string;
  ownerName: string;
  ownerEmail: string;
  updatedAt: string;
  createdAt: string;
  shareCount: number;
  /** Set when the owner deleted it and this deployment keeps deleted
   * conversations. It is gone everywhere else — this list is the only place
   * one appears. */
  deletedAt: string | null;
  /** An admin held it past its window; the sweep leaves it alone. */
  deletedHold: boolean;
  /** When the sweep will erase it: null if it is held (nothing will), the
   * deletion time itself if retention is off (the next sweep takes it).
   * Derived by the server on every read, so shortening the window moves every
   * retained conversation with it. */
  purgeAt: string | null;
}

/** One message of a deleted conversation, as the admin transcript shows it.
 * Content blocks are passed through untouched — the transcript renders text
 * and names attachments, and never fetches their bytes. */
export interface AdminMessage {
  id: string;
  authorType: "user" | "assistant" | "system" | "tool" | "summary";
  authorUserId: string | null;
  model: string | null;
  content: unknown;
  status: string;
  createdAt: string;
}

export interface DirectoryUser {
  id: string;
  name: string;
  email: string;
}

export async function getShares(conversationId: string): Promise<ConversationShare[]> {
  const res = await authedFetch(`/v1/conversations/${conversationId}/shares`);
  return ((await res.json()) as { shares: ConversationShare[] }).shares;
}

export async function putShare(
  conversationId: string,
  userId: string,
  role: "viewer" | "editor",
): Promise<ConversationShare[]> {
  const res = await authedFetch(`/v1/conversations/${conversationId}/shares`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: userId, role }),
  });
  return ((await res.json()) as { shares: ConversationShare[] }).shares;
}

export async function deleteShare(
  conversationId: string,
  userId: string,
): Promise<ConversationShare[]> {
  const res = await authedFetch(`/v1/conversations/${conversationId}/shares/${userId}`, {
    method: "DELETE",
  });
  return ((await res.json()) as { shares: ConversationShare[] }).shares;
}

export async function searchUsers(q: string): Promise<DirectoryUser[]> {
  const res = await authedFetch(`/v1/users/search?q=${encodeURIComponent(q)}`);
  return ((await res.json()) as { users: DirectoryUser[] }).users;
}

export async function adminListConversations(): Promise<AdminConversation[]> {
  const res = await authedFetch("/v1/admin/conversations");
  return (await res.json()) as AdminConversation[];
}

export async function adminGetShares(conversationId: string): Promise<ConversationShare[]> {
  const res = await authedFetch(`/v1/admin/conversations/${conversationId}/shares`);
  return ((await res.json()) as { shares: ConversationShare[] }).shares;
}

export async function adminPatchShare(
  conversationId: string,
  input: { user_id: string; role?: "viewer" | "editor"; revoke?: boolean },
): Promise<ConversationShare[]> {
  const res = await authedFetch(`/v1/admin/conversations/${conversationId}/shares`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return ((await res.json()) as { shares: ConversationShare[] }).shares;
}

/**
 * A conversation's messages, read-only, for the admin screen.
 *
 * The only way to read a conversation this deployment retained after its
 * owner deleted it. Live conversations are readable here too — an admin
 * already resolves to a viewer on those — so the screen does not have to
 * branch on which kind it is showing.
 */
export async function adminGetMessages(conversationId: string): Promise<AdminMessage[]> {
  const res = await authedFetch(`/v1/admin/conversations/${conversationId}/messages`);
  return ((await res.json()) as { messages: AdminMessage[] }).messages;
}

/** Give a retained conversation back to its owner. Its shares come back with
 * it; its agent workspace does not, having been destroyed at delete time. */
export async function adminRestoreConversation(conversationId: string): Promise<void> {
  await authedFetch(`/v1/admin/conversations/${conversationId}/restore`, { method: "POST" });
}

/** Erase a retained conversation now rather than at the end of its window. */
export async function adminPurgeConversation(conversationId: string): Promise<void> {
  await authedFetch(`/v1/admin/conversations/${conversationId}/purge`, { method: "POST" });
}

/** Hold a retained conversation past its window, or release it back to it. */
export async function adminSetConversationHold(conversationId: string, hold: boolean): Promise<void> {
  await authedFetch(`/v1/admin/conversations/${conversationId}/hold`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hold }),
  });
}

/** How this deployment treats a deleted conversation. Admin-only, like every
 * other server-level setting. */
export interface ConversationRetentionSettings {
  keepDeleted: boolean;
  keepDeletedDays: number;
  envOverrides: { keepDeleted: boolean; keepDeletedDays: boolean };
}

export async function getConversationRetention(): Promise<ConversationRetentionSettings> {
  return adminFetch("/v1/admin/settings/conversations");
}

export async function updateConversationRetention(
  patch: Partial<Pick<ConversationRetentionSettings, "keepDeleted" | "keepDeletedDays">>,
): Promise<ConversationRetentionSettings> {
  return adminFetch("/v1/admin/settings/conversations", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
}

/** A conversation's workspace as the client sees it. `status` is the lifecycle
 * from the server: "stopped" means paused with its contents intact, not gone. */
export interface SandboxRow {
  id: string;
  conversationId: string | null;
  provider: "container" | "host";
  status: "creating" | "running" | "stopped" | "destroyed";
  lastUsedAt: string;
  createdAt: string;
  stoppedAt: string | null;
  /** Resource and posture facts fixed at creation. `network` is whether this
   * sandbox can reach the internet — recorded then because it cannot change
   * for the sandbox's life; absent on rows that predate it. */
  limits?: { memory?: number; cpu?: number; network?: boolean } | null;
  /** When this workspace would be deleted, or null when reaping is off (in
   * which case it is kept until the conversation is). Derived server-side from
   * the live policy, so it never advertises a date an admin has since moved. */
  reap_at: string | null;
}

export async function getSandboxes(conversationId?: string): Promise<SandboxRow[]> {
  const query = conversationId ? `?conversation_id=${encodeURIComponent(conversationId)}` : "";
  const res = await authedFetch(`/v1/sandboxes${query}`);
  return res.json() as Promise<SandboxRow[]>;
}

/**
 * Creates a conversation up front, so an agent chat can choose its workspace
 * before its first message. The workspace is immutable afterwards: the agent's
 * system prompt is built from it. A plain send with no conversation still
 * opens a scratch one implicitly, for clients that predate the chooser.
 */
/** What a client may ask for when creating an agent conversation. The server
 * fills in everything it refuses to take on trust: GitHub's clone URL and
 * default branch, and a local machine's name. */
export type WorkspaceRequest =
  | import("@loxaic/types").Workspace
  | { kind: "github"; repo: string; baseBranch?: string; branch?: string }
  | { kind: "local"; executorId: string; path: string; isolation?: import("@loxaic/types").WorkspaceIsolation };

export async function createConversation(input: {
  title?: string;
  kind?: "chat" | "agent";
  workspace?: WorkspaceRequest;
}): Promise<Conversation> {
  const res = await authedFetch("/v1/conversations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return res.json() as Promise<Conversation>;
}

export async function getConversation(id: string): Promise<Conversation> {
  const res = await authedFetch(`/v1/conversations/${id}`);
  return res.json() as Promise<Conversation>;
}

export async function getConversations(): Promise<Conversation[]> {
  const token = await getAuthToken();
  const res = await fetch(`${BASE_URL}/v1/conversations`, {
    headers: { Authorization: `Bearer ${String(token)}` },
  });
  if (!res.ok) throw new ApiError(`Conversations failed: ${String(res.status)}`, res.status);
  return res.json() as Promise<Conversation[]>;
}

/**
 * Delete a conversation. Owner-only, and deliberately silent about it: the
 * server answers `{ok: true}` whether or not the caller was allowed, so a
 * non-owner's delete is indistinguishable from deleting something already
 * gone. Whether the server erases it or keeps it for an audit window is the
 * deployment's policy — `getConfig().deletedChatRetentionDays` says which.
 */
export async function deleteConversation(id: string): Promise<{ ok: true }> {
  return (await authedFetch(`/v1/conversations/${id}`, { method: "DELETE" })).json() as Promise<{ ok: true }>;
}

export async function updateConversation(
  id: string,
  patch: {
    model_pref?: import("@loxaic/types").ModelPref;
    mcp_overrides?: { disabledServerIds?: string[] };
  },
): Promise<Conversation> {
  return (
    await authedFetch(`/v1/conversations/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    })
  ).json() as Promise<Conversation>;
}

export interface ApiMessageUsage {
  inputTokens: number;
  /** Tokens the backend reported reusing from its KV cache. **Null means the
   * backend does not report it** — not that nothing was cached. */
  cachedTokens: number | null;
  /** Tokens of the prompt that were a token-identical prefix of the previous
   * request — what the server offered the backend to reuse. Computed
   * server-side, so present on every backend. */
  reusableTokens: number | null;
  outputTokens: number;
  ttftMs: number | null;
  promptMs: number | null;
  predictMs: number | null;
  totalMs: number | null;
  promptTps: number | null;
  predictedTps: number | null;
  /** null for rows written before this column existed, and for any backend
   * that reported no usage — the UI must degrade rather than assume. */
  contextBreakdown: import("@loxaic/types").ContextBreakdown | null;
}

export interface ApiMessage {
  id: string;
  conversationId: string;
  parentId: string | null;
  authorType: "user" | "assistant" | "system" | "tool" | "summary";
  authorUserId: string | null;
  origin: "server" | "device";
  deviceId: string | null;
  model: string | null;
  lamport: number;
  content: import("@loxaic/types").ContentBlock[];
  status: "streaming" | "complete" | "error" | "cancelled";
  /** Why an errored turn failed. Null otherwise, and on errored rows that
   * predate the column. */
  error: string | null;
  createdAt: string;
  deletedAt: string | null;
  /** Persisted usage/timing for this message — null for user messages or if never recorded. */
  usage: ApiMessageUsage | null;
}

export async function getMessages(
  conversationId: string,
): Promise<{ messages: ApiMessage[]; forks: unknown }> {
  const token = await getAuthToken();
  const res = await fetch(`${BASE_URL}/v1/conversations/${conversationId}/messages`, {
    headers: { Authorization: `Bearer ${String(token)}` },
  });
  if (!res.ok) throw new ApiError(`Messages failed: ${String(res.status)}`, res.status);
  return res.json() as Promise<{ messages: ApiMessage[]; forks: unknown }>;
}

// ── Routines ──────────────────────────────────────────────
export interface Routine {
  id: string;
  ownerId: string;
  name: string;
  cron: string;
  prompt: string;
  target: unknown;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
}

export interface RoutineRun {
  id: string;
  routineId: string;
  conversationId: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
}

async function authedFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = await getAuthToken();
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${String(token)}`);
  const res = await fetch(`${BASE_URL}${path}`, { ...init, headers });
  if (!res.ok) throw new ApiError(await describeFailure(res, init?.method ?? "GET", path), res.status);
  return res;
}

/**
 * The server's own explanation when it gave one, else the status line. Every
 * route that validates spells out *why* — "workspace.repo must be owner/name",
 * "GitHub is not connected", a branch name git would refuse — and all of it
 * used to collapse into `POST /v1/conversations failed: 400` at exactly the
 * moment the user could have acted on the reason.
 */
async function describeFailure(res: Response, method: string, path: string): Promise<string> {
  const fallback = `${method} ${path} failed: ${String(res.status)}`;
  try {
    const body = (await res.json()) as { error?: unknown; message?: unknown };
    const detail = typeof body.error === "string" ? body.error : typeof body.message === "string" ? body.message : null;
    return detail && detail.length > 0 ? detail : fallback;
  } catch {
    return fallback;
  }
}

// ── Attachments ───────────────────────────────────────────
export type { AttachmentRef } from "@loxaic/types";

export interface UploadedAttachment {
  ref: string;
  mime: string;
  size_bytes: number;
  name: string;
  extract_status: "none" | "ok" | "failed" | "unsupported";
}

/** A multipart part `expo/fetch` can encode on native: it reads `name` and
 * `type` for the part headers and `bytes()` for the body. This is the *only*
 * non-Blob shape it accepts — React Native's `{uri, name, type}` recipe throws
 * "Unsupported FormDataPart implementation" now that `expo/fetch` is
 * `globalThis.fetch` (SDK 56+). Built by `nativeAttachmentFile` in
 * apps/mobile/lib/attachmentUpload.ts. */
export interface NativeUploadPart {
  name: string;
  type: string;
  bytes(): Promise<Uint8Array>;
}

/** Upload one file — image or document. `file` is a web File/Blob, or a
 * native `NativeUploadPart`; both work as a FormData entry. `filename`, when
 * given, names the multipart part explicitly — needed when `file` is a plain
 * Blob (a Blob carries no name of its own; a File would, but the web upload
 * path here works from a re-wrapped Blob, not the original File, so the name
 * has to be threaded through separately). */
export async function uploadAttachment(
  file: Blob | NativeUploadPart,
  filename?: string,
): Promise<UploadedAttachment> {
  const token = await getAuthToken();
  const form = new FormData();
  // The DOM lib's FormData types only know Blob, hence the cast on the native
  // part; expo/fetch's encoder duck-types it. The part already carries its own
  // `name`, so `filename` only matters for the Blob branch — FormData.append's
  // 3rd argument is exactly the web mechanism for naming a Blob part.
  if (file instanceof Blob) {
    form.append("file", file, filename);
  } else {
    form.append("file", file as unknown as Blob);
  }
  const res = await fetch(`${BASE_URL}/v1/files`, {
    method: "POST",
    headers: { Authorization: `Bearer ${String(token)}` },
    body: form,
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string } & Partial<UploadedAttachment>;
  if (!res.ok || !body.ref) throw new Error(body.error ?? `Upload failed: ${String(res.status)}`);
  return body as UploadedAttachment;
}

/** URL an <img>/Image component, or a plain download link, can load directly
 * — the token rides in the query string since these requests can't carry an
 * Authorization header. Works for any attachment class; the server decides
 * inline vs attachment disposition based on mime. */
export function attachmentUrl(ref: string, token: string): string {
  return `${BASE_URL}/v1/files/${ref}?token=${encodeURIComponent(token)}`;
}

/** Fetches a document's cached extraction — exactly the text the model was
 * given, which for a PDF is not the same thing as the file itself. Used by
 * the document preview modal. Throws with the server's own message on
 * anything other than 200 (e.g. 409 when extraction isn't "ok" — an image,
 * or a document whose extraction failed). */
export async function getAttachmentText(
  ref: string,
): Promise<{ ref: string; name: string; mime: string; text: string }> {
  const token = await getAuthToken();
  const res = await fetch(`${BASE_URL}/v1/files/${ref}/text`, {
    headers: { Authorization: `Bearer ${String(token)}` },
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string } & Record<string, unknown>;
  if (!res.ok) throw new Error(body.error ?? `Fetching attachment text failed: ${String(res.status)}`);
  return body as { ref: string; name: string; mime: string; text: string };
}

export async function getRoutines(): Promise<Routine[]> {
  return (await authedFetch("/v1/routines")).json() as Promise<Routine[]>;
}

export async function createRoutine(input: { name: string; cron: string; prompt: string }): Promise<Routine> {
  return (
    await authedFetch("/v1/routines", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    })
  ).json() as Promise<Routine>;
}

export async function updateRoutine(
  id: string,
  patch: Partial<{ name: string; cron: string; prompt: string; enabled: boolean }>,
): Promise<Routine> {
  return (
    await authedFetch(`/v1/routines/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    })
  ).json() as Promise<Routine>;
}

export async function deleteRoutine(id: string): Promise<{ ok: true }> {
  return (await authedFetch(`/v1/routines/${id}`, { method: "DELETE" })).json() as Promise<{ ok: true }>;
}

export async function runRoutineNow(id: string): Promise<RoutineRun> {
  return (await authedFetch(`/v1/routines/${id}/run`, { method: "POST" })).json() as Promise<RoutineRun>;
}

export async function getRoutineRuns(id: string): Promise<RoutineRun[]> {
  return (await authedFetch(`/v1/routines/${id}/runs`)).json() as Promise<RoutineRun[]>;
}

// ── MCP servers ───────────────────────────────────────────
export interface McpToolPolicy {
  enabled: boolean;
  approval: "ask" | "allow";
  readOnly: boolean;
  changed?: boolean;
  missing?: boolean;
}

export interface McpServer {
  id: string;
  ownerId: string;
  name: string;
  slug: string;
  transport: "stdio" | "http";
  command: string | null;
  args: unknown;
  url: string | null;
  headers: unknown;
  env: unknown;
  builtinKey: string | null;
  enabled: boolean;
  allowPrivateNetwork: boolean;
  toolPolicies: Record<string, McpToolPolicy>;
  knownTools: Record<string, string>;
  lastConnectedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  /** Names of stored secrets; values never leave the server. */
  secretKeys: string[];
}

export interface McpDiscoveredTool {
  name: string;
  namespacedName: string;
  description: string;
  /** Server-claimed, display-only — never used for policy decisions. */
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean } | null;
  policy: McpToolPolicy;
}

export type McpTestResult =
  | { ok: true; changedTools: string[]; tools: McpDiscoveredTool[] }
  | { ok: false; error: string };

export interface McpCatalogEntry {
  key: string;
  name: string;
  slug: string;
  description: string;
  transport: "stdio" | "http";
  secretKeys: { env: string; label: string }[];
  /** Set when the server's credential comes from another connection rather
   * than from secrets typed here. A server made from such an entry follows
   * that connection: it cannot be added without it, or deleted while it lasts. */
  credentials: "github-connection" | null;
  configured: boolean;
}

export interface McpServerInput {
  name?: string;
  slug?: string;
  transport?: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  /** string sets a secret, null deletes it. */
  secrets?: Record<string, string | null>;
  enabled?: boolean;
  allowPrivateNetwork?: boolean;
  builtinKey?: string;
  toolPolicies?: Record<string, Partial<McpToolPolicy>>;
}

/** Carries the server's error body so the UI can offer the SSRF override. */
export class McpApiError extends Error {
  status: number;
  ssrf: boolean;
  constructor(message: string, status: number, ssrf: boolean) {
    super(message);
    this.status = status;
    this.ssrf = ssrf;
  }
}

async function mcpFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await getAuthToken();
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${String(token)}`);
  const res = await fetch(`${BASE_URL}${path}`, { ...init, headers });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; ssrf?: boolean };
    throw new McpApiError(
      body.error ?? `${init?.method ?? "GET"} ${path} failed: ${String(res.status)}`,
      res.status,
      body.ssrf === true,
    );
  }
  return res.json() as Promise<T>;
}

export async function getMcpServers(): Promise<McpServer[]> {
  return mcpFetch("/v1/mcp/servers");
}

export async function getMcpCatalog(): Promise<McpCatalogEntry[]> {
  return mcpFetch("/v1/mcp/catalog");
}

export async function createMcpServer(input: McpServerInput): Promise<McpServer> {
  return mcpFetch("/v1/mcp/servers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function updateMcpServer(id: string, patch: McpServerInput): Promise<McpServer> {
  return mcpFetch(`/v1/mcp/servers/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
}

export async function deleteMcpServer(id: string): Promise<{ ok: true }> {
  return mcpFetch(`/v1/mcp/servers/${id}`, { method: "DELETE" });
}

export async function testMcpServer(id: string): Promise<McpTestResult> {
  return mcpFetch(`/v1/mcp/servers/${id}/test`, { method: "POST" });
}

// ── GitHub connection ────────────────────────────────────
/** Whether connecting GitHub also set up its MCP tools, and if not, why. */
export type GithubMcpStatus =
  | { ok: true; serverId: string; enabled: boolean }
  | { ok: false; error: string };

export interface GithubConnection {
  login: string;
  name: string | null;
  email: string | null;
  /** Null for a fine-grained PAT — GitHub does not report scopes for those,
   * so null means "unknown", never "no access". */
  scopes: string | null;
  validatedAt: string;
  /** Optional on purpose: a client outlives the server it points at (a desktop
   * client against someone else's Host, an OTA update against an unchanged
   * server), and a server older than the GitHub-tools change sends no `mcp` at
   * all. Declaring it required made the compiler vouch for a field the wire
   * need not carry, and the screen crashed on the deref. */
  mcp?: GithubMcpStatus;
}

export interface GithubRepo {
  id: number;
  full_name: string;
  private: boolean;
  default_branch: string;
}

/** Carries the server's error body, same shape as McpApiError — a bad token
 * or an unreachable GitHub both need a message the connection screen can show
 * directly. */
export class GithubApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function githubFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await getAuthToken();
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${String(token)}`);
  const res = await fetch(`${BASE_URL}${path}`, { ...init, headers });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new GithubApiError(body.error ?? `${init?.method ?? "GET"} ${path} failed: ${String(res.status)}`, res.status);
  }
  return res.json() as Promise<T>;
}

/** Null when nothing is connected. */
export async function getGithubConnection(): Promise<GithubConnection | null> {
  return githubFetch("/v1/github/connection");
}

export async function putGithubConnection(token: string): Promise<GithubConnection> {
  return githubFetch("/v1/github/connection", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
}

export async function deleteGithubConnection(): Promise<{ ok: true }> {
  return githubFetch("/v1/github/connection", { method: "DELETE" });
}

export async function getGithubRepos(q?: string): Promise<GithubRepo[]> {
  const query = q ? `?q=${encodeURIComponent(q)}` : "";
  return githubFetch(`/v1/github/repos${query}`);
}

export async function getGithubBranches(
  owner: string,
  repo: string,
): Promise<{ default_branch: string; branches: string[] }> {
  return githubFetch(`/v1/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches`);
}

// ── Local executors (the user's own machines, via the desktop app) ────
/** One of the caller's machines with the desktop app open and signed in,
 * from `GET /v1/executors`. `roots` are the folders chosen on it. */
export interface ExecutorView {
  id: string;
  name: string;
  platform: string;
  capabilities: { direct: boolean; container: boolean };
  roots: string[];
  connectedAt: string;
}

export async function getExecutors(): Promise<ExecutorView[]> {
  const res = await authedFetch("/v1/executors");
  return res.json() as Promise<ExecutorView[]>;
}

// ── Git actions on an agent conversation's GitHub workspace ────
export interface GitStatus {
  /** Whether the agent has run a tool in this repo yet — false means nothing
   * below is meaningful, only the workspace's own repo/branch names are. */
  cloned: boolean;
  repo: string;
  branch: string;
  baseBranch: string;
  pr: { number: number; url: string } | null;
  changed?: { path: string; status: string }[];
  /** Null when the server could not count — the base ref was never fetched —
   * which the panel shows as unknown rather than as 0. */
  ahead?: number | null;
  behind?: number | null;
}

export class GitActionError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function gitFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await getAuthToken();
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${String(token)}`);
  const res = await fetch(`${BASE_URL}${path}`, { ...init, headers });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new GitActionError(body.error ?? `${init?.method ?? "GET"} ${path} failed: ${String(res.status)}`, res.status);
  }
  return res.json() as Promise<T>;
}

export async function getGitStatus(conversationId: string): Promise<GitStatus> {
  return gitFetch(`/v1/conversations/${conversationId}/git/status`);
}

export async function commitGit(conversationId: string, message: string): Promise<{ ok: true }> {
  return gitFetch(`/v1/conversations/${conversationId}/git/commit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });
}

export async function pushGit(conversationId: string): Promise<{ ok: true }> {
  return gitFetch(`/v1/conversations/${conversationId}/git/push`, { method: "POST" });
}

export async function openPullRequest(
  conversationId: string,
  title: string,
  body?: string,
): Promise<{ number: number; url: string }> {
  return gitFetch(`/v1/conversations/${conversationId}/git/pr`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, ...(body ? { body } : {}) }),
  });
}

// ── User prefs (builtin tool "allow always") ────────────────
export interface UserPrefs {
  /** Builtin tool names allowlisted globally — skip approval anywhere the
   * tool loop runs. MCP tools have their own per-server allowlist instead. */
  toolAllowlist: string[];
  /**
   * Optional because a server that predates the field simply omits it — it
   * does not error — and the client talks to servers it was not shipped with
   * (desktop Client mode, any remote host). Typing these as always-present
   * made `undefined` sail past a `=== null` guard and render a settings
   * control with nothing selected, which would then PATCH a field the old
   * server ignores. Callers must treat absence as "this server has no such
   * setting", not as a value.
   */
  autoCompact?: boolean;
  /** Tool round-trips the agent takes for one message before it pauses and
   * asks whether to keep going. A cadence, not a ceiling — the run is never
   * cut off. 1-500; defaults to 100. Optional — see `autoCompact`. */
  maxIterations?: number;
}

export async function getPrefs(): Promise<UserPrefs> {
  return (await authedFetch("/v1/prefs")).json() as Promise<UserPrefs>;
}

export async function updatePrefs(patch: Partial<UserPrefs>): Promise<UserPrefs> {
  return (
    await authedFetch("/v1/prefs", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    })
  ).json() as Promise<UserPrefs>;
}

// ── Stats ─────────────────────────────────────────────────
export type StatsRange = "session" | "today" | "week" | "month" | "year";

export interface UsageStatsSnapshot {
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Percentage of prompt tokens that did not need fresh evaluation. Null when
   * nothing in the window carried a reuse figure — render that as "not
   * measured", never as 0%. */
  cacheHitRate: number | null;
  requestCount: number;
  avgTtftMs: number | null;
  avgPromptTps: number | null;
  avgPredictedTps: number | null;
  avgTotalMs: number | null;
}

export interface UsageStatsSpark {
  totalTokens: number[];
  cacheHitRate: (number | null)[];
  avgTtftMs: (number | null)[];
  avgPredictedTps: (number | null)[];
}

export type UsageStats = UsageStatsSnapshot & {
  /** The equivalent-length window immediately before this one — null for a custom from/to range, which has no natural "previous period". */
  previous: UsageStatsSnapshot | null;
  /** Compact per-metric time buckets across the current window, for KPI-card sparklines — null alongside `previous`. */
  spark: UsageStatsSpark | null;
};

export async function getUsageStats(params?: {
  conversation_id?: string;
  model?: string;
  from?: string;
  to?: string;
  range?: StatsRange;
}): Promise<UsageStats> {
  const qs = new URLSearchParams(params).toString();
  return (await authedFetch(`/v1/stats/usage${qs ? `?${qs}` : ""}`)).json() as Promise<UsageStats>;
}

export interface StatsSeriesPoint { bucket: string; values: Record<string, number> }
export interface CacheRatePoint { bucket: string; cacheHitRate: number | null }
export interface StatsSeries { range: StatsRange; points: StatsSeriesPoint[]; cachePoints: CacheRatePoint[] }

export async function getStatsSeries(range?: StatsRange): Promise<StatsSeries> {
  const qs = range ? `?range=${range}` : "";
  return (await authedFetch(`/v1/stats/series${qs}`)).json() as Promise<StatsSeries>;
}

export interface ModelStats {
  model: string;
  conversations: number;
  tokens: number;
  cachePct: number | null;
  ppSpeed: number | null;
  tgSpeed: number | null;
  ttftP50: number | null;
  ttftP95: number | null;
  ttftP99: number | null;
}

export async function getModelStats(range?: StatsRange): Promise<ModelStats[]> {
  const qs = range ? `?range=${range}` : "";
  return (await authedFetch(`/v1/stats/models${qs}`)).json() as Promise<ModelStats[]>;
}

export interface ConversationStats {
  conversationId: string;
  title: string;
  kind: "chat" | "agent" | "routine";
  model: string;
  tokens: number;
  cachePct: number | null;
  avgTtftMs: number | null;
  lastUsedAt: string;
}

export async function getConversationStats(range?: StatsRange, limit?: number): Promise<ConversationStats[]> {
  const params = new URLSearchParams();
  if (range) params.set("range", range);
  if (limit) params.set("limit", String(limit));
  const qs = params.toString();
  return (await authedFetch(`/v1/stats/conversations${qs ? `?${qs}` : ""}`)).json() as Promise<ConversationStats[]>;
}

// ── Streaming protocol (shared by chat + agent WebSockets) ─
// The envelope is owned by @loxaic/types (the server emits it from the
// same definitions) and re-exported here so UI code has a single import.
export type {
  ServerMessage,
  ClientMessage,
  StreamEventKind,
  StreamSnapshot,
  StreamSnapshotMessage,
  StreamStatus,
  TurnUsage,
  ContextBreakdown,
  ContextCategory,
  ContextPart,
  PermissionMode,
  Todo,
  CheckinReason,
  StepsDecision,
  CompactionStats,
  CommandKind,
  CommandSurface,
  SlashCommand,
} from "@loxaic/types";
import type { ServerMessage, StepsDecision } from "@loxaic/types";
export {
  BUILT_IN_COMMANDS, findCommand, commandQuery, parseCommand,
  MAX_ATTACHMENTS, ATTACHMENT_MIMES, MAX_ATTACHMENT_BYTES, MAX_DOCUMENT_BYTES,
  IMAGE_MIMES, TEXT_MIMES, DOCUMENT_MIMES,
  attachmentClass, maxBytesForMime, resolveAttachmentMime, sanitizeFilename,
  CHECKIN_ANSWER_NUDGE,
} from "@loxaic/types";

/** True if the send was actually written to the socket — false (never
 * throws) if the connection isn't open, so callers can decide whether to
 * queue, drop, or surface that to the user. */
function trySend(ws: WebSocket, payload: unknown): boolean {
  if (ws.readyState !== ws.OPEN) return false;
  ws.send(JSON.stringify(payload));
  return true;
}

function createStreamSocket(path: string, token: string, onEvent: (event: ServerMessage) => void): WebSocket {
  const wsBase = BASE_URL.replace("http", "ws");
  const ws = new WebSocket(`${wsBase}${path}?token=${token}`);
  ws.onmessage = (msg) => {
    try {
      onEvent(JSON.parse(msg.data as string) as ServerMessage);
    } catch {
      // ignore
    }
  };
  return ws;
}

export function createChatSocket(token: string, onEvent: (event: ServerMessage) => void): WebSocket {
  return createStreamSocket("/ws/chat", token, onEvent);
}

export function createAgentSocket(token: string, onEvent: (event: ServerMessage) => void): WebSocket {
  return createStreamSocket("/ws/agent", token, onEvent);
}

// ── Sandbox terminal (`/ws/sandbox/:id`) ──────────────────
// Its own small protocol rather than the chat/agent envelope: this carries
// raw keystrokes and terminal bytes, which have nothing to do with runs.

/** Sent once, before anything else. `tty` is the one thing a client cannot
 * work out for itself: a container sandbox gets a real PTY (prompt, echo,
 * colour, a size worth resizing), a host or local-machine one is bash over
 * pipes and has none of that. Render accordingly rather than guessing. */
export interface TerminalReadyEvent {
  type: "terminal.ready";
  tty: boolean;
  /** Where the shell opened — the same directory the agent's own commands
   * land in, whichever provider this is. */
  workdir: string;
}
export interface TerminalOutputEvent {
  type: "terminal.output";
  data: string;
}
/** The shell ended. Distinct from the socket dropping, which is why it is
 * said before the close rather than left to be inferred from it. */
export interface TerminalExitEvent {
  type: "terminal.exit";
}
/** Why the terminal could not be opened, in words worth showing. Rides as a
 * message because a WebSocket close reason is capped at 123 bytes. */
export interface TerminalErrorEvent {
  type: "terminal.error";
  message: string;
}

export type TerminalServerEvent =
  | TerminalReadyEvent
  | TerminalOutputEvent
  | TerminalExitEvent
  | TerminalErrorEvent;

export function createSandboxTerminalSocket(
  sandboxId: string,
  token: string,
  onEvent: (event: TerminalServerEvent) => void,
): WebSocket {
  const wsBase = BASE_URL.replace("http", "ws");
  const ws = new WebSocket(`${wsBase}/ws/sandbox/${encodeURIComponent(sandboxId)}?token=${token}`);
  ws.onmessage = (msg) => {
    try {
      onEvent(JSON.parse(msg.data as string) as TerminalServerEvent);
    } catch {
      // ignore
    }
  };
  return ws;
}

/** Raw — no newline is added at either end. Enter is `\r` from a real
 * terminal and `\n` from a line input, and both mean what they say. */
export function sendTerminalInput(ws: WebSocket, data: string): boolean {
  return trySend(ws, { type: "terminal.input", data });
}

export function sendTerminalResize(ws: WebSocket, cols: number, rows: number): boolean {
  return trySend(ws, { type: "terminal.resize", cols, rows });
}

export function sendChatMessage(
  ws: WebSocket,
  content: string,
  model?: string,
  conversationId?: string,
  parentId?: string,
  attachments?: string[],
): boolean {
  return trySend(ws, {
    type: "chat.send",
    content,
    model: model ?? "default",
    conversation_id: conversationId,
    parent_id: parentId,
    attachments,
  });
}

export function sendAgentMessage(
  ws: WebSocket,
  content: string,
  mode: import("@loxaic/types").PermissionMode,
  convId?: string,
  parentId?: string,
  model?: string,
  attachments?: string[],
): boolean {
  return trySend(ws, {
    type: "agent.send",
    content,
    mode,
    conversation_id: convId,
    parent_id: parentId,
    model: model ?? "default",
    attachments,
  });
}

/** Run a built-in slash command (currently just "compact") against an
 * existing conversation. Surface is implied by which socket this rides on. */
export function sendCommand(
  ws: WebSocket,
  command: string,
  conversationId: string,
  model?: string,
  args?: string,
): boolean {
  return trySend(ws, {
    type: "command.run",
    command,
    conversation_id: conversationId,
    model: model ?? "default",
    args,
  });
}

/** cursors = last seq the client has already applied, keyed by stream_id. */
export function subscribeStreams(ws: WebSocket, conversationId: string, cursors?: Record<string, number>): boolean {
  return trySend(ws, { type: "stream.subscribe", conversation_id: conversationId, cursors });
}

export function stopStream(ws: WebSocket, streamId: string): boolean {
  return trySend(ws, { type: "stream.stop", stream_id: streamId });
}

export function setAgentMode(ws: WebSocket, mode: import("@loxaic/types").PermissionMode): boolean {
  return trySend(ws, { type: "agent.mode", mode });
}

export function approveTool(ws: WebSocket, callId: string): boolean {
  return trySend(ws, { type: "agent.approve", call_id: callId });
}

export function denyTool(ws: WebSocket, callId: string): boolean {
  return trySend(ws, { type: "agent.deny", call_id: callId });
}

/** Answers a `steps.checkin` — "keep going" or "answer with what you have".
 * Stopping is not a decision here: that stays `stopStream`, which works on any
 * run whether or not it is parked. */
export function sendStepsDecision(ws: WebSocket, streamId: string, decision: StepsDecision): boolean {
  return trySend(ws, { type: "agent.steps", stream_id: streamId, decision });
}