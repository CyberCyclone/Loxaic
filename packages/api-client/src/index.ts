const BASE_URL = "http://localhost:4000";

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

export type ModelInfo = {
  id: string;
  name: string;
  context_window: number;
};

export async function getModels(): Promise<ModelInfo[]> {
  const res = await fetch(`${BASE_URL}/v1/models`);
  if (!res.ok) throw new Error(`GET /v1/models ${res.status}`);
  return res.json();
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
  const res = await fetch(`${BASE_URL}/api/auth/token`, {
    credentials: "include",
  });
  if (res.status === 401) return null;
  if (!res.ok) return null;
  const data = (await res.json()) as { token: string | null };
  return data.token;
}

// ── Conversations ─────────────────────────────────────────
export type Conversation = {
  id: string;
  ownerId: string;
  title: string;
  kind: string;
  activeLeafId: string | null;
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

// ── WebSocket Chat ────────────────────────────────────────
export type ChatClientEvent =
  | { type: "chat.delta"; message_id: string; conversation_id: string; delta: string }
  | { type: "chat.message_complete"; message_id: string; conversation_id: string; usage: unknown }
  | { type: "chat.conversation"; conversation_id: string; message_id: string }
  | { type: "chat.error"; error: string };

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
export type AgentEvent =
  | { type: "agent.delta"; text: string }
  | { type: "agent.done"; text: string; usage?: unknown }
  | { type: "agent.conversation"; conversation_id: string }
  | { type: "agent.error"; error: string }
  | { type: "agent.mode_changed"; mode: string }
  | { type: "agent.approval_request"; call_id: string; tool: string; args: unknown };

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

export function sendAgentMessage(ws: WebSocket, content: string, mode: string, convId?: string, parentId?: string) {
  ws.send(JSON.stringify({ type: "agent.send", content, mode, conversation_id: convId, parent_id: parentId }));
}

export function setAgentMode(ws: WebSocket, mode: string) {
  ws.send(JSON.stringify({ type: "agent.mode", mode }));
}

export function approveTool(ws: WebSocket, callId: string) {
  ws.send(JSON.stringify({ type: "agent.approve", call_id: callId }));
}

export function denyTool(ws: WebSocket, callId: string) {
  ws.send(JSON.stringify({ type: "agent.deny", call_id: callId }));
}