import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { v4 as uuid } from "uuid";
import Fastify from "fastify";
import { db, eq } from "@loxaic/db";
import { conversations, user } from "@loxaic/db/schema";

/**
 * `POST /v1/conversations` with a kind and a workspace, and `active_run` on
 * the single-conversation read. Auth stubbed, everything else real — the
 * prefs.test.ts shape.
 */
const currentUser = { id: "" };
vi.mock("../../auth/middleware", () => ({
  authenticate: () => Promise.resolve(currentUser.id),
}));

const { conversationRoutes } = await import("../conversations.ts");
const { registerRun, unregisterRun } = await import("../../streams/registry.ts");

const userId = `test-conv-create-${uuid()}`;
const app = Fastify();
conversationRoutes(app);

beforeAll(async () => {
  await app.ready();
  await db.insert(user).values({
    id: userId,
    name: "Conv",
    email: `${userId}@example.test`,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  currentUser.id = userId;
});

afterAll(async () => {
  await db.delete(conversations).where(eq(conversations.ownerId, userId));
  await db.delete(user).where(eq(user.id, userId));
  await app.close();
});

interface Row {
  id: string;
  kind: string;
  workspace: unknown;
  title: string;
  active_run?: boolean;
}

describe("POST /v1/conversations", () => {
  it("defaults to a chat with no workspace, as before", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/conversations", payload: {} });
    expect(res.statusCode).toBe(200);
    const row = res.json<Row>();
    expect(row.kind).toBe("chat");
    expect(row.workspace).toBeNull();
    expect(row.title).toBe("New conversation");
  });

  it("creates an agent conversation with a scratch workspace stored as null", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/conversations",
      payload: { kind: "agent", workspace: { kind: "scratch" } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<Row>().kind).toBe("agent");
    // Indistinguishable from a pre-workspace row on purpose.
    expect(res.json<Row>().workspace).toBeNull();
  });

  it("refuses kinds a client may not open", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/conversations", payload: { kind: "routine" } });
    expect(res.statusCode).toBe(400);
  });

  it("refuses a workspace on a chat", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/conversations",
      payload: { kind: "chat", workspace: { kind: "scratch" } },
    });
    expect(res.statusCode).toBe(400);
  });

  it("refuses a github workspace with no GitHub connection, with the reason", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/conversations",
      payload: { kind: "agent", workspace: { kind: "github", repo: "a/b" } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toMatch(/not connected/);
  });

  it("refuses local for now", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/conversations",
      payload: { kind: "agent", workspace: { kind: "local" } },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /v1/conversations/:id active_run", () => {
  it("is false when nothing is running and true while a run is registered", async () => {
    const created = await app.inject({ method: "POST", url: "/v1/conversations", payload: { kind: "agent" } });
    const id = created.json<Row>().id;

    const idle = await app.inject({ method: "GET", url: `/v1/conversations/${id}` });
    expect(idle.json<Row>().active_run).toBe(false);

    registerRun({ streamId: "s1", conversationId: id, userId, abort: new AbortController(), approvals: new Map() });
    try {
      const busy = await app.inject({ method: "GET", url: `/v1/conversations/${id}` });
      expect(busy.json<Row>().active_run).toBe(true);
    } finally {
      unregisterRun("s1");
    }
  });
});
