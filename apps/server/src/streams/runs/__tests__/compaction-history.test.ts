import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useServableModels } from "../../../llama/__tests__/servable-model.ts";
import { v4 as uuid } from "uuid";
import { db, eq } from "@loxaic/db";
import { conversations, messages, usageRecords, user } from "@loxaic/db/schema";
import type { ContentBlock } from "@loxaic/types";
import { getStreamBroker, initStreamBroker } from "../../index.ts";
import {
  assistantMessageForPrompt,
  loadHistory as loadAgentHistory,
  toolCallsForPrompt,
  toolResultMessageForPrompt,
} from "../engine.ts";

/** Mirrors the engine's own arg parsing, which isn't exported. */
function safeParseArgsLike(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
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
  // "test-model" is a bare reference, which is only usable as an enabled local model.
  let cleanupServable: () => Promise<void> = () => Promise.resolve();

  beforeAll(async () => {
    await initStreamBroker();
    cleanupServable = await useServableModels(["test-model"]);
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
    await cleanupServable();
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
          { id: "call-ok", type: "function", function: { name: "bash", arguments: '{"command":"echo hi"}' } },
        ],
      },
      // `name` is part of the shape, not optional decoration: the live loop
      // sends it, so a replay without it is a different message — see below.
      { role: "tool", tool_call_id: "call-ok", name: "bash", content: "hi" },
      { role: "assistant", content: "Done." },
    ]);
  });

  it("replays a tool exchange byte-identically to what the live loop sent", async () => {
    // The prompt cache works on a *prefix*, and prompt fingerprints hash each
    // message with JSON.stringify — so a replay that differs from the live
    // message by a key, a key's order, or the spacing inside `arguments`
    // breaks the prefix at the first tool call and records reusable_tokens: 0
    // for every turn after it. Both divergences below were real: the loop sent
    // the model's verbatim `arguments` string and a `name` the replay omitted.
    const convId = await newConv();
    let lamport = 5000;
    // Deliberately *not* canonical JSON: odd spacing, and keys in an order
    // Postgres jsonb will not give back (it re-sorts by length, so "cwd"
    // returns before "command"). Both paths must still agree.
    const rawArguments = '{ "command" : "echo hi",  "cwd": "/tmp" }';
    const parsed = JSON.parse(rawArguments) as Record<string, unknown>;

    await db.insert(messages).values([
      { id: uuid(), conversationId: convId, authorType: "user", origin: "server", lamport: lamport++, content: textBlock("go"), status: "complete", createdAt: new Date() },
      {
        id: uuid(),
        conversationId: convId,
        authorType: "assistant",
        origin: "server",
        lamport: lamport++,
        content: [
          { kind: "text", text: "Running." },
          { kind: "tool_call", call_id: "c1", tool: "bash", args: parsed },
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
        content: [{ kind: "tool_result", call_id: "c1", output: "hi" }] as ContentBlock[],
        status: "complete",
        createdAt: new Date(),
      },
    ]);

    // What the live loop appends for that same exchange, through the shared
    // builders. If these constructors ever stop being the only way either path
    // makes a message, this test stops meaning anything — hence the direct use.
    const liveCalls = toolCallsForPrompt([{ id: "c1", name: "bash", args: safeParseArgsLike(rawArguments) }]);
    const live = [
      assistantMessageForPrompt("Running.", liveCalls),
      toolResultMessageForPrompt("c1", "bash", "hi"),
    ];

    const replayed = (await loadAgentHistory(convId)).messages.slice(1);
    // JSON.stringify, not toEqual: key order is what the fingerprint hashes,
    // and toEqual would happily accept a reordered object.
    expect(replayed.map((m) => JSON.stringify(m))).toEqual(live.map((m) => JSON.stringify(m)));
  });

  it("replays assistant text identically when the model left whitespace around it", async () => {
    // The live loop pushes the raw accumulated deltas; textOf trims. A model
    // ending its text with "\n" before a tool call is routine, and the two
    // paths then disagreed at that message — breaking the prefix and recording
    // reusable_tokens: 0 for the turn after it. The builder trims for both.
    const convId = await newConv();
    let lamport = 7000;
    await db.insert(messages).values([
      { id: uuid(), conversationId: convId, authorType: "user", origin: "server", lamport: lamport++, content: textBlock("go"), status: "complete", createdAt: new Date() },
      {
        id: uuid(),
        conversationId: convId,
        authorType: "assistant",
        origin: "server",
        lamport: lamport++,
        // Stored exactly as the model produced it, trailing newlines included.
        content: [
          { kind: "text", text: "Running it.\n\n" },
          { kind: "tool_call", call_id: "w1", tool: "bash", args: { command: "ls" } },
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
        content: [{ kind: "tool_result", call_id: "w1", output: "ok" }] as ContentBlock[],
        status: "complete",
        createdAt: new Date(),
      },
    ]);

    const live = assistantMessageForPrompt(
      "Running it.\n\n",
      toolCallsForPrompt([{ id: "w1", name: "bash", args: { command: "ls" } }]),
    );
    const replayed = (await loadAgentHistory(convId)).messages[1];
    expect(JSON.stringify(replayed)).toBe(JSON.stringify(live));
  });

  it("collapses whitespace-only assistant text to null on both paths", () => {
    // Live sent "\n" (truthy) where the replay sent null — the same divergence
    // in its nastiest form, since it changes the field's type as well.
    const calls = toolCallsForPrompt([{ id: "w2", name: "bash", args: {} }]);
    expect(JSON.stringify(assistantMessageForPrompt("\n  ", calls))).toBe(
      JSON.stringify(assistantMessageForPrompt("", calls)),
    );
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
