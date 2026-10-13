import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { v4 as uuid } from "uuid";
import Fastify from "fastify";
import { db, eq } from "@loxaic/db";
import { conversations, messages, user } from "@loxaic/db/schema";
import type { ContentBlock } from "@loxaic/types";

/**
 * `GET /v1/conversations/:id/todos` answers the agent's newest todo list.
 *
 * The client's list used to live only in the run's stream, so it went blank on
 * the next turn and after a reload; and history arrives a page at a time, so
 * the call that wrote the list can be on a page the client has not loaded.
 * Only authentication is stubbed.
 */
const currentUser = { id: "" };

vi.mock("../../auth/middleware", () => ({
  authenticate: () => Promise.resolve(currentUser.id),
  requireAdmin: () => Promise.resolve(currentUser.id),
}));

const { conversationRoutes } = await import("../conversations.ts");

describe("GET /v1/conversations/:id/todos", () => {
  const owner = `test-latest-todos-${uuid()}`;
  const app = Fastify();
  const convIds: string[] = [];
  let lamport = 1_000;

  beforeAll(async () => {
    conversationRoutes(app);
    await app.ready();
    currentUser.id = owner;
    await db.insert(user).values({
      id: owner,
      name: "Test Latest Todos",
      email: `${owner}@example.test`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  afterAll(async () => {
    for (const id of convIds) {
      await db.delete(messages).where(eq(messages.conversationId, id));
      await db.delete(conversations).where(eq(conversations.id, id));
    }
    await db.delete(user).where(eq(user.id, owner));
    await app.close();
  });

  async function conversation(kind: "agent" | "chat"): Promise<string> {
    const [row] = await db.insert(conversations).values({ ownerId: owner, title: "todos", kind }).returning();
    convIds.push(row.id);
    return row.id;
  }

  /** One assistant row calling todo_write, and its tool row. */
  async function write(convId: string, todos: unknown, ok: boolean | undefined): Promise<void> {
    const assistantId = uuid();
    const callId = `call-${uuid()}`;
    await db.insert(messages).values({
      id: assistantId,
      conversationId: convId,
      authorType: "assistant",
      lamport: lamport++,
      content: [{ kind: "tool_call", call_id: callId, tool: "todo_write", args: { todos } }] as ContentBlock[],
      status: "complete",
    });
    await db.insert(messages).values({
      id: uuid(),
      conversationId: convId,
      parentId: assistantId,
      authorType: "tool",
      lamport: lamport++,
      content: [{ kind: "tool_result", call_id: callId, output: "Todo list updated", ...(ok === undefined ? {} : { ok }) }] as ContentBlock[],
      status: "complete",
    });
  }

  const get = async (convId: string) =>
    (await app.inject({ method: "GET", url: `/v1/conversations/${convId}/todos` })).json<Record<string, unknown>>();

  it("is the newest list the tool accepted", async () => {
    const convId = await conversation("agent");
    await write(convId, [{ id: "1", text: "Old", status: "completed" }], true);
    await write(convId, [{ id: "1", text: "Schema", status: "completed" }, { id: "2", text: "Routes", status: "in_progress" }], true);
    // Newest, but refused: not the agent's list.
    await write(convId, "not a list", false);
    expect((await get(convId)).todos).toEqual([
      { id: "1", text: "Schema", status: "completed" },
      { id: "2", text: "Routes", status: "in_progress" },
    ]);
  });

  it("reads a call from before results carried `ok` as accepted", async () => {
    const convId = await conversation("agent");
    await write(convId, [{ text: "Unnumbered", status: "pending" }], undefined);
    expect((await get(convId)).todos).toEqual([{ id: "1", text: "Unnumbered", status: "pending" }]);
  });

  it("is null for an agent conversation with no list, and for a chat", async () => {
    expect((await get(await conversation("agent"))).todos).toBeNull();
    expect((await get(await conversation("chat"))).todos).toBeNull();
  });

  it("finds a list behind newer tool calls of other kinds", async () => {
    // The scan is bounded to rows that contain a todo_write call, so any
    // amount of other work after the list does not push it out of reach.
    const convId = await conversation("agent");
    await write(convId, [{ id: "1", text: "Behind", status: "in_progress" }], true);
    for (let i = 0; i < 30; i++) {
      await db.insert(messages).values({
        id: uuid(),
        conversationId: convId,
        authorType: "assistant",
        lamport: lamport++,
        content: [{ kind: "tool_call", call_id: `other-${String(i)}`, tool: "bash", args: { command: "ls" } }] as ContentBlock[],
        status: "complete",
      });
    }
    expect((await get(convId)).todos).toEqual([{ id: "1", text: "Behind", status: "in_progress" }]);
  });

  it("is not on the conversation's own read", async () => {
    const convId = await conversation("agent");
    await write(convId, [{ id: "1", text: "Schema", status: "pending" }], true);
    const conv = (await app.inject({ method: "GET", url: `/v1/conversations/${convId}` })).json<Record<string, unknown>>();
    expect("latest_todos" in conv).toBe(false);
  });

  it("is a 404 for a conversation the caller cannot see", async () => {
    const res = await app.inject({ method: "GET", url: `/v1/conversations/${uuid()}/todos` });
    expect(res.statusCode).toBe(404);
  });

  it("leaves out a list a rewind removed", async () => {
    const convId = await conversation("agent");
    await write(convId, [{ id: "1", text: "Kept", status: "pending" }], true);
    await write(convId, [{ id: "1", text: "Rewound", status: "pending" }], true);
    const rows = await db.query.messages.findMany({ where: eq(messages.conversationId, convId) });
    const newest = rows.filter((r) => r.authorType === "assistant").sort((a, b) => b.lamport - a.lamport)[0];
    await db.update(messages).set({ deletedAt: new Date() }).where(eq(messages.id, newest.id));
    expect((await get(convId)).todos).toEqual([{ id: "1", text: "Kept", status: "pending" }]);
  });
});
