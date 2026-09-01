export type ToolName = "fs_read" | "fs_write" | "fs_edit" | "bash" | "grep" | "glob" | "web_fetch" | "todo_write";

export type PermissionMode = "planning" | "manual" | "auto";

/** Tools that mutate state. Planning mode never offers these to the model. */
export const WRITE_TOOLS: ToolName[] = ["fs_write", "fs_edit", "bash"];

export interface ToolDef {
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
}

export const TOOLS: ToolDef[] = [
  {
    name: "fs_read",
    description:
      "Read a UTF-8 text file. Relative paths resolve against the repo working directory. " +
      "For a large file, pass offset/limit to page through it rather than reading it all at " +
      "once — the response says how many lines the file has and, if there's more, what offset " +
      "to pass next.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path to read" },
        offset: { type: "integer", description: "1-indexed line number to start from (default 1)" },
        limit: { type: "integer", description: "Maximum number of lines to return (default 2000)" },
      },
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
    description: "Run a shell command in the workspace and return its output and exit code.",
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

export interface OpenAiTool {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

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

/** Where a resolved tool comes from. MCP tools carry enough provenance to
 * dispatch back to their server and to attribute them in the UI. */
export type ToolSource =
  | { kind: "builtin" }
  | {
      kind: "mcp";
      serverId: string;
      serverSlug: string;
      serverName: string;
      /** The tool's un-namespaced name on the MCP server. */
      remoteName: string;
      /** User-asserted (never taken from server annotations). Gates planning mode. */
      readOnly: boolean;
    };

/** A tool as offered to the model for one run — builtin or dynamically
 * discovered. `name` is the wire name (namespaced for MCP tools). */
export interface ResolvedTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Manual-mode default; MCP tools override this via user policy. */
  requiresApproval: boolean;
  /** Planning mode never offers write tools. */
  isWrite: boolean;
  source: ToolSource;
}

export function resolveBuiltinTools(): ResolvedTool[] {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
    requiresApproval: t.requiresApproval,
    isWrite: WRITE_TOOLS.includes(t.name),
    source: { kind: "builtin" },
  }));
}

/** Builtin schemas are closed exactly as toOpenAiTools does; MCP schemas pass
 * through untouched — forcing additionalProperties:false onto an arbitrary
 * server-supplied schema would break tools that accept open maps. */
export function resolvedToOpenAiTool(t: ResolvedTool): OpenAiTool {
  return {
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters:
        t.source.kind === "builtin" ? { ...t.parameters, additionalProperties: false } : t.parameters,
    },
  };
}

export interface Todo { id?: string; text: string; status: "pending" | "in_progress" | "completed" }

export interface FileDiff { path: string; oldContent: string | null; newContent: string | null }
