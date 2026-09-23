import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useServableModels } from "../../llama/__tests__/servable-model.ts";
import { v4 as uuid } from "uuid";
import Fastify from "fastify";
import { db, eq, inArray } from "@loxaic/db";
import { conversations, messages, routineRuns, routines, usageRecords, user } from "@loxaic/db/schema";

/**
 * The routine routes a client actually drives — #179.
 *
 * Two things are being held here. First, a routine's model and cron are
 * validated at the write rather than discovered later: an invalid cron used to
 * insert the row and then throw out of `cron.schedule`, leaving a routine that
 * existed and was never scheduled, and an unusable model was only found by the
 * run itself, at 6am, with nobody watching.
 *
 * Second, `GET /:id/conversations` — the list behind the routine chat's own
 * history panel, which the issue asks to be "only for this routine". So the
 * cases that matter are the ones about what it must *not* contain.
 */
/** "test-model" is a bare reference, which is only usable as an enabled local model. */
let cleanupServable: () => Promise<void> = () => Promise.resolve();
const currentUser = { id: "" };

vi.mock("../../auth/middleware", () => ({
  authenticate: () => Promise.resolve(currentUser.id),
  requireAdmin: () => Promise.resolve(currentUser.id),
}));

/** Makes the next `executeRoutine` report that it started nothing — what it
 * does when the run row cannot be written at all. */
const startNothing = { on: false };

vi.mock("../../routines/scheduler", async (original) => {
  const real = await original<typeof import("../../routines/scheduler.ts")>();
  return {
    ...real,
    executeRoutine: (id: string) => {
      if (startNothing.on) {
        startNothing.on = false;
        return Promise.resolve(undefined);
      }
      return real.executeRoutine(id);
    },
  };
});

const { routineRoutes } = await import("../routines.ts");
const { stopRoutineScheduler } = await import("../../routines/scheduler.ts");
const { conversationRoutes } = await import("../conversations.ts");
const { registerRun, unregisterRun } = await import("../../streams/registry.ts");

const owner = `test-rt-owner-${uuid()}`;
const stranger = `test-rt-stranger-${uuid()}`;
const everyone = [owner, stranger];

/** Unprefixed: the built-in backend's models keep their bare upstream id. */
const MODEL = "test-model";
const DEAD_MODEL = `ghost-${uuid().slice(0, 8)}::some-model`;

const app = Fastify();

function as(userId: string) {
  currentUser.id = userId;
}

async function makeRoutine(opts?: { ownerId?: string; name?: string; model?: string | null }) {
  const [r] = await db
    .insert(routines)
    .values({
      ownerId: opts?.ownerId ?? owner,
      name: opts?.name ?? "Nightly",
      cron: "0 6 * * *",
      prompt: "do the thing",
      model: opts?.model === undefined ? MODEL : opts.model,
    })
    .returning();
  return r;
}

async function makeRun(
  routineId: string,
  opts?: { ownerId?: string; startedAt?: Date; deleted?: boolean; status?: string },
) {
  const ownerId = opts?.ownerId ?? owner;
  const [conv] = await db
    .insert(conversations)
    .values({
      ownerId,
      title: "Routine: Nightly",
      kind: "routine",
      ...(opts?.deleted ? { deletedAt: new Date() } : {}),
    })
    .returning();
  const [run] = await db
    .insert(routineRuns)
    .values({
      routineId,
      conversationId: conv.id,
      status: opts?.status ?? "completed",
      ...(opts?.startedAt ? { startedAt: opts.startedAt } : {}),
    })
    .returning();
  return { convId: conv.id, runId: run.id };
}

beforeAll(async () => {
  cleanupServable = await useServableModels(["test-model"]);
  routineRoutes(app);
  conversationRoutes(app);
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
  as(owner);
});

afterEach(async () => {
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
  await db.delete(usageRecords).where(inArray(usageRecords.userId, everyone));
});

afterAll(async () => {
  await cleanupServable();
  stopRoutineScheduler();
  await db.delete(user).where(inArray(user.id, everyone));
  await app.close();
});

describe("writing a routine", () => {
  it("refuses a cron expression it could never schedule", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/routines",
      payload: { name: "Bad", cron: "not a cron", prompt: "hi", model: MODEL },
    });
    expect(res.statusCode).toBe(400);
    // Nothing was written: the old code inserted first and threw afterwards.
    const rows = await db.select().from(routines).where(eq(routines.ownerId, owner));
    expect(rows).toHaveLength(0);
  });

  it("refuses a model whose provider does not exist", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/routines",
      payload: { name: "Ghost", cron: "0 6 * * *", prompt: "hi", model: DEAD_MODEL },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toContain("no longer configured");
  });

  it("accepts a routine with no model, for a client that predates the field", async () => {
    // It will fail its runs with the reason in the run's own chat, which is
    // better than refusing a write an old build cannot fix.
    const res = await app.inject({
      method: "POST",
      url: "/v1/routines",
      payload: { name: "Legacy", cron: "0 6 * * *", prompt: "hi" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ model: string | null }>().model).toBeNull();
  });

  it("changes a model but refuses to remove one", async () => {
    const routine = await makeRoutine();

    const cleared = await app.inject({
      method: "PATCH",
      url: `/v1/routines/${routine.id}`,
      payload: { model: null },
    });
    // A routine that once had a model and now does not would start failing
    // its runs for a reason nobody chose.
    expect(cleared.statusCode).toBe(400);

    const bad = await app.inject({
      method: "PATCH",
      url: `/v1/routines/${routine.id}`,
      payload: { model: DEAD_MODEL },
    });
    expect(bad.statusCode).toBe(400);

    const ok = await app.inject({
      method: "PATCH",
      url: `/v1/routines/${routine.id}`,
      payload: { model: MODEL, name: "Renamed" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json<{ name: string }>().name).toBe("Renamed");
  });

  it("will not patch someone else's routine", async () => {
    const routine = await makeRoutine({ ownerId: stranger });
    const res = await app.inject({
      method: "PATCH",
      url: `/v1/routines/${routine.id}`,
      payload: { name: "Mine now" },
    });
    expect(res.statusCode).toBe(404);
    const row = await db.query.routines.findFirst({ where: eq(routines.id, routine.id) });
    expect(row?.name).toBe("Nightly");
  });
});

describe("POST /v1/routines/:id/run", () => {
  it("does not answer 200 for a run that never started", async () => {
    const routine = await makeRoutine();
    startNothing.on = true;
    const res = await app.inject({ method: "POST", url: `/v1/routines/${routine.id}/run` });
    // It used to be `200 {ok: true}`, which the client is typed to read as a
    // run — it opened `conversationId: undefined` and blanked a screen full of
    // history, with nothing saying the run had not started.
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toContain("could not be started");
  });
});

describe("GET /v1/routines/:id/conversations/count", () => {
  it("counts every chat, past the page the history list stops at", async () => {
    const routine = await makeRoutine();
    // One more than the listing's page: the delete dialog used to count that
    // page, so a long-lived hourly routine read "Its 50 chats go with it"
    // while the delete took all of them.
    const convs = await db
      .insert(conversations)
      .values(Array.from({ length: 51 }, () => ({ ownerId: owner, title: "Routine: Nightly", kind: "routine" as const })))
      .returning({ id: conversations.id });
    await db.insert(routineRuns).values(
      convs.map((c) => ({ routineId: routine.id, conversationId: c.id, status: "completed" })),
    );
    await makeRun(routine.id, { deleted: true });

    const listed = await app.inject({ method: "GET", url: `/v1/routines/${routine.id}/conversations` });
    expect(listed.json<unknown[]>()).toHaveLength(50);

    const res = await app.inject({ method: "GET", url: `/v1/routines/${routine.id}/conversations/count` });
    expect(res.statusCode).toBe(200);
    // All 51, and not the one already deleted — it counts what the user can see.
    expect(res.json<{ count: number }>().count).toBe(51);
  });

  it("404s for someone else's routine", async () => {
    const routine = await makeRoutine({ ownerId: stranger });
    const res = await app.inject({ method: "GET", url: `/v1/routines/${routine.id}/conversations/count` });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /v1/routines/:id/conversations", () => {
  it("returns this routine's chats, newest run first, and nobody else's", async () => {
    const mine = await makeRoutine({ name: "Mine" });
    const other = await makeRoutine({ name: "Other" });
    const old = await makeRun(mine.id, { startedAt: new Date(Date.now() - 60_000) });
    const recent = await makeRun(mine.id, { startedAt: new Date() });
    const theirs = await makeRun(other.id);

    const res = await app.inject({ method: "GET", url: `/v1/routines/${mine.id}/conversations` });
    expect(res.statusCode).toBe(200);
    const rows = res.json<{ id: string; run: { status: string } }[]>();
    // The issue's "only for this routine": the last run first, so the screen
    // opens on it.
    expect(rows.map((r) => r.id)).toEqual([recent.convId, old.convId]);
    expect(rows.map((r) => r.id)).not.toContain(theirs.convId);
    expect(rows[0].run.status).toBe("completed");
  });

  it("omits a chat that was deleted", async () => {
    const routine = await makeRoutine();
    const kept = await makeRun(routine.id);
    await makeRun(routine.id, { deleted: true });

    const res = await app.inject({ method: "GET", url: `/v1/routines/${routine.id}/conversations` });
    expect(res.json<{ id: string }[]>().map((r) => r.id)).toEqual([kept.convId]);
  });

  it("404s for someone else's routine rather than listing their chats", async () => {
    const routine = await makeRoutine({ ownerId: stranger });
    await makeRun(routine.id, { ownerId: stranger });
    const res = await app.inject({ method: "GET", url: `/v1/routines/${routine.id}/conversations` });
    expect(res.statusCode).toBe(404);
  });

  it("says which chats have a run going", async () => {
    const routine = await makeRoutine();
    const idle = await makeRun(routine.id, { startedAt: new Date(Date.now() - 60_000) });
    const live = await makeRun(routine.id, { status: "running" });
    const streamId = uuid();
    registerRun({
      streamId,
      conversationId: live.convId,
      userId: owner,
      abort: new AbortController(),
      approvals: new Map(),
    });

    try {
      const res = await app.inject({ method: "GET", url: `/v1/routines/${routine.id}/conversations` });
      const rows = res.json<{ id: string; active_run: boolean }[]>();
      // So the history list can show a run in flight before its socket
      // catches up.
      expect(rows.find((r) => r.id === live.convId)?.active_run).toBe(true);
      expect(rows.find((r) => r.id === idle.convId)?.active_run).toBe(false);
    } finally {
      unregisterRun(streamId);
    }
  });
});

describe("GET /v1/conversations", () => {
  it("leaves routine chats out of the ordinary list", async () => {
    const routine = await makeRoutine();
    const { convId } = await makeRun(routine.id);
    const [chat] = await db
      .insert(conversations)
      .values({ ownerId: owner, title: "A real chat" })
      .returning();

    const res = await app.inject({ method: "GET", url: "/v1/conversations" });
    const ids = res.json<{ id: string }[]>().map((r) => r.id);
    // This query is capped at 50 rows, and an hourly routine now makes 24 real
    // conversations a day — left in, they would push a user's own chats out of
    // their own list.
    expect(ids).toContain(chat.id);
    expect(ids).not.toContain(convId);
  });
});
