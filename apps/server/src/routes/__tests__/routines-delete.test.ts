import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { v4 as uuid } from "uuid";
import Fastify from "fastify";
import { and, db, eq, inArray, isNull } from "@loxaic/db";
import { conversations, messages, routineRuns, routines, usageRecords, user } from "@loxaic/db/schema";

/**
 * Deleting a routine deletes it — #179.
 *
 * It used to set `enabled = false` and answer `{ok: true}`, so the client
 * dropped the row, said "Routine deleted", and the next refresh put it back
 * disabled. The chats its runs had produced stayed forever, reachable by
 * nothing.
 *
 * On the `conversations-delete.test.ts` harness, for the same reasons: real
 * Fastify `inject`, only authentication stubbed, and retention pinned per case
 * through the environment rather than through the settings row, which is
 * global and shared with every other suite in this Postgres.
 *
 * The retention split is the point of half of these. A routine's chat can be
 * continued by hand, which makes it an ordinary conversation as far as an
 * audit is concerned — so deleting the routine must go through the same
 * policy-aware path "Delete chat" does, and must not become a way around it.
 */
const currentUser = { id: "" };

vi.mock("../../auth/middleware", () => ({
  authenticate: () => Promise.resolve(currentUser.id),
  requireAdmin: () => Promise.resolve(currentUser.id),
}));

/** Makes the next `deleteConversation` throw, once — the transient failure
 * (a database blip, a retention read, a sandbox destroy surfacing) that the
 * delete route has to survive without leaving the routine half-gone. */
const failNextDelete = { on: false };

vi.mock("../../conversations/delete.ts", async (original) => {
  const real = await original<typeof import("../../conversations/delete.ts")>();
  return {
    ...real,
    deleteConversation: (...args: Parameters<typeof real.deleteConversation>) => {
      if (failNextDelete.on) {
        failNextDelete.on = false;
        return Promise.reject(new Error("transient failure"));
      }
      return real.deleteConversation(...args);
    },
  };
});

const { routineRoutes } = await import("../routines.ts");
const { isRoutineScheduled, stopRoutineScheduler } = await import("../../routines/scheduler.ts");
const { restoreConversation, purgeConversation } = await import("../../conversations/delete.ts");
const { registerRun, unregisterRun } = await import("../../streams/registry.ts");

const owner = `test-rdel-owner-${uuid()}`;
const stranger = `test-rdel-stranger-${uuid()}`;
const everyone = [owner, stranger];

const app = Fastify();

function as(userId: string) {
  currentUser.id = userId;
}

function retentionOff() {
  process.env.DELETED_CHAT_RETENTION_ENABLED = "0";
  delete process.env.DELETED_CHAT_RETENTION_DAYS;
}

function retentionOn(days = 30) {
  process.env.DELETED_CHAT_RETENTION_ENABLED = "1";
  process.env.DELETED_CHAT_RETENTION_DAYS = String(days);
}

async function makeRoutine(ownerId = owner, name = "Nightly") {
  const [r] = await db
    .insert(routines)
    .values({ ownerId, name, cron: "0 6 * * *", prompt: "do the thing", model: "test-model" })
    .returning();
  return r;
}

/** A run and the chat it produced, as `executeRoutine` writes them. */
async function makeRun(routineId: string, ownerId = owner) {
  const [conv] = await db
    .insert(conversations)
    .values({ ownerId, title: "Routine: Nightly", kind: "routine" })
    .returning();
  const [run] = await db
    .insert(routineRuns)
    .values({ routineId, conversationId: conv.id, status: "completed", finishedAt: new Date() })
    .returning();
  await db.insert(messages).values({
    id: uuid(),
    conversationId: conv.id,
    parentId: null,
    authorType: "user",
    authorUserId: ownerId,
    origin: "server",
    lamport: Date.now(),
    content: [{ kind: "text", text: "do the thing" }],
    status: "complete",
    createdAt: new Date(),
  });
  return { runId: run.id, convId: conv.id };
}

async function conversationRow(convId: string) {
  return db.query.conversations.findFirst({ where: eq(conversations.id, convId) });
}

async function runRowsFor(routineId: string) {
  return db.select().from(routineRuns).where(eq(routineRuns.routineId, routineId));
}

/** The delete's cleanup detaches from the response on purpose. */
async function settle() {
  await new Promise((r) => setTimeout(r, 50));
}

beforeAll(async () => {
  routineRoutes(app);
  await app.ready();
  await db.insert(user).values(
    everyone.map((id) => ({
      id,
      name: "Person",
      email: `${id}@example.test`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
  );
});

beforeEach(() => {
  retentionOff();
  as(owner);
});

afterEach(async () => {
  retentionOff();
  // Scoped to this suite's own users — an unscoped delete would take every
  // other suite's rows out from under them (AGENTS.md records exactly that
  // bug in git.test.ts).
  await db.delete(routines).where(inArray(routines.ownerId, everyone));
  const own = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(inArray(conversations.ownerId, everyone));
  const ids = own.map((c) => c.id);
  if (ids.length) {
    await db.delete(routineRuns).where(inArray(routineRuns.conversationId, ids));
    await db.delete(messages).where(inArray(messages.conversationId, ids));
    await db.delete(usageRecords).where(inArray(usageRecords.conversationId, ids));
    await db.delete(conversations).where(inArray(conversations.id, ids));
  }
  // Detached usage rows keep their user, which is the point of them — and
  // which blocks deleting these test users in afterAll if they are left.
  await db.delete(usageRecords).where(inArray(usageRecords.userId, everyone));
});

afterAll(async () => {
  stopRoutineScheduler();
  delete process.env.DELETED_CHAT_RETENTION_ENABLED;
  delete process.env.DELETED_CHAT_RETENTION_DAYS;
  await db.delete(user).where(inArray(user.id, everyone));
  await app.close();
});

describe("DELETE /v1/routines/:id — retention off", () => {
  it("removes the routine, its runs, and the chats they produced", async () => {
    const routine = await makeRoutine();
    const a = await makeRun(routine.id);
    const b = await makeRun(routine.id);

    const res = await app.inject({ method: "DELETE", url: `/v1/routines/${routine.id}` });
    expect(res.statusCode).toBe(200);
    await settle();

    expect(await db.query.routines.findFirst({ where: eq(routines.id, routine.id) })).toBeUndefined();
    expect(await runRowsFor(routine.id)).toHaveLength(0);
    for (const { convId } of [a, b]) {
      expect(await conversationRow(convId)).toBeUndefined();
      const left = await db.select().from(messages).where(eq(messages.conversationId, convId));
      expect(left).toHaveLength(0);
    }
  });

  it("no longer lists it — which is the whole bug", async () => {
    const routine = await makeRoutine();
    await app.inject({ method: "DELETE", url: `/v1/routines/${routine.id}` });

    const list = await app.inject({ method: "GET", url: "/v1/routines" });
    const rows = list.json<{ id: string }[]>();
    // It used to come back here with `enabled: false`, seconds after the UI
    // said it had been deleted.
    expect(rows.find((r) => r.id === routine.id)).toBeUndefined();
  });

  it("keeps the usage records, detached", async () => {
    const routine = await makeRoutine();
    const { convId } = await makeRun(routine.id);
    const usageId = uuid();
    await db.insert(usageRecords).values({
      id: usageId,
      userId: owner,
      conversationId: convId,
      model: "test-model",
      inputTokens: 100,
      outputTokens: 20,
    });

    await app.inject({ method: "DELETE", url: `/v1/routines/${routine.id}` });
    await settle();

    // The tokens were spent; the Stats screen's lifetime totals are made of
    // these. What must not survive is the pointer to a conversation that is
    // gone.
    const row = await db.query.usageRecords.findFirst({ where: eq(usageRecords.id, usageId) });
    expect(row).toBeDefined();
    expect(row?.conversationId).toBeNull();
  });

  it("aborts a run still going in one of its chats", async () => {
    const routine = await makeRoutine();
    const { convId } = await makeRun(routine.id);
    const abort = new AbortController();
    const streamId = uuid();
    registerRun({ streamId, conversationId: convId, userId: owner, abort, approvals: new Map() });

    try {
      await app.inject({ method: "DELETE", url: `/v1/routines/${routine.id}` });
      await settle();
      expect(abort.signal.aborted).toBe(true);
    } finally {
      unregisterRun(streamId);
    }
  });
});

describe("DELETE /v1/routines/:id — retention on", () => {
  beforeEach(() => {
    retentionOn(30);
  });

  it("retains the chats for the audit, and still removes the routine", async () => {
    const routine = await makeRoutine();
    const { convId } = await makeRun(routine.id);

    await app.inject({ method: "DELETE", url: `/v1/routines/${routine.id}` });
    await settle();

    // The routine is gone either way — retention is about conversations.
    expect(await db.query.routines.findFirst({ where: eq(routines.id, routine.id) })).toBeUndefined();
    const conv = await conversationRow(convId);
    expect(conv?.deletedAt).not.toBeNull();
    // Retained means the content is still there for an admin to read.
    const left = await db.select().from(messages).where(eq(messages.conversationId, convId));
    expect(left).toHaveLength(1);
  });

  it("restores a retained routine chat as an ordinary chat", async () => {
    const routine = await makeRoutine();
    const { convId } = await makeRun(routine.id);
    await app.inject({ method: "DELETE", url: `/v1/routines/${routine.id}` });
    await settle();

    await restoreConversation(convId);

    // Only a routine lists its own conversations, and this one's routine is
    // gone — left as `kind: "routine"` it would come back where nothing can
    // reach it, restored in name only.
    const conv = await conversationRow(convId);
    expect(conv?.deletedAt).toBeNull();
    expect(conv?.kind).toBe("chat");
  });
});

describe("DELETE /v1/routines/:id — a delete that fails halfway", () => {
  it("leaves the routine scheduled, so a retry is a retry and not a silent stop", async () => {
    // Created through the route, because that is what schedules it.
    const created = await app.inject({
      method: "POST",
      url: "/v1/routines",
      payload: { name: "Halfway", cron: "0 6 * * *", prompt: "do the thing", model: "test-model" },
    });
    const routine = created.json<{ id: string }>();
    await makeRun(routine.id);
    expect(isRoutineScheduled(routine.id)).toBe(true);

    failNextDelete.on = true;
    const failed = await app.inject({ method: "DELETE", url: `/v1/routines/${routine.id}` });
    expect(failed.statusCode).toBe(500);

    // The row survives, which was always true. The schedule has to as well:
    // unscheduling used to happen first, and nothing re-adds a job outside
    // POST, PATCH and boot — so the routine came back in the list looking
    // enabled and never fired again until a restart.
    expect(await db.query.routines.findFirst({ where: eq(routines.id, routine.id) })).toBeDefined();
    expect(isRoutineScheduled(routine.id)).toBe(true);

    const retried = await app.inject({ method: "DELETE", url: `/v1/routines/${routine.id}` });
    expect(retried.statusCode).toBe(200);
    expect(isRoutineScheduled(routine.id)).toBe(false);
  });
});

describe("DELETE /v1/routines/:id — who may", () => {
  it("404s for a routine that is not yours, and changes nothing", async () => {
    const routine = await makeRoutine();
    as(stranger);
    const res = await app.inject({ method: "DELETE", url: `/v1/routines/${routine.id}` });
    expect(res.statusCode).toBe(404);
    as(owner);
    expect(await db.query.routines.findFirst({ where: eq(routines.id, routine.id) })).toBeDefined();
  });

  it("404s for an id that does not exist — which is what a second delete is", async () => {
    const routine = await makeRoutine();
    expect((await app.inject({ method: "DELETE", url: `/v1/routines/${routine.id}` })).statusCode).toBe(200);
    expect((await app.inject({ method: "DELETE", url: `/v1/routines/${routine.id}` })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `/v1/routines/${uuid()}` })).statusCode).toBe(404);
  });
});

describe("erasing one chat of a routine", () => {
  it("takes its run row with it, leaving no run pointing at a chat that is gone", async () => {
    const routine = await makeRoutine();
    const a = await makeRun(routine.id);
    const b = await makeRun(routine.id);

    await purgeConversation(a.convId, { warn: () => undefined });
    await settle();

    const rows = await runRowsFor(routine.id);
    // The other run is untouched: deleting one of a routine's chats is not
    // deleting the routine.
    expect(rows.map((r) => r.conversationId)).toEqual([b.convId]);
    expect(await db.query.routines.findFirst({ where: eq(routines.id, routine.id) })).toBeDefined();
  });

  it("drops it from the routine's own history while it is retained", async () => {
    retentionOn(30);
    const routine = await makeRoutine();
    const a = await makeRun(routine.id);
    const b = await makeRun(routine.id);
    const { deleteConversation } = await import("../../conversations/delete.ts");
    await deleteConversation(a.convId, { warn: () => undefined });
    await settle();

    const res = await app.inject({ method: "GET", url: `/v1/routines/${routine.id}/conversations` });
    const rows = res.json<{ id: string }[]>();
    // Retained is invisible on every ordinary path, and a routine's history is
    // one of them.
    expect(rows.map((r) => r.id)).toEqual([b.convId]);

    const runs = await app.inject({ method: "GET", url: `/v1/routines/${routine.id}/runs` });
    expect(runs.json<{ conversationId: string }[]>().map((r) => r.conversationId)).toEqual([b.convId]);
  });
});

describe("the sweep and the delete agree", () => {
  it("leaves nothing behind when a retained routine chat is finally erased", async () => {
    retentionOn(30);
    const routine = await makeRoutine();
    const { convId } = await makeRun(routine.id);
    await app.inject({ method: "DELETE", url: `/v1/routines/${routine.id}` });
    await settle();

    // The routine delete removed the run rows; the reaper erases the chat
    // later. Neither step may leave the other's rows orphaned.
    await purgeConversation(convId, { warn: () => undefined });
    await settle();
    expect(await conversationRow(convId)).toBeUndefined();
    const stillDeleted = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.ownerId, owner), isNull(conversations.deletedAt)));
    expect(stillDeleted).toHaveLength(0);
  });
});
