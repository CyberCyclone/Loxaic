export type ToolName = "fs_read" | "fs_write" | "fs_edit" | "bash" | "grep" | "glob" | "web_fetch" | "todo_write";

export type PermissionMode = "planning" | "manual" | "auto";

/** Tools that mutate state. Planning mode never offers these to the model. */
export const WRITE_TOOLS: ToolName[] = ["fs_write", "fs_edit", "bash"];

export type ToolDef = {
  name: ToolName;
  description: string;
  /** JSON Schema for the tool's arguments, as sent to the model. */
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  requiresApproval: boolean; // true if manual/permission required
};

export const TOOLS: ToolDef[] = [
  {
    name: "fs_read",
    description: "Read a UTF-8 text file. Relative paths resolve against the repo working directory.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "File path to read" } },
      required: ["path"],
    },
    requiresApproval: false,
  },
  {
    name: "fs_write",
    description: "Create or overwrite a file with the given content.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path to write" },
        content: { type: "string", description: "Full file content" },
      },
      required: ["path", "content"],
    },
    requiresApproval: true,
  },
  {
    name: "fs_edit",
    description: "Replace an exact snippet in a file. oldText must appear exactly once.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path to edit" },
        oldText: { type: "string", description: "Exact text to replace; must be unique in the file" },
        newText: { type: "string", description: "Replacement text" },
      },
      required: ["path", "oldText", "newText"],
    },
    requiresApproval: true,
  },
  {
    name: "bash",
    description: "Run a shell command in the sandbox and return its output and exit code.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Command line to execute with bash -c" },
      },
      required: ["command"],
    },
    requiresApproval: true,
  },
  {
    name: "grep",
    description: "Search file contents with a regular expression (ripgrep).",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regular expression to search for" },
        path: { type: "string", description: "Directory or file to search; defaults to the repo root" },
      },
      required: ["pattern"],
    },
    requiresApproval: false,
  },
  {
    name: "glob",
    description: "List files matching a glob pattern, e.g. src/**/*.ts",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern to match" },
        path: { type: "string", description: "Directory to search from; defaults to the repo root" },
      },
      required: ["pattern"],
    },
    requiresApproval: false,
  },
  {
    name: "web_fetch",
    description: "Fetch a public http(s) URL and return its text content.",
    parameters: {
      type: "object",
      properties: { url: { type: "string", description: "Absolute http or https URL" } },
      required: ["url"],
    },
    requiresApproval: false,
  },
  {
    name: "todo_write",
    description: "Replace the agent's visible todo list. Use it to plan and track multi-step work.",
    parameters: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          description: "The full todo list, in order",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              text: { type: "string" },
              status: { type: "string", enum: ["pending", "in_progress", "completed"] },
            },
            required: ["text", "status"],
          },
        },
      },
      required: ["todos"],
    },
    requiresApproval: false,
  },
];

export function toolRequiresApproval(tool: ToolName, mode: PermissionMode): boolean {
  if (mode === "auto") return false;
  if (mode === "planning") {
    return WRITE_TOOLS.includes(tool);
  }
  const td = TOOLS.find((t) => t.name === tool);
  return td?.requiresApproval ?? true;
}

export type OpenAiTool = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

/** Convert TOOLS to the OpenAI `tools` array, optionally omitting some. */
export function toOpenAiTools(exclude: ToolName[] = []): OpenAiTool[] {
  return TOOLS.filter((t) => !exclude.includes(t.name)).map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: { ...t.parameters, additionalProperties: false },
    },
  }));
}

export function isToolName(value: unknown): value is ToolName {
  return typeof value === "string" && TOOLS.some((t) => t.name === value);
}

export type Todo = { id?: string; text: string; status: "pending" | "in_progress" | "completed" };

export type FileDiff = { path: string; oldContent: string | null; newContent: string | null };

/**
 * Every event the agent WebSocket can emit. `conversation_id` is on all of
 * them so a client multiplexing several runs never has to infer it.
 */
export type AgentEvent =
  | { type: "agent.conversation"; conversation_id: string; message_id: string }
  | { type: "agent.model_loading"; conversation_id: string; message_id: string }
  | { type: "agent.delta"; conversation_id: string; message_id: string; text: string }
  | { type: "agent.thinking"; conversation_id: string; message_id: string; text: string }
  | { type: "agent.iteration"; conversation_id: string; iteration: number; max: number }
  | { type: "agent.tool_call"; conversation_id: string; call_id: string; tool: ToolName; args: Record<string, unknown> }
  | { type: "agent.approval_request"; conversation_id: string; call_id: string; tool: ToolName; args: Record<string, unknown> }
  | { type: "agent.tool_result"; conversation_id: string; call_id: string; tool: ToolName; output: string; ok: boolean; diff?: FileDiff[] }
  | { type: "agent.todos"; conversation_id: string; todos: Todo[] }
  | { type: "agent.mode_changed"; mode: PermissionMode }
  | { type: "agent.done"; conversation_id: string; message_id: string; text: string; usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number; prompt_tps: number | null; gen_tps: number | null; total_ms: number } }
  | { type: "agent.error"; conversation_id?: string; error: string };
