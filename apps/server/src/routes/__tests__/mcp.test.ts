import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { v4 as uuid } from "uuid";
import Fastify from "fastify";
import { db, eq } from "@loxaic/db";
import { githubConnections, mcpServers, user } from "@loxaic/db/schema";
import { deleteConnection, upsertConnection } from "../../github/connection.ts";

process.env.MCP_ENCRYPTION_KEY ??= "mcp-routes-test-key";

/**
 * The parts of `/v1/mcp/*` that differ for a credential-linked server — the
 * GitHub one, which follows the GitHub connection. Auth is stubbed, the
 * database is real (same shape as github.test.ts).
 */
const currentUser = { id: "" };
vi.mock("../../auth/middleware", () => ({
  authenticate: () => Promise.resolve(currentUser.id),
}));

// Wrapped, not replaced: counts how often an edit drops a server's live
// connections, which a change to its per-kind defaults must not do.
const closeServerClients = vi.hoisted(() => vi.fn());
vi.mock("../../mcp/client-manager.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../mcp/client-manager.ts")>();
  return {
    ...real,
    closeServerClients: (id: string) => {
      closeServerClients(id);
      return real.closeServerClients(id);
    },
  };
});

const { mcpRoutes } = await import("../mcp.ts");

const userId = `test-mcp-routes-${uuid()}`;
const app = Fastify();
mcpRoutes(app);

beforeAll(async () => {
  await app.ready();
  await db.insert(user).values({
    id: userId,
    name: "MCP Routes Test",
    email: `${userId}@example.test`,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  currentUser.id = userId;
});

afterEach(async () => {
  await db.delete(mcpServers).where(eq(mcpServers.ownerId, userId));
  await db.delete(githubConnections).where(eq(githubConnections.userId, userId));
});

afterAll(async () => {
  await db.delete(user).where(eq(user.id, userId));
  await app.close();
});

async function connectGithub() {
  await upsertConnection(userId, { token: "ghp_routes-test", login: "octocat", name: null, email: null, scopes: "repo" });
}

async function createGithubServer(): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/v1/mcp/servers", payload: { builtinKey: "github" } });
  expect(res.statusCode).toBe(200);
  return res.json<{ id: string }>().id;
}

describe("the GitHub catalog entry", () => {
  it("says where its credential comes from instead of asking for one", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/mcp/catalog" });
    const entries = res.json<{ key: string; transport: string; secretKeys: unknown[]; credentials: string | null }[]>();
    expect(entries.find((e) => e.key === "github")).toMatchObject({
      transport: "http",
      secretKeys: [],
      credentials: "github-connection",
    });
    expect(entries.find((e) => e.key === "brave")).toMatchObject({ transport: "stdio", credentials: null });
  });

  it("cannot be added without a GitHub connection", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/mcp/servers", payload: { builtinKey: "github" } });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toContain("Settings → GitHub");
    expect(await db.query.mcpServers.findFirst({ where: eq(mcpServers.ownerId, userId) })).toBeUndefined();
  });

  it("is added from the connection, ignoring any address or credential in the request", async () => {
    await connectGithub();
    const res = await app.inject({
      method: "POST",
      url: "/v1/mcp/servers",
      payload: { builtinKey: "github", url: "http://169.254.169.254/", secrets: { GITHUB_TOKEN: "planted" } },
    });
    expect(res.statusCode).toBe(200);
    const row = await db.query.mcpServers.findFirst({ where: eq(mcpServers.ownerId, userId) });
    expect(row).toMatchObject({ url: "https://api.githubcopilot.com/mcp/", secrets: null, allowPrivateNetwork: false });
  });
});

describe("a linked GitHub server", () => {
  it("refuses deletion while GitHub is connected, and says what to do instead", async () => {
    await connectGithub();
    const id = await createGithubServer();
    const res = await app.inject({ method: "DELETE", url: `/v1/mcp/servers/${id}` });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toMatch(/Switch them off here, or disconnect GitHub/);
    expect(await db.query.mcpServers.findFirst({ where: eq(mcpServers.id, id) })).toBeDefined();
  });

  it("can be deleted once the connection is gone, so a half-finished disconnect is never stuck", async () => {
    await connectGithub();
    const id = await createGithubServer();
    await deleteConnection(userId);
    const res = await app.inject({ method: "DELETE", url: `/v1/mcp/servers/${id}` });
    expect(res.statusCode).toBe(200);
  });

  it("refuses edits to its address, credential or network exception", async () => {
    await connectGithub();
    const id = await createGithubServer();
    for (const payload of [
      { url: "https://example.test/mcp" },
      { headers: { Authorization: "Bearer planted" } },
      { secrets: { GITHUB_TOKEN: "planted" } },
      { allowPrivateNetwork: true },
    ]) {
      const res = await app.inject({ method: "PATCH", url: `/v1/mcp/servers/${id}`, payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    const row = await db.query.mcpServers.findFirst({ where: eq(mcpServers.id, id) });
    expect(row).toMatchObject({ url: "https://api.githubcopilot.com/mcp/", headers: null, secrets: null, allowPrivateNetwork: false });
  });

  it("can still be renamed, switched off, and have its tool policies changed", async () => {
    await connectGithub();
    const id = await createGithubServer();
    const res = await app.inject({
      method: "PATCH",
      url: `/v1/mcp/servers/${id}`,
      payload: { name: "Work GitHub", enabled: false, toolPolicies: { create_pull_request: { approval: "allow" } } },
    });
    expect(res.statusCode).toBe(200);
    const row = await db.query.mcpServers.findFirst({ where: eq(mcpServers.id, id) });
    expect(row).toMatchObject({ name: "Work GitHub", enabled: false });
    expect((row?.toolPolicies as Record<string, { approval: string }>).create_pull_request.approval).toBe("allow");
  });
});

describe("per-kind defaults", () => {
  async function stdioServer(): Promise<string> {
    const [row] = await db
      .insert(mcpServers)
      .values({ ownerId: userId, name: "Plain", slug: `plain-${uuid().slice(0, 8)}`, transport: "stdio", command: "true" })
      .returning();
    return row.id;
  }

  it("starts on everywhere", async () => {
    const id = await stdioServer();
    const row = await db.query.mcpServers.findFirst({ where: eq(mcpServers.id, id) });
    expect(row).toMatchObject({ onInChat: true, onInAgent: true, onInRoutines: true });
  });

  it("sets each kind independently", async () => {
    const id = await stdioServer();
    const res = await app.inject({ method: "PATCH", url: `/v1/mcp/servers/${id}`, payload: { onInChat: false } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ onInChat: false, onInAgent: true, onInRoutines: true });
    await app.inject({ method: "PATCH", url: `/v1/mcp/servers/${id}`, payload: { onInRoutines: false, onInChat: true } });
    const row = await db.query.mcpServers.findFirst({ where: eq(mcpServers.id, id) });
    expect(row).toMatchObject({ onInChat: true, onInAgent: true, onInRoutines: false });
  });

  it("refuses a value that is not a boolean, and changes nothing", async () => {
    const id = await stdioServer();
    const res = await app.inject({
      method: "PATCH",
      url: `/v1/mcp/servers/${id}`,
      payload: { onInAgent: "false", name: "Renamed" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toContain("onInAgent");
    const row = await db.query.mcpServers.findFirst({ where: eq(mcpServers.id, id) });
    expect(row).toMatchObject({ onInAgent: true, name: "Plain" });
  });

  it("are stored as asked when a server is added, not quietly left on", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/mcp/servers",
      payload: { name: "Off for routines", slug: `off-${uuid().slice(0, 8)}`, transport: "stdio", command: "true", onInRoutines: false },
    });
    expect(res.statusCode).toBe(200);
    const { id } = res.json<{ id: string }>();
    expect(res.json()).toMatchObject({ onInChat: true, onInAgent: true, onInRoutines: false });
    const row = await db.query.mcpServers.findFirst({ where: eq(mcpServers.id, id) });
    expect(row).toMatchObject({ onInChat: true, onInAgent: true, onInRoutines: false });
  });

  it("are refused when malformed on add, and nothing is added", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/mcp/servers",
      payload: { name: "Bad", slug: `bad-${uuid().slice(0, 8)}`, transport: "stdio", command: "true", onInChat: "no" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toContain("onInChat");
    expect(await db.query.mcpServers.findFirst({ where: eq(mcpServers.ownerId, userId) })).toBeUndefined();
  });

  it("leave the server's connection alone when they are all that changed", async () => {
    const id = await stdioServer();
    const before = await db.query.mcpServers.findFirst({ where: eq(mcpServers.id, id) });
    closeServerClients.mockClear();
    await app.inject({ method: "PATCH", url: `/v1/mcp/servers/${id}`, payload: { onInChat: false, onInAgent: false } });
    const after = await db.query.mcpServers.findFirst({ where: eq(mcpServers.id, id) });
    // The stamp is what bypasses the connect-failure cache; it must not move.
    expect(after?.updatedAt.getTime()).toBe(before?.updatedAt.getTime());
    expect(closeServerClients).not.toHaveBeenCalled();

    // Anything else in the same request is a connection change as before.
    await app.inject({ method: "PATCH", url: `/v1/mcp/servers/${id}`, payload: { onInChat: true, command: "false" } });
    const changed = await db.query.mcpServers.findFirst({ where: eq(mcpServers.id, id) });
    expect(changed?.updatedAt.getTime()).toBeGreaterThan(before?.updatedAt.getTime() ?? 0);
    expect(closeServerClients).toHaveBeenCalledWith(id);
  });

  it("can be changed on the GitHub server, which follows the connection", async () => {
    await connectGithub();
    const id = await createGithubServer();
    const res = await app.inject({ method: "PATCH", url: `/v1/mcp/servers/${id}`, payload: { onInChat: false } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ onInChat: false });
  });
});
