import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { v4 as uuid } from "uuid";
import { asc, db, eq, sql } from "@loxaic/db";
import { conversations, messages, usageRecords, user, userPrefs } from "@loxaic/db/schema";
import type { ContentBlock } from "@loxaic/types";
import { initStreamBroker } from "../../index.ts";
import { getRunByConversation } from "../../registry.ts";
import { retryChatRun, startChatRun } from "../chatRun.ts";
import { startAgentRun } from "../agentRun.ts";

/**
 * Every message from a current client carries the time it was sent, in the
 * sender's zone (streams/runs/local-time.ts): stored on the user row, told to
 * the model ahead of the message, and the zone kept for the person's routines.
 */
process.env.MOCK_INFERENCE = "true";
const MODEL = "llama-3.1-8b-instruct";

const userId = `test-local-time-${uuid()}`;
const convIds: string[] = [];

beforeAll(async () => {
  process.env.DELETED_CHAT_RETENTION_ENABLED = "false";
  await initStreamBroker();
  await db.insert(user).values({
    id: userId,
    name: "Test Local Time",
    email: `${userId}@example.test`,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
});

afterAll(async () => {
  delete process.env.DELETED_CHAT_RETENTION_ENABLED;
  for (const id of convIds) {
    await db.delete(messages).where(eq(messages.conversationId, id));
    await db.delete(conversations).where(eq(conversations.id, id));
  }
  await db.delete(usageRecords).where(eq(usageRecords.userId, userId));
  await db.delete(userPrefs).where(eq(userPrefs.userId, userId));
  await db.delete(user).where(eq(user.id, userId));
});

async function waitForRun(convId: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (getRunByConversation(convId)) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the run to end");
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function send(content: string, localTime: Parameters<typeof startChatRun>[0]["localTime"], conversationId?: string) {
  const started = await startChatRun({ userId, content, model: MODEL, conversationId, localTime });
  if (!convIds.includes(started.conversationId)) convIds.push(started.conversationId);
  await waitForRun(started.conversationId);
  return started.conversationId;
}

const rowsOf = (convId: string) =>
  db.select().from(messages).where(eq(messages.conversationId, convId)).orderBy(asc(messages.lamport), asc(messages.createdAt));

const textOf = (row: { content: unknown }) =>
  (row.content as ContentBlock[]).filter((b) => b.kind === "text").map((b) => (b as { text: string }).text).join("");

const sentOf = (row: { content: unknown }) => (row.content as ContentBlock[]).filter((b) => b.kind === "local_time");

const storedZone = async () =>
  (await db.query.userPrefs.findFirst({ where: eq(userPrefs.userId, userId), columns: { timeZone: true } }))?.timeZone;

describe("the time a message was sent", () => {
  it("is stored on the user row and reaches the model ahead of the message", async () => {
    const convId = await send("what time is it", { tz: "Australia/Brisbane", utc_offset_min: 600 });
    const [userRow, reply] = await rowsOf(convId);
    const [sent] = sentOf(userRow);
    expect(sent).toMatchObject({ kind: "local_time", source: "device", tz: "Australia/Brisbane" });
    expect(sent.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}\+10:00$/);
    // The mock answers "what time is it" with what the prompt carried.
    expect(textOf(reply)).toBe(`[Mock] Local time: ${sent.text.replace(/^<local-time>|<\/local-time>$/g, "")}`);
  });

  it("is not seen by the mock's triggers, so a plain echo is unchanged", async () => {
    const convId = await send("hello there", { tz: "Australia/Brisbane" });
    const [, reply] = await rowsOf(convId);
    expect(textOf(reply)).toBe("[Mock] Echo: hello there");
  });

  it("is absent when the client named no zone, as from an older client", async () => {
    const convId = await send("what time is it", null);
    const [userRow, reply] = await rowsOf(convId);
    expect(sentOf(userRow)).toEqual([]);
    expect(textOf(reply)).toBe("[Mock] Local time: none");
  });

  it("is not added again by a retry, which answers the same stored message", async () => {
    const convId = await send("first", { tz: "Australia/Brisbane" });
    const retried = await retryChatRun({ userId, conversationId: convId, model: MODEL });
    await waitForRun(retried.conversationId);
    const users = (await rowsOf(convId)).filter((r) => r.authorType === "user");
    expect(users).toHaveLength(1);
    expect(sentOf(users[0])).toHaveLength(1);
  });

  it("comes with an agent run's message too", async () => {
    const started = await startAgentRun({
      userId,
      content: "hello agent",
      model: MODEL,
      mode: "manual",
      localTime: { tz: "Europe/London" },
    });
    convIds.push(started.conversationId);
    await waitForRun(started.conversationId);
    const [userRow] = await rowsOf(started.conversationId);
    expect(sentOf(userRow)).toMatchObject([{ source: "device", tz: "Europe/London" }]);
  });
});

describe("the zone kept for routines", () => {
  it("is the last one sent from, written only when it changes", async () => {
    await db.delete(userPrefs).where(eq(userPrefs.userId, userId));
    await send("one", { tz: "Australia/Perth" });
    expect(await storedZone()).toBe("Australia/Perth");
    // xmin moves on every write to the row, so it shows a write that changed nothing.
    const version = async () =>
      (await db.execute<{ v: string }>(sql`SELECT xmin::text AS v FROM user_prefs WHERE user_id = ${userId}`)).at(0)?.v;
    const before = await version();
    await send("two", { tz: "Australia/Perth" });
    expect(await version()).toBe(before);
    await send("three", { tz: "Asia/Tokyo" });
    expect(await storedZone()).toBe("Asia/Tokyo");
  });

  it("is never one the server does not know, nor taken from an older client", async () => {
    await db.delete(userPrefs).where(eq(userPrefs.userId, userId));
    await send("unknown zone", { tz: "Mars/Olympus_Mons", utc_offset_min: 600 });
    await send("no zone", null);
    expect((await storedZone()) ?? null).toBeNull();
  });
});
