import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { v4 as uuid } from "uuid";
import { db, eq, inArray } from "@loxaic/db";
import { checkpointFiles, conversations, messages, routineRuns, routines, usageRecords, user } from "@loxaic/db/schema";
import { sweepOrphanedRows } from "../delete.ts";

/**
 * The backstop for what a delete's own passes cannot collect: rows written for
 * a conversation after its last erase pass, by a run that outlived the
 * cleanup's ceiling, and sub-agents whose parent is gone. An erased
 * conversation is modelled as an id with rows and no conversation row, which
 * is exactly what a delete leaves. Every sweep here is scoped to this suite's
 * conversation ids — the suites share one Postgres, and an unscoped sweep
 * would act on whatever another suite is in the middle of.
 */
describe("the orphaned-row sweep", () => {
  const ownerId = `test-orphan-sweep-${uuid()}`;
  const convIds: string[] = [];
  let routineId = "";
  const HOURS_AGO = (h: number) => new Date(Date.now() - h * 60 * 60 * 1000);

  beforeAll(async () => {
    await db.insert(user).values({
      id: ownerId,
      name: "Orphan sweep",
      email: `${ownerId}@example.test`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const [routine] = await db.insert(routines).values({ ownerId, name: "r", cron: "0 * * * *", prompt: "p" }).returning();
    routineId = routine.id;
  });

  afterAll(async () => {
    if (convIds.length > 0) {
      await db.delete(messages).where(inArray(messages.conversationId, convIds));
      await db.delete(checkpointFiles).where(inArray(checkpointFiles.conversationId, convIds));
      await db.delete(routineRuns).where(inArray(routineRuns.conversationId, convIds));
      await db.delete(conversations).where(inArray(conversations.id, convIds));
    }
    await db.delete(routines).where(eq(routines.id, routineId));
    await db.delete(usageRecords).where(eq(usageRecords.userId, ownerId));
    await db.delete(user).where(eq(user.id, ownerId));
  });

  /** A conversation id with a row, or (`gone`) one whose row never existed —
   * which is what an erased conversation looks like to the sweep. */
  async function conversation(opts?: { gone?: boolean; deletedAt?: Date; parent?: string; createdAt?: Date }): Promise<string> {
    const id = uuid();
    convIds.push(id);
    if (!opts?.gone) {
      await db.insert(conversations).values({
        id,
        ownerId,
        title: "orphan sweep test",
        ...(opts?.deletedAt ? { deletedAt: opts.deletedAt } : {}),
        ...(opts?.parent ? { kind: "subagent" as const, parentConversationId: opts.parent, parentMessageId: uuid(), parentCallId: "call_0" } : {}),
        ...(opts?.createdAt ? { createdAt: opts.createdAt } : {}),
      });
    }
    return id;
  }

  const warnings: unknown[] = [];
  const sweep = (conversationIds: string[], limit?: number) =>
    sweepOrphanedRows({ warn: (obj) => warnings.push(obj) }, { conversationIds, ...(limit === undefined ? {} : { limit }) });

  async function exists(convId: string): Promise<boolean> {
    return (await db.query.conversations.findFirst({ where: eq(conversations.id, convId) })) !== undefined;
  }

  /** One row of each kind the sweep covers, written at `at`. */
  async function rowsFor(convId: string, at: Date): Promise<{ messageId: string; usageId: string }> {
    const messageId = uuid();
    await db.insert(messages).values({
      id: messageId,
      conversationId: convId,
      authorType: "assistant",
      origin: "server",
      lamport: at.getTime(),
      content: [{ kind: "text", text: "what the run wrote" }],
      status: "cancelled",
      createdAt: at,
    });
    await db.insert(checkpointFiles).values({ conversationId: convId, turnMessageId: messageId, path: "a.txt", state: "unknown", createdAt: at });
    await db.insert(routineRuns).values({ routineId, conversationId: convId, startedAt: at });
    const usageId = uuid();
    await db.insert(usageRecords).values({ id: usageId, userId: ownerId, conversationId: convId, messageId, model: "m", inputTokens: 1, outputTokens: 1, createdAt: at });
    return { messageId, usageId };
  }

  async function remaining(convId: string) {
    return {
      messages: (await db.select({ id: messages.id }).from(messages).where(eq(messages.conversationId, convId))).length,
      checkpoints: (await db.select({ id: checkpointFiles.id }).from(checkpointFiles).where(eq(checkpointFiles.conversationId, convId))).length,
      routineRuns: (await db.select({ id: routineRuns.id }).from(routineRuns).where(eq(routineRuns.conversationId, convId))).length,
    };
  }

  async function usage(usageId: string) {
    return db.query.usageRecords.findFirst({ where: eq(usageRecords.id, usageId) });
  }

  it("erases what an erased conversation left behind, and detaches its usage", async () => {
    const convId = await conversation({ gone: true });
    const { usageId } = await rowsFor(convId, HOURS_AGO(2));

    expect(await sweep([convId])).toBe(1);
    expect(await remaining(convId)).toEqual({ messages: 0, checkpoints: 0, routineRuns: 0 });
    // Kept, as a delete keeps it: the tokens were spent.
    expect(await usage(usageId)).toMatchObject({ conversationId: null, messageId: null });
  });

  it("finds an erased conversation by whichever of its rows is left", async () => {
    // A late tool result, a late checkpoint, a late usage row: any one of them
    // is enough for the conversation to be found.
    const onlyCheckpoint = await conversation({ gone: true });
    await db.insert(checkpointFiles).values({ conversationId: onlyCheckpoint, turnMessageId: uuid(), path: "a.txt", state: "unknown", createdAt: HOURS_AGO(2) });
    const onlyRoutineRun = await conversation({ gone: true });
    await db.insert(routineRuns).values({ routineId, conversationId: onlyRoutineRun, startedAt: HOURS_AGO(2) });
    const onlyUsage = await conversation({ gone: true });
    const usageId = uuid();
    await db.insert(usageRecords).values({ id: usageId, userId: ownerId, conversationId: onlyUsage, model: "m", inputTokens: 1, outputTokens: 1, createdAt: HOURS_AGO(2) });

    expect(await sweep([onlyCheckpoint, onlyRoutineRun, onlyUsage])).toBe(3);
    expect(await remaining(onlyCheckpoint)).toEqual({ messages: 0, checkpoints: 0, routineRuns: 0 });
    expect(await remaining(onlyRoutineRun)).toEqual({ messages: 0, checkpoints: 0, routineRuns: 0 });
    expect(await usage(usageId)).toMatchObject({ conversationId: null });
  });

  it("leaves a live conversation's rows alone", async () => {
    const convId = await conversation();
    const { usageId } = await rowsFor(convId, HOURS_AGO(2));

    expect(await sweep([convId])).toBe(0);
    expect(await remaining(convId)).toEqual({ messages: 1, checkpoints: 1, routineRuns: 1 });
    expect(await usage(usageId)).toMatchObject({ conversationId: convId });
  });

  it("leaves a retained conversation's rows alone", async () => {
    // Deleted with retention on: the row is stamped, not gone, and the admin
    // audit view still reads its transcript until the reaper erases it.
    const convId = await conversation({ deletedAt: HOURS_AGO(3) });
    const { usageId } = await rowsFor(convId, HOURS_AGO(2));

    expect(await sweep([convId])).toBe(0);
    expect(await remaining(convId)).toEqual({ messages: 1, checkpoints: 1, routineRuns: 1 });
    expect(await usage(usageId)).toMatchObject({ conversationId: convId });
  });

  it("waits out the grace period before taking an orphan", async () => {
    const convId = await conversation({ gone: true });
    const { usageId } = await rowsFor(convId, HOURS_AGO(0.5));

    expect(await sweep([convId])).toBe(0);
    expect(await remaining(convId)).toEqual({ messages: 1, checkpoints: 1, routineRuns: 1 });
    expect(await usage(usageId)).toMatchObject({ conversationId: convId });
  });

  it("touches only the conversations it is scoped to", async () => {
    const inScope = await conversation({ gone: true });
    const outOfScope = await conversation({ gone: true });
    await rowsFor(inScope, HOURS_AGO(2));
    const { usageId } = await rowsFor(outOfScope, HOURS_AGO(2));

    await sweep([inScope]);
    expect(await remaining(inScope)).toEqual({ messages: 0, checkpoints: 0, routineRuns: 0 });
    expect(await remaining(outOfScope)).toEqual({ messages: 1, checkpoints: 1, routineRuns: 1 });
    expect(await usage(usageId)).toMatchObject({ conversationId: outOfScope });
    // An empty scope is nothing, never everything.
    expect(await sweep([])).toBe(0);
    expect(await remaining(outOfScope)).toEqual({ messages: 1, checkpoints: 1, routineRuns: 1 });
  });

  it("erases a sub-agent whose parent is gone, with its rows", async () => {
    // Created just as its parent's last erase committed: it has a row of its
    // own, so nothing about its messages looks orphaned.
    const parentId = await conversation({ gone: true });
    const childId = await conversation({ parent: parentId, createdAt: HOURS_AGO(2) });
    const { usageId } = await rowsFor(childId, HOURS_AGO(2));
    // A sub-agent of a live thread, and one of a retained thread, stay.
    const liveChild = await conversation({ parent: await conversation(), createdAt: HOURS_AGO(2) });
    const retainedChild = await conversation({ parent: await conversation({ deletedAt: HOURS_AGO(3) }), createdAt: HOURS_AGO(2) });

    expect(await sweep([childId, liveChild, retainedChild])).toBe(1);
    expect(await exists(childId)).toBe(false);
    expect(await remaining(childId)).toEqual({ messages: 0, checkpoints: 0, routineRuns: 0 });
    expect(await usage(usageId)).toMatchObject({ conversationId: null, messageId: null });
    expect(await exists(liveChild)).toBe(true);
    expect(await exists(retainedChild)).toBe(true);
  });

  it("waits out the grace period before taking a sub-agent whose parent is gone", async () => {
    const childId = await conversation({ parent: await conversation({ gone: true }), createdAt: HOURS_AGO(0.5) });
    expect(await sweep([childId])).toBe(0);
    expect(await exists(childId)).toBe(true);
  });

  it("takes one batch per sweep and leaves the rest for the next", async () => {
    const ids = [await conversation({ gone: true }), await conversation({ gone: true }), await conversation({ gone: true })];
    for (const id of ids) await rowsFor(id, HOURS_AGO(2));

    expect(await sweep(ids, 2)).toBe(2);
    expect((await Promise.all(ids.map(remaining))).filter((r) => r.messages > 0)).toHaveLength(1);
    expect(await sweep(ids, 2)).toBe(1);
    expect((await Promise.all(ids.map(remaining))).filter((r) => r.messages > 0)).toHaveLength(0);
    expect(warnings).toEqual([]);
  });
});
