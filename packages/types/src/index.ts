export type Result<T, E = Error> =
  | { ok: true; data: T }
  | { ok: false; error: E };

export type Id = string;

export type Origin = "server" | "device";

export type ConversationKind = "chat" | "agent" | "routine";

export type PermissionMode = "planning" | "manual" | "auto";

export type MessageStatus = "streaming" | "complete" | "error" | "cancelled";

export type AuthorType = "user" | "assistant" | "system" | "tool" | "summary";

export type FileDiff = {
  path: string;
  oldContent: string | null;
  newContent: string | null;
};

export type ContentBlock =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool_call"; call_id: string; tool: string; args: unknown }
  | { kind: "tool_result"; call_id: string; output: string; diff?: FileDiff[] }
  | { kind: "attachment"; ref: string; mime: string };

export type ModelInfo = {
  id: string;
  display_name: string;
  quant: string;
  /** Weight format, e.g. "gguf" or "mlx" — "—" when the backend doesn't expose it. */
  format: string;
  context_tokens: number;
  location: "server" | "device" | "remote";
  price: number;
  loaded: boolean;
};

export type ModelPref = { model?: string };

export * from "./stream-protocol";

export type UsageRecord = {
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
  createdAt: string;
};
