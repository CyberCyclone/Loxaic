import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { v4 as uuid } from "uuid";
import { db, eq } from "@loxaic/db";
import { conversations, messages, user } from "@loxaic/db/schema";
import type { ContentBlock } from "@loxaic/types";
import { HISTORY_LIMIT, HISTORY_STEP, historyAnchor, loadHistory } from "../engine.ts";

/**
 * The replay window's oldest edge must be *anchored*, not sliding.
 *
 * A window of exactly HISTORY_LIMIT that drops one message per turn means the
 * prompt never starts with the same tokens twice, so the backend's KV cache
 * is useless and the whole history is re-evaluated on every turn — measured
 * at 312 ms versus 14,551 ms on a 14.5k-token thread against a local LM
 * Studio. What these tests pin is the property that makes the cache work:
 * consecutive turns produce prompts where the earlier one is a *prefix* of
 * the later one, except at the rare quantised re-anchor.
 *
 * Integration against the real dev Postgres, matching compaction-history.test.ts.
 */
describe("history window: anchored, not sliding", () => {
  const userId = `test-window-${uuid()}`;
  const convIds: string[] = [];

  beforeAll(async () => {
    await db.insert(user).values({
      id: userId,
      name: "Test Window",
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
    const [conv] = await db.insert(conversations).values({ ownerId: userId, title: "window test" }).returning();
    convIds.push(conv.id);
    return conv.id;
  }

  const textBlock = (text: string): ContentBlock[] => [{ kind: "text", text }];

  /** Append message `m<i>` for i in [from, to), alternating roles. */
  async function append(convId: string, from: number, to: number): Promise<void> {
    const rows: (typeof messages.$inferInsert)[] = [];
    for (let i = from; i < to; i++) {
      rows.push({
        id: uuid(),
        conversationId: convId,
        authorType: i % 2 === 0 ? "user" : "assistant",
        origin: "server" as const,
        lamport: 1000 + i,
        content: textBlock(`m${String(i)}`),
        status: "complete" as const,
        createdAt: new Date(1_700_000_000_000 + i),
      });
    }
    await db.insert(messages).values(rows);
  }

  /** The replayed contents, e.g. ["m25", "m26", …]. */
  const contents = (msgs: { content: unknown }[]): string[] => msgs.map((m) => String(m.content));

  describe("historyAnchor", () => {
    it("replays everything up to HISTORY_LIMIT", () => {
      expect(historyAnchor(0)).toBe(0);
      expect(historyAnchor(1)).toBe(0);
      expect(historyAnchor(HISTORY_LIMIT)).toBe(0);
    });

    it("lets the window grow past the limit rather than sliding at it", () => {
      // The window is allowed to reach HISTORY_LIMIT + HISTORY_STEP - 1
      // messages before it is narrowed — that growth is what buys a stable
      // prefix for HISTORY_STEP turns at a time.
      expect(historyAnchor(HISTORY_LIMIT + 1)).toBe(0);
      expect(historyAnchor(HISTORY_LIMIT + HISTORY_STEP - 1)).toBe(0);
    });

    it("re-anchors in HISTORY_STEP jumps, never by one", () => {
      expect(historyAnchor(HISTORY_LIMIT + HISTORY_STEP)).toBe(HISTORY_STEP);
      expect(historyAnchor(HISTORY_LIMIT + 2 * HISTORY_STEP - 1)).toBe(HISTORY_STEP);
      expect(historyAnchor(HISTORY_LIMIT + 2 * HISTORY_STEP)).toBe(2 * HISTORY_STEP);
    });

    it("never narrows the window below HISTORY_LIMIT", () => {
      for (let total = 0; total <= 400; total++) {
        const size = total - historyAnchor(total);
        expect(size).toBeGreaterThanOrEqual(Math.min(total, HISTORY_LIMIT));
        expect(size).toBeLessThan(HISTORY_LIMIT + HISTORY_STEP);
      }
    });
  });

  it("keeps the prompt a strict prefix extension across consecutive turns", async () => {
    const convId = await newConv();
    const total = HISTORY_LIMIT + 3 * HISTORY_STEP; // 125 with today's numbers
    await append(convId, 0, HISTORY_LIMIT);

    let previous = contents((await loadHistory(convId)).messages);
    const reanchoredAt: number[] = [];

    for (let n = HISTORY_LIMIT + 1; n <= total; n++) {
      await append(convId, n - 1, n);
      const current = contents((await loadHistory(convId)).messages);

      // The newest message is always present — the window only ever moves at
      // its oldest edge.
      expect(current.at(-1)).toBe(`m${String(n - 1)}`);

      if (current[0] === previous[0]) {
        // The common case: same starting message, one more on the end. This
        // is the shape the backend can serve from cache.
        expect(current.slice(0, previous.length)).toEqual(previous);
      } else {
        reanchoredAt.push(n);
      }
      previous = current;
    }

    // Three re-anchors across 75 added messages — one per HISTORY_STEP —
    // where the old sliding window paid a full prompt evaluation on all 75.
    expect(reanchoredAt).toEqual([
      HISTORY_LIMIT + HISTORY_STEP,
      HISTORY_LIMIT + 2 * HISTORY_STEP,
      HISTORY_LIMIT + 3 * HISTORY_STEP,
    ]);
  });

  it("reports truncated only once the window actually drops something", async () => {
    const convId = await newConv();
    await append(convId, 0, HISTORY_LIMIT + HISTORY_STEP - 1);

    const held = await loadHistory(convId);
    expect(held.truncated).toBe(false);
    expect(contents(held.messages)[0]).toBe("m0");

    await append(convId, HISTORY_LIMIT + HISTORY_STEP - 1, HISTORY_LIMIT + HISTORY_STEP);
    const moved = await loadHistory(convId);
    expect(moved.truncated).toBe(true);
    expect(contents(moved.messages)[0]).toBe(`m${String(HISTORY_STEP)}`);
    expect(moved.messages).toHaveLength(HISTORY_LIMIT);
  });

  it("drops a tool_result whose tool_call fell outside the window", async () => {
    const convId = await newConv();
    // The anchor lands on index HISTORY_STEP, so put the assistant's
    // tool_call at HISTORY_STEP - 1 (outside) and its result at HISTORY_STEP
    // (the window's very first message). Replaying that result alone would
    // send a `role: "tool"` message with no preceding call, which most
    // backends reject outright.
    const total = HISTORY_LIMIT + HISTORY_STEP;
    await append(convId, 0, HISTORY_STEP - 1);
    await db.insert(messages).values([
      {
        id: uuid(),
        conversationId: convId,
        authorType: "assistant",
        origin: "server",
        lamport: 1000 + HISTORY_STEP - 1,
        content: [
          { kind: "text", text: "Running it." },
          { kind: "tool_call", call_id: "call-outside", tool: "bash", args: { command: "echo hi" } },
        ] as ContentBlock[],
        status: "complete",
        createdAt: new Date(1_700_000_000_000 + HISTORY_STEP - 1),
      },
      {
        id: uuid(),
        conversationId: convId,
        authorType: "tool",
        origin: "server",
        lamport: 1000 + HISTORY_STEP,
        content: [{ kind: "tool_result", call_id: "call-outside", output: "hi" }] as ContentBlock[],
        status: "complete",
        createdAt: new Date(1_700_000_000_000 + HISTORY_STEP),
      },
    ]);
    await append(convId, HISTORY_STEP + 1, total);

    const history = await loadHistory(convId);
    expect(history.messages).toHaveLength(HISTORY_LIMIT - 1); // the orphan is gone
    expect(history.messages.some((m) => m.role === "tool")).toBe(false);
    // The window now opens on the message after the orphaned result.
    expect(history.messages[0]).toEqual({ role: "user", content: `m${String(HISTORY_STEP + 1)}` });
  });

  it("keeps a tool exchange intact when both halves are inside the window", async () => {
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
});
