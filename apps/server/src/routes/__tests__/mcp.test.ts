import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { v4 as uuid } from "uuid";
import Fastify from "fastify";
import { db, eq } from "@loxaic/db";
import { mcpServers, user } from "@loxaic/db/schema";

process.env.MCP_ENCRYPTION_KEY ??= "mcp-routes-test-key";

/**
 * `/v1/mcp/*`: the built-in catalog and per-kind defaults. Auth is stubbed,
 * the database is real (same shape as github.test.ts).
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
});

afterAll(async () => {
  await db.delete(user).where(eq(user.id, userId));
  await app.close();
});


describe("the catalog", () => {
  it("offers no GitHub server, and refuses one by its old key", async () => {
    // GitHub is reached with git and gh through the egress proxy (egress/).
    const catalog = await app.inject({ method: "GET", url: "/v1/mcp/catalog" });
    expect(catalog.json<{ key: string }[]>().map((e) => e.key)).not.toContain("github");
    const res = await app.inject({ method: "POST", url: "/v1/mcp/servers", payload: { builtinKey: "github" } });
    expect(res.statusCode).toBe(400);
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
});

describe("adding a server whose slug you already use", () => {
  // No pre-check: the unique index is what refuses it, so this is the path
  // every duplicate takes. Since drizzle-orm 0.44 the Postgres error sits on
  // the query error's `cause`, and the message carries the bound parameters.
  it("answers 409, never a 500 that repeats the secrets it was sent", async () => {
    const slug = `dup-${uuid().slice(0, 8)}`;
    const add = (name: string) =>
      app.inject({
        method: "POST",
        url: "/v1/mcp/servers",
        payload: { name, slug, transport: "stdio", command: "true", secrets: { API_KEY: "sk-dup-secret-value" } },
      });
    expect((await add("First")).statusCode).toBe(200);
    const second = await add("Second");
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ error: "A server with that slug already exists" });
    expect(second.body).not.toContain("sk-dup-secret-value");
    const rows = await db.query.mcpServers.findMany({ where: eq(mcpServers.ownerId, userId) });
    expect(rows.map((r) => r.name)).toEqual(["First"]);
  });
});
