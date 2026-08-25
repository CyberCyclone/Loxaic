import type { FileDiff } from "./index";

/** Duplicated (structurally, not nominally) from @shannon/agent so this
 * package stays dependency-free — packages/agent is the authority for
 * agent-loop *logic* (toolRequiresApproval etc.), this is only the wire shape. */
export type PermissionMode = "planning" | "manual" | "auto";

export type Todo = { id?: string; text: string; status: "pending" | "in_progress" | "completed" };

export type TurnUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tps: number | null;
  gen_tps: number | null;
  total_ms: number;
};

export type StreamStatus = "active" | "complete" | "error" | "cancelled";

/**
 * Payload kinds appended to a stream's durable log. Chat and agent share one
 * envelope — the agent-only kinds (iteration, tool.*, approval.request,
 * todos) simply never appear on a chat stream. Every event that names a
 * message carries `message_id` (including tool calls/results — the client
 * used to have to infer this via a placeholder-promotion hack; it doesn't
 * need to anymore).
 */
export type StreamEventKind =
  | {
      kind: "message.start";
      message_id: string;
      author_type: "user" | "assistant" | "tool";
      parent_id: string | null;
      model?: string;
      /** User messages arrive already-complete and carry their full text here. */
      text?: string;
    }
  | { kind: "text.delta"; message_id: string; text: string }
  | { kind: "thinking.delta"; message_id: string; text: string }
  | {
      kind: "message.end";
      message_id: string;
      status: "complete" | "error" | "cancelled";
      usage?: TurnUsage;
      error?: string;
    }
  | { kind: "model.loading"; message_id: string }
  | { kind: "iteration"; n: number; max: number }
  | { kind: "tool.call"; message_id: string; call_id: string; tool: string; args: Record<string, unknown> }
  | { kind: "approval.request"; call_id: string; tool: string; args: Record<string, unknown> }
  | {
      kind: "tool.result";
      message_id: string;
      call_id: string;
      tool: string;
      output: string;
      ok: boolean;
      diff?: FileDiff[];
    }
  | { kind: "todos"; todos: Todo[] };

export type StreamSnapshotMessage = {
  message_id: string;
  author_type: "user" | "assistant" | "tool";
  parent_id: string | null;
  model?: string;
  text: string;
  thinking: string;
  tool_calls: {
    call_id: string;
    tool: string;
    args: Record<string, unknown>;
    output?: string;
    ok?: boolean;
    diff?: FileDiff[];
  }[];
  status: "streaming" | "complete" | "error" | "cancelled";
  usage?: TurnUsage;
  error?: string;
};

/** Everything-so-far, folded server-side from the durable log. The client
 * renders this instantly on subscribe, then applies live `stream.event`s
 * with `seq` greater than this snapshot's `seq`. */
export type StreamSnapshot = {
  messages: StreamSnapshotMessage[];
  // agent-only:
  iteration?: { n: number; max: number };
  todos?: Todo[];
  pending_approval?: { call_id: string; tool: string; args: Record<string, unknown> };
};

export type ServerMessage =
  | { type: "turn.started"; stream_id: string; conversation_id: string; user_message_id: string; incognito: boolean }
  | {
      type: "conv.streams";
      conversation_id: string;
      streams: { stream_id: string; status: StreamStatus; last_seq: number }[];
    }
  | {
      type: "stream.sync";
      stream_id: string;
      conversation_id: string;
      seq: number;
      status: StreamStatus;
      snapshot: StreamSnapshot;
    }
  | { type: "stream.event"; stream_id: string; conversation_id: string; seq: number; event: StreamEventKind }
  | {
      type: "stream.end";
      stream_id: string;
      conversation_id: string;
      seq: number;
      status: "complete" | "error" | "cancelled";
      usage?: TurnUsage;
      error?: string;
    }
  | { type: "agent.mode_changed"; mode: PermissionMode }
  | { type: "error"; error: string; conversation_id?: string; stream_id?: string };

export type ClientMessage =
  | {
      type: "chat.send";
      content: string;
      model?: string;
      conversation_id?: string;
      parent_id?: string;
      incognito?: boolean;
    }
  | {
      type: "agent.send";
      content: string;
      model?: string;
      mode?: PermissionMode;
      conversation_id?: string;
      parent_id?: string;
      incognito?: boolean;
    }
  /** cursors = last seq the client has already applied, per stream_id it knows about. */
  | { type: "stream.subscribe"; conversation_id: string; cursors?: Record<string, number> }
  | { type: "stream.stop"; stream_id: string }
  | { type: "agent.mode"; mode: PermissionMode }
  | { type: "agent.approve"; call_id: string }
  | { type: "agent.deny"; call_id: string };
