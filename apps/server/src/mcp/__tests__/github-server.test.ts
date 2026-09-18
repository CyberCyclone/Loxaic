import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { v4 as uuid } from "uuid";
import { and, db, eq } from "@loxaic/db";
import { githubConnections, mcpServers, user } from "@loxaic/db/schema";
import { deleteConnection, upsertConnection } from "../../github/connection.ts";
import { startMockMcpHttp, type MockMcpHttp } from "./mock-mcp-http.ts";
import { dropEntry, listServerTools, reapIdleMcpClients, redactionsFor, CONNECT_FAILURE_TTL_MS } from "../client-manager.ts";
import {
  backfillGithubMcpServers,
  describeGithubMcp,
  ensureGithubMcpServer,
  GITHUB_SLUG_TAKEN,
  removeGithubMcpServer,
} from "../github-server.ts";
import { buildToolset } from "../registry.ts";

/**
 * The GitHub MCP server provisioned from a GitHub connection, against real
 * Postgres and a real streamable-HTTP MCP server standing in for GitHub's
 * hosted one. The fixture refuses any bearer but the connection's token, so a
 * tool that answers at all proves the token travelled from github_connections
 * to the request without ever being copied into the server row.
 */

process.env.MCP_ENCRYPTION_KEY ??= "github-mcp-test-key";

const TOKEN = "ghp_github-mcp-test-token-0123456789";
let mock: MockMcpHttp;

async function makeUser(): Promise<string> {
  const id = `test-github-mcp-${uuid()}`;
  await db.insert(user).values({
    id,
    name: "GitHub MCP Test",
    email: `${id}@example.com`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  users.push(id);
  return id;
}

async function connect(userId: string, token = TOKEN): Promise<void> {
  await upsertConnection(userId, { token, login: "e2e-bot", name: null, email: null, scopes: "repo" });
}

async function githubRow(userId: string) {
  return db.query.mcpServers.findFirst({
    where: and(eq(mcpServers.ownerId, userId), eq(mcpServers.builtinKey, "github")),
  });
}

async function mustRow(userId: string) {
  const row = await githubRow(userId);
  if (!row) throw new Error("expected a GitHub MCP server row");
  return row;
}

const users: string[] = [];

beforeAll(async () => {
  mock = await startMockMcpHttp({ requireBearer: TOKEN });
  process.env.GITHUB_MCP_URL = mock.url;
});

beforeEach(() => {
  process.env.GITHUB_MCP_URL = mock.url;
});

afterAll(async () => {
  for (const id of users) {
    await db.delete(mcpServers).where(eq(mcpServers.ownerId, id));
    await db.delete(githubConnections).where(eq(githubConnections.userId, id));
    await db.delete(user).where(eq(user.id, id));
  }
  await mock.close();
});

describe("provisioning", () => {
  it("creates a row that holds no credential and no environment-specific address", async () => {
    const userId = await makeUser();
    await connect(userId);
    const status = await ensureGithubMcpServer(userId);
    expect(status.ok).toBe(true);

    const row = await mustRow(userId);
    // GITHUB_MCP_URL points at the fixture for this whole file, and still the
    // row records the public endpoint with the SSRF guard on: the override is
    // applied when connecting, so it can never outlive this process in a
    // database other servers share.
    expect(row).toMatchObject({
      slug: "github",
      transport: "http",
      url: "https://api.githubcopilot.com/mcp/",
      allowPrivateNetwork: false,
      secrets: null,
      headers: null,
      enabled: true,
    });
    expect(JSON.stringify(row)).not.toContain(TOKEN);
    // Default policies are applied on discovery, not written ahead of it.
    expect(row.toolPolicies).toEqual({});
  });

  it("refreshes rather than duplicates on a second connect", async () => {
    const userId = await makeUser();
    await connect(userId);
    await ensureGithubMcpServer(userId);
    const first = await mustRow(userId);
    await new Promise((r) => setTimeout(r, 5));
    await ensureGithubMcpServer(userId);
    const rows = await db.select().from(mcpServers).where(eq(mcpServers.ownerId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(first.id);
    expect(rows[0].updatedAt.getTime()).toBeGreaterThan(first.updatedAt.getTime());
  });

  it("converges on one row when two connects race", async () => {
    const userId = await makeUser();
    await connect(userId);
    const [a, b] = await Promise.all([ensureGithubMcpServer(userId), ensureGithubMcpServer(userId)]);
    expect(a).toEqual(b);
    const rows = await db.select().from(mcpServers).where(eq(mcpServers.ownerId, userId));
    expect(rows).toHaveLength(1);
  });

  it("leaves a hand-made server named github alone, and says so", async () => {
    const userId = await makeUser();
    await connect(userId);
    await db.insert(mcpServers).values({
      ownerId: userId,
      name: "My GitHub",
      slug: "github",
      transport: "stdio",
      command: "true",
    });
    expect(await ensureGithubMcpServer(userId)).toEqual({ ok: false, error: GITHUB_SLUG_TAKEN });
    expect(await describeGithubMcp(userId)).toEqual({ ok: false, error: GITHUB_SLUG_TAKEN });
    const rows = await db.select().from(mcpServers).where(eq(mcpServers.ownerId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("My GitHub");
  });

  it("removes the row", async () => {
    const userId = await makeUser();
    await connect(userId);
    await ensureGithubMcpServer(userId);
    await removeGithubMcpServer(userId);
    expect(await githubRow(userId)).toBeUndefined();
  });

  it("backfills connections that predate provisioning, once", async () => {
    const userId = await makeUser();
    await connect(userId);
    expect(await githubRow(userId)).toBeUndefined();
    await backfillGithubMcpServers(() => undefined, userId);
    expect(await githubRow(userId)).toBeDefined();
    const again = await db.select().from(mcpServers).where(eq(mcpServers.ownerId, userId));
    await backfillGithubMcpServers(() => undefined, userId);
    expect(await db.select().from(mcpServers).where(eq(mcpServers.ownerId, userId))).toHaveLength(again.length);
  });
});

describe("connecting with the connection's token", () => {
  it("offers GitHub's read tools without approval and calls them with the token", async () => {
    const userId = await makeUser();
    await connect(userId);
    await ensureGithubMcpServer(userId);

    const ts = await buildToolset(userId, { mode: "manual" });
    const getMe = ts.get("github__get_me");
    const ping = ts.get("github__ping");
    if (!getMe || !ping) throw new Error("GitHub tools were not offered");
    // get_me is on the read-only list; ping is not, so it asks like any tool.
    expect(ts.requiresApproval(getMe, "manual")).toBe(false);
    expect(getMe.isWrite).toBe(false);
    expect(ts.requiresApproval(ping, "manual")).toBe(true);

    const result = await ts.dispatchMcp(getMe, {});
    expect(result.ok).toBe(true);
    expect(result.output).toContain("e2e-bot");
    expect(mock.lastAuthorization()).toBe(`Bearer ${TOKEN}`);

    // The default was recorded with the tool's hash, so change detection can
    // still revoke it.
    const row = await mustRow(userId);
    const policies = row.toolPolicies as Record<string, unknown>;
    const known = row.knownTools as Record<string, string>;
    expect(policies.get_me).toEqual({ enabled: true, approval: "allow", readOnly: true });
    expect(known.get_me).toMatch(/^[0-9a-f]{64}$/);
    // Planning mode offers the read-only tool and nothing else from GitHub.
    const planning = await buildToolset(userId, { mode: "planning" });
    expect(planning.get("github__get_me")).toBeDefined();
    expect(planning.get("github__ping")).toBeUndefined();
  }, 20_000);

  it("tells the model the tools exist, since the sandbox has no network to reach GitHub any other way", async () => {
    const userId = await makeUser();
    await connect(userId);
    await ensureGithubMcpServer(userId);

    const ts = await buildToolset(userId, { mode: "manual" });
    expect(ts.systemPromptAddendum).toMatch(/github__\* tools/);
    expect(ts.systemPromptAddendum).toMatch(/UNTRUSTED/);

    // Without the server there is nothing to point at, so the line is absent
    // rather than describing tools this run was never offered.
    await removeGithubMcpServer(userId);
    const without = await buildToolset(userId, { mode: "manual" });
    expect(without.systemPromptAddendum ?? "").not.toMatch(/github__\* tools/);
  }, 20_000);

  it("uses a re-issued token straight away", async () => {
    const userId = await makeUser();
    await connect(userId, "ghp_stale-token-that-the-fixture-refuses");
    await ensureGithubMcpServer(userId);
    await expect(listServerTools(userId, await mustRow(userId))).rejects.toThrow(/Could not connect/);

    await connect(userId);
    await ensureGithubMcpServer(userId);
    const tools = await listServerTools(userId, await mustRow(userId));
    expect(tools.map((t) => t.name)).toContain("get_me");
  });

  it("never lets the token into an error, even when the server echoes it", async () => {
    const userId = await makeUser();
    const wrong = "ghp_wrong-token-the-server-will-echo-back";
    await connect(userId, wrong);
    await ensureGithubMcpServer(userId);
    const error = await listServerTools(userId, await mustRow(userId)).then(
      () => { throw new Error("expected the connect to fail"); },
      (err: unknown) => err as Error,
    );
    expect(error.message).not.toContain(wrong);
    const row = await mustRow(userId);
    expect(row.lastError).toBeTruthy();
    expect(row.lastError).not.toContain(wrong);
  });

  it("hands the token to an outer catch, which has only the row and its empty secrets", async () => {
    const userId = await makeUser();
    await connect(userId);
    await ensureGithubMcpServer(userId);
    const row = await mustRow(userId);

    // What `/test` and the registry's warning redact with. The row's own
    // secrets are null here, so redacting with those alone is a no-op.
    expect(await redactionsFor(row)).toEqual({ GITHUB_TOKEN: TOKEN });
    await deleteConnection(userId);
    expect(await redactionsFor(row)).toEqual({});
  });

  it("forgets a failure once its window has passed, rather than holding it for the process's life", async () => {
    const userId = await makeUser();
    await connect(userId, "ghp_refused-so-this-failure-is-remembered");
    await ensureGithubMcpServer(userId);
    const row = await mustRow(userId);

    await expect(listServerTools(userId, row)).rejects.toThrow();
    const afterFirst = mock.requests();
    await expect(listServerTools(userId, row)).rejects.toThrow();
    expect(mock.requests()).toBe(afterFirst);

    // The reaper is the only thing that sweeps it: nothing here names this
    // (user, server) pair again.
    await reapIdleMcpClients(Date.now() + CONNECT_FAILURE_TTL_MS + 1);
    await expect(listServerTools(userId, row)).rejects.toThrow();
    expect(mock.requests()).toBeGreaterThan(afterFirst);
  });

  it("says GitHub is not connected once the connection is gone", async () => {
    const userId = await makeUser();
    await connect(userId);
    await ensureGithubMcpServer(userId);
    await deleteConnection(userId);
    const row = await mustRow(userId);
    await dropEntry(userId, row.id);
    await expect(listServerTools(userId, row)).rejects.toThrow(/GitHub is not connected/);
    expect((await mustRow(userId)).lastError).toMatch(/GitHub is not connected/);
  });

  it("says to reconnect when the stored token can no longer be read", async () => {
    const userId = await makeUser();
    await connect(userId);
    await ensureGithubMcpServer(userId);
    await db
      .update(githubConnections)
      .set({ encryptedToken: "v1:AAAA:AAAA:AAAA:AAAA" })
      .where(eq(githubConnections.userId, userId));
    const row = await mustRow(userId);
    await dropEntry(userId, row.id);
    const error = await listServerTools(userId, row).then(
      () => { throw new Error("expected the connect to fail"); },
      (err: unknown) => err as Error,
    );
    expect(error.message).toMatch(/reconnect/i);
    expect(error.message).not.toContain(TOKEN);
  });

  it("does not retry a failed connect on every turn, until asked to", async () => {
    const userId = await makeUser();
    await connect(userId, "ghp_refused-for-the-backoff-test");
    await ensureGithubMcpServer(userId);
    const row = await mustRow(userId);

    await expect(listServerTools(userId, row)).rejects.toThrow();
    const afterFirst = mock.requests();
    await expect(listServerTools(userId, row)).rejects.toThrow();
    expect(mock.requests()).toBe(afterFirst);

    // Test (which drops the entry first) always really tries.
    await dropEntry(userId, row.id);
    await expect(listServerTools(userId, row)).rejects.toThrow();
    expect(mock.requests()).toBeGreaterThan(afterFirst);
  });
});
