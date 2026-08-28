import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { v4 as uuid } from "uuid";
import { db, eq } from "@shannon/db";
import { conversations, messages, usageRecords, user } from "@shannon/db/schema";
import type { ContentBlock } from "@shannon/types";
import { getStreamBroker, initStreamBroker } from "../../index.ts";
import { loadHistory as loadAgentHistory } from "../engine.ts";
import { startCompactRun } from "../compactRun.ts";

/**
 * Integration test against the real dev Postgres (matches authz.test.ts's
 * pattern) — exercises two things a unit test on pure functions can't:
 *
 *   1. Both history loaders actually stop at the newest *real* summary (not
 *      a textless skip card) and correctly exclude everything at-or-before
 *      it from the prompt, while a cold REST load would still show all of it.
 *   2. `startCompactRun`'s no-op guard fires BEFORE any model call — proven
 *      here by never configuring a live inference backend at all: if the
 *      guard didn't short-circuit, these tests would hang or fail on a
 *      network call instead of resolving immediately.
 */
describe("compaction: history cutoff + no-op guard", () => {
  const userId = `test-compact-${uuid()}`;
  const convIds: string[] = [];

  beforeAll(async () => {
    await initStreamBroker();
    await db.insert(user).values({
      id: userId,
      name: "Test Compact",
      email: `${userId}@example.test`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  afterAll(async () => {
    for (const id of convIds) {
      await db.delete(messages).where(eq(messages.conversationId, id));
      await db.delete(usageRecords).where(eq(usageRecords.conversationId, id));
      await db.delete(conversations).where(eq(conversations.id, id));
    }
    await db.delete(user).where(eq(user.id, userId));
  });

  async function newConv(): Promise<string> {
    const [conv] = await db.insert(conversations).values({ ownerId: userId, title: "compact test" }).returning();
    convIds.push(conv.id);
    return conv.id;
  }

  const textBlock = (text: string): ContentBlock[] => [{ kind: "text", text }];
  const summaryBlocks = (text: string): ContentBlock[] => [
    { kind: "text", text },
    { kind: "compaction", messages_compacted: 2, before_tokens: 100, after_tokens: 20, saved_tokens: 80, before_estimated: false },
  ];

  // Chat now uses the same lamport-ordered, tool-aware loader as the agent
  // surface (its old createdAt-ordered, text-only loader is gone) — so what
  // is worth pinning here is the tool round-trip: persisted tool turns
  // replay, and a dangling call (no matching result) is stripped.
  it("loadHistory replays tool turns and strips dangling calls", async () => {
    const convId = await newConv();
    let lamport = 1000;

    await db.insert(messages).values([
      { id: uuid(), conversationId: convId, authorType: "user", origin: "server", lamport: lamport++, content: textBlock("run something"), status: "complete", createdAt: new Date() },
      {
        id: uuid(),
        conversationId: convId,
        authorType: "assistant",
        origin: "server",
        lamport: lamport++,
        content: [
          { kind: "text", text: "Running it." },
          { kind: "tool_call", call_id: "call-ok", tool: "bash", args: { command: "echo hi" } },
          { kind: "tool_call", call_id: "call-dangling", tool: "bash", args: { command: "echo lost" } },
        ] as ContentBlock[],
        status: "complete",
        createdAt: new Date(),
      },
      {
        id: uuid(),
        conversationId: convId,
        authorType: "tool",
        origin: "server",
        lamport: lamport++,
        content: [{ kind: "tool_result", call_id: "call-ok", output: "hi" }] as ContentBlock[],
        status: "complete",
        createdAt: new Date(),
      },
      { id: uuid(), conversationId: convId, authorType: "assistant", origin: "server", lamport: lamport++, content: textBlock("Done."), status: "complete", createdAt: new Date() },
    ]);

    const history = await loadAgentHistory(convId);
    expect(history.messages).toEqual([
      { role: "user", content: "run something" },
      {
        role: "assistant",
        content: "Running it.",
        tool_calls: [
          { id: "call-ok", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "echo hi" }) } },
        ],
      },
      { role: "tool", tool_call_id: "call-ok", content: "hi" },
      { role: "assistant", content: "Done." },
    ]);
  });

  it("loadHistory (agent) replays only what came after the newest summary, by lamport — not createdAt", async () => {
    const convId = await newConv();
    // Every row gets the SAME createdAt on purpose: if the cutoff were
    // accidentally keyed on createdAt instead of lamport, this test would
    // fail (or pass for the wrong reason) — this forces it to only pass if
    // the lamport-based query is what's actually running.
    const sameCreatedAt = new Date();
    let lamport = 1000;

    await db.insert(messages).values([
      { id: uuid(), conversationId: convId, authorType: "user", origin: "server", lamport: lamport++, content: textBlock("old ask"), status: "complete", createdAt: sameCreatedAt },
      { id: uuid(), conversationId: convId, authorType: "assistant", origin: "server", lamport: lamport++, content: textBlock("old reply"), status: "complete", createdAt: sameCreatedAt },
    ]);
    await db.insert(messages).values({
      id: uuid(),
      conversationId: convId,
      authorType: "summary",
      origin: "server",
      lamport: lamport++,
      content: summaryBlocks("AGENT SUMMARY"),
      status: "complete",
      createdAt: sameCreatedAt,
    });
    await db.insert(messages).values([
      { id: uuid(), conversationId: convId, authorType: "user", origin: "server", lamport: lamport++, content: textBlock("new ask"), status: "complete", createdAt: sameCreatedAt },
      { id: uuid(), conversationId: convId, authorType: "assistant", origin: "server", lamport: lamport++, content: textBlock("new reply"), status: "complete", createdAt: sameCreatedAt },
    ]);

    const history = await loadAgentHistory(convId);
    expect(history.summaryText).toBe("AGENT SUMMARY");
    expect(history.messages).toEqual([
      { role: "user", content: "new ask" },
      { role: "assistant", content: "new reply" },
    ]);
  });

  it("a textless skip card never acts as a compaction cutoff", async () => {
    const convId = await newConv();
    const t0 = Date.now();
    const at = (offsetMs: number) => new Date(t0 + offsetMs);

    await db.insert(messages).values([
      { id: uuid(), conversationId: convId, authorType: "user", origin: "server", lamport: t0, content: textBlock("q1"), status: "complete", createdAt: at(0) },
      { id: uuid(), conversationId: convId, authorType: "assistant", origin: "server", lamport: t0 + 1, content: textBlock("a1"), status: "complete", createdAt: at(1000) },
    ]);
    // A skip card: compaction block only, no text block — exactly what
    // startCompactRun's no-op path persists.
    await db.insert(messages).values({
      id: uuid(),
      conversationId: convId,
      authorType: "summary",
      origin: "server",
      lamport: t0 + 2,
      content: [{ kind: "compaction", messages_compacted: 0, before_tokens: 0, after_tokens: 0, saved_tokens: 0, before_estimated: false, skipped: "too_short" }] as ContentBlock[],
      status: "complete",
      createdAt: at(2000),
    });

    const history = await loadAgentHistory(convId);
    expect(history.summaryText).toBeNull();
    expect(history.messages).toEqual([
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
    ]);
  });

  it("startCompactRun refuses (skipped: already_compacted) when nothing follows the newest summary — no model call", async () => {
    const convId = await newConv();
    await db.insert(messages).values([
      { id: uuid(), conversationId: convId, authorType: "user", origin: "server", lamport: 1, content: textBlock("q"), status: "complete", createdAt: new Date(Date.now() - 2000) },
      { id: uuid(), conversationId: convId, authorType: "assistant", origin: "server", lamport: 2, content: textBlock("a"), status: "complete", createdAt: new Date(Date.now() - 1000) },
    ]);
    await db.insert(messages).values({
      id: uuid(),
      conversationId: convId,
      authorType: "summary",
      origin: "server",
      lamport: 3,
      content: summaryBlocks("already done"),
      status: "complete",
      createdAt: new Date(),
    });

    // No MOCK_INFERENCE, no reachable inference backend configured for this
    // test run — if the guard didn't short-circuit before generation, this
    // would hang or reject on a network call instead of resolving.
    const result = await startCompactRun({ userId, conversationId: convId, model: "test-model", surface: "chat" });

    const broker = getStreamBroker();
    const records = await broker.readFrom(result.streamId, 0);
    const snapshot = broker.foldSnapshot(records);
    const summaryMsg = snapshot.messages.find((m) => m.author_type === "summary");
    expect(summaryMsg?.compaction?.skipped).toBe("already_compacted");
    expect(summaryMsg?.compaction?.saved_tokens).toBe(0);

    // Nothing extra was written — the skip card is the only new row.
    const rows = await db.query.messages.findMany({ where: eq(messages.conversationId, convId) });
    expect(rows.filter((r) => r.authorType === "summary")).toHaveLength(2);
  });

  it("startCompactRun refuses (skipped: too_short) on a conversation with fewer than 2 messages", async () => {
    const convId = await newConv();
    await db.insert(messages).values({
      id: uuid(),
      conversationId: convId,
      authorType: "user",
      origin: "server",
      lamport: 1,
      content: textBlock("hi"),
      status: "complete",
      createdAt: new Date(),
    });

    const result = await startCompactRun({ userId, conversationId: convId, model: "test-model", surface: "chat" });

    const broker = getStreamBroker();
    const records = await broker.readFrom(result.streamId, 0);
    const snapshot = broker.foldSnapshot(records);
    const summaryMsg = snapshot.messages.find((m) => m.author_type === "summary");
    expect(summaryMsg?.compaction?.skipped).toBe("too_short");
  });
});
