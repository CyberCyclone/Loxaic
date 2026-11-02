import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { v4 as uuid } from "uuid";
import Fastify from "fastify";
import { db, eq } from "@loxaic/db";
import { conversations, conversationShares, user } from "@loxaic/db/schema";

/**
 * A conversation's step limit and loop check: stored per conversation, its
 * owner's alone, and refused where they would unbound what must stay bounded.
 * Auth stubbed, everything else real.
 */
const currentUser = { id: "" };
vi.mock("../../auth/middleware", () => ({
  authenticate: () => Promise.resolve(currentUser.id),
}));

const { conversationRoutes } = await import("../conversations.ts");
const { registerRun, unregisterRun } = await import("../../streams/registry.ts");
const { watchConversationEvents } = await import("../../streams/watchers.ts");

const owner = `test-run-limits-${uuid()}`;
const editor = `test-run-limits-${uuid()}`;
const app = Fastify();
conversationRoutes(app);

async function conversation(kind: "chat" | "agent" | "routine" | "subagent"): Promise<string> {
  const [row] = await db.insert(conversations).values({ ownerId: owner, title: "limits", kind }).returning();
  return row.id;
}

const patch = (id: string, payload: object) => app.inject({ method: "PATCH", url: `/v1/conversations/${id}`, payload });

beforeAll(async () => {
  await app.ready();
  for (const id of [owner, editor]) {
    await db.insert(user).values({ id, name: "Limits", email: `${id}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
  }
  currentUser.id = owner;
});

afterAll(async () => {
  await db.delete(conversations).where(eq(conversations.ownerId, owner));
  await db.delete(user).where(eq(user.id, owner));
  await db.delete(user).where(eq(user.id, editor));
  await app.close();
});

describe("PATCH /v1/conversations/:id, run limits", () => {
  it("turns each off and back on, independently", async () => {
    const id = await conversation("chat");
    expect((await patch(id, { step_limit_off: true })).json()).toMatchObject({ stepLimitOff: true, loopCheckOff: false });
    expect((await patch(id, { loop_check_off: true })).json()).toMatchObject({ stepLimitOff: true, loopCheckOff: true });
    expect((await patch(id, { step_limit_off: false })).json()).toMatchObject({ stepLimitOff: false, loopCheckOff: true });
  });

  it("offers them on an agent thread, and refuses a routine's or a sub-agent's", async () => {
    expect((await patch(await conversation("agent"), { loop_check_off: true })).statusCode).toBe(200);
    const routine = await conversation("routine");
    expect((await patch(routine, { step_limit_off: true })).statusCode).toBe(400);
    // Nobody owns a sub-agent's conversation, so it is not found before that.
    const child = await conversation("subagent");
    expect((await patch(child, { step_limit_off: true })).statusCode).toBe(404);
    for (const id of [routine, child]) {
      const row = await db.query.conversations.findFirst({ where: eq(conversations.id, id) });
      expect(row?.stepLimitOff).toBe(false);
    }
  });

  it("refuses anything but true or false", async () => {
    const id = await conversation("chat");
    expect((await patch(id, { step_limit_off: "yes" })).statusCode).toBe(400);
  });

  it("is the owner's: an editor gets the same 404 as a stranger", async () => {
    const id = await conversation("chat");
    await db.insert(conversationShares).values({ conversationId: id, userId: editor, role: "editor", createdBy: owner });
    currentUser.id = editor;
    try {
      expect((await patch(id, { step_limit_off: true })).statusCode).toBe(404);
    } finally {
      currentUser.id = owner;
    }
  });

  it("leaves them alone on a patch about something else, and says nothing", async () => {
    const id = await conversation("chat");
    await patch(id, { step_limit_off: true });
    const heard: unknown[] = [];
    const stop = watchConversationEvents(id, (event) => { heard.push(event); });
    const res = await patch(id, { model_pref: { model: "m" } });
    stop();
    expect(res.json()).toMatchObject({ stepLimitOff: true });
    expect(heard).toEqual([]);
  });

  it("reaches the run its sender has going, and tells the conversation's watchers", async () => {
    const id = await conversation("chat");
    const handle = { streamId: uuid(), conversationId: id, userId: owner, abort: new AbortController(), approvals: new Map() };
    registerRun(handle);
    const heard: unknown[] = [];
    const stop = watchConversationEvents(id, (event) => { heard.push(event); });
    try {
      await patch(id, { loop_check_off: true });
      expect(handle).toMatchObject({ limits: { stepLimitOff: false, loopCheckOff: true } });
      expect(heard).toEqual([{ type: "conversation.limits", conversation_id: id, step_limit_off: false, loop_check_off: true }]);
    } finally {
      stop();
      unregisterRun(handle);
    }
  });
});

describe("POST /v1/conversations, run limits", () => {
  it("stores what a client chose before the conversation existed", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/conversations",
      payload: { kind: "agent", workspace: { kind: "scratch" }, run_limits: { step_limit_off: true, loop_check_off: "x" } },
    });
    expect(res.json()).toMatchObject({ stepLimitOff: true, loopCheckOff: false });
  });

  it("has every limit on otherwise", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/conversations", payload: {} });
    expect(res.json()).toMatchObject({ stepLimitOff: false, loopCheckOff: false });
  });
});
