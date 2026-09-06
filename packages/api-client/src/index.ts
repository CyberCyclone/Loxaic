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

export interface ConfigResponse {
  sandbox: {
    mode: SandboxMode;
    available: boolean;
    /** Whether sandboxes can reach the network. Always true in host mode. */
    allowNetwork: boolean;
    reason?: string;
  };
}

export async function getConfig(): Promise<ConfigResponse> {
  const res = await fetch(`${BASE_URL}/v1/config`);
  if (!res.ok) throw new Error(`GET /v1/config ${String(res.status)}`);
  return res.json() as Promise<ConfigResponse>;
}

// ── Admin: server-level sandbox settings ──────────────────

export interface EngineProbe {
  id: "docker" | "podman";
  available: boolean;
  socketPath?: string;
  detectedAs?: "docker" | "podman";
}

export interface SandboxSettings {
  mode: SandboxMode;
  engine: SandboxEngine;
  customSocket: string | null;
  allowNetwork: boolean;
  /** Fields pinned by an environment variable — render read-only; PATCHing
   * one returns 409. */
  envOverrides: { mode: boolean; socket: boolean; allowNetwork: boolean };
  available: boolean;
  reason?: string;
  /** Which engines are installed/running, for greying out the picker. Empty
   * outside container mode. */
  engines: EngineProbe[];
}

export type SandboxSettingsPatch = Partial<
  Pick<SandboxSettings, "mode" | "engine" | "customSocket" | "allowNetwork">
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

export async function getConversations(): Promise<Conversation[]> {
  const token = await getAuthToken();
  const res = await fetch(`${BASE_URL}/v1/conversations`, {
    headers: { Authorization: `Bearer ${String(token)}` },
  });
  if (!res.ok) throw new ApiError(`Conversations failed: ${String(res.status)}`, res.status);
  return res.json() as Promise<Conversation[]>;
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
  if (!res.ok) throw new ApiError(`${init?.method ?? "GET"} ${path} failed: ${String(res.status)}`, res.status);
  return res;
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
  secretKeys: { env: string; label: string }[];
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
  /** Tool round-trips the agent may take for one message before stopping and
   * handing back. 1-50; defaults to 20. Optional — see `autoCompact`. */
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
  CompactionStats,
  CommandKind,
  CommandSurface,
  SlashCommand,
} from "@loxaic/types";
import type { ServerMessage } from "@loxaic/types";
export {
  BUILT_IN_COMMANDS, findCommand, commandQuery, parseCommand,
  MAX_ATTACHMENTS, ATTACHMENT_MIMES, MAX_ATTACHMENT_BYTES, MAX_DOCUMENT_BYTES,
  IMAGE_MIMES, TEXT_MIMES, DOCUMENT_MIMES,
  attachmentClass, maxBytesForMime, resolveAttachmentMime, sanitizeFilename,
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