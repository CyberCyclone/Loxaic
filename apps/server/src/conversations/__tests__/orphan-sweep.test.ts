import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { v4 as uuid } from "uuid";
import { db, eq, inArray } from "@loxaic/db";
import { checkpointFiles, conversations, messages, routineRuns, routines, usageRecords, user } from "@loxaic/db/schema";
import { purgeConversation, sweepOrphanedRows } from "../delete.ts";
import { registerRun, unregisterRun } from "../../streams/registry.ts";

/**
 * The backstop for rows a delete's own passes cannot collect: anything written
 * for a conversation after its last erase pass, by a run that outlived the
 * cleanup's ceiling. Every sweep here is scoped to this suite's conversation
 * ids — the suites share one Postgres, and an unscoped sweep would act on
 * whatever another suite is in the middle of.
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
  async function conversation(opts?: { gone?: boolean; deletedAt?: Date }): Promise<string> {
    const id = uuid();
    convIds.push(id);
    if (!opts?.gone) {
      await db.insert(conversations).values({
        id,
        ownerId,
        title: "orphan sweep test",
        ...(opts?.deletedAt ? { deletedAt: opts.deletedAt } : {}),
      });
    }
    return id;
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

    expect(await sweepOrphanedRows({ conversationIds: [convId] })).toBe(1);
    expect(await remaining(convId)).toEqual({ messages: 0, checkpoints: 0, routineRuns: 0 });
    // Kept, as a delete keeps it: the tokens were spent.
    expect(await usage(usageId)).toMatchObject({ conversationId: null, messageId: null });
  });

  it("leaves a live conversation's rows alone", async () => {
    const convId = await conversation();
    const { usageId } = await rowsFor(convId, HOURS_AGO(2));

    expect(await sweepOrphanedRows({ conversationIds: [convId] })).toBe(0);
    expect(await remaining(convId)).toEqual({ messages: 1, checkpoints: 1, routineRuns: 1 });
    expect(await usage(usageId)).toMatchObject({ conversationId: convId });
  });

  it("leaves a retained conversation's rows alone", async () => {
    // Deleted with retention on: the row is stamped, not gone, and the admin
    // audit view still reads its transcript until the reaper erases it.
    const convId = await conversation({ deletedAt: HOURS_AGO(3) });
    const { usageId } = await rowsFor(convId, HOURS_AGO(2));

    expect(await sweepOrphanedRows({ conversationIds: [convId] })).toBe(0);
    expect(await remaining(convId)).toEqual({ messages: 1, checkpoints: 1, routineRuns: 1 });
    expect(await usage(usageId)).toMatchObject({ conversationId: convId });
  });

  it("waits out the grace period before taking an orphan", async () => {
    const convId = await conversation({ gone: true });
    const { usageId } = await rowsFor(convId, HOURS_AGO(0.5));

    expect(await sweepOrphanedRows({ conversationIds: [convId] })).toBe(0);
    expect(await remaining(convId)).toEqual({ messages: 1, checkpoints: 1, routineRuns: 1 });
    expect(await usage(usageId)).toMatchObject({ conversationId: convId });
  });

  it("touches only the conversations it is scoped to", async () => {
    const inScope = await conversation({ gone: true });
    const outOfScope = await conversation({ gone: true });
    await rowsFor(inScope, HOURS_AGO(2));
    const { usageId } = await rowsFor(outOfScope, HOURS_AGO(2));

    await sweepOrphanedRows({ conversationIds: [inScope] });
    expect(await remaining(inScope)).toEqual({ messages: 0, checkpoints: 0, routineRuns: 0 });
    expect(await remaining(outOfScope)).toEqual({ messages: 1, checkpoints: 1, routineRuns: 1 });
    expect(await usage(usageId)).toMatchObject({ conversationId: outOfScope });
    // An empty scope is nothing, never everything.
    expect(await sweepOrphanedRows({ conversationIds: [] })).toBe(0);
    expect(await remaining(outOfScope)).toEqual({ messages: 1, checkpoints: 1, routineRuns: 1 });
  });

  it("collects what a run wrote after a delete had finished with its conversation", async () => {
    const convId = await conversation();
    // A run holds the conversation, so the delete's own second pass waits for
    // it; a row written meanwhile is that pass's to collect. Once it is seen
    // gone, the delete is done with this conversation.
    const streamId = uuid();
    registerRun({ streamId, conversationId: convId, userId: ownerId, abort: new AbortController(), approvals: new Map() });
    try {
      await purgeConversation(convId, { warn: () => undefined });
      expect(await db.query.conversations.findFirst({ where: eq(conversations.id, convId) })).toBeUndefined();
      await rowsFor(convId, HOURS_AGO(2));
    } finally {
      unregisterRun(streamId);
    }
    const deadline = Date.now() + 10_000;
    while ((await remaining(convId)).messages > 0) {
      if (Date.now() > deadline) throw new Error("timed out waiting for the delete's second pass");
      await new Promise((r) => setTimeout(r, 25));
    }

    // A run past the delete's ceiling writing on its way out — dated past the
    // grace period, as it would be by the time an hourly sweep came round.
    const { usageId } = await rowsFor(convId, HOURS_AGO(2));

    await sweepOrphanedRows({ conversationIds: [convId] });
    expect(await remaining(convId)).toEqual({ messages: 0, checkpoints: 0, routineRuns: 0 });
    expect(await usage(usageId)).toMatchObject({ conversationId: null, messageId: null });
  });
});
