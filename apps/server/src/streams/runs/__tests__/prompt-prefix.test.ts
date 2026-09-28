import "./force-prompt-prefix.ts";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { v4 as uuid } from "uuid";
import { db, eq } from "@loxaic/db";
import { conversations, messages, sandboxes, usageRecords, user, userPrefs } from "@loxaic/db/schema";
import { CHECKIN_ANSWER_NUDGE, PLAN_ACCEPTED_MESSAGE, QUESTIONS_ANSWERED_PREFIX } from "@loxaic/types";
import type { ChatMessage } from "../../../inference/provider.ts";
import { __resetMockScenariosForTest } from "../../../inference/mock-scenarios.ts";
import { __resetExecutorsForTest, handleExecutorResult, registerExecutor } from "../../../executor/registry.ts";
import { createExecutorService } from "../../../executor/service.ts";
import type { ServerToExecutor } from "../../../executor/protocol.ts";

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
/** The options each request went out with, in the same order — so a case can
 * assert not just *what* was sent but under what constraint. */
const requestOptions: { toolChoice?: string; toolCount: number; tools: string }[] = [];

vi.mock("../../../inference/provider.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../inference/provider.ts")>();
  return {
    ...actual,
    streamCompletion: (model: string, msgs: ChatMessage[], options?: unknown) => {
      // Snapshot at call time. `chatMessages` is the live array the tool loop
      // keeps appending to, so holding a reference would record what it looked
      // like at the *end* of the run and quietly assert nothing.
      requests.push(msgs.map((m) => JSON.stringify(m)));
      const opts = (options ?? {}) as { toolChoice?: string; tools?: unknown[] };
      requestOptions.push({
        toolChoice: opts.toolChoice,
        toolCount: opts.tools?.length ?? 0,
        // The schemas themselves: the same count of different tools rewrites
        // the prompt as surely as a missing one.
        tools: JSON.stringify(opts.tools ?? []),
      });
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
  requestOptions.length = 0;
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

describe("prompt prefix across a step check-in", () => {
  /**
   * A check-in parks the run mid-turn and then resumes it, which makes it a
   * new way for the live loop and the replay to diverge — and "answer now"
   * goes further, writing a message into the middle of the transcript that the
   * *next* turn has to reproduce byte for byte.
   *
   * That last part is why the instruction is persisted as a `user` row using
   * the exported constant rather than injected into the live prompt only: this
   * is the test that would fail if either side ever interpolated a step count,
   * a name, or a different key order into it.
   */
  let dir: string;
  let file: string;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "checkin-prefix-"));
    file = path.join(dir, "scenarios.json");
    writeFileSync(
      file,
      JSON.stringify([
        {
          match: "check in on me",
          steps: [
            { tool: "todo_write", args: { todos: [{ status: "pending", id: "1", text: "look around" }] } },
            { tool: "todo_write", args: { todos: [{ status: "completed", id: "1", text: "look around" }] } },
          ],
          finalText: "[Mock] check-in scenario finished.\n",
        },
      ]),
    );
    await db
      .insert(userPrefs)
      .values({ userId, maxIterations: 1, updatedAt: new Date() })
      .onConflictDoUpdate({ target: userPrefs.userId, set: { maxIterations: 1 } });
  });

  afterAll(async () => {
    delete process.env.MOCK_SCENARIOS_FILE;
    __resetMockScenariosForTest();
    rmSync(dir, { recursive: true, force: true });
    await db.delete(userPrefs).where(eq(userPrefs.userId, userId));
  });

  /** Starts a turn, waits for it to park at a check-in, and answers it. */
  async function turnAnsweringCheckin(content: string, decision: "continue" | "answer", conversationId?: string) {
    const result = await startChatRun({
      userId,
      content,
      model: "llama-3.1-8b-instruct",
      ...(conversationId === undefined ? {} : { conversationId }),
    });
    const convId = result.conversationId;
    if (!convIds.includes(convId)) convIds.push(convId);

    const deadline = Date.now() + 20_000;
    for (;;) {
      const run = getRunByConversation(convId);
      if (!run) break;
      if (run.stepsDecision) {
        run.stepsDecision(decision, userId);
        continue;
      }
      if (Date.now() > deadline) throw new Error("timed out waiting for the run to finish");
      await new Promise((r) => setTimeout(r, 25));
    }
    return convId;
  }

  it("holds when a check-in is answered with keep going", async () => {
    process.env.MOCK_SCENARIOS_FILE = file;
    __resetMockScenariosForTest();

    const convId = await turnAnsweringCheckin("check in on me", "continue");
    await turn("thanks, what is next?", convId);
    expectEachRequestExtendsTheLast();
    // Keep going adds no message of its own — the window moves, the prompt
    // does not.
    expect(requestOptions.every((o) => o.toolChoice === undefined)).toBe(true);
  });

  it("holds when a check-in is answered with answer now, and on the turn after", async () => {
    process.env.MOCK_SCENARIOS_FILE = file;
    __resetMockScenariosForTest();

    const convId = await turnAnsweringCheckin("check in on me", "answer");
    const afterAnswerNow = requests.length;
    // The wrap-up request is the one that must not use tools...
    expect(requestOptions.at(-1)?.toolChoice).toBe("none");
    // ...but it still carries them, so the template renders the same prefix it
    // did on the request before. Dropping them to express "no tools" would
    // rewrite the front of the prompt and cost a full re-evaluation on exactly
    // the request that is meant to wrap up cheaply.
    expect(requestOptions.at(-1)?.toolCount).toBe(requestOptions.at(-2)?.toolCount);
    expect(requestOptions.at(-1)?.toolCount).toBeGreaterThan(0);

    // The next turn replays the persisted instruction in the position the live
    // loop pushed it, byte for byte — this is the assertion that catches an
    // interpolated step count or a `system` row that replays differently.
    await turn("thanks, what is next?", convId);
    expectEachRequestExtendsTheLast();
    const replayed = requests[afterAnswerNow];
    expect(replayed).toContain(JSON.stringify({ role: "user", content: CHECKIN_ANSWER_NUDGE }));
  });

  it("holds when nobody answers: an auto-continue, then an automatic answer, then the next turn", async () => {
    // The ladder writes nothing of its own on a keep-going — its notice is
    // client-only — and the automatic answer persists the same fixed nudge a
    // person's would. So neither may move the prefix.
    process.env.MOCK_SCENARIOS_FILE = file;
    __resetMockScenariosForTest();
    const previous = process.env.APPROVAL_TIMEOUT_MS;
    process.env.APPROVAL_TIMEOUT_MS = "50";
    await db.update(userPrefs).set({ checkinAutoContinues: 1 }).where(eq(userPrefs.userId, userId));
    try {
      const result = await startChatRun({ userId, content: "check in on me", model: "llama-3.1-8b-instruct" });
      const convId = result.conversationId;
      convIds.push(convId);
      const deadline = Date.now() + 20_000;
      while (getRunByConversation(convId)) {
        if (Date.now() > deadline) throw new Error("timed out waiting for the run to answer for itself");
        await new Promise((r) => setTimeout(r, 25));
      }
      const afterAutoAnswer = requests.length;
      expect(requestOptions.at(-1)?.toolChoice).toBe("none");
      // Both steps ran: the first check-in kept going, the second wrapped up.
      expect(requestOptions.filter((o) => o.toolChoice === undefined).length).toBeGreaterThanOrEqual(2);

      await turn("thanks, what is next?", convId);
      expectEachRequestExtendsTheLast();
      expect(requests[afterAutoAnswer]).toContain(JSON.stringify({ role: "user", content: CHECKIN_ANSWER_NUDGE }));
    } finally {
      if (previous === undefined) delete process.env.APPROVAL_TIMEOUT_MS;
      else process.env.APPROVAL_TIMEOUT_MS = previous;
      await db.update(userPrefs).set({ checkinAutoContinues: 2 }).where(eq(userPrefs.userId, userId));
    }
  });
});

describe("prompt prefix across a plan review (#199)", () => {
  /** One planning-surface turn, finished. */
  async function agentTurn(content: string, mode: "planning" | "manual", conversationId?: string): Promise<string> {
    const { startAgentRun } = await import("../agentRun.ts");
    const result = await startAgentRun({
      userId,
      content,
      model: "llama-3.1-8b-instruct",
      mode,
      ...(conversationId === undefined ? {} : { conversationId }),
    });
    if (!convIds.includes(result.conversationId)) convIds.push(result.conversationId);
    await waitForRun(result.conversationId);
    return result.conversationId;
  }

  it("holds from a plan, through a suggestion, to the revised plan", async () => {
    // A plan ends its turn on a tool row, so the suggestion is a user row
    // straight after it — the replay boundary this case is about.
    const convId = await agentTurn("look around and propose a plan", "planning");
    await agentTurn("Add a test step, then propose a plan again.", "planning", convId);
    expectEachRequestExtendsTheLast();
  });

  it("holds across a nudged turn: prose, the nudge, then the plan, and the turn after", async () => {
    // The prose and the nudge are pushed live and replayed from rows; both
    // sides must produce the same bytes, empty prose included.
    const convId = await agentTurn("Please answer in prose, then plan it.", "planning");
    await agentTurn("Add a test step, then propose a plan again.", "planning", convId);
    expectEachRequestExtendsTheLast();
  });

  it("holds from questions, through the answers, to the plan", async () => {
    const convId = await agentTurn("Ask me some questions before you plan.", "planning");
    await agentTurn(`${QUESTIONS_ANSWERED_PREFIX}\n\n1. Which part first? — The API`, "planning", convId);
    expectEachRequestExtendsTheLast();
  });

  it("changes only the system prompt when the plan is accepted", async () => {
    const convId = await agentTurn("look around and propose a plan", "planning");
    const planning = requests.length;
    await agentTurn(PLAN_ACCEPTED_MESSAGE, "manual", convId);
    // Accepting leaves planning, and a mode is a system prompt and a tool
    // list: that one message may differ, by design. Everything after it must
    // be what the planning turn sent, byte for byte.
    const before = requests[planning - 1];
    const after = requests[planning];
    expect(after[0]).not.toEqual(before[0]);
    expect(after.slice(1, before.length)).toEqual(before.slice(1));
  });
});

describe("project instructions keep the prefix", () => {
  /**
   * The project's AGENTS.md rides at the very front of every request, so any
   * variation in it between runs — re-reading the file, re-deciding whole
   * versus outline against a window that moved — would re-evaluate the whole
   * conversation on every turn. A nested file rides inside a tool result,
   * which the replay has to reproduce exactly and must not attach twice.
   */
  const run = async (convId: string, content: string, mode: "auto" | "manual" = "auto") => {
    const { startAgentRun } = await import("../agentRun.ts");
    await startAgentRun({ userId, content, model: "llama-3.1-8b-instruct", mode, conversationId: convId });
    await waitForRun(convId);
  };

  it("renders a stored snapshot byte for byte on every run", async () => {
    const big = Array.from({ length: 300 }, (_, i) => `## Rule ${String(i)}\n${"Always do the thing. ".repeat(20)}`).join("\n");
    const [conv] = await db
      .insert(conversations)
      .values({
        ownerId: userId,
        title: "instructions prefix test",
        kind: "agent",
        workspace: {
          kind: "github", repo: "octo/real", baseBranch: "main", branch: "loxaic/instr",
          cloneUrl: "https://github.example/octo/real.git",
        },
        instructions: {
          status: "found", path: "AGENTS.md", text: big, sourceBytes: big.length, sourceTruncated: false,
          fetchedAt: "2026-09-28T00:00:00.000Z",
        },
      })
      .returning();
    convIds.push(conv.id);
    await run(conv.id, "make a todo list for alpha");
    await run(conv.id, "make a todo list for bravo");
    expectEachRequestExtendsTheLast();
    const system = (JSON.parse(requests[0][0]) as { content: string }).content;
    expect(system).toContain('<project-instructions path="AGENTS.md"');
  });

  describe("a nested file attached to a read", () => {
    let dir: string;
    let file: string;
    let hostRoot: string;
    /** A local folder: the project's own files, served by the desktop's
     * executor in process (the executor-provider.test.ts pattern). */
    let project: string;

    beforeAll(() => {
      dir = mkdtempSync(path.join(tmpdir(), "instr-prefix-"));
      hostRoot = mkdtempSync(path.join(tmpdir(), "instr-prefix-host-"));
      project = realpathSync(mkdtempSync(path.join(tmpdir(), "instr-prefix-project-")));
      mkdirSync(path.join(project, "pkg", "sub"), { recursive: true });
      writeFileSync(path.join(project, "pkg", "sub", "AGENTS.md"), "# Sub\nUse tabs in pkg/sub.\n");
      writeFileSync(path.join(project, "pkg", "sub", "index.js"), "export {};\n");
      file = path.join(dir, "scenarios.json");
      writeFileSync(
        file,
        JSON.stringify([
          {
            match: "read the sub package",
            steps: [{ tool: "fs_read", args: { path: "pkg/sub/index.js" } }],
            finalText: "[Mock] read.\n",
          },
          {
            match: "write my own sub package",
            steps: [
              {
                calls: [
                  { tool: "fs_write", args: { path: "pkg/sub/AGENTS.md", content: "# Sub\nUse tabs in pkg/sub.\n" } },
                  { tool: "fs_write", args: { path: "pkg/sub/index.js", content: "export {};\n" } },
                ],
              },
              { tool: "fs_read", args: { path: "pkg/sub/index.js" } },
            ],
            finalText: "[Mock] written.\n",
          },
        ]),
      );
      // Read at call time, like every sandbox setting — no cache to reset.
      process.env.SANDBOX_MODE = "host";
      process.env.SANDBOX_HOST_ROOT = hostRoot;
      process.env.MOCK_SCENARIOS_FILE = file;
      __resetMockScenariosForTest();

      const service = createExecutorService({ roots: () => [project], executorId: "laptop-prefix" });
      registerExecutor({
        executorId: "laptop-prefix", userId, name: "Laptop", platform: process.platform,
        capabilities: { direct: true, container: false }, roots: [project],
        send(message: ServerToExecutor) {
          if (message.type !== "call") return;
          void service.handle(message.method, message.params)
            .then((value) => { handleExecutorResult("laptop-prefix", { type: "result", id: message.id, ok: true, value }); })
            .catch((err: unknown) => {
              handleExecutorResult("laptop-prefix", { type: "result", id: message.id, ok: false, error: (err as Error).message });
            });
        },
        close: () => undefined,
      });
    });

    afterAll(async () => {
      const { destroyConversationSandboxes } = await import("../../../agent/sandbox-manager.ts");
      for (const id of convIds) await destroyConversationSandboxes(id).catch(() => undefined);
      // Scoped to this suite's user — never an unscoped delete, which would
      // take other suites' rows out from under them.
      await db.delete(sandboxes).where(eq(sandboxes.ownerId, userId));
      __resetExecutorsForTest();
      delete process.env.SANDBOX_MODE;
      delete process.env.SANDBOX_HOST_ROOT;
      delete process.env.MOCK_SCENARIOS_FILE;
      __resetMockScenariosForTest();
      rmSync(dir, { recursive: true, force: true });
      rmSync(hostRoot, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    });

    const toolResults = () =>
      (requests.at(-1) ?? [])
        .map((j) => JSON.parse(j) as { role: string; content: string })
        .filter((m) => m.role === "tool");

    it("attaches the project's own file once, and the next turn replays it exactly", async () => {
      const [conv] = await db
        .insert(conversations)
        .values({
          ownerId: userId,
          title: "nested",
          kind: "agent",
          workspace: { kind: "local", executorId: "laptop-prefix", executorName: "Laptop", path: project, isolation: "direct" },
        })
        .returning();
      convIds.push(conv.id);
      await run(conv.id, "read the sub package");
      await run(conv.id, "read the sub package again");
      expectEachRequestExtendsTheLast();

      const withMarker = toolResults().filter((m) => m.content.includes('<project-instructions path="pkg/sub/AGENTS.md"'));
      expect(withMarker).toHaveLength(1);
      expect(withMarker[0].content).toContain("Use tabs in pkg/sub.");
    });

    it("never attaches one in a scratch workspace, where the model wrote it", async () => {
      // No project, so any such file is the model's own output. Framed as the
      // project's instructions, it would come back to the model as rules it
      // must follow.
      const [conv] = await db.insert(conversations).values({ ownerId: userId, title: "nested scratch", kind: "agent" }).returning();
      convIds.push(conv.id);
      await run(conv.id, "write my own sub package");
      const results = toolResults();
      expect(results.some((m) => m.content.includes("export {};"))).toBe(true);
      expect(results.some((m) => m.content.includes("<project-instructions"))).toBe(false);
    });
  });
});

describe("a change to the project's instructions keeps the prefix", () => {
  /**
   * An edit to AGENTS.md mid-conversation reaches the model as a notice on
   * the next run's user message — appended at the end, so that request still
   * extends the last one byte for byte. The system prompt takes the new
   * version only on a request whose front has moved anyway (here, after a
   * compaction), never on an ordinary turn.
   */
  const EXECUTOR = "prefix-laptop";
  let dir: string;

  beforeAll(async () => {
    dir = realpathSync(mkdtempSync(path.join(tmpdir(), "instr-updates-prefix-")));
    const { createExecutorService } = await import("../../../executor/service.ts");
    const { registerExecutor, handleExecutorResult } = await import("../../../executor/registry.ts");
    const service = createExecutorService({ roots: () => [dir], executorId: EXECUTOR });
    registerExecutor({
      executorId: EXECUTOR, userId, name: "Laptop", platform: process.platform,
      capabilities: { direct: true, container: false }, roots: [dir],
      send(message) {
        if (message.type !== "call") return;
        void service.handle(message.method, message.params)
          .then((value) => { handleExecutorResult(EXECUTOR, { type: "result", id: message.id, ok: true, value }); })
          .catch((err: unknown) => { handleExecutorResult(EXECUTOR, { type: "result", id: message.id, ok: false, error: (err as Error).message }); });
      },
      close: () => undefined,
    });
  });

  afterAll(async () => {
    const { __resetExecutorsForTest } = await import("../../../executor/registry.ts");
    __resetExecutorsForTest();
    rmSync(dir, { recursive: true, force: true });
  });

  it("sends an edit in the chat, and puts it in the system prompt only after a compaction", async () => {
    const rules = ["# Rules", "## Commands", "Use pnpm.", "## Stable", "Unchanged guidance. ".repeat(30)].join("\n");
    writeFileSync(path.join(dir, "AGENTS.md"), rules);
    const [conv] = await db
      .insert(conversations)
      .values({
        ownerId: userId, title: "instructions updates", kind: "agent",
        workspace: { kind: "local", executorId: EXECUTOR, executorName: "Laptop", path: dir, isolation: "direct" },
      })
      .returning();
    convIds.push(conv.id);
    const { startAgentRun } = await import("../agentRun.ts");
    const run = async (content: string) => {
      await startAgentRun({ userId, content, model: "llama-3.1-8b-instruct", mode: "manual", conversationId: conv.id });
      await waitForRun(conv.id);
    };
    const system = (req: string[]) => (JSON.parse(req[0]) as { content: string }).content;

    await run("say hello one");
    writeFileSync(path.join(dir, "AGENTS.md"), rules.replace("Use pnpm.", "Use pnpm, never npm."));
    await run("say hello two");
    expectEachRequestExtendsTheLast();
    const edited = requests.at(-1) ?? [];
    const lastUser = JSON.parse(edited.at(-1) ?? "{}") as { role: string; content: string };
    expect(lastUser.role).toBe("user");
    expect(lastUser.content).toMatch(/^<project-instructions-update path="AGENTS.md">[\s\S]*Use pnpm, never npm\.[\s\S]*<\/project-instructions-update>\n\nsay hello two$/);
    expect(system(edited)).not.toContain("never npm");

    const { startCompactRun } = await import("../compactRun.ts");
    await startCompactRun({ userId, conversationId: conv.id, model: "llama-3.1-8b-instruct", surface: "agent" });
    await waitForRun(conv.id);
    // The summary never carries the notice: it was left out of what was summarised.
    const summarised = requests.at(-1) ?? [];
    expect(summarised.join("")).not.toContain("project-instructions-update");

    requests.length = 0;
    await run("say hello three");
    const folded = requests[0];
    expect(system(folded)).toContain("Use pnpm, never npm.");
    // And it moved on a request whose front was already new: the summary rides second.
    expect((JSON.parse(folded[1]) as { role: string }).role).toBe("system");
  });
});

describe("a compaction extends the prompt it compacts", () => {
  /**
   * A compaction used to drop the system prompt and the tools, so its request
   * shared nothing with the conversation's cached prefix and the backend
   * re-read everything: 749 s for 235k tokens on the beta, after a turn that
   * was 97% cached. Now it sends the last run's own front and history and
   * appends the instruction — a strict extension of that run's last request.
   */
  it("sends the last request plus the instruction, same tools, none callable — and keeps its usage", async () => {
    const convId = await turn("first question about pnpm");
    await turn("second question about bun", convId);
    const lastRun = requests.at(-1) ?? [];
    const lastOptions = requestOptions.at(-1);

    const { startCompactRun } = await import("../compactRun.ts");
    const { summaryMessageId } = await startCompactRun({
      userId, conversationId: convId, model: "llama-3.1-8b-instruct", surface: "chat",
    });
    await waitForRun(convId);

    const compaction = requests.at(-1) ?? [];
    // Every message the last run sent, byte for byte, then the replayed
    // reply to it, then the instruction.
    expect(compaction.slice(0, lastRun.length)).toEqual(lastRun);
    expect(compaction.length).toBeGreaterThan(lastRun.length);
    expect(compaction.at(-1)).toContain("Summarize this conversation");
    expect(requestOptions.at(-1)).toEqual({ ...lastOptions, toolChoice: "none" });
    expect(lastOptions?.toolCount).toBeGreaterThan(0);

    // It finished — the usage row (fractional timings from the mock, as from
    // llama.cpp) no longer throws the summary away.
    const summary = await db.query.messages.findFirst({ where: eq(messages.id, summaryMessageId) });
    expect(summary?.status).toBe("complete");
    const usage = await db.query.usageRecords.findFirst({ where: eq(usageRecords.messageId, summaryMessageId) });
    expect(usage?.promptMs).toBe(50);
  });
});
