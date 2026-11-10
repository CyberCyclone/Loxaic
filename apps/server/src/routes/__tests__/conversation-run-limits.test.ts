import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { v4 as uuid } from "uuid";
import Fastify from "fastify";
import { db, eq } from "@loxaic/db";
import { conversations, conversationShares, user } from "@loxaic/db/schema";
import { LIMITS_ON } from "@loxaic/types";

/**
 * A conversation's progress-review switch: stored per conversation, its
 * owner's alone, and refused where it would leave unwatched what must stay
 * watched. Auth stubbed, everything else real.
 */
const currentUser = { id: "" };
vi.mock("../../auth/middleware", () => ({
  authenticate: () => Promise.resolve(currentUser.id),
}));

const { conversationRoutes } = await import("../conversations.ts");
const { registerRun, unregisterRun } = await import("../../streams/registry.ts");
const { watchConversationEvents } = await import("../../streams/watchers.ts");
const { loadRunLimits } = await import("../../conversations/run-limits.ts");

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

describe("PATCH /v1/conversations/:id, progress review switch", () => {
  it("turns it off and back on", async () => {
    const id = await conversation("chat");
    expect((await patch(id, { progress_review_off: true })).json()).toMatchObject({ progressReviewOff: true });
    expect((await patch(id, { progress_review_off: false })).json()).toMatchObject({ progressReviewOff: false });
  });

  it("offers it on an agent thread, and refuses a routine's or a sub-agent's", async () => {
    expect((await patch(await conversation("agent"), { progress_review_off: true })).statusCode).toBe(200);
    const routine = await conversation("routine");
    expect((await patch(routine, { progress_review_off: true })).statusCode).toBe(400);
    // Nobody owns a sub-agent's conversation, so it is not found before that.
    const child = await conversation("subagent");
    expect((await patch(child, { progress_review_off: true })).statusCode).toBe(404);
    for (const id of [routine, child]) {
      const row = await db.query.conversations.findFirst({ where: eq(conversations.id, id) });
      expect(row?.progressReviewOff).toBe(false);
    }
  });

  it("refuses anything but true or false, even beside a valid change", async () => {
    const id = await conversation("chat");
    expect((await patch(id, { progress_review_off: "yes" })).statusCode).toBe(400);
    expect((await patch(id, { progress_review_off: "yes", model_pref: { model: "m" } })).statusCode).toBe(400);
    const row = await db.query.conversations.findFirst({ where: eq(conversations.id, id) });
    expect(row).toMatchObject({ progressReviewOff: false, modelPref: null });
  });

  it("is the owner's: an editor gets the same 404 as a stranger", async () => {
    const id = await conversation("chat");
    await db.insert(conversationShares).values({ conversationId: id, userId: editor, role: "editor", createdBy: owner });
    currentUser.id = editor;
    try {
      expect((await patch(id, { progress_review_off: true })).statusCode).toBe(404);
    } finally {
      currentUser.id = owner;
    }
  });

  it("leaves it alone on a patch about something else, and says nothing", async () => {
    const id = await conversation("chat");
    await patch(id, { progress_review_off: true });
    const heard: unknown[] = [];
    const stop = watchConversationEvents(id, (event) => { heard.push(event); });
    const res = await patch(id, { model_pref: { model: "m" } });
    stop();
    expect(res.json()).toMatchObject({ progressReviewOff: true });
    expect(heard).toEqual([]);
  });

  it("reaches the run its sender has going, and tells the conversation's watchers", async () => {
    const id = await conversation("chat");
    const handle = { streamId: uuid(), conversationId: id, userId: owner, abort: new AbortController(), approvals: new Map() };
    registerRun(handle);
    const heard: unknown[] = [];
    const stop = watchConversationEvents(id, (event) => { heard.push(event); });
    try {
      await patch(id, { progress_review_off: true });
      expect(handle).toMatchObject({ limits: { progressReviewOff: true } });
      expect(heard).toEqual([{ type: "conversation.limits", conversation_id: id, progress_review_off: true }]);
    } finally {
      stop();
      unregisterRun(handle.streamId);
    }
  });

  it("turns the review back on in a run someone else sent, but never off", async () => {
    const id = await conversation("chat");
    const handle = {
      streamId: uuid(), conversationId: id, userId: editor, abort: new AbortController(), approvals: new Map(),
      limits: { progressReviewOff: false },
    };
    registerRun(handle);
    try {
      await patch(id, { progress_review_off: true });
      expect(handle.limits).toEqual({ progressReviewOff: false });
      handle.limits = { progressReviewOff: true };
      await patch(id, { progress_review_off: false });
      expect(handle.limits).toEqual({ progressReviewOff: false });
    } finally {
      unregisterRun(handle.streamId);
    }
  });
});

describe("loadRunLimits", () => {
  it("is the review on for a routine or a sub-agent, whatever its column says", async () => {
    for (const kind of ["routine", "subagent"] as const) {
      const id = await conversation(kind);
      await db.update(conversations).set({ progressReviewOff: true }).where(eq(conversations.id, id));
      expect(await loadRunLimits(id)).toEqual(LIMITS_ON);
    }
    const chat = await conversation("chat");
    await db.update(conversations).set({ progressReviewOff: true }).where(eq(conversations.id, chat));
    expect(await loadRunLimits(chat)).toEqual({ progressReviewOff: true });
  });
});

describe("POST /v1/conversations, progress review switch", () => {
  it("stores what a client chose before the conversation existed", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/conversations",
      payload: { kind: "agent", workspace: { kind: "scratch" }, run_limits: { progress_review_off: true } },
    });
    expect(res.json()).toMatchObject({ progressReviewOff: true });
  });

  it("ignores a value that is not true or false, and has the review on otherwise", async () => {
    const odd = await app.inject({ method: "POST", url: "/v1/conversations", payload: { run_limits: { progress_review_off: "x" } } });
    expect(odd.json()).toMatchObject({ progressReviewOff: false });
    const res = await app.inject({ method: "POST", url: "/v1/conversations", payload: {} });
    expect(res.json()).toMatchObject({ progressReviewOff: false });
  });
});
