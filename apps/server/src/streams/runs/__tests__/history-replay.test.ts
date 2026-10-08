import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { v4 as uuid } from "uuid";
import { db, eq } from "@loxaic/db";
import { conversations, messages, user } from "@loxaic/db/schema";
import type { ContentBlock } from "@loxaic/types";
import { historyFront, loadHistory } from "../engine.ts";

/**
 * The replay is everything after the newest summary, and nothing is ever left
 * out of it.
 *
 * It used to be a window of the newest 50–74 stored rows. That was sized for
 * chat, where a row is a turn; an agent iteration stores two (the call and its
 * result), so the run after a long agent turn started from a fraction of the
 * conversation. On the beta a planning run's turn 4 began at 91K tokens where
 * turn 3 had ended at 261K: the person's own request and the early research
 * were gone, nothing said so, and no summary held them, because compaction
 * only ever summarised what the window had kept. Compaction and a context
 * extension are now the only things that shorten a prompt.
 *
 * Integration against the real dev Postgres, matching compaction-history.test.ts.
 */
describe("history replay: everything since the last summary", () => {
  const userId = `test-replay-${uuid()}`;
  const convIds: string[] = [];

  beforeAll(async () => {
    await db.insert(user).values({
      id: userId,
      name: "Test Replay",
      email: `${userId}@example.test`,
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
    await db.delete(user).where(eq(user.id, userId));
  });

  async function newConv(): Promise<string> {
    const [conv] = await db.insert(conversations).values({ ownerId: userId, title: "replay test" }).returning();
    convIds.push(conv.id);
    return conv.id;
  }

  const textBlock = (text: string): ContentBlock[] => [{ kind: "text", text }];
  let lamport = 1000;

  /** Append message `m<i>` for i in [from, to), alternating roles. */
  async function append(convId: string, from: number, to: number): Promise<void> {
    const rows: (typeof messages.$inferInsert)[] = [];
    for (let i = from; i < to; i++) {
      rows.push({
        id: uuid(),
        conversationId: convId,
        authorType: i % 2 === 0 ? "user" : "assistant",
        origin: "server" as const,
        lamport: lamport++,
        content: textBlock(`m${String(i)}`),
        status: "complete" as const,
        createdAt: new Date(1_700_000_000_000 + lamport),
      });
    }
    await db.insert(messages).values(rows);
  }

  /** One agent iteration: an assistant row calling `bash`, and its result row. */
  async function toolStep(convId: string, n: number): Promise<void> {
    const callId = `call-${String(n)}`;
    await db.insert(messages).values([
      {
        id: uuid(),
        conversationId: convId,
        authorType: "assistant",
        origin: "server",
        lamport: lamport++,
        content: [{ kind: "tool_call", call_id: callId, tool: "bash", args: { command: `echo ${String(n)}` } }] as ContentBlock[],
        status: "complete",
        createdAt: new Date(1_700_000_000_000 + lamport),
      },
      {
        id: uuid(),
        conversationId: convId,
        authorType: "tool",
        origin: "server",
        lamport: lamport++,
        content: [{ kind: "tool_result", call_id: callId, output: String(n) }] as ContentBlock[],
        status: "complete",
        createdAt: new Date(1_700_000_000_000 + lamport),
      },
    ]);
  }

  async function summary(convId: string, text: string): Promise<void> {
    await db.insert(messages).values({
      id: uuid(),
      conversationId: convId,
      authorType: "summary",
      origin: "server",
      lamport: lamport++,
      content: textBlock(text),
      status: "complete",
      createdAt: new Date(1_700_000_000_000 + lamport),
    });
  }

  /** The replayed contents, e.g. ["m0", "m1", …]. */
  const contents = (msgs: { content: unknown }[]): string[] => msgs.map((m) => String(m.content));

  it("keeps a long agent turn's opening request", async () => {
    // The shape that lost history on the beta: one request, then a long run of
    // tool calls, two stored rows each.
    const convId = await newConv();
    await db.insert(messages).values({
      id: uuid(),
      conversationId: convId,
      authorType: "user",
      origin: "server",
      lamport: lamport++,
      content: textBlock("Create a plan to implement the feature"),
      status: "complete",
      createdAt: new Date(1_700_000_000_000 + lamport),
    });
    for (let n = 0; n < 75; n++) await toolStep(convId, n);

    const history = await loadHistory(convId);
    expect(history.messages).toHaveLength(1 + 150);
    expect(history.messages[0]).toEqual({ role: "user", content: "Create a plan to implement the feature" });
    expect(history.messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "call-74" });
  });

  it("extends the previous turn's replay on every turn, however long the conversation", async () => {
    const convId = await newConv();
    await append(convId, 0, 50);
    let previous = contents((await loadHistory(convId)).messages);

    for (let n = 51; n <= 200; n++) {
      await append(convId, n - 1, n);
      const current = contents((await loadHistory(convId)).messages);
      // Same first message, one more on the end: the prefix the backend holds.
      expect(current[0]).toBe("m0");
      expect(current.slice(0, previous.length)).toEqual(previous);
      expect(current).toHaveLength(n);
      previous = current;
    }
  });

  it("starts after the newest summary, and replays everything after it", async () => {
    const convId = await newConv();
    await append(convId, 0, 120);
    await summary(convId, "What happened so far.");
    await append(convId, 120, 300);

    const history = await loadHistory(convId);
    expect(history.summaryText).toBe("What happened so far.");
    expect(contents(history.messages)[0]).toBe("m120");
    expect(history.messages).toHaveLength(180);
  });

  it("drops a tool_result whose tool_call sits before the summary", async () => {
    // A summary written between a call and its result (a /compact after a run
    // that was stopped mid-call) leaves the result with no call in the replay,
    // and a `role: "tool"` message with no preceding call is rejected outright
    // by most backends.
    const convId = await newConv();
    await db.insert(messages).values({
      id: uuid(),
      conversationId: convId,
      authorType: "assistant",
      origin: "server",
      lamport: lamport++,
      content: [{ kind: "tool_call", call_id: "call-before", tool: "bash", args: { command: "echo hi" } }] as ContentBlock[],
      status: "complete",
      createdAt: new Date(1_700_000_000_000 + lamport),
    });
    await summary(convId, "Earlier work.");
    await db.insert(messages).values({
      id: uuid(),
      conversationId: convId,
      authorType: "tool",
      origin: "server",
      lamport: lamport++,
      content: [{ kind: "tool_result", call_id: "call-before", output: "hi" }] as ContentBlock[],
      status: "complete",
      createdAt: new Date(1_700_000_000_000 + lamport),
    });
    await append(convId, 0, 2);

    const history = await loadHistory(convId);
    expect(history.messages.some((m) => m.role === "tool")).toBe(false);
    expect(contents(history.messages)).toEqual(["m0", "m1"]);
  });

  it("keeps a tool exchange intact", async () => {
    const convId = await newConv();
    await db.insert(messages).values([
      { id: uuid(), conversationId: convId, authorType: "user" as const, origin: "server" as const, lamport: 1, content: textBlock("run it"), status: "complete" as const, createdAt: new Date(1) },
      {
        id: uuid(),
        conversationId: convId,
        authorType: "assistant",
        origin: "server",
        lamport: 2,
        content: [
          { kind: "text", text: "Running it." },
          { kind: "tool_call", call_id: "call-ok", tool: "bash", args: { command: "echo hi" } },
        ] as ContentBlock[],
        status: "complete",
        createdAt: new Date(2),
      },
      {
        id: uuid(),
        conversationId: convId,
        authorType: "tool",
        origin: "server",
        lamport: 3,
        content: [{ kind: "tool_result", call_id: "call-ok", output: "hi" }] as ContentBlock[],
        status: "complete",
        createdAt: new Date(3),
      },
    ]);

    const history = await loadHistory(convId);
    expect(history.messages).toEqual([
      { role: "user", content: "run it" },
      {
        role: "assistant",
        content: "Running it.",
        tool_calls: [
          { id: "call-ok", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "echo hi" }) } },
        ],
      },
      // `name` is part of the shape the live loop sends, so the replay carries
      // it too — see the byte-identity test in compaction-history.test.ts.
      { role: "tool", tool_call_id: "call-ok", name: "bash", content: "hi" },
    ]);
  });

  it("moves the front only at a summary", async () => {
    const convId = await newConv();
    const before = await historyFront(convId);
    await append(convId, 0, 200);
    expect(await historyFront(convId)).toBe(before);
    await summary(convId, "So far.");
    expect(await historyFront(convId)).not.toBe(before);
  });
});
