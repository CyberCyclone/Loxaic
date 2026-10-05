import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";
import type { OpenAiTool, PermissionMode, ResolvedTool } from "@loxaic/agent";
import { isToolName, resolveBuiltinTools, resolvedToOpenAiTool } from "@loxaic/agent";
import { and, db, eq, sql } from "@loxaic/db";
import { conversations, mcpServers, userPrefs } from "@loxaic/db/schema";
import { mcpServerActive, normalizeMcpOverrides, type McpConversationKind, type McpOverrides } from "@loxaic/types";
import { catalogDefaultPolicy, GITHUB_BUILTIN_KEY } from "./catalog.ts";
import { DEFAULT_POLICY, reconcileTools, type ToolPolicy } from "./change-detection.ts";
import { callServerTool, listServerTools, redactionsFor, type McpServerRow } from "./client-manager.ts";
import { namespaceTool } from "./naming.ts";
import {
  compactSchemaForModel,
  extractResultText,
  GITHUB_TOOLS_ADDENDUM,
  MCP_SYSTEM_ADDENDUM,
  wrapResult,
} from "./sanitize.ts";
import { redact } from "./secrets.ts";

/** The tools available to one agent run: what the model is offered, plus the
 * lookup, approval policy, and dispatch for every name the model may come
 * back with. Built once per run — MCP servers connect (or fail) here, not
 * mid-loop, and a dead server only costs its own tools. */
export interface Toolset {
  /** What goes into the completion request's `tools` array. */
  openAiTools: OpenAiTool[];
  /** Resolve a model-returned tool name; undefined means unknown tool. */
  get(name: string): ResolvedTool | undefined;
  requiresApproval(tool: ResolvedTool, mode: PermissionMode): boolean;
  /** Appended to the system prompt when untrusted (MCP) tools are offered. */
  systemPromptAddendum: string | null;
  /** Execute an MCP-sourced tool. Never rejects — failures become ok:false. */
  dispatchMcp(tool: ResolvedTool, args: Record<string, unknown>): Promise<{ ok: boolean; output: string }>;
  /**
   * "Allow always" (#266): this tool stops asking, in this run and every
   * later one. Never rejects. The caller has established that the toolset's
   * own user asked for it — see `runOneToolCall` in the engine.
   */
  grantTrust(tool: ResolvedTool): Promise<void>;
}

// MCP servers ship arbitrary JSON Schema; strict mode would reject harmless
// idioms and formats aren't worth a dependency. An uncompilable schema drops
// the tool — it never silently skips validation. The 2020-12 build matches
// the MCP spec's dialect (draft-07 keywords still compile under it).
const ajv = new Ajv2020({ strict: false, validateFormats: false, allErrors: false });

/** Compile a server-declared input schema into a validator. The $schema
 * pointer is stripped first — servers commonly stamp a meta-schema URL
 * (Brave does), and ajv would otherwise try to resolve it as a ref. */
export function compileValidator(schema: Record<string, unknown>): ValidateFunction {
  const { $schema: _meta, ...compilable } = schema;
  return ajv.compile(compilable);
}

interface McpToolEntry {
  row: McpServerRow;
  remoteName: string;
  validate: ValidateFunction | null;
}

export async function buildToolset(
  userId: string,
  opts: {
    mode: PermissionMode;
    conversationId?: string;
    /** Which kind of conversation's MCP defaults apply when there is no
     * conversation row to read one from. A conversation's own `kind` wins. */
    surface?: McpConversationKind;
    /** The user's builtin allowlist, when the caller has already loaded the
     * prefs row. Optional so this stays usable on its own; the tool loop
     * passes it because it reads the same row one line earlier for the
     * iteration ceiling, and two statements against the same key back to back
     * is just waste. */
    allowlist?: ReadonlySet<string>;
    /** Offer the sub-agent tool. Only the agent surface and routines ask for
     * it; a sub-agent's own toolset never does, which is what keeps them one
     * level deep. `models` is what its `model` argument may name. */
    subagents?: { models?: readonly string[] | null };
    /** False to leave out the plan and questions tools in planning mode — a
     * sub-agent has no user to hand either to. */
    handover?: boolean;
  },
): Promise<Toolset> {
  const allowlist = opts.allowlist ?? (await builtinAllowlist(userId));
  const resolved = resolveBuiltinTools(opts.mode, { handover: opts.handover, subagents: opts.subagents }).map((t) =>
    allowlist.has(t.name) ? { ...t, requiresApproval: false } : t,
  );
  const mcpEntries = new Map<string, McpToolEntry>();

  for (const { tool, entry } of await resolveMcpTools(userId, opts)) {
    resolved.push(tool);
    mcpEntries.set(tool.name, entry);
  }

  // Planning mode hides write tools from the model but keeps builtins
  // resolvable, so a hallucinated write-tool call still takes the approval
  // path rather than the unknown-tool path — matching the old
  // toolRequiresApproval behavior. MCP tools are planning-visible only when
  // the USER marked them read-only (server annotations are never trusted).
  const offered = opts.mode === "planning" ? resolved.filter((t) => !t.isWrite) : resolved;
  const byName = new Map(
    (opts.mode === "planning" ? resolved.filter((t) => t.source.kind === "builtin" || !t.isWrite) : resolved).map(
      (t) => [t.name, t] as const,
    ),
  );
  const hasMcp = mcpEntries.size > 0;
  // Offered tools, not merely an enabled row: planning mode hides the write
  // ones, and a server that failed to connect contributes none at all.
  const hasGithub = offered.some(
    (t) => t.source.kind === "mcp" && t.source.serverSlug === GITHUB_BUILTIN_KEY,
  );
  const addendum = [hasMcp ? MCP_SYSTEM_ADDENDUM : null, hasGithub ? GITHUB_TOOLS_ADDENDUM : null]
    .filter((line): line is string => line !== null)
    .join(" ");

  return {
    openAiTools: offered.map(resolvedToOpenAiTool),
    get: (name) => byName.get(name),
    requiresApproval: toolsetRequiresApproval,
    systemPromptAddendum: addendum === "" ? null : addendum,
    dispatchMcp: (tool, args) => dispatchMcpTool(userId, tool, args, mcpEntries),
    grantTrust: (tool) => grantTrust(userId, tool, mcpEntries),
  };
}

function toolsetRequiresApproval(tool: ResolvedTool, mode: PermissionMode): boolean {
  if (tool.source.kind === "mcp") {
    // MCP tools ask in every mode, auto included, until the user allows the
    // tool: the MCP tools sheet, or "Allow always" on an approval. The grant
    // is for the exact tool: `reconcileTools` revokes it when the tool's
    // description or schema changes.
    return tool.requiresApproval;
  }
  if (mode === "auto") return false;
  if (mode === "planning") return tool.isWrite;
  return tool.requiresApproval;
}

/**
 * Records "Allow always" for one tool (#266), in the store that already
 * decides whether it asks: an MCP tool's own policy on its server row (what
 * the MCP tools sheet edits), a builtin's entry in the user's allowlist.
 *
 * The tool object is this run's own, so flipping it stops this run asking
 * too. Without that the grant only helped the *next* run, and a run that
 * writes five files asked four more times after "Allow always".
 *
 * Each write is one statement that changes one tool's entry in place. A read
 * followed by a write of the whole map would put back whatever another
 * device or run had changed in between.
 *
 * Never throws: the call was approved either way, and a grant that could not
 * be saved only means the tool asks again next run.
 */
async function grantTrust(userId: string, tool: ResolvedTool, entries: Map<string, McpToolEntry>): Promise<void> {
  tool.requiresApproval = false;
  try {
    if (tool.source.kind === "mcp") {
      const entry = entries.get(tool.name);
      if (!entry) return;
      // `changed: false` because allowing the tool again is what acknowledges
      // a change (as a save in the tools sheet does); `grantedFrom` lets that
      // sheet say where an allow it did not make came from.
      const patch = JSON.stringify({ approval: "allow", changed: false, grantedFrom: "prompt" });
      await db
        .update(mcpServers)
        .set({
          toolPolicies: sql`jsonb_set(
            COALESCE(${mcpServers.toolPolicies}, '{}'::jsonb),
            ARRAY[${entry.remoteName}]::text[],
            COALESCE(${mcpServers.toolPolicies} -> ${entry.remoteName}, ${JSON.stringify(DEFAULT_POLICY)}::jsonb) || ${patch}::jsonb
          )`,
        })
        .where(and(eq(mcpServers.id, entry.row.id), eq(mcpServers.ownerId, userId)));
      return;
    }
    // The planning hand-over tools are builtins too, and are not ones a
    // person can put on the list (`PATCH /v1/prefs` refuses them as well).
    if (!isToolName(tool.name)) return;
    const name = JSON.stringify(tool.name);
    await db
      .insert(userPrefs)
      .values({ userId, toolAllowlist: [tool.name] })
      .onConflictDoUpdate({
        target: userPrefs.userId,
        set: {
          toolAllowlist: sql`CASE
            WHEN jsonb_typeof(${userPrefs.toolAllowlist}) <> 'array' THEN jsonb_build_array(${name}::jsonb)
            WHEN ${userPrefs.toolAllowlist} @> ${name}::jsonb THEN ${userPrefs.toolAllowlist}
            ELSE ${userPrefs.toolAllowlist} || ${name}::jsonb
          END`,
        },
      });
  } catch (err) {
    console.warn(`could not save "allow always" for ${tool.name}: ${(err as Error).message}`);
  }
}

async function resolveMcpTools(
  userId: string,
  opts: { mode: PermissionMode; conversationId?: string; surface?: McpConversationKind },
): Promise<{ tool: ResolvedTool; entry: McpToolEntry }[]> {
  let rows: McpServerRow[];
  try {
    rows = await db
      .select()
      .from(mcpServers)
      .where(and(eq(mcpServers.ownerId, userId), eq(mcpServers.enabled, true)));
  } catch (err) {
    console.warn(`MCP server query failed; running with builtins only: ${(err as Error).message}`);
    return [];
  }
  if (rows.length === 0) return [];

  // The conversation's own choices, then the server's default for its kind —
  // the one rule the client's switches render (`mcpServerActive`).
  const state = await conversationMcpState(opts.conversationId, opts.surface ?? "chat");
  if (!state) {
    console.warn("Conversation MCP choices could not be read; running with builtins only");
    return [];
  }
  const { kind, overrides } = state;
  const activeRows = rows.filter((r) => mcpServerActive(r, kind, overrides));
  if (activeRows.length === 0) return [];

  const out: { tool: ResolvedTool; entry: McpToolEntry }[] = [];
  // One dead or slow server must not block the run — connect all in parallel
  // and simply run without the failures' tools.
  const settled = await Promise.allSettled(
    activeRows.map(async (row) => ({ row, tools: await listServerTools(userId, row) })),
  );

  for (let i = 0; i < settled.length; i++) {
    const result = settled[i];
    if (result.status === "rejected") {
      const row = activeRows[i];
      const redactions = await redactionsFor(row);
      console.warn(
        `MCP server "${row.name}" unavailable this run: ${redact(result.reason instanceof Error ? result.reason.message : String(result.reason), redactions)}`,
      );
      continue;
    }

    const { row, tools } = result.value;
    const reconciled = reconcileTools(
      {
        toolPolicies: row.toolPolicies ?? {},
        knownTools: row.knownTools ?? {},
      },
      tools,
      catalogDefaultPolicy(row),
    );
    // Persist the reconciliation so allowlist revocations stick even when the
    // change is first seen by a run rather than a test-connection.
    await db
      .update(mcpServers)
      .set({ toolPolicies: reconciled.toolPolicies, knownTools: reconciled.knownTools })
      .where(eq(mcpServers.id, row.id))
      .catch(() => undefined);

    for (const meta of tools) {
      const policy: ToolPolicy = reconciled.toolPolicies[meta.name] ?? {
        enabled: true,
        approval: "ask",
        readOnly: false,
      };
      if (!policy.enabled) continue;
      if (opts.mode === "planning" && !policy.readOnly) continue;

      let validate: ValidateFunction | null = null;
      try {
        validate = compileValidator(meta.inputSchema);
      } catch (err) {
        console.warn(`Dropping MCP tool ${row.slug}/${meta.name}: schema failed to compile: ${(err as Error).message}`);
        continue;
      }

      const name = namespaceTool(row.slug, meta.name);
      out.push({
        tool: {
          name,
          description: meta.description,
          // The model sees a compacted copy; the validator (above) enforces
          // the server's full original schema.
          parameters: compactSchemaForModel(meta.inputSchema),
          requiresApproval: policy.approval !== "allow",
          isWrite: !policy.readOnly,
          source: {
            kind: "mcp",
            serverId: row.id,
            serverSlug: row.slug,
            serverName: row.name,
            remoteName: meta.name,
            readOnly: policy.readOnly,
          },
        },
        entry: { row, remoteName: meta.name, validate },
      });
    }
  }
  return out;
}

/** Builtin tools the user has allowlisted ("allow always") — global, applies
 * to every run regardless of surface or mode. */
async function builtinAllowlist(userId: string): Promise<Set<string>> {
  try {
    const row = await db.query.userPrefs.findFirst({
      where: eq(userPrefs.userId, userId),
      columns: { toolAllowlist: true },
    });
    return new Set(Array.isArray(row?.toolAllowlist) ? row.toolAllowlist.map(String) : []);
  } catch {
    return new Set();
  }
}

/**
 * The conversation's kind and its own MCP choices. `fallbackKind` (the run's
 * surface) is used only when there is no conversation to read; it can never be
 * "routine", which is why a failed read answers null rather than falling back —
 * a routine run resolved against `on_in_chat` would offer a server its owner
 * switched off for exactly the unattended kind. The caller offers no MCP
 * servers then, as it does when the server list itself cannot be read.
 */
async function conversationMcpState(
  conversationId: string | undefined,
  fallbackKind: McpConversationKind,
): Promise<{ kind: McpConversationKind; overrides: McpOverrides | null } | null> {
  if (!conversationId) return { kind: fallbackKind, overrides: null };
  try {
    const conv = await db.query.conversations.findFirst({
      where: eq(conversations.id, conversationId),
      columns: { kind: true, mcpOverrides: true },
    });
    // A sub-agent's toolset is built against its *parent's* conversation
    // (engine.ts passes that id), so `subagent` is not a kind this ever reads.
    // Were one to arrive anyway it gets no MCP servers rather than chat's
    // defaults: none of the three per-kind switches was set with it in mind.
    if (conv?.kind === "subagent") return null;
    return { kind: conv?.kind ?? fallbackKind, overrides: normalizeMcpOverrides(conv?.mcpOverrides) };
  } catch {
    return null;
  }
}

async function dispatchMcpTool(
  userId: string,
  tool: ResolvedTool,
  args: Record<string, unknown>,
  entries: Map<string, McpToolEntry>,
): Promise<{ ok: boolean; output: string }> {
  if (tool.source.kind !== "mcp") return { ok: false, output: `Not an MCP tool: ${tool.name}` };
  const entry = entries.get(tool.name);
  if (!entry) return { ok: false, output: `Unknown tool: ${tool.name}` };
  const { serverSlug, remoteName } = tool.source;

  // The model's arguments are validated against the server's declared schema
  // BEFORE anything reaches the server; an invalid call is reported back to
  // the model so it can retry, never forwarded.
  if (entry.validate && !entry.validate(args)) {
    const detail = ajv.errorsText(entry.validate.errors, { dataVar: "arguments" });
    return { ok: false, output: `Invalid arguments for ${tool.name}: ${detail}` };
  }

  try {
    const raw = await callServerTool(userId, entry.row, remoteName, args);
    const { text, ok } = extractResultText(raw);
    return { ok, output: wrapResult(serverSlug, remoteName, text) };
  } catch (err) {
    // The linked row carries no secrets of its own, and this output goes into
    // the model's transcript — redact with the credential actually in play.
    const redactions = await redactionsFor(entry.row);
    return {
      ok: false,
      output: `MCP server "${serverSlug}" failed: ${redact(err instanceof Error ? err.message : String(err), redactions)}`,
    };
  }
}
