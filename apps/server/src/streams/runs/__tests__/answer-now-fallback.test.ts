import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { v4 as uuid } from "uuid";
import { db, eq } from "@loxaic/db";
import { conversations, messages, usageRecords, user, userPrefs } from "@loxaic/db/schema";
import type { ContentBlock } from "@loxaic/types";
import type { ChatMessage, StreamEvent, StreamOptions } from "../../../inference/provider.ts";

/**
 * `tool_choice: "none"` is a request, and a backend is free to ignore it.
 *
 * LM Studio reports nothing about whether it honours the field, and the
 * deployment's backend is whatever the operator pointed us at — so a run a
 * progress review told to answer cannot assume the model will comply. If it calls a tool anyway, the one
 * thing that must not happen is an assistant `tool_call` left without a
 * matching `tool_result`: that is the orphan `loadHistory` has to strip, and
 * most backends reject it outright on the next turn, which would break the
 * conversation rather than just this reply.
 *
 * So this mocks a disobedient backend directly. The mock lane honours the
 * flag, which is correct of it and is exactly why this case needs its own
 * stub.
 */
process.env.MOCK_INFERENCE = "true";

const disobedient = vi.hoisted(() => ({ on: false }));

vi.mock("../../../inference/provider.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../inference/provider.ts")>();
  return {
    ...actual,
    streamCompletion: (model: string, msgs: ChatMessage[], options: StreamOptions = {}) => {
      if (!(disobedient.on && options.toolChoice === "none")) return actual.streamCompletion(model, msgs, options);
      // Told not to use tools; calls one regardless, with some text alongside.
      return (async function* (): AsyncGenerator<StreamEvent> {
        await Promise.resolve();
        yield { type: "delta", content: "Here is what I found." };
        yield {
          type: "done",
          result: {
            text: "Here is what I found.",
            content: "Here is what I found.",
            toolCalls: [
              {
                id: "defiant_call_1",
                type: "function" as const,
                function: { name: "todo_write", arguments: JSON.stringify({ todos: [{ text: "More", status: "pending" }] }) },
              },
            ],
            finishReason: "tool_calls",
            ttftMs: 1,
            totalMs: 2,
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            timings: null,
            cachedTokens: null,
            promptTps: null,
            genTps: null,
          },
        };
      })();
    },
  };
});

const { startAgentRun } = await import("../agentRun.ts");
const { getRunByConversation } = await import("../../registry.ts");
const { initStreamBroker, getStreamBroker } = await import("../../index.ts");
const { __resetMockScenariosForTest } = await import("../../../inference/mock-scenarios.ts");

describe("answer now, against a backend that calls a tool anyway", () => {
  const userId = `test-answer-now-${uuid()}`;
  const convIds: string[] = [];
  const dir = mkdtempSync(path.join(tmpdir(), "answer-now-"));

  beforeAll(async () => {
    await initStreamBroker();
    await db.insert(user).values({
      id: userId,
      name: "Test Answer Now",
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
    await db.delete(userPrefs).where(eq(userPrefs.userId, userId));
    await db.delete(user).where(eq(user.id, userId));
    delete process.env.MOCK_SCENARIOS_FILE;
    __resetMockScenariosForTest();
    rmSync(dir, { recursive: true, force: true });
  });

  async function waitFor(label: string, check: () => boolean, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (check()) return;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  it("pairs the ignored call with a result and ends the turn complete", async () => {
    // Reviewed after every step, and the mock's reviewer says it is finished:
    // the run is told so after its first step and told to answer, without
    // tools, after its second.
    await db
      .insert(userPrefs)
      .values({ userId, progressCheckSteps: null, updatedAt: new Date() })
      .onConflictDoUpdate({ target: userPrefs.userId, set: { progressCheckSteps: null } });
    process.env.PROGRESS_CHECK_STEPS = "1";
    writeFileSync(path.join(dir, "scenarios.json"), JSON.stringify([{ match: "review-finished", steps: [1, 2].map((n) => ({ tool: "todo_write", args: { todos: [{ id: "1", text: `Step ${String(n)}`, status: "in_progress" }] } })) }]));
    process.env.MOCK_SCENARIOS_FILE = path.join(dir, "scenarios.json");
    __resetMockScenariosForTest();
    // Before the run starts: its steps and reviews take milliseconds.
    disobedient.on = true;
    const [conv] = await db
      .insert(conversations)
      .values({ ownerId: userId, title: "answer now", kind: "agent" })
      .returning();
    convIds.push(conv.id);

    const { streamId } = await startAgentRun({
      userId,
      // Two scripted todo_write steps, so the run is reviewed twice.
      content: "review-finished: two steps",
      model: "llama-3.1-8b-instruct",
      mode: "auto",
      conversationId: conv.id,
    });

    try {
      await waitFor("the run to finish", () => getRunByConversation(conv.id) === undefined);
    } finally {
      disobedient.on = false;
      delete process.env.PROGRESS_CHECK_STEPS;
    }

    // The turn ended cleanly: a model that would not stop calling tools is not
    // a failure of the turn, and the text it did produce is the answer.
    expect((await getStreamBroker().getMeta(streamId))?.status).toBe("complete");

    const rows = await db.query.messages.findMany({ where: eq(messages.conversationId, conv.id) });
    const blocks = rows.flatMap((r) => r.content as ContentBlock[]);
    const calls = blocks.filter((b): b is Extract<ContentBlock, { kind: "tool_call" }> => b.kind === "tool_call");
    const results = blocks.filter((b): b is Extract<ContentBlock, { kind: "tool_result" }> => b.kind === "tool_result");
    // Every call has its partner — the property that keeps the *next* turn
    // loadable at all.
    expect(results.map((r) => r.call_id).sort()).toEqual(calls.map((c) => c.call_id).sort());
    const defiant = results.find((r) => r.call_id === "defiant_call_1");
    expect(defiant?.ok).toBe(false);
    expect(defiant?.output).toContain("without tools");
    // ...and the tool it insisted on did not actually run.
    expect(blocks.some((b) => b.kind === "text" && b.text.includes("Here is what I found."))).toBe(true);

    // A successful turn ends like every other successful turn. This branch
    // used to end the stream with no usage at all — no token counts, no
    // context breakdown — and `return` past the compaction check, so a turn
    // over the threshold silently left the next one to build an over-size
    // prompt. The usage on the final `message.end` is the observable half of
    // both fixes: it is built by the same closure that decides compaction.
    const records = await getStreamBroker().readFrom(streamId, 0);
    const ends = records
      .map((r) => r.event)
      .filter((e): e is Extract<typeof e, { kind: "message.end" }> => e.kind === "message.end");
    const finalEnd = ends.at(-1);
    expect(finalEnd?.status).toBe("complete");
    expect(finalEnd?.usage?.prompt_tokens).toBe(10);
    expect(finalEnd?.usage?.completion_tokens).toBe(5);
  });
});
