import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { v4 as uuid } from "uuid";
import { db, eq } from "@loxaic/db";
import { conversations, messages, usageRecords, user, userPrefs } from "@loxaic/db/schema";
import { TODO_STALE_REMINDER, type ContentBlock } from "@loxaic/types";
import { initStreamBroker } from "../../index.ts";
import { getRunByConversation } from "../../registry.ts";
import { startAgentRun } from "../agentRun.ts";
import { TODO_REMINDER_EVERY } from "../todo-staleness.ts";
import { __resetMockScenariosForTest } from "../../../inference/mock-scenarios.ts";

/**
 * A todo list with unfinished items that has not changed for ten tool
 * iterations gets a reminder on the next tool result.
 *
 * A model on the beta wrote its list once, item 1 in progress, and did four
 * more items without touching it; the person watching took item 1 for the one
 * being worked on. The reminder rides on a tool result — the live event, the
 * stored row and the replay are one text — so these read the stored rows.
 */
process.env.MOCK_INFERENCE = "true";

const OPEN = { todos: [{ id: "1", text: "Schema", status: "in_progress" }, { id: "2", text: "Routes", status: "pending" }] };
const DONE = { todos: [{ id: "1", text: "Schema", status: "completed" }] };
/** Ordinary work that needs no sandbox and no approval: the SSRF guard refuses
 * a loopback address at once. A different address each time, or the loop
 * detector would stop the run to ask whether it is stuck. */
const fetchStep = (i: number) => ({ tool: "web_fetch", args: { url: `http://127.0.0.1:1/${String(i)}` } });
const fetches = (from: number, n: number) => Array.from({ length: n }, (_, i) => fetchStep(from + i));

describe("the stale todo reminder", () => {
  const userId = `test-todo-reminder-${uuid()}`;
  const convIds: string[] = [];
  let dir: string;

  beforeAll(async () => {
    await initStreamBroker();
    await db.insert(user).values({
      id: userId,
      name: "Test Todo Reminder",
      email: `${userId}@example.test`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    dir = mkdtempSync(path.join(tmpdir(), "todo-reminder-"));
  });

  afterAll(async () => {
    for (const id of convIds) {
      await db.delete(messages).where(eq(messages.conversationId, id));
      await db.delete(usageRecords).where(eq(usageRecords.conversationId, id));
      await db.delete(conversations).where(eq(conversations.id, id));
    }
    await db.delete(userPrefs).where(eq(userPrefs.userId, userId));
    await db.delete(user).where(eq(user.id, userId));
    delete process.env.MOCK_SCENARIOS_FILE;
    __resetMockScenariosForTest();
    rmSync(dir, { recursive: true, force: true });
  });

  function useScenarios(scenarios: { match: string; steps: unknown[] }[]): void {
    const file = path.join(dir, `${uuid()}.json`);
    writeFileSync(file, JSON.stringify(scenarios.map((s) => ({ ...s, finalText: "[Mock] Done.\n" }))));
    process.env.MOCK_SCENARIOS_FILE = file;
    __resetMockScenariosForTest();
  }

  async function newConversation(): Promise<string> {
    const [conv] = await db.insert(conversations).values({ ownerId: userId, title: "todo reminder", kind: "agent" }).returning();
    convIds.push(conv.id);
    return conv.id;
  }

  async function run(convId: string, content: string): Promise<void> {
    await startAgentRun({ userId, content, model: "llama-3.1-8b-instruct", mode: "auto", conversationId: convId });
    const deadline = Date.now() + 30_000;
    while (getRunByConversation(convId)) {
      if (Date.now() > deadline) throw new Error("the run never ended");
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  /** The web_fetch results in conversation order, and which carry the reminder. */
  async function fetchResults(convId: string): Promise<boolean[]> {
    const rows = await db.query.messages.findMany({
      where: eq(messages.conversationId, convId),
      orderBy: (m, { asc }) => [asc(m.lamport), asc(m.createdAt)],
    });
    const fetchCalls = new Set(
      rows.flatMap((r) =>
        (r.content as ContentBlock[]).flatMap((b) => (b.kind === "tool_call" && b.tool === "web_fetch" ? [b.call_id] : [])),
      ),
    );
    return rows.flatMap((r) =>
      (r.content as ContentBlock[]).flatMap((b) =>
        b.kind === "tool_result" && fetchCalls.has(b.call_id) ? [b.output.endsWith(TODO_STALE_REMINDER)] : [],
      ),
    );
  }

  it("lands once, on the first tool result after ten iterations without a write", async () => {
    useScenarios([{ match: "write the list once", steps: [{ tool: "todo_write", args: OPEN }, ...fetches(0, 12)] }]);
    const convId = await newConversation();
    await run(convId, "write the list once then work");
    const marked = await fetchResults(convId);
    expect(marked).toHaveLength(12);
    // Ten fetches leave the list ten iterations stale; the eleventh carries it.
    expect(marked.map((m, i) => (m ? i : -1)).filter((i) => i >= 0)).toEqual([TODO_REMINDER_EVERY]);
  });

  it("says nothing about a list whose every item is done", async () => {
    useScenarios([{ match: "finish the list first", steps: [{ tool: "todo_write", args: DONE }, ...fetches(0, 12)] }]);
    const convId = await newConversation();
    await run(convId, "finish the list first");
    expect((await fetchResults(convId)).some(Boolean)).toBe(false);
  });

  it("counts again from a write in the middle", async () => {
    useScenarios([
      { match: "keep the list going", steps: [{ tool: "todo_write", args: OPEN }, ...fetches(0, 5), { tool: "todo_write", args: OPEN }, ...fetches(5, 10)] },
    ]);
    const convId = await newConversation();
    await run(convId, "keep the list going");
    expect((await fetchResults(convId)).some(Boolean)).toBe(false);
  });

  it("counts a list written in an earlier turn", async () => {
    useScenarios([
      { match: "start the list", steps: [{ tool: "todo_write", args: OPEN }, ...fetches(0, 4)] },
      { match: "carry on with it", steps: fetches(4, 8) },
    ]);
    const convId = await newConversation();
    await run(convId, "start the list");
    await run(convId, "carry on with it");
    const marked = await fetchResults(convId);
    expect(marked).toHaveLength(12);
    // Four fetches in the first turn, six in the second make ten; the
    // seventh of the second turn carries it.
    expect(marked.map((m, i) => (m ? i : -1)).filter((i) => i >= 0)).toEqual([TODO_REMINDER_EVERY]);
  });
});
