export type ToolName =
  | "fs_read"
  | "fs_write"
  | "fs_edit"
  | "bash"
  | "grep"
  | "glob"
  | "web_fetch"
  | "browse"
  | "todo_write"
  | "propose_plan"
  | "ask_questions"
  | "subagent"
  | "skill";

export type PermissionMode = "planning" | "manual" | "auto";

/** Tools that mutate state. Planning mode never offers these to the model.
 * `bash` is not one of them: planning offers it for read-only commands only,
 * which the server enforces per command (apps/server/src/permissions/bash). */
export const WRITE_TOOLS: ToolName[] = ["fs_write", "fs_edit"];

/** The `bash` description planning mode offers instead of the usual one. */
export const PLANNING_BASH_DESCRIPTION =
  "Run a read-only shell command in the workspace: listing, reading and searching files, and git and gh reads " +
  "(git log, git diff, gh pr view, gh issue view). Anything that changes something is refused in planning mode.";

/** Every `browse` action, as the tool's schema and the server's switch agree.
 * Here rather than in the server because the schema the model sees and the set
 * planning mode narrows to must be one list — a drift between them would offer
 * an action the refusal logic does not know. */
export const BROWSE_ACTIONS = [
  "goto",
  "back",
  "forward",
  "reload",
  "text",
  "links",
  "screenshot",
  "click",
  "type",
  "press",
  "select",
  "hover",
  "scroll",
  "wait",
] as const;

export type BrowseAction = (typeof BROWSE_ACTIONS)[number];

/** The actions that change what the page does or holds. `scroll` and `wait`
 * move the view, not the page; `goto` is how a model leaves a page, which
 * planning mode needs in order to read anything. */
export const MUTATING_BROWSE_ACTIONS: readonly BrowseAction[] = ["click", "type", "press", "select", "hover"];

/** What planning mode offers: read the page, do not change it. Enforced in
 * apps/server/src/browser/actions.ts as well as by the schema and description
 * below — a description is presentation. */
export const READ_ONLY_BROWSE_ACTIONS: readonly BrowseAction[] = BROWSE_ACTIONS.filter(
  (a) => !MUTATING_BROWSE_ACTIONS.includes(a),
);

/** The `browse` description planning mode offers instead of the usual one. The
 * mutating actions are refused server-side too (apps/server/src/browser/actions.ts);
 * this is what stops the model trying them. */
export const PLANNING_BROWSE_DESCRIPTION =
  "Open and read a page in the conversation's own browser: navigate, read the rendered text, list its links, " +
  "take a screenshot. Clicking, typing and pressing keys are refused in planning mode.";

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
    description:
      "Fetch a public http(s) URL and return its text content. Fast, and it sees only what the server returns: " +
      "a page that renders with JavaScript will come back mostly empty. Pass render: true to load it in the " +
      "conversation's browser instead — slower, and it sees the page as a person would.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute http or https URL" },
        render: {
          type: "boolean",
          description: "Load the page in the browser and return the rendered text. Use when the plain fetch comes back empty or clearly unfinished.",
        },
      },
      required: ["url"],
    },
    requiresApproval: false,
  },
  {
    name: "browse",
    // The actions and the caps are named because a model that does not know a
    // screenshot comes back as an image it can see will keep asking for one in
    // text, and a model that does not know `wait` exists will read a page half
    // rendered and report what was there.
    description:
      "Drive the conversation's own headless browser: goto, back, forward, reload, text, links, screenshot, " +
      "click, type, press, select, hover, scroll, wait. One session per conversation, reused across calls, so you " +
      "can navigate and then act on what loaded; it has no history of any other conversation and nothing you do " +
      "here persists once the conversation ends or the session goes idle. `screenshot` returns an image you can " +
      "see and the person can view. Prefer `text` for reading and `screenshot` for layout; `wait` with a selector " +
      "before acting on content a page fetches after load.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [...BROWSE_ACTIONS],
        },
        url: { type: "string", description: "goto: the absolute http(s) URL to open" },
        selector: {
          type: "string",
          description: "CSS selector, for click / type / press / select / hover / wait. One matching element.",
        },
        text: { type: "string", description: "type: the text to enter. select: the option value." },
        key: { type: "string", description: "press: the key name, e.g. Enter, Escape, Tab, Control+a" },
        fullPage: { type: "boolean", description: "screenshot: capture the whole scrollable page, not just the viewport" },
        format: { type: "string", enum: ["png", "jpeg"], description: "screenshot: png (default) or jpeg (smaller, lossy)" },
        pixels: { type: "number", description: "scroll: how far, positive down (default 720)" },
        loadState: {
          type: "string",
          enum: ["load", "domcontentloaded", "networkidle"],
          description: "wait without a selector: which load state to wait for. networkidle is what a JavaScript-heavy page needs.",
        },
      },
      required: ["action"],
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

/** The wire name of `skillTool`. */
export const SKILL_TOOL_NAME = "skill";

/** A skill as the model is told of it: what the `skill` tool's description lists. */
export interface SkillListing {
  name: string;
  description: string;
}

/** A skill's name or description as the tool lists it, unable to close a
 * marker: a description is a person's or a repository's text, and this list
 * sits at the front of every request. Any closing tag is broken with a
 * zero-width space, which covers `</skill-content>` and `</skills-update>`
 * — what the server's own renderers neutralise — without this package
 * knowing their names. */
function inert(text: string): string {
  return text.split("</").join("</\u200b");
}

/**
 * How the model loads a skill (#283): specialised instructions for a kind of
 * task, in the Agent Skills format. The model sees each skill's name and
 * description here and loads a body only when a task calls for it.
 *
 * `skills` is the conversation's catalog **as frozen on its first run**
 * (apps/server/src/skills/session.ts): the tools array is the front of every
 * prompt, so a skill added or edited later is announced in a notice on the
 * next message instead of changing this description. `name` is therefore a
 * plain string rather than an enum of this list — a skill announced later
 * must still be loadable — and the server checks it against the live
 * catalog.
 *
 * Kept out of `TOOLS`, like the plan tools, so `isToolName` keeps it off the
 * "Allow always" list. It never asks: loading instructions changes nothing.
 */
export function skillTool(skills: readonly SkillListing[]): ToolDef {
  const list = skills.length
    ? skills.map((s) => `- ${inert(s.name)}: ${inert(s.description)}`).join("\n")
    : "(none yet)";
  return {
    name: SKILL_TOOL_NAME,
    description:
      "Load a skill: specialised instructions for a kind of task. When a task matches a skill's description, " +
      "call this with the skill's name before starting the task, then follow the instructions it returns. " +
      "Skills added or changed later in this conversation are announced in the messages.\n\n" +
      `Skills:\n${list}`,
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "The skill's name, exactly as listed" },
      },
      required: ["name"],
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

/** Builtins "Allow always" may put on the allowlist. Not `bash`: a grant for
 * the whole tool allowed every command forever, so its grants are command
 * rules instead (apps/server/src/permissions/bash/rules.ts). */
export function isAllowlistableTool(value: unknown): value is ToolName {
  return isToolName(value) && value !== "bash";
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
    /** Present to offer the `skill` tool, listing these skills (see
     * `skillTool`). Absent when the conversation has none. */
    skills?: readonly SkillListing[];
    /** Offer `browse`. Gated on the admin **setting**, not on whether an engine
     * answers right now: the tool list is part of every request's prompt prefix,
     * so a tool that appeared and disappeared with the engine's health would
     * break the cache on every blip. A conversation whose browsing is enabled
     * but whose engine is down gets a clear tool failure instead, and the
     * availability answer belongs to `/v1/config` and the admin view. */
    browsing?: boolean;
    /** Addresses this deployment has no browser for, used to decide nothing
     * about offering — kept out on purpose. See `browsing`. */
  },
): ResolvedTool[] {
  const defs = [
    ...TOOLS.filter((t) => t.name !== "browse" || opts?.browsing === true),
    ...(mode === "planning" && opts?.handover !== false ? [PLAN_TOOL, QUESTIONS_TOOL] : []),
    ...(opts?.subagents ? [subagentTool(opts.subagents.models ?? undefined)] : []),
    ...(opts?.skills ? [skillTool(opts.skills)] : []),
  ];
  return defs.map((t) => ({
    name: t.name,
    description:
      mode === "planning" && t.name === "bash"
        ? PLANNING_BASH_DESCRIPTION
        : mode === "planning" && t.name === "browse"
          ? PLANNING_BROWSE_DESCRIPTION
          : t.description,
    parameters:
      // Planning mode's `action` list is the read-only half, so the model is not
      // offered a choice it will only be refused. The refusal is enforced in
      // browser/actions.ts regardless; this is presentation.
      t.name === "browse" && mode === "planning"
        ? { ...t.parameters, properties: { ...t.parameters.properties, action: { type: "string", enum: [...READ_ONLY_BROWSE_ACTIONS] } } }
        : t.parameters,
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
