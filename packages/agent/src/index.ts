export type ToolName =
  | "fs_read"
  | "fs_write"
  | "fs_edit"
  | "bash"
  | "grep"
  | "glob"
  | "web_fetch"
  | "todo_write"
  | "propose_plan"
  | "ask_questions"
  | "subagent";

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
    // The rules, not just the purpose: with only "plan and track multi-step
    // work", a model wrote the list once and did four more items without
    // touching it, while the person watching read item 1 as still in progress.
    description:
      "Replace the visible todo list with the full list, in order. Use it for work with several steps. " +
      "Keep it current as you go, because the person watching reads it to see where you are: mark an item " +
      "in_progress just before you start it and completed as soon as it is done, one call at a time rather " +
      "than all at the end; keep exactly one item in_progress while you work; add items you discover and drop " +
      "ones that no longer apply.",
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

/** The wire name of `PLAN_TOOL`. The client matches it to render a plan
 * rather than a tool card (its own copy lives in apps/mobile/lib/plan.ts). */
export const PLAN_TOOL_NAME = "propose_plan";

/**
 * How planning mode hands its plan to the user (#199). Offered in planning
 * mode only, and a successful call **ends the turn**: what happens next is the
 * user's decision — accept, suggest changes, or reject — and it arrives as
 * their next message.
 *
 * A tool rather than "the last message of a planning run" so the plan has an
 * exact boundary (not whatever prose the model wrapped around it), its own
 * call id, and survives a reload exactly as written. Kept out of `TOOLS`, so no
 * other mode or surface can be offered it and `isToolName` keeps it off the
 * "Allow always" list — see `resolveBuiltinTools`.
 */
export const PLAN_TOOL: ToolDef = {
  name: PLAN_TOOL_NAME,
  description:
    "Submit your finished plan to the user for review. Pass the complete plan as Markdown; it is shown to the " +
    "user as written, in a panel where they accept it, suggest changes, or reject it. Your turn ends when you " +
    "call this, so call it last, once the plan is ready.",
  parameters: {
    type: "object",
    properties: {
      plan: { type: "string", description: "The complete plan, in Markdown" },
    },
    required: ["plan"],
  },
  requiresApproval: false,
};

/** The wire name of `QUESTIONS_TOOL` (the client's copy is in
 * apps/mobile/lib/plan.ts). */
export const QUESTIONS_TOOL_NAME = "ask_questions";

/** Bounds on an `ask_questions` call, enforced by the executor before anything
 * reaches the user — the panel shows one question per step, so a model asking
 * twenty would be twenty steps. */
export const QUESTION_LIMITS = { maxQuestions: 4, minOptions: 2, maxOptions: 4, maxText: 300 } as const;

/**
 * The other way planning mode can end its turn (#199): questions whose answers
 * would change the plan, shown one at a time with options to pick and room to
 * write another answer. Planning mode only, like `PLAN_TOOL`, and it ends the
 * turn the same way — the answers arrive as the user's next message.
 */
export const QUESTIONS_TOOL: ToolDef = {
  name: QUESTIONS_TOOL_NAME,
  description:
    "Ask the user questions whose answers would change your plan, instead of guessing. Each question offers " +
    "2-4 short options; the user picks one (or several, with multiSelect) or writes their own answer. Ask at " +
    "most 4 questions. Your turn ends when you call this; the answers arrive as the user's next message.",
  parameters: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        description: "1-4 questions, in the order to ask them",
        items: {
          type: "object",
          properties: {
            question: { type: "string", description: "The question, as a full sentence" },
            header: { type: "string", description: "A 1-3 word label for the question" },
            options: {
              type: "array",
              description: "2-4 answers to choose from",
              items: {
                type: "object",
                properties: {
                  label: { type: "string", description: "The answer, in a few words" },
                  description: { type: "string", description: "What choosing it means" },
                },
                required: ["label"],
              },
            },
            multiSelect: { type: "boolean", description: "True if more than one option may be chosen" },
          },
          required: ["question", "options"],
        },
      },
    },
    required: ["questions"],
  },
  requiresApproval: false,
};

/** The wire name of the sub-agent tool (the shared copy clients match on is
 * `SUBAGENT_TOOL_NAME` in packages/types). */
export const SUBAGENT_TOOL_NAME = "subagent";

/**
 * The tool a run spawns a sub-agent with: a child agent run with its own
 * conversation and context window, working in the same workspace under the
 * same permission mode, whose final reply comes back as this call's result
 * (apps/server/src/streams/runs/subagentRun.ts).
 *
 * Kept out of `TOOLS`, like the plan tools, so it is offered only where the
 * toolset asks for it — the agent surface and routines, never plain chat, and
 * never to a sub-agent itself — and `isToolName` keeps it off the "Allow
 * always" list. It never asks for approval and is not a write tool: starting a
 * child changes nothing, and everything the child then does asks (or not) by
 * the parent's own mode.
 *
 * `models` is what the `model` argument may name, when the user lets the
 * parent choose and there is more than one to choose from; absent, the tool
 * has no such argument and a child runs on the model the server picks. A
 * function rather than a constant because that list is per conversation.
 */
export function subagentTool(models?: readonly string[]): ToolDef {
  const choice = models && models.length > 1 ? models : null;
  return {
    name: SUBAGENT_TOOL_NAME,
    description:
      "Hand a self-contained task to a sub-agent: a separate agent with its own context window, working in the " +
      "same workspace with the same tools and permissions as you, which reports back once. Use it for work that " +
      "would otherwise fill your own context — searching a large codebase, investigating one question in depth — " +
      "and to run independent tasks side by side: several calls in one message run together (at most 4). " +
      "The sub-agent sees nothing of this conversation, so `prompt` must carry everything it needs: the goal, " +
      "what you already know, and exactly what to report back. Its final reply is returned to you as this call's " +
      "result; the user does not see that reply unless you tell them. Sub-agents running together share the " +
      "workspace, so give them work that does not overlap.",
    parameters: {
      type: "object",
      properties: {
        description: { type: "string", description: "The task in 3-7 words, shown to the user while it runs" },
        prompt: { type: "string", description: "The complete task for the sub-agent, with all the context it needs" },
        ...(choice
          ? {
              model: {
                type: "string",
                enum: [...choice],
                description: "The model to run it on. Omit to use the model you are running on.",
              },
            }
          : {}),
      },
      required: ["description", "prompt"],
    },
    requiresApproval: false,
  };
}

/** The tools that hand the turn to the user: a successful call to either ends
 * the turn with no further model request. */
export const HANDOVER_TOOL_NAMES: ReadonlySet<string> = new Set([PLAN_TOOL_NAME, QUESTIONS_TOOL_NAME]);

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

/** Every builtin a run in `mode` may be offered — `PLAN_TOOL` and
 * `QUESTIONS_TOOL` in planning mode only. Write tools are still included here; hiding them from a planning run
 * is the toolset's job, since it has MCP tools to judge the same way. */
export function resolveBuiltinTools(
  mode?: PermissionMode,
  opts?: {
    /** False for a run that has nobody to hand a plan or questions to — a
     * sub-agent, whose only reader is the run that spawned it. */
    handover?: boolean;
    /** Present to offer the sub-agent tool; `models` is what its `model`
     * argument may name (see `subagentTool`). */
    subagents?: { models?: readonly string[] | null };
  },
): ResolvedTool[] {
  const defs = [
    ...TOOLS,
    ...(mode === "planning" && opts?.handover !== false ? [PLAN_TOOL, QUESTIONS_TOOL] : []),
    ...(opts?.subagents ? [subagentTool(opts.subagents.models ?? undefined)] : []),
  ];
  return defs.map((t) => ({
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
