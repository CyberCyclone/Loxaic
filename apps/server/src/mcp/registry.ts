import type { OpenAiTool, PermissionMode, ResolvedTool } from "@shannon/agent";
import { resolveBuiltinTools, resolvedToOpenAiTool } from "@shannon/agent";

/** The tools available to one agent run: what the model is offered, plus the
 * lookup and approval policy for every name the model may come back with.
 * Built once per run — MCP servers connect (or fail) here, not mid-loop. */
export type Toolset = {
  /** What goes into the completion request's `tools` array. */
  openAiTools: OpenAiTool[];
  /** Resolve a model-returned tool name; undefined means unknown tool. */
  get(name: string): ResolvedTool | undefined;
  requiresApproval(tool: ResolvedTool, mode: PermissionMode): boolean;
  /** Appended to the system prompt when untrusted (MCP) tools are offered. */
  systemPromptAddendum: string | null;
};

export async function buildToolset(
  userId: string,
  opts: { mode: PermissionMode; disabledServerIds?: string[] },
): Promise<Toolset> {
  void userId;
  const resolved = resolveBuiltinTools();
  // Planning mode hides write tools from the model but keeps them resolvable,
  // so a hallucinated write-tool call still takes the approval path rather
  // than the unknown-tool path — matching toolRequiresApproval's behavior.
  const offered = opts.mode === "planning" ? resolved.filter((t) => !t.isWrite) : resolved;
  const byName = new Map(resolved.map((t) => [t.name, t] as const));

  return {
    openAiTools: offered.map(resolvedToOpenAiTool),
    get: (name) => byName.get(name),
    requiresApproval: toolsetRequiresApproval,
    systemPromptAddendum: null,
  };
}

function toolsetRequiresApproval(tool: ResolvedTool, mode: PermissionMode): boolean {
  if (mode === "auto") return false;
  if (mode === "planning") return tool.isWrite;
  return tool.requiresApproval;
}
