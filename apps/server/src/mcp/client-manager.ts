import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { db, eq } from "@loxaic/db";
import { mcpServers } from "@loxaic/db/schema";
import { assertPublicUrl } from "../agent/executor.ts";
import { getOwnerToken } from "../github/connection.ts";
import { catalogEntry } from "./catalog.ts";
import { decryptSecrets, redact } from "./secrets.ts";
import { MAX_TOOLS_PER_SERVER, sanitizeToolMeta, type SanitizedToolMeta } from "./sanitize.ts";

export type McpServerRow = typeof mcpServers.$inferSelect;

/** How long a connection may sit unused before the reaper closes it. */
const IDLE_TTL_MS = 15 * 60 * 1000;
const REAP_INTERVAL_MS = 5 * 60 * 1000;
export const CONNECT_TIMEOUT_MS = 10_000;
export const CALL_TIMEOUT_MS = 60_000;
/**
 * How long a failed connect is remembered. The registry connects every enabled
 * server at the start of every turn, and without this a server that cannot be
 * reached (a box with no route to api.githubcopilot.com, say) costs
 * CONNECT_TIMEOUT_MS on every turn — for the GitHub server, on a row the user
 * never added by hand. `dropEntry` clears it, so Test always really tries.
 */
export const CONNECT_FAILURE_TTL_MS = 30_000;

interface Entry {
  client: Client;
  /** row.updatedAt at connect time — an edited row invalidates the cache. */
  configStamp: string;
  lastUsedAt: number;
  tools: SanitizedToolMeta[] | null;
  /** Every value to scrub from an error: the row's secrets, plus a linked
   * credential (the GitHub token) that never lives in the row. */
  redactions: Record<string, string>;
}

// Keyed `${userId}:${serverId}`. Same shape as sandbox-manager: an `active`
// cache plus a `pending` map so concurrent tool calls share one connect.
const active = new Map<string, Entry>();
const pending = new Map<string, Promise<Entry>>();
const recentFailures = new Map<string, { at: number; stamp: string; error: Error }>();

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

function linkedEndpoint(row: McpServerRow): { url: string; allowPrivateNetwork: boolean } | null {
  const entry = catalogEntry(row.builtinKey);
  return entry?.transport === "http" ? entry.resolveUrl() : null;
}

async function connect(userId: string, row: McpServerRow): Promise<Entry> {
  const secrets = rowSecrets(row);
  const redactions: Record<string, string> = { ...secrets };
  const client = new Client({ name: "loxaic", version: "1.0.0" });

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
      // A credential-linked row takes its address from the catalog at connect
      // time, not from the row. Every server process on a machine shares one
      // database, and an e2e harness boots with GITHUB_MCP_URL pointed at a
      // mock: freezing that into rows would leave other users' GitHub tools
      // aimed at a dead loopback port, with the SSRF guard lifted, long after
      // the harness exited.
      const linked = linkedEndpoint(row);
      const target = linked ?? { url: row.url, allowPrivateNetwork: row.allowPrivateNetwork };
      if (!target.url) throw new Error("http MCP server has no URL configured");
      const allowPrivateNetwork = target.allowPrivateNetwork;
      const url = new URL(target.url);
      if (!allowPrivateNetwork) await assertPublicUrl(url);
      const headers: Record<string, string> = { ...asStringRecord(row.headers), ...secrets };
      if (linked) {
        // The row's *owner's* token, never the caller's — the same rule clone
        // credentials follow. Read here rather than copied into the row, so a
        // token re-issued or disconnected in Settings → GitHub is the one used.
        // A token that can no longer be decrypted throws its own sentence
        // ("disconnect and reconnect"), which lands in lastError as-is.
        const token = await getOwnerToken(row.ownerId);
        if (!token) throw new Error("GitHub is not connected. Connect it under Settings → GitHub.");
        redactions.GITHUB_TOKEN = token;
        headers.Authorization = `Bearer ${token}`;
      }
      // Re-vet every request unless the user explicitly allowed a private
      // address — a public hostname can re-resolve to an internal one later.
      const guardedFetch: typeof fetch = async (input, init) => {
        const requestUrl = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
        if (!allowPrivateNetwork) await assertPublicUrl(requestUrl);
        return fetch(input, init);
      };
      const transport = new StreamableHTTPClientTransport(url, {
        fetch: guardedFetch,
        requestInit: { headers },
      });
      await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
    }
  } catch (err) {
    await client.close().catch(() => undefined);
    const message = redact(err instanceof Error ? err.message : String(err), redactions);
    await recordConnectResult(row.id, message);
    throw new Error(`Could not connect to MCP server "${row.name}": ${message}`);
  }

  await recordConnectResult(row.id, null);
  return { client, configStamp: stampOf(row), lastUsedAt: Date.now(), tools: null, redactions };
}

async function recordConnectResult(serverId: string, error: string | null): Promise<void> {
  await db
    .update(mcpServers)
    .set(error === null ? { lastConnectedAt: new Date(), lastError: null } : { lastError: error })
    .where(eq(mcpServers.id, serverId))
    .catch(() => undefined);
}

async function resolveEntry(userId: string, row: McpServerRow): Promise<Entry> {
  const key = keyOf(userId, row.id);
  const existing = active.get(key);
  if (existing?.configStamp === stampOf(row)) {
    existing.lastUsedAt = Date.now();
    return existing;
  }
  if (existing) {
    active.delete(key);
    await existing.client.close().catch(() => undefined);
  }

  const inFlight = pending.get(key);
  if (inFlight) return inFlight;

  // An edited row (new stamp) always gets a fresh attempt.
  const failure = recentFailures.get(key);
  if (failure?.stamp === stampOf(row) && Date.now() - failure.at < CONNECT_FAILURE_TTL_MS) {
    throw failure.error;
  }

  const creation = connect(userId, row)
    .then((entry) => {
      recentFailures.delete(key);
      active.set(key, entry);
      return entry;
    })
    .catch((err: unknown) => {
      const error = err instanceof Error ? err : new Error(String(err));
      recentFailures.set(key, { at: Date.now(), stamp: stampOf(row), error });
      throw error;
    })
    .finally(() => pending.delete(key));
  pending.set(key, creation);
  return creation;
}

/** Discover (and cache) the server's sanitized tool list. */
export async function listServerTools(userId: string, row: McpServerRow): Promise<SanitizedToolMeta[]> {
  const entry = await resolveEntry(userId, row);
  if (entry.tools) return entry.tools;
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
    throw new Error(redact(err instanceof Error ? err.message : String(err), entry.redactions));
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
  try {
    return (await entry.client.callTool({ name: remoteName, arguments: args }, undefined, {
      timeout: CALL_TIMEOUT_MS,
    })) as { content?: unknown; isError?: boolean };
  } catch (err) {
    // Drop the cached connection: a timeout usually means a wedged server,
    // and the next call should respawn/reconnect rather than reuse it.
    await dropEntry(userId, row.id);
    throw new Error(redact(err instanceof Error ? err.message : String(err), entry.redactions));
  }
}

/**
 * Every value to scrub from an error about this server: its own secrets, plus
 * a linked credential (the GitHub token) the row does not store.
 *
 * Exported because the outer catches — the `/test` route and the registry's
 * per-run warning — only have the row, and for a linked row its secrets are
 * `{}` by construction, so redacting with those alone is a no-op. This repo
 * redacts a GitHub token at the route layer as well as here, deliberately.
 */
export async function redactionsFor(row: McpServerRow): Promise<Record<string, string>> {
  const secrets = rowSecrets(row);
  if (!linkedEndpoint(row)) return secrets;
  try {
    const token = await getOwnerToken(row.ownerId);
    return token ? { ...secrets, GITHUB_TOKEN: token } : secrets;
  } catch {
    // An unreadable token is nothing to redact — and this is an error path
    // already, so it must not throw a second error over the first.
    return secrets;
  }
}

export async function dropEntry(userId: string, serverId: string): Promise<void> {
  const key = keyOf(userId, serverId);
  recentFailures.delete(key);
  const entry = active.get(key);
  if (!entry) return;
  active.delete(key);
  await entry.client.close().catch(() => undefined);
}

/** Close every cached connection for a server, regardless of user. Used by
 * the PATCH/DELETE routes so config edits take effect immediately. */
export async function closeServerClients(serverId: string): Promise<void> {
  for (const key of recentFailures.keys()) {
    if (key.endsWith(`:${serverId}`)) recentFailures.delete(key);
  }
  for (const [key, entry] of active) {
    if (key.endsWith(`:${serverId}`)) {
      active.delete(key);
      await entry.client.close().catch(() => undefined);
    }
  }
}

export async function reapIdleMcpClients(now = Date.now()): Promise<number> {
  // A failure is only consulted for CONNECT_FAILURE_TTL_MS; after that the
  // entry is dead weight holding an Error and its stack. Nothing else sweeps
  // it — dropEntry/closeServerClients only fire for a pair someone names — so
  // without this it is one retained Error per (user, server) that ever failed,
  // for the life of the process.
  for (const [key, failure] of recentFailures) {
    if (now - failure.at > CONNECT_FAILURE_TTL_MS) recentFailures.delete(key);
  }
  let reaped = 0;
  for (const [key, entry] of active) {
    if (now - entry.lastUsedAt > IDLE_TTL_MS) {
      active.delete(key);
      await entry.client.close().catch(() => undefined);
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
