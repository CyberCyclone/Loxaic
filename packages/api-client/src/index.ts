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

export type HealthResponse = {
  status: string;
  timestamp: string;
  services: {
    database: "ok" | "error";
    inference: "ok" | "error" | "unavailable";
  };
};

export async function getHealth(): Promise<HealthResponse> {
  const res = await fetch(`${BASE_URL}/health`);
  if (!res.ok) throw new Error(`GET /health ${res.status}`);
  return res.json();
}

export type { ModelInfo, ModelPref } from "@shannon/types";

export async function getModels(): Promise<import("@shannon/types").ModelInfo[]> {
  return (await authedFetch("/v1/models")).json();
}

// ── Auth ──────────────────────────────────────────────────
export type Session = {
  token: string;
  user: { id: string; email: string; name: string; emailVerified: boolean; image: string | null; createdAt: string; updatedAt: string };
  redirect?: boolean;
};

export async function signUp(email: string, password: string, name?: string): Promise<Session> {
  const res = await fetch(`${BASE_URL}/api/auth/sign-up`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ email, password, name }),
  });
  if (!res.ok) throw new Error(`Sign up failed: ${res.status}`);
  return res.json();
}

export async function signIn(email: string, password: string): Promise<Session> {
  const res = await fetch(`${BASE_URL}/api/auth/sign-in`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`Sign in failed: ${res.status}`);
  return res.json();
}

export async function getSession(): Promise<Session | null> {
  const res = await fetch(`${BASE_URL}/api/auth/session`, {
    credentials: "include",
  });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`Session fetch failed: ${res.status}`);
  return res.json();
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
export type Conversation = {
  id: string;
  ownerId: string;
  title: string;
  kind: string;
  activeLeafId: string | null;
  modelPref: import("@shannon/types").ModelPref | null;
  createdAt: string;
  updatedAt: string;
};

export async function getConversations(): Promise<Conversation[]> {
  const token = await getAuthToken();
  const res = await fetch(`${BASE_URL}/v1/conversations`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Conversations failed: ${res.status}`);
  return res.json();
}

export async function updateConversation(
  id: string,
  patch: { model_pref?: import("@shannon/types").ModelPref },
): Promise<Conversation> {
  return (
    await authedFetch(`/v1/conversations/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    })
  ).json();
}

export type ApiMessageUsage = {
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  ttftMs: number | null;
  promptMs: number | null;
  predictMs: number | null;
  totalMs: number | null;
  promptTps: number | null;
  predictedTps: number | null;
};

export type ApiMessage = {
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
};

export async function getMessages(
  conversationId: string,
): Promise<{ messages: ApiMessage[]; forks: unknown }> {
  const token = await getAuthToken();
  const res = await fetch(`${BASE_URL}/v1/conversations/${conversationId}/messages`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Messages failed: ${res.status}`);
  return res.json();
}

// ── Routines ──────────────────────────────────────────────
export type Routine = {
  id: string;
  ownerId: string;
  name: string;
  cron: string;
  prompt: string;
  target: unknown;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
};

export type RoutineRun = {
  id: string;
  routineId: string;
  conversationId: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
};

async function authedFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = await getAuthToken();
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} failed: ${res.status}`);
  return res;
}

export async function getRoutines(): Promise<Routine[]> {
  return (await authedFetch("/v1/routines")).json();
}

export async function createRoutine(input: { name: string; cron: string; prompt: string }): Promise<Routine> {
  return (
    await authedFetch("/v1/routines", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    })
  ).json();
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
  ).json();
}

export async function deleteRoutine(id: string): Promise<{ ok: true }> {
  return (await authedFetch(`/v1/routines/${id}`, { method: "DELETE" })).json();
}

export async function runRoutineNow(id: string): Promise<RoutineRun> {
  return (await authedFetch(`/v1/routines/${id}/run`, { method: "POST" })).json();
}

export async function getRoutineRuns(id: string): Promise<RoutineRun[]> {
  return (await authedFetch(`/v1/routines/${id}/runs`)).json();
}

// ── Stats ─────────────────────────────────────────────────
export type StatsRange = "session" | "today" | "week" | "month" | "year";

export type UsageStats = {
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
};

export async function getUsageStats(params?: {
  conversation_id?: string;
  model?: string;
  from?: string;
  to?: string;
}): Promise<UsageStats> {
  const qs = new URLSearchParams(params as Record<string, string>).toString();
  return (await authedFetch(`/v1/stats/usage${qs ? `?${qs}` : ""}`)).json();
}

export type StatsSeriesPoint = { bucket: string; values: Record<string, number> };
export type StatsSeries = { range: StatsRange; points: StatsSeriesPoint[] };

export async function getStatsSeries(range?: StatsRange): Promise<StatsSeries> {
  const qs = range ? `?range=${range}` : "";
  return (await authedFetch(`/v1/stats/series${qs}`)).json();
}

export type ModelStats = {
  model: string;
  conversations: number;
  tokens: number;
  cachePct: number;
  ppSpeed: number | null;
  tgSpeed: number | null;
  ttftP50: number | null;
  ttftP95: number | null;
  ttftP99: number | null;
};

export async function getModelStats(range?: StatsRange): Promise<ModelStats[]> {
  const qs = range ? `?range=${range}` : "";
  return (await authedFetch(`/v1/stats/models${qs}`)).json();
}

export type ConversationStats = {
  conversationId: string;
  title: string;
  model: string;
  tokens: number;
  cachePct: number;
  lastUsedAt: string;
};

export async function getConversationStats(range?: StatsRange, limit?: number): Promise<ConversationStats[]> {
  const params = new URLSearchParams();
  if (range) params.set("range", range);
  if (limit) params.set("limit", String(limit));
  const qs = params.toString();
  return (await authedFetch(`/v1/stats/conversations${qs ? `?${qs}` : ""}`)).json();
}

// ── WebSocket Chat ────────────────────────────────────────
export type ChatUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tps: number | null;
  gen_tps: number | null;
  total_ms: number;
};

export type ChatClientEvent =
  | { type: "chat.delta"; message_id: string; conversation_id: string; delta: string }
  | { type: "chat.thinking"; message_id: string; conversation_id: string; delta: string }
  | { type: "chat.message_complete"; message_id: string; conversation_id: string; usage: ChatUsage }
  | { type: "chat.conversation"; conversation_id: string; message_id: string }
  | { type: "chat.model_loading"; conversation_id: string; message_id: string }
  | { type: "chat.error"; error: string; conversation_id?: string; message_id?: string };

export function createChatSocket(
  token: string,
  onEvent: (event: ChatClientEvent) => void,
): WebSocket {
  const wsBase = BASE_URL.replace("http", "ws");
  const ws = new WebSocket(`${wsBase}/ws/chat?token=${token}`);

  ws.onmessage = (msg) => {
    try {
      const event = JSON.parse(msg.data) as ChatClientEvent;
      onEvent(event);
    } catch {
      // ignore
    }
  };

  return ws;
}

export function sendChatMessage(
  ws: WebSocket,
  content: string,
  model?: string,
  conversationId?: string,
  parentId?: string,
) {
  ws.send(JSON.stringify({
    type: "chat.send",
    content,
    model: model || "default",
    conversation_id: conversationId,
    parent_id: parentId,
  }));
}

// ── Agent WebSocket ───────────────────────────────────────
// The event union is owned by @shannon/agent (the server emits it from the
// same definition) and re-exported here so UI code has a single import.
export type { AgentEvent, PermissionMode, Todo, ToolName, FileDiff } from "@shannon/agent";
import type { AgentEvent, PermissionMode } from "@shannon/agent";

export function createAgentSocket(
  token: string,
  onEvent: (event: AgentEvent) => void,
): WebSocket {
  const wsBase = BASE_URL.replace("http", "ws");
  const ws = new WebSocket(`${wsBase}/ws/agent?token=${token}`);
  ws.onmessage = (msg) => {
    try { const event = JSON.parse(msg.data) as AgentEvent; onEvent(event); } catch { /* ignore */ }
  };
  return ws;
}

export function sendAgentMessage(
  ws: WebSocket,
  content: string,
  mode: PermissionMode,
  convId?: string,
  parentId?: string,
  model?: string,
) {
  ws.send(JSON.stringify({
    type: "agent.send",
    content,
    mode,
    conversation_id: convId,
    parent_id: parentId,
    model: model || "default",
  }));
}

export function setAgentMode(ws: WebSocket, mode: PermissionMode) {
  ws.send(JSON.stringify({ type: "agent.mode", mode }));
}

export function approveTool(ws: WebSocket, callId: string) {
  ws.send(JSON.stringify({ type: "agent.approve", call_id: callId }));
}

export function denyTool(ws: WebSocket, callId: string) {
  ws.send(JSON.stringify({ type: "agent.deny", call_id: callId }));
}