import type { FastifyInstance } from "fastify";
import { and, db, eq } from "@loxaic/db";
import { mcpServers } from "@loxaic/db/schema";
import { authenticate } from "../auth/middleware";
import { assertPublicUrl } from "../agent/executor.ts";
import { BUILTIN_CATALOG, catalogDefaultPolicy, catalogEntry, isCredentialLinked } from "../mcp/catalog.ts";
import { ensureGithubMcpServer } from "../mcp/github-server.ts";
import { getConnection } from "../github/connection.ts";
import {
  closeServerClients,
  dropEntry,
  listServerTools,
  redactionsFor,
  type McpServerRow,
} from "../mcp/client-manager.ts";
import { reconcileTools, type ToolPolicies, type ToolPolicy } from "../mcp/change-detection.ts";
import { isValidSlug, namespaceTool } from "../mcp/naming.ts";
import { decryptSecrets, encryptSecrets, redact, secretKeys } from "../mcp/secrets.ts";

async function findOwnedServer(id: string, userId: string) {
  return db.query.mcpServers.findFirst({
    where: and(eq(mcpServers.id, id), eq(mcpServers.ownerId, userId)),
  });
}

/** What the API exposes about a server row — never the secret blob. */
function toApi(row: McpServerRow) {
  const { secrets, ...rest } = row;
  return { ...rest, secretKeys: secretKeys(secrets) };
}

function asOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** Merge a secrets patch over the stored blob: string sets, null deletes. */
function mergeSecrets(existingBlob: string | null, patch: Record<string, unknown>): string | null {
  let merged: Record<string, string> = existingBlob ? decryptSecrets(existingBlob) : {};
  for (const [key, value] of Object.entries(patch)) {
    // A null clears the secret; rebuilt without the key rather than deleted,
    // since a computed `delete` is disallowed here.
    if (value === null) merged = Object.fromEntries(Object.entries(merged).filter(([k]) => k !== key));
    else if (typeof value === "string" && value.length > 0) merged[key] = value;
  }
  return Object.keys(merged).length > 0 ? encryptSecrets(merged) : null;
}

function sanitizePolicyPatch(existing: ToolPolicies, patch: Record<string, unknown>): ToolPolicies {
  const out: ToolPolicies = { ...existing };
  for (const [toolName, raw] of Object.entries(patch)) {
    const p = asOptionalRecord(raw);
    if (!p) continue;
    const prev: ToolPolicy = out[toolName] ?? { enabled: true, approval: "ask", readOnly: false };
    out[toolName] = {
      enabled: typeof p.enabled === "boolean" ? p.enabled : prev.enabled,
      approval: p.approval === "allow" ? "allow" : p.approval === "ask" ? "ask" : prev.approval,
      readOnly: typeof p.readOnly === "boolean" ? p.readOnly : prev.readOnly,
      // Re-saving a policy acknowledges the change badge.
      changed: false,
      missing: prev.missing,
    };
  }
  return out;
}

async function vetHttpUrl(rawUrl: string, allowPrivateNetwork: boolean): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return "url is not a valid URL";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "url must be http or https";
  if (!allowPrivateNetwork) {
    try {
      await assertPublicUrl(url);
    } catch (err) {
      return (err as Error).message;
    }
  }
  return null;
}

export function mcpRoutes(app: FastifyInstance) {
  app.get("/v1/mcp/servers", async (request, reply) => {
    const userId = await authenticate(request, reply);
    const rows = await db.select().from(mcpServers).where(eq(mcpServers.ownerId, userId));
    return rows.map(toApi);
  });

  app.get("/v1/mcp/catalog", async (request, reply) => {
    const userId = await authenticate(request, reply);
    const rows = await db.select().from(mcpServers).where(eq(mcpServers.ownerId, userId));
    const configured = new Set(rows.map((r) => r.builtinKey).filter(Boolean));
    return BUILTIN_CATALOG.map((entry) => ({
      key: entry.key,
      name: entry.name,
      slug: entry.slug,
      description: entry.description,
      transport: entry.transport,
      secretKeys: entry.transport === "stdio" ? entry.secretKeys : [],
      credentials: entry.transport === "http" ? entry.credentials : null,
      configured: configured.has(entry.key),
    }));
  });

  app.post("/v1/mcp/servers", async (request, reply) => {
    const userId = await authenticate(request, reply);
    const body = (request.body ?? {}) as Record<string, unknown>;

    let insert: Partial<typeof mcpServers.$inferInsert>;
    if (typeof body.builtinKey === "string") {
      const entry = catalogEntry(body.builtinKey);
      if (!entry) {
        reply.code(400);
        return { error: `Unknown builtin "${body.builtinKey}"` };
      }
      if (entry.transport === "http") {
        // Credential-linked: the row is made from the connection it depends
        // on, and never without one. Normally the GitHub screen has already
        // made it; this is the path for a user who removed it by hand.
        if (!(await getConnection(userId))) {
          reply.code(409);
          return { error: "Connect GitHub under Settings → GitHub first; its tools are set up for you when you do." };
        }
        const status = await ensureGithubMcpServer(userId);
        if (!status.ok) {
          reply.code(409);
          return { error: status.error };
        }
        const row = await findOwnedServer(status.serverId, userId);
        if (!row) {
          reply.code(404);
          return { error: "Not found" };
        }
        return toApi(row);
      }
      const launch = entry.resolveLaunch();
      insert = {
        name: entry.name,
        slug: entry.slug,
        transport: entry.transport,
        command: launch.command,
        args: launch.args,
        builtinKey: entry.key,
      };
    } else {
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const slug = typeof body.slug === "string" ? body.slug.trim() : "";
      const transport = body.transport;
      if (!name) {
        reply.code(400);
        return { error: "name is required" };
      }
      if (!isValidSlug(slug)) {
        reply.code(400);
        return { error: "slug must match [a-z0-9][a-z0-9-]{0,31} and not be a builtin tool name" };
      }
      if (transport !== "stdio" && transport !== "http") {
        reply.code(400);
        return { error: "transport must be 'stdio' or 'http'" };
      }
      const allowPrivateNetwork = body.allowPrivateNetwork === true;
      if (transport === "stdio") {
        if (typeof body.command !== "string" || !body.command.trim()) {
          reply.code(400);
          return { error: "command is required for stdio servers" };
        }
      } else {
        if (typeof body.url !== "string" || !body.url.trim()) {
          reply.code(400);
          return { error: "url is required for http servers" };
        }
        const urlError = await vetHttpUrl(body.url, allowPrivateNetwork);
        if (urlError) {
          reply.code(400);
          return { error: urlError, ssrf: true };
        }
      }
      insert = {
        name,
        slug,
        transport,
        command: typeof body.command === "string" ? body.command.trim() : null,
        args: Array.isArray(body.args) ? body.args.map(String) : null,
        url: typeof body.url === "string" ? body.url.trim() : null,
        headers: asOptionalRecord(body.headers) ?? null,
        env: asOptionalRecord(body.env) ?? null,
        allowPrivateNetwork,
      };
    }

    const secretsPatch = asOptionalRecord(body.secrets);
    const [row] = await db
      .insert(mcpServers)
      .values({
        ...insert,
        ownerId: userId,
        secrets: secretsPatch ? mergeSecrets(null, secretsPatch) : null,
        enabled: body.enabled !== false,
      } as typeof mcpServers.$inferInsert)
      .returning()
      // Drizzle's `.returning()` type doesn't reflect that the duplicate-slug
      // catch below yields zero rows — cast to what actually comes back.
      .catch((err: unknown) => {
        if (err instanceof Error && /mcp_servers_owner_slug_idx|duplicate key/.test(err.message)) {
          return [];
        }
        throw err;
      }) as (typeof mcpServers.$inferSelect | undefined)[];
    if (!row) {
      reply.code(409);
      return { error: "A server with that slug already exists" };
    }
    return toApi(row);
  });

  app.patch<{ Params: { id: string } }>("/v1/mcp/servers/:id", async (request, reply) => {
    const userId = await authenticate(request, reply);
    const existing = await findOwnedServer(request.params.id, userId);
    if (!existing) {
      reply.code(404);
      return { error: "Not found" };
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    const patch: Partial<typeof mcpServers.$inferInsert> = {};

    // A linked row's address and credential come from the connection it
    // follows. allowPrivateNetwork is on the list because an operator-set
    // GITHUB_MCP_URL is the only thing entitled to lift the SSRF guard for it.
    if (isCredentialLinked(existing)) {
      const locked = ["url", "headers", "secrets", "allowPrivateNetwork", "env", "command", "args"].filter(
        (key) => body[key] !== undefined,
      );
      if (locked.length > 0) {
        reply.code(400);
        return {
          error: `${existing.name} uses your GitHub connection, so ${locked.join(", ")} cannot be changed here.`,
        };
      }
    }

    if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim();
    if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
    if (typeof body.command === "string" && existing.builtinKey === null) patch.command = body.command.trim();
    if (Array.isArray(body.args) && existing.builtinKey === null) patch.args = body.args.map(String);
    if (asOptionalRecord(body.env)) patch.env = asOptionalRecord(body.env);
    if (asOptionalRecord(body.headers)) patch.headers = asOptionalRecord(body.headers);

    const allowPrivateNetwork =
      typeof body.allowPrivateNetwork === "boolean" ? body.allowPrivateNetwork : existing.allowPrivateNetwork;
    if (typeof body.allowPrivateNetwork === "boolean") patch.allowPrivateNetwork = body.allowPrivateNetwork;
    if (typeof body.url === "string" && existing.transport === "http") {
      const urlError = await vetHttpUrl(body.url, allowPrivateNetwork);
      if (urlError) {
        reply.code(400);
        return { error: urlError, ssrf: true };
      }
      patch.url = body.url.trim();
    } else if (body.allowPrivateNetwork === false && existing.url) {
      const urlError = await vetHttpUrl(existing.url, false);
      if (urlError) {
        reply.code(400);
        return { error: urlError, ssrf: true };
      }
    }

    const secretsPatch = asOptionalRecord(body.secrets);
    if (secretsPatch) patch.secrets = mergeSecrets(existing.secrets, secretsPatch);

    const policyPatch = asOptionalRecord(body.toolPolicies);
    if (policyPatch) {
      patch.toolPolicies = sanitizePolicyPatch(existing.toolPolicies ?? {}, policyPatch);
    }

    // Any config change invalidates cached connections via the updatedAt stamp.
    patch.updatedAt = new Date();
    const [updated] = await db.update(mcpServers).set(patch).where(eq(mcpServers.id, existing.id)).returning();
    await closeServerClients(existing.id);
    return toApi(updated);
  });

  app.delete<{ Params: { id: string } }>("/v1/mcp/servers/:id", async (request, reply) => {
    const userId = await authenticate(request, reply);
    const existing = await findOwnedServer(request.params.id, userId);
    if (!existing) {
      reply.code(404);
      return { error: "Not found" };
    }
    // A linked row follows its connection. Deleting it here would only have it
    // come back on the next reconnect, so the answer names the two things that
    // do what the user wants. With no connection left (a crash between the two
    // deletes on disconnect) it is an ordinary row and may go.
    if (isCredentialLinked(existing) && (await getConnection(userId))) {
      reply.code(409);
      return {
        error:
          "GitHub tools follow your GitHub connection. Switch them off here, or disconnect GitHub under Settings → GitHub to remove them.",
      };
    }
    // Hard delete, unlike routines' soft-disable: stored credentials must not
    // outlive the user's intent to remove the server.
    await closeServerClients(existing.id);
    await db.delete(mcpServers).where(eq(mcpServers.id, existing.id));
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/v1/mcp/servers/:id/test", async (request, reply) => {
    const userId = await authenticate(request, reply);
    const existing = await findOwnedServer(request.params.id, userId);
    if (!existing) {
      reply.code(404);
      return { error: "Not found" };
    }

    // Force a fresh connect + listing rather than serving a cached tool list.
    await dropEntry(userId, existing.id);
    try {
      const tools = await listServerTools(userId, existing);
      const reconciled = reconcileTools(
        {
          toolPolicies: existing.toolPolicies ?? {},
          knownTools: existing.knownTools ?? {},
        },
        tools,
        catalogDefaultPolicy(existing),
      );
      await db
        .update(mcpServers)
        .set({ toolPolicies: reconciled.toolPolicies, knownTools: reconciled.knownTools })
        .where(eq(mcpServers.id, existing.id));

      return {
        ok: true,
        changedTools: reconciled.changedTools,
        tools: tools.map((t) => ({
          name: t.name,
          namespacedName: namespaceTool(existing.slug, t.name),
          description: t.description,
          annotations: t.annotations ?? null,
          policy: reconciled.toolPolicies[t.name],
        })),
      };
    } catch (err) {
      // Not `existing.secrets`: a credential-linked row stores none, so that
      // would redact with `{}` and put whatever the transport threw — a header
      // echo, a 401 body — straight into the MCP screen.
      return { ok: false, error: redact((err as Error).message, await redactionsFor(existing)) };
    }
  });
}
