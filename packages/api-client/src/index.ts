let BASE_URL = "http://localhost:4000";
let AUTH_TOKEN: string | null = null;

/** Point the client at a different server (LAN IP, tailnet HTTPS URL, …). */
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

export interface ConfigResponse {
  sandbox: {
    mode: "container" | "host" | "off";
    available: boolean;
    reason?: string;
  };
}

export async function getConfig(): Promise<ConfigResponse> {
  const res = await fetch(`${BASE_URL}/v1/config`);
  if (!res.ok) throw new Error(`GET /v1/config ${String(res.status)}`);
  return res.json() as Promise<ConfigResponse>;
}

export type { ModelInfo, ModelPref } from "@shannon/types";

export async function getModels(): Promise<import("@shannon/types").ModelInfo[]> {
  return (await authedFetch("/v1/models")).json() as Promise<import("@shannon/types").ModelInfo[]>;
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
export interface Conversation {
  id: string;
  ownerId: string;
  title: string;
  kind: string;
  activeLeafId: string | null;
  modelPref: import("@shannon/types").ModelPref | null;
  mcpOverrides: { disabledServerIds?: string[] } | null;
  createdAt: string;
  updatedAt: string;
}

export async function getConversations(): Promise<Conversation[]> {
  const token = await getAuthToken();
  const res = await fetch(`${BASE_URL}/v1/conversations`, {
    headers: { Authorization: `Bearer ${String(token)}` },
  });
  if (!res.ok) throw new Error(`Conversations failed: ${String(res.status)}`);
  return res.json() as Promise<Conversation[]>;
}

export async function updateConversation(
  id: string,
  patch: {
    model_pref?: import("@shannon/types").ModelPref;
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
  cachedTokens: number;
  outputTokens: number;
  ttftMs: number | null;
  promptMs: number | null;
  predictMs: number | null;
  totalMs: number | null;
  promptTps: number | null;
  predictedTps: number | null;
  /** null for rows written before this column existed, and for any backend
   * that reported no usage — the UI must degrade rather than assume. */
  contextBreakdown: import("@shannon/types").ContextBreakdown | null;
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
  content: import("@shannon/types").ContentBlock[];
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
  if (!res.ok) throw new Error(`Messages failed: ${String(res.status)}`);
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
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} failed: ${String(res.status)}`);
  return res;
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
  cacheHitRate: number;
  requestCount: number;
  avgTtftMs: number | null;
  avgPromptTps: number | null;
  avgPredictedTps: number | null;
  avgTotalMs: number | null;
}

export interface UsageStatsSpark {
  totalTokens: number[];
  cacheHitRate: number[];
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
export interface CacheRatePoint { bucket: string; cacheHitRate: number }
export interface StatsSeries { range: StatsRange; points: StatsSeriesPoint[]; cachePoints: CacheRatePoint[] }

export async function getStatsSeries(range?: StatsRange): Promise<StatsSeries> {
  const qs = range ? `?range=${range}` : "";
  return (await authedFetch(`/v1/stats/series${qs}`)).json() as Promise<StatsSeries>;
}

export interface ModelStats {
  model: string;
  conversations: number;
  tokens: number;
  cachePct: number;
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
  cachePct: number;
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
// The envelope is owned by @shannon/types (the server emits it from the
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
} from "@shannon/types";
import type { ServerMessage } from "@shannon/types";
export { BUILT_IN_COMMANDS, findCommand, commandQuery, parseCommand } from "@shannon/types";

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
  incognito?: boolean,
): boolean {
  return trySend(ws, {
    type: "chat.send",
    content,
    model: model ?? "default",
    conversation_id: conversationId,
    parent_id: parentId,
    incognito,
  });
}

export function sendAgentMessage(
  ws: WebSocket,
  content: string,
  mode: import("@shannon/types").PermissionMode,
  convId?: string,
  parentId?: string,
  model?: string,
  incognito?: boolean,
): boolean {
  return trySend(ws, {
    type: "agent.send",
    content,
    mode,
    conversation_id: convId,
    parent_id: parentId,
    model: model ?? "default",
    incognito,
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

export function setAgentMode(ws: WebSocket, mode: import("@shannon/types").PermissionMode): boolean {
  return trySend(ws, { type: "agent.mode", mode });
}

export function approveTool(ws: WebSocket, callId: string): boolean {
  return trySend(ws, { type: "agent.approve", call_id: callId });
}

export function denyTool(ws: WebSocket, callId: string): boolean {
  return trySend(ws, { type: "agent.deny", call_id: callId });
}