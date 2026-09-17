import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";
import type { OpenAiTool, PermissionMode, ResolvedTool } from "@loxaic/agent";
import { resolveBuiltinTools, resolvedToOpenAiTool } from "@loxaic/agent";
import { and, db, eq } from "@loxaic/db";
import { conversations, mcpServers, userPrefs } from "@loxaic/db/schema";
import { catalogDefaultPolicy } from "./catalog.ts";
import { reconcileTools, type ToolPolicy } from "./change-detection.ts";
import { callServerTool, listServerTools, type McpServerRow } from "./client-manager.ts";
import { namespaceTool } from "./naming.ts";
import { compactSchemaForModel, extractResultText, MCP_SYSTEM_ADDENDUM, wrapResult } from "./sanitize.ts";
import { decryptSecrets, redact } from "./secrets.ts";

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
    /** The user's builtin allowlist, when the caller has already loaded the
     * prefs row. Optional so this stays usable on its own; the tool loop
     * passes it because it reads the same row one line earlier for the
     * iteration ceiling, and two statements against the same key back to back
     * is just waste. */
    allowlist?: ReadonlySet<string>;
  },
): Promise<Toolset> {
  const allowlist = opts.allowlist ?? (await builtinAllowlist(userId));
  const resolved = resolveBuiltinTools().map((t) =>
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

  return {
    openAiTools: offered.map(resolvedToOpenAiTool),
    get: (name) => byName.get(name),
    requiresApproval: toolsetRequiresApproval,
    systemPromptAddendum: hasMcp ? MCP_SYSTEM_ADDENDUM : null,
    dispatchMcp: (tool, args) => dispatchMcpTool(userId, tool, args, mcpEntries),
  };
}

function toolsetRequiresApproval(tool: ResolvedTool, mode: PermissionMode): boolean {
  if (tool.source.kind === "mcp") {
    // MCP tools ask in EVERY mode — auto included — unless the user
    // explicitly allowlisted the tool (requiresApproval=false then).
    return tool.requiresApproval;
  }
  if (mode === "auto") return false;
  if (mode === "planning") return tool.isWrite;
  return tool.requiresApproval;
}

async function resolveMcpTools(
  userId: string,
  opts: { mode: PermissionMode; conversationId?: string },
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

  const disabled = await disabledServerIds(opts.conversationId);
  const activeRows = rows.filter((r) => !disabled.has(r.id));
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
      const secrets = row.secrets ? safeDecrypt(row.secrets) : {};
      console.warn(
        `MCP server "${row.name}" unavailable this run: ${redact(result.reason instanceof Error ? result.reason.message : String(result.reason), secrets)}`,
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

async function disabledServerIds(conversationId: string | undefined): Promise<Set<string>> {
  if (!conversationId) return new Set();
  try {
    const conv = await db.query.conversations.findFirst({
      where: eq(conversations.id, conversationId),
      columns: { mcpOverrides: true },
    });
    const overrides = conv?.mcpOverrides as { disabledServerIds?: unknown } | null;
    return new Set(
      Array.isArray(overrides?.disabledServerIds) ? overrides.disabledServerIds.map(String) : [],
    );
  } catch {
    return new Set();
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
    const secrets = entry.row.secrets ? safeDecrypt(entry.row.secrets) : {};
    return {
      ok: false,
      output: `MCP server "${serverSlug}" failed: ${redact(err instanceof Error ? err.message : String(err), secrets)}`,
    };
  }
}

function safeDecrypt(blob: string): Record<string, string> {
  try {
    return decryptSecrets(blob);
  } catch {
    return {};
  }
}
