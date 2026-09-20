import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { v4 as uuid } from "uuid";
import { db, eq, inArray } from "@loxaic/db";
import {
  conversations,
  messages,
  routineRuns,
  routines,
  usageRecords,
  user,
  userPrefs,
} from "@loxaic/db/schema";

/**
 * A routine run is a real run — #179.
 *
 * It used to be a stub that inserted `[Routine "X" executed at …]` and never
 * called a model, which is why the issue's first half ("let me see the chat")
 * had nothing worth seeing. What this file holds is the two properties that
 * are easy to lose again:
 *
 *   1. A run reaches a *terminal* status, written from the stream log's own
 *      finalize rather than from "we dispatched it". Before, the row said
 *      `completed` the moment the insert returned.
 *   2. The routine's model is the only model a run ever uses. Every failure —
 *      no model, a deleted provider — fails the run with the reason in its own
 *      chat, because the alternative (fall back to whatever is loaded) spends
 *      an admin's provider key on a choice nobody made and says nothing.
 *
 * On the `stop-abort.test.ts` harness: MOCK_INFERENCE with a real broker, so
 * the whole loop runs. Every assertion is scoped to this suite's own rows —
 * the database is shared and `routines` is not owner-partitioned by any sweep.
 */
process.env.MOCK_INFERENCE = "true";
// The ntfy post is fire-and-forget; point it at a closed port so a run here
// never reaches a real notification server someone is running in dev.
process.env.NTFY_URL = "http://127.0.0.1:1";

const { initStreamBroker } = await import("../../streams/index.ts");
const { getRunByConversation } = await import("../../streams/registry.ts");
const { executeRoutine, startRoutineScheduler, stopRoutineScheduler } = await import("../scheduler.ts");
const { startChatRun } = await import("../../streams/runs/chatRun.ts");
const { getRecentModels, __resetRecentModelsForTest } = await import("../../inference/recent-models.ts");

/** The built-in backend's models keep their bare upstream id (AGENTS.md), so
 * an unprefixed ref is the one thing that resolves with no provider row. */
const MODEL = "test-routine-model";
/** A provider slug nothing has ever created: `slug::id` cannot resolve. */
const DEAD_MODEL = `ghost-${uuid().slice(0, 8)}::some-model`;

const ownerId = `test-routine-${uuid()}`;

async function makeRoutine(opts?: { model?: string | null; prompt?: string; name?: string }) {
  const [r] = await db
    .insert(routines)
    .values({
      ownerId,
      name: opts?.name ?? "Test routine",
      cron: "0 6 * * *",
      prompt: opts?.prompt ?? "say hello",
      model: opts?.model === undefined ? MODEL : opts.model,
    })
    .returning();
  return r;
}

async function runRow(runId: string) {
  return db.query.routineRuns.findFirst({ where: eq(routineRuns.id, runId) });
}

async function waitFor(label: string, check: () => boolean | Promise<boolean>, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** The run's own row reaching any terminal status. */
async function waitForRunFinished(runId: string, timeoutMs = 20_000) {
  await waitFor(`run ${runId} to finish`, async () => (await runRow(runId))?.status !== "running", timeoutMs);
  const row = await runRow(runId);
  if (!row) throw new Error(`run ${runId} disappeared`);
  return row;
}

async function messagesOf(convId: string) {
  return db.select().from(messages).where(eq(messages.conversationId, convId)).orderBy(messages.lamport);
}

beforeAll(async () => {
  await initStreamBroker();
  await db.insert(user).values({
    id: ownerId,
    name: "Routine Owner",
    email: `${ownerId}@example.test`,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
});

afterEach(async () => {
  __resetRecentModelsForTest();
  await db.delete(userPrefs).where(eq(userPrefs.userId, ownerId));
});

afterAll(async () => {
  stopRoutineScheduler();
  const own = await db.select({ id: conversations.id }).from(conversations).where(eq(conversations.ownerId, ownerId));
  const ids = own.map((c) => c.id);
  if (ids.length) {
    await db.delete(messages).where(inArray(messages.conversationId, ids));
    await db.delete(usageRecords).where(inArray(usageRecords.conversationId, ids));
  }
  // routine_runs cascades from routines.
  await db.delete(routines).where(eq(routines.ownerId, ownerId));
  if (ids.length) await db.delete(conversations).where(inArray(conversations.id, ids));
  await db.delete(userPrefs).where(eq(userPrefs.userId, ownerId));
  await db.delete(user).where(eq(user.id, ownerId));
});

describe("a routine run is a real run", () => {
  it("reaches a terminal status only when the turn is actually over, and records usage", async () => {
    const routine = await makeRoutine({ prompt: "what is two plus two" });
    const runId = await executeRoutine(routine.id);
    if (!runId) throw new Error("no run started");

    // The row is `running` while the run is: the status comes from the stream
    // log's finalize, not from dispatch.
    const started = await runRow(runId);
    expect(started?.status).toBe("running");
    expect(started?.finishedAt).toBeNull();

    const finished = await waitForRunFinished(runId);
    expect(finished.status).toBe("completed");
    expect(finished.finishedAt).not.toBeNull();

    const convId = finished.conversationId;
    const rows = await messagesOf(convId);
    // The prompt, then a real assistant reply — not the old placeholder.
    expect(rows[0].authorType).toBe("user");
    expect(rows.some((m) => m.authorType === "assistant" && m.status === "complete")).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("executed at");

    const usage = await db.select().from(usageRecords).where(eq(usageRecords.conversationId, convId));
    expect(usage.length).toBeGreaterThan(0);
    // Exactly the routine's model, everywhere it is recorded.
    expect(usage[0].model).toBe(MODEL);
    const assistant = rows.find((m) => m.authorType === "assistant");
    expect(assistant?.model).toBe(MODEL);
  });

  it("writes the conversation as the routine's own, with its model", async () => {
    const routine = await makeRoutine({ name: "Morning digest" });
    const runId = await executeRoutine(routine.id);
    if (!runId) throw new Error("no run started");
    const row = await waitForRunFinished(runId);

    const conv = await db.query.conversations.findFirst({ where: eq(conversations.id, row.conversationId) });
    expect(conv?.kind).toBe("routine");
    expect(conv?.title).toBe("Routine: Morning digest");
    // So the client opening this chat continues on the model the run used.
    expect(conv?.modelPref).toEqual({ model: MODEL });
  });

  it("does not put a scheduled run's model in the picker's recents", async () => {
    // A cron firing at 6am is nobody's choice of model, exactly as an
    // automatic compaction is not.
    const routine = await makeRoutine();
    const runId = await executeRoutine(routine.id);
    if (!runId) throw new Error("no run started");
    await waitForRunFinished(runId);

    expect(await getRecentModels(ownerId)).toEqual([]);

    // The contrast is the point: the same machinery does record a send the
    // user typed, so the empty list above is the `recordUse: false` flag
    // working rather than recents being broken.
    const typed = await startChatRun({ userId: ownerId, content: "hello", model: MODEL });
    await waitFor("the typed run to end", () => getRunByConversation(typed.conversationId) === undefined);
    expect(await getRecentModels(ownerId)).toEqual([MODEL]);
  });
});

describe("the routine's model is the only one a run uses", () => {
  it("fails a routine that has no model, rather than picking one", async () => {
    // Recents hold a perfectly usable model and the built-in backend has one
    // loaded — neither may be substituted.
    await startChatRun({ userId: ownerId, content: "prime the recents", model: MODEL }).then(async (r) => {
      await waitFor("the priming run to end", () => getRunByConversation(r.conversationId) === undefined);
    });
    expect(await getRecentModels(ownerId)).toEqual([MODEL]);

    const routine = await makeRoutine({ model: null });
    const runId = await executeRoutine(routine.id);
    if (!runId) throw new Error("no run started");
    const row = await waitForRunFinished(runId);
    expect(row.status).toBe("failed");

    const rows = await messagesOf(row.conversationId);
    // The prompt is kept, and the reason is in the chat rather than nowhere:
    // an empty conversation is what this used to leave behind.
    expect(rows).toHaveLength(2);
    expect(rows[1].status).toBe("error");
    expect(rows[1].error).toContain("no model");
    // Nothing was sent anywhere.
    const usage = await db.select().from(usageRecords).where(eq(usageRecords.conversationId, row.conversationId));
    expect(usage).toHaveLength(0);
  });

  it("fails a routine whose provider is gone, naming it", async () => {
    const routine = await makeRoutine({ model: DEAD_MODEL });
    const runId = await executeRoutine(routine.id);
    if (!runId) throw new Error("no run started");
    const row = await waitForRunFinished(runId);
    expect(row.status).toBe("failed");

    const rows = await messagesOf(row.conversationId);
    expect(rows[1].error).toContain(DEAD_MODEL);
    const usage = await db.select().from(usageRecords).where(eq(usageRecords.conversationId, row.conversationId));
    expect(usage).toHaveLength(0);
  });

  it("serves a follow-up on the routine's model, whatever the client names", async () => {
    const routine = await makeRoutine();
    const runId = await executeRoutine(routine.id);
    if (!runId) throw new Error("no run started");
    const row = await waitForRunFinished(runId);

    // A client continuing this chat names a model from a provider that does
    // not exist. It must not be honoured — and must not fail the send either,
    // because the routine's own model is what will be used.
    const sent = await startChatRun({
      userId: ownerId,
      content: "and again",
      model: DEAD_MODEL,
      conversationId: row.conversationId,
    });
    await waitFor("the follow-up to end", () => getRunByConversation(sent.conversationId) === undefined);

    const rows = await messagesOf(row.conversationId);
    const assistants = rows.filter((m) => m.authorType === "assistant");
    expect(assistants).toHaveLength(2);
    for (const a of assistants) expect(a.model).toBe(MODEL);
  });
});

describe("a run that outlives its process", () => {
  it("reconciles rows still marked running at boot, and leaves newer ones alone", async () => {
    const routine = await makeRoutine();
    // A row from a process that died mid-run: nothing else would ever move it,
    // and it would sit in the routine's history as permanently "running".
    const [conv] = await db
      .insert(conversations)
      .values({ ownerId, title: "Routine: crashed", kind: "routine" })
      .returning();
    const stale = uuid();
    await db.insert(routineRuns).values({
      id: stale,
      routineId: routine.id,
      conversationId: conv.id,
      status: "running",
      startedAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    // And one that started after this process did — a "Run now" racing boot,
    // which the reconcile must not touch.
    const fresh = uuid();
    const [conv2] = await db
      .insert(conversations)
      .values({ ownerId, title: "Routine: live", kind: "routine" })
      .returning();
    await db.insert(routineRuns).values({
      id: fresh,
      routineId: routine.id,
      conversationId: conv2.id,
      status: "running",
      startedAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    await startRoutineScheduler();
    stopRoutineScheduler();

    expect((await runRow(stale))?.status).toBe("failed");
    expect((await runRow(fresh))?.status).toBe("running");
  });
});
