export type ToolName = "fs_read" | "fs_write" | "fs_edit" | "bash" | "grep" | "glob" | "web_fetch" | "todo_write";

export type PermissionMode = "planning" | "manual" | "auto";

export type ToolDef = {
  name: ToolName;
  description: string;
  parameters: Record<string, unknown>;
  requiresApproval: boolean; // true if manual/permission required
};

export const TOOLS: ToolDef[] = [
  { name: "fs_read", description: "Read a file from the filesystem", parameters: { path: { type: "string", required: true } }, requiresApproval: false },
  { name: "fs_write", description: "Write content to a file", parameters: { path: { type: "string", required: true }, content: { type: "string", required: true } }, requiresApproval: true },
  { name: "fs_edit", description: "Edit a file via search/replace", parameters: { path: { type: "string", required: true }, oldText: { type: "string", required: true }, newText: { type: "string", required: true } }, requiresApproval: true },
  { name: "bash", description: "Execute a shell command", parameters: { command: { type: "string", required: true } }, requiresApproval: true },
  { name: "grep", description: "Search file contents via regex", parameters: { pattern: { type: "string", required: true }, path: { type: "string" } }, requiresApproval: false },
  { name: "glob", description: "Find files matching a pattern", parameters: { pattern: { type: "string", required: true } }, requiresApproval: false },
  { name: "web_fetch", description: "Fetch content from a URL", parameters: { url: { type: "string", required: true } }, requiresApproval: false },
  { name: "todo_write", description: "Update the agent's todo list", parameters: { todos: { type: "array", required: true } }, requiresApproval: false },
];

export function toolRequiresApproval(tool: ToolName, mode: PermissionMode): boolean {
  if (mode === "auto") return false;
  if (mode === "planning") {
    return tool === "fs_write" || tool === "fs_edit" || tool === "bash";
  }
  const td = TOOLS.find((t) => t.name === tool);
  return td?.requiresApproval ?? true;
}

export type AgentEvent =
  | { type: "agent.tool_call"; call_id: string; tool: ToolName; args: Record<string, unknown> }
  | { type: "agent.tool_result"; call_id: string; output: string }
  | { type: "agent.approval_request"; call_id: string; tool: ToolName; args: Record<string, unknown> }
  | { type: "agent.delta"; text: string }
  | { type: "agent.thinking"; text: string }
  | { type: "agent.done"; text: string; usage?: { prompt_tokens: number; completion_tokens: number } };