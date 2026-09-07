import "./force-prompt-prefix.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { v4 as uuid } from "uuid";
import { db, eq } from "@loxaic/db";
import { conversations, messages, usageRecords, user } from "@loxaic/db/schema";
import type { ChatMessage } from "../../../inference/provider.ts";
import { __resetMockScenariosForTest } from "../../../inference/mock-scenarios.ts";

/**
 * The invariant the whole prompt-caching effort rests on, asserted end to end
 * against real runs rather than against either side's idea of what it sends.
 *
 * llama.cpp and LM Studio cache the KV state of a prompt **prefix**: a turn is
 * cheap only when the previous request's prompt is a literal prefix of this
 * one. Every request the server makes for a conversation must therefore extend
 * the last, message for message and byte for byte.
 *
 * Four separate bugs have broken exactly this, each in its own way, and each
 * was found by inspection *after* shipping:
 *
 *   1. a history window that slid by one message per turn;
 *   2. the replay dropping `name` from tool messages the live loop sent;
 *   3. the replay re-serialising tool `arguments` — and Postgres jsonb not
 *      preserving key order, so the round-trip changed the bytes on its own;
 *   4. the live loop sending untrimmed assistant text where the replay trimmed.
 *
 * Every one of those is a *serialisation* mismatch between two code paths that
 * must agree, and no unit test on either path alone can see it. This one does:
 * it records the actual `messages` array handed to `streamCompletion` on every
 * request and asserts each is an element-wise extension of the one before.
 * Reproduced against all four defects before being committed.
 */

/** Every request's messages, JSON-encoded per message, in call order. */
const requests: string[][] = [];

vi.mock("../../../inference/provider.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../inference/provider.ts")>();
  return {
    ...actual,
    streamCompletion: (model: string, msgs: ChatMessage[], options?: unknown) => {
      // Snapshot at call time. `chatMessages` is the live array the tool loop
      // keeps appending to, so holding a reference would record what it looked
      // like at the *end* of the run and quietly assert nothing.
      requests.push(msgs.map((m) => JSON.stringify(m)));
      return actual.streamCompletion(model, msgs, options as never);
    },
  };
});

const { startChatRun } = await import("../chatRun.ts");
const { getRunByConversation } = await import("../../registry.ts");
const { initStreamBroker } = await import("../../index.ts");

const userId = `test-prefix-${uuid()}`;
const convIds: string[] = [];

beforeAll(async () => {
  await initStreamBroker();
  await db.insert(user).values({
    id: userId,
    name: "Test Prefix",
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
  delete process.env.AUTO_COMPACT_THRESHOLD;
});

afterEach(() => {
  requests.length = 0;
});

/** Starts a turn without waiting for it, for the concurrency case below. */
async function startTurn(content: string): Promise<string> {
  const result = await startChatRun({ userId, content, model: "llama-3.1-8b-instruct" });
  if (!convIds.includes(result.conversationId)) convIds.push(result.conversationId);
  return result.conversationId;
}

async function waitForRun(convId: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (getRunByConversation(convId)) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the run to finish");
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Sends one turn and resolves when the run has fully finished. */
async function turn(content: string, conversationId?: string): Promise<string> {
  const result = await startChatRun({
    userId,
    content,
    model: "llama-3.1-8b-instruct",
    ...(conversationId === undefined ? {} : { conversationId }),
  });
  const convId = result.conversationId;
  if (!convIds.includes(convId)) convIds.push(convId);

  const deadline = Date.now() + 20_000;
  // The run is detached from the caller, and the registry entry is what says
  // it is still going — polling the message rows would race the tool loop,
  // which completes an assistant message and then keeps iterating.
  while (getRunByConversation(convId)) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the run to finish");
    await new Promise((r) => setTimeout(r, 50));
  }
  return convId;
}

/**
 * Asserts request N is an element-wise prefix of request N+1, for every
 * consecutive pair.
 *
 * Compares the JSON of each message rather than the objects, because key order
 * is part of what the backend renders and what `fingerprintPrompt` hashes —
 * `toEqual` would accept a reordered object, which is precisely the bug the
 * jsonb round-trip produced.
 */
function expectEachRequestExtendsTheLast(): void {
  expect(requests.length).toBeGreaterThan(1);
  for (let n = 1; n < requests.length; n++) {
    const previous = requests[n - 1];
    const current = requests[n];
    expect(current.length).toBeGreaterThanOrEqual(previous.length);
    for (let i = 0; i < previous.length; i++) {
      // Named in the failure so a regression says *which* message diverged.
      expect({ request: n, message: i, json: current[i] }).toEqual({
        request: n,
        message: i,
        json: previous[i],
      });
    }
  }
}

describe("a github workspace produces a byte-identical system prompt every turn", () => {
  it("holds across two turns", async () => {
    // The workspace description is the very first thing in every request. If
    // anything in it varied between turns — a live "is a PR open" flag, the
    // sandbox's current state — the prefix would break at token one and every
    // turn would re-evaluate the whole history. No sandbox is created here:
    // the todo trigger needs none, and the prompt is built before any would be.
    const [conv] = await db
      .insert(conversations)
      .values({
        ownerId: userId,
        title: "github prefix test",
        kind: "agent",
        workspace: {
          kind: "github", repo: "octo/real", baseBranch: "main", branch: "loxaic/abcd1234",
          cloneUrl: "https://github.example/octo/real.git",
        },
      })
      .returning();
    convIds.push(conv.id);
    const { startAgentRun } = await import("../agentRun.ts");
    const run = async (content: string) => {
      await startAgentRun({ userId, content, model: "llama-3.1-8b-instruct", mode: "auto", conversationId: conv.id });
      await waitForRun(conv.id);
    };
    await run("make a todo list for alpha");
    await run("make a todo list for bravo");

    expectEachRequestExtendsTheLast();
    // And it is the workspace prompt, not a leftover generic one.
    expect(requests[0][0]).toContain("octo/real");
    expect(requests[0][0]).toContain("loxaic/abcd1234");
  });
});

describe("two conversations do not interleave their requests", () => {
  it("finishes one run's requests before starting the other's", async () => {
    // The prefix invariant every other case here asserts is *per conversation*
    // and says nothing about this: two runs can each extend their own previous
    // request perfectly while alternating, which is exactly what evicts the
    // backend's single cached prefix on every call. On a 14.5k-token thread
    // that is the difference between 312 ms and 14,551 ms — per iteration.
    //
    // Both prompts trigger the mock's todo_write call, so each run makes two
    // requests and there is a real window to interleave in.
    const alpha = await startTurn("make a todo list for alpha");
    const bravo = await startTurn("make a todo list for bravo");
    await waitForRun(alpha);
    await waitForRun(bravo);

    // Which conversation each request belonged to, in the order they went out.
    const owners = requests.map((msgs) => {
      const joined = msgs.join("");
      if (joined.includes("alpha")) return "alpha";
      if (joined.includes("bravo")) return "bravo";
      throw new Error("a request belonged to neither conversation");
    });

    expect(owners.length).toBeGreaterThanOrEqual(4);
    // Contiguous: every run's requests form one unbroken block. Asserted as
    // "the owner changes at most once" rather than by comparing to a fixed
    // order, because which run wins the slot first is a race and does not
    // matter — only that the loser waits.
    const switches = owners.filter((o, i) => i > 0 && o !== owners[i - 1]).length;
    expect({ owners, switches }).toEqual({ owners, switches: 1 });
  });
});

describe("every prompt extends the previous one", () => {
  it("holds across a plain two-turn conversation", async () => {
    const convId = await turn("first question");
    await turn("second question", convId);
    expectEachRequestExtendsTheLast();
  });

  it("holds across a run that called a tool, and the turn after it", async () => {
    // "todo" triggers the mock's todo_write call, which needs no approval and
    // no sandbox — so the loop really does run a second iteration, persist an
    // assistant message with a tool_call and a tool message with its result,
    // and replay both on the next turn. That replay boundary is where three of
    // the four historical defects lived.
    const convId = await turn("make a todo list for this work");
    expect(requests.length).toBeGreaterThan(1); // the tool loop iterated

    await turn("thanks, what is next?", convId);
    expectEachRequestExtendsTheLast();
  });

  it("holds on a conversation long enough for the replay window to be anchored", async () => {
    // 74 seeded messages puts the next two turns at 75 and 77 rows, both of
    // which anchor at offset 25 — so the window is genuinely truncating and
    // genuinely holding still. A window that slid with the conversation (the
    // original defect) would start at 25 for one turn and 27 for the next,
    // and the prefix would break at the very first replayed message.
    const [conv] = await db
      .insert(conversations)
      .values({ ownerId: userId, title: "prefix window test" })
      .returning();
    convIds.push(conv.id);
    const seeded: (typeof messages.$inferInsert)[] = Array.from({ length: 74 }, (_, i) => ({
        id: uuid(),
        conversationId: conv.id,
        authorType: i % 2 === 0 ? "user" : "assistant",
        origin: "server",
        lamport: 1000 + i,
        content: [{ kind: "text", text: `seeded ${String(i)}` }],
        status: "complete",
        createdAt: new Date(1_700_000_000_000 + i),
    }));
    await db.insert(messages).values(seeded);

    await turn("first real question", conv.id);
    await turn("second real question", conv.id);
    // The window is doing its job, not quietly replaying everything.
    expect(requests[0].length).toBeLessThan(74);
    expectEachRequestExtendsTheLast();
  });

  it("keeps the fixture able to expose these bugs at all", async () => {
    // A canary, not a behaviour test. Two of the four defects above were
    // invisible for as long as they were because MOCK_INFERENCE was tidier
    // than a real model: its text had no trailing whitespace, and its tool
    // arguments happened to be in the same order Postgres jsonb returns them.
    // Both tests above depend on the mock *not* being tidy, and neither would
    // fail loudly if someone cleaned it up — they would just silently stop
    // covering anything. So the fixture's two load-bearing properties are
    // pinned here, where a change to them fails with a reason.
    const convId = await turn("make a todo list for this work");
    const rows = await db.query.messages.findMany({ where: eq(messages.conversationId, convId) });

    const assistant = rows.find(
      (r) => r.authorType === "assistant" && (r.content as { kind: string }[]).some((b) => b.kind === "tool_call"),
    );
    if (!assistant) throw new Error("expected an assistant message carrying a tool call");
    const blocks = assistant.content as { kind: string; text?: string; args?: Record<string, unknown> }[];

    const text = blocks.find((b) => b.kind === "text")?.text ?? "";
    expect(text).not.toBe(text.trim()); // untrimmed, as a real model leaves it

    // Round-tripped through jsonb, so this is the order the replay actually
    // sees — and it must differ from the order the live loop sent, or the
    // canonicalisation this relies on is never exercised.
    const todos = (blocks.find((b) => b.kind === "tool_call")?.args?.todos ?? []) as Record<string, unknown>[];
    expect(todos.length).toBeGreaterThan(0);
    expect(Object.keys(todos[0])).not.toEqual(["status", "id", "text"]);
  });
});

describe("a mock scenario's steps replay identically too", () => {
  // A scenario step bypasses the single-call rule by design (that is the
  // whole reason it exists), which makes it a new way for the live loop and
  // the replay to disagree — the same class of bug the four-defects comment
  // at the top of this file describes, just from a second code path capable
  // of producing a multi-tool-call turn.
  let dir: string;
  let file: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "mock-scenarios-"));
    file = path.join(dir, "scenarios.json");
    writeFileSync(
      file,
      JSON.stringify([
        {
          match: "run scenario alpha",
          steps: [
            { tool: "todo_write", args: { todos: [{ status: "pending", id: "1", text: "step one" }] } },
            { tool: "todo_write", args: { todos: [{ status: "completed", id: "1", text: "step one" }] } },
          ],
          finalText: "[Mock] scenario alpha finished.\n",
        },
      ]),
    );
  });

  afterAll(() => {
    delete process.env.MOCK_SCENARIOS_FILE;
    __resetMockScenariosForTest();
    rmSync(dir, { recursive: true, force: true });
  });

  it("drives two tool calls in one turn, then a byte-identical next turn", async () => {
    process.env.MOCK_SCENARIOS_FILE = file;
    __resetMockScenariosForTest();

    const convId = await turn("run scenario alpha");
    // Two scenario steps plus the wrap-up request: three requests, where the
    // single-call rule alone would have allowed only two (one tool call, one
    // wrap-up).
    expect(requests.length).toBe(3);

    await turn("thanks, what is next?", convId);
    expectEachRequestExtendsTheLast();

    const rows = await db.query.messages.findMany({ where: eq(messages.conversationId, convId) });
    const finalAssistant = rows.find(
      (r) =>
        r.authorType === "assistant" &&
        (r.content as { kind: string; text?: string }[]).some((b) => b.kind === "text" && b.text?.includes("scenario alpha finished")),
    );
    expect(finalAssistant).toBeTruthy();
  });
});
