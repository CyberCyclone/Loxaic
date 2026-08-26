import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { db, eq } from "@shannon/db";
import { mcpServers } from "@shannon/db/schema";
import { assertPublicUrl } from "../agent/executor.ts";
import { decryptSecrets, redact } from "./secrets.ts";
import { MAX_TOOLS_PER_SERVER, sanitizeToolMeta, type SanitizedToolMeta } from "./sanitize.ts";

export type McpServerRow = typeof mcpServers.$inferSelect;

/** How long a connection may sit unused before the reaper closes it. */
const IDLE_TTL_MS = 15 * 60 * 1000;
const REAP_INTERVAL_MS = 5 * 60 * 1000;
export const CONNECT_TIMEOUT_MS = 10_000;
export const CALL_TIMEOUT_MS = 60_000;

type Entry = {
  client: Client;
  /** row.updatedAt at connect time — an edited row invalidates the cache. */
  configStamp: string;
  lastUsedAt: number;
  tools: SanitizedToolMeta[] | null;
};

// Keyed `${userId}:${serverId}`. Same shape as sandbox-manager: an `active`
// cache plus a `pending` map so concurrent tool calls share one connect.
const active = new Map<string, Entry>();
const pending = new Map<string, Promise<Entry>>();

function keyOf(userId: string, serverId: string): string {
  return `${userId}:${serverId}`;
}

function stampOf(row: McpServerRow): string {
  return row.updatedAt.toISOString();
}

function rowSecrets(row: McpServerRow): Record<string, string> {
  return row.secrets ? decryptSecrets(row.secrets) : {};
}

function asStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

async function connect(userId: string, row: McpServerRow): Promise<Entry> {
  const secrets = rowSecrets(row);
  const client = new Client({ name: "open-shannon", version: "1.0.0" });

  try {
    if (row.transport === "stdio") {
      if (!row.command) throw new Error("stdio MCP server has no command configured");
      const args = Array.isArray(row.args) ? (row.args as unknown[]).map(String) : [];
      // Deliberately NOT process.env: the child sees only what it needs, so
      // the server process can never read the host's own secrets.
      const env: Record<string, string> = {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
        ...asStringRecord(row.env),
        ...secrets,
      };
      const transport = new StdioClientTransport({ command: row.command, args, env, stderr: "ignore" });
      await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
    } else {
      if (!row.url) throw new Error("http MCP server has no URL configured");
      const url = new URL(row.url);
      if (!row.allowPrivateNetwork) await assertPublicUrl(url);
      const headers = { ...asStringRecord(row.headers), ...secrets };
      // Re-vet every request unless the user explicitly allowed a private
      // address — a public hostname can re-resolve to an internal one later.
      const guardedFetch: typeof fetch = async (input, init) => {
        const target = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
        if (!row.allowPrivateNetwork) await assertPublicUrl(target);
        return fetch(input, init);
      };
      const transport = new StreamableHTTPClientTransport(url, {
        fetch: guardedFetch,
        requestInit: { headers },
      });
      await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
    }
  } catch (err) {
    await client.close().catch(() => {});
    const message = redact((err as Error).message ?? String(err), secrets);
    await recordConnectResult(row.id, message);
    throw new Error(`Could not connect to MCP server "${row.name}": ${message}`);
  }

  await recordConnectResult(row.id, null);
  return { client, configStamp: stampOf(row), lastUsedAt: Date.now(), tools: null };
}

async function recordConnectResult(serverId: string, error: string | null): Promise<void> {
  await db
    .update(mcpServers)
    .set(error === null ? { lastConnectedAt: new Date(), lastError: null } : { lastError: error })
    .where(eq(mcpServers.id, serverId))
    .catch(() => {});
}

async function resolveEntry(userId: string, row: McpServerRow): Promise<Entry> {
  const key = keyOf(userId, row.id);
  const existing = active.get(key);
  if (existing && existing.configStamp === stampOf(row)) {
    existing.lastUsedAt = Date.now();
    return existing;
  }
  if (existing) {
    active.delete(key);
    await existing.client.close().catch(() => {});
  }

  const inFlight = pending.get(key);
  if (inFlight) return inFlight;

  const creation = connect(userId, row)
    .then((entry) => {
      active.set(key, entry);
      return entry;
    })
    .finally(() => pending.delete(key));
  pending.set(key, creation);
  return creation;
}

/** Discover (and cache) the server's sanitized tool list. */
export async function listServerTools(userId: string, row: McpServerRow): Promise<SanitizedToolMeta[]> {
  const entry = await resolveEntry(userId, row);
  if (entry.tools) return entry.tools;
  const secrets = rowSecrets(row);
  try {
    const listing = await entry.client.listTools(undefined, { timeout: CONNECT_TIMEOUT_MS });
    const tools: SanitizedToolMeta[] = [];
    for (const raw of listing.tools.slice(0, MAX_TOOLS_PER_SERVER)) {
      const meta = sanitizeToolMeta(raw);
      if (meta) tools.push(meta);
    }
    entry.tools = tools;
    return tools;
  } catch (err) {
    await dropEntry(userId, row.id);
    throw new Error(redact((err as Error).message ?? String(err), secrets));
  }
}

/** Call one tool; rejections (timeout, crash, transport loss) propagate to
 * the caller, which converts them into a failed tool result — never a dead run. */
export async function callServerTool(
  userId: string,
  row: McpServerRow,
  remoteName: string,
  args: Record<string, unknown>,
): Promise<{ content?: unknown; isError?: boolean }> {
  const entry = await resolveEntry(userId, row);
  entry.lastUsedAt = Date.now();
  const secrets = rowSecrets(row);
  try {
    return (await entry.client.callTool({ name: remoteName, arguments: args }, undefined, {
      timeout: CALL_TIMEOUT_MS,
    })) as { content?: unknown; isError?: boolean };
  } catch (err) {
    // Drop the cached connection: a timeout usually means a wedged server,
    // and the next call should respawn/reconnect rather than reuse it.
    await dropEntry(userId, row.id);
    throw new Error(redact((err as Error).message ?? String(err), secrets));
  }
}

export async function dropEntry(userId: string, serverId: string): Promise<void> {
  const key = keyOf(userId, serverId);
  const entry = active.get(key);
  if (!entry) return;
  active.delete(key);
  await entry.client.close().catch(() => {});
}

/** Close every cached connection for a server, regardless of user. Used by
 * the PATCH/DELETE routes so config edits take effect immediately. */
export async function closeServerClients(serverId: string): Promise<void> {
  for (const [key, entry] of active) {
    if (key.endsWith(`:${serverId}`)) {
      active.delete(key);
      await entry.client.close().catch(() => {});
    }
  }
}

export async function reapIdleMcpClients(now = Date.now()): Promise<number> {
  let reaped = 0;
  for (const [key, entry] of active) {
    if (now - entry.lastUsedAt > IDLE_TTL_MS) {
      active.delete(key);
      await entry.client.close().catch(() => {});
      reaped++;
    }
  }
  return reaped;
}

export function startMcpReaper(onReap?: (count: number) => void): NodeJS.Timeout {
  const timer = setInterval(() => {
    void reapIdleMcpClients().then((n) => {
      if (n > 0) onReap?.(n);
    });
  }, REAP_INTERVAL_MS);
  timer.unref();
  return timer;
}
