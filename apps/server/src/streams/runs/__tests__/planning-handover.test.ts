import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { v4 as uuid } from "uuid";
import { db, eq } from "@loxaic/db";
import { conversations, messages, usageRecords, user, userPrefs } from "@loxaic/db/schema";
import { CHECKIN_ANSWER_NUDGE, PLAN_REJECTED_MESSAGE, PLAN_REQUIRED_NUDGE, type ContentBlock } from "@loxaic/types";
import { PLAN_TOOL_NAME, QUESTIONS_TOOL_NAME } from "@loxaic/agent";
import type { ChatMessage, StreamOptions } from "../../../inference/provider.ts";

/**
 * Planning mode ends every turn in a plan or questions (#199) — whatever is
 * asked, not only "propose a plan".
 *
 * - `ask_questions` is the other way to hand the turn over, and ends it the
 *   same way `propose_plan` does.
 * - A planning turn that answers in prose is asked once, on a request sent with
 *   `tool_choice: "required"`; prose a second time ends the turn.
 * - "Answer now" is the user asking for prose, and is never nudged.
 *
 * `streamCompletion` is wrapped to record each request's tool_choice, and —
 * for the one case that needs a model that will not comply — to force prose.
 */
process.env.MOCK_INFERENCE = "true";

const requests: { toolChoice?: string }[] = [];
/** Conversations whose every request is answered in prose, required or not. */
const stubborn = new Set<string>();
/** Conversations whose nudged request calls a read tool instead of handing
 * over — what a real model may well do with "required". */
const detours = new Set<string>();

const mentions = (msgs: ChatMessage[], markers: Set<string>) =>
  msgs.some((m) => {
    const c = m.content;
    return typeof c === "string" && [...markers].some((s) => c.includes(s));
  });

vi.mock("../../../inference/provider.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../inference/provider.ts")>();
  return {
    ...actual,
    streamCompletion: (model: string, msgs: ChatMessage[], options?: StreamOptions) => {
      requests.push({ toolChoice: options?.toolChoice });
      if (mentions(msgs, stubborn)) return actual.streamCompletion(model, msgs, { ...options, toolChoice: "none" });
      if (options?.toolChoice === "required" && mentions(msgs, detours)) {
        // The mock plans from the last user message; show it one that asks
        // for a todo list, which it answers with todo_write.
        const last = msgs.map((m) => m.role).lastIndexOf("user");
        const detoured = msgs.map((m, i) => (i === last ? { role: "user" as const, content: "make a todo list first" } : m));
        return actual.streamCompletion(model, detoured, { ...options, toolChoice: undefined });
      }
      return actual.streamCompletion(model, msgs, options);
    },
  };
});

const { startAgentRun } = await import("../agentRun.ts");
const { getRunByConversation } = await import("../../registry.ts");
const { initStreamBroker } = await import("../../index.ts");
const { buildToolset } = await import("../../../mcp/registry.ts");
const { QUESTIONS_SUBMITTED, questionsProblem } = await import("../../../agent/executor.ts");

const MODEL = "llama-3.1-8b-instruct";
const userId = `test-handover-${uuid()}`;
const convIds: string[] = [];

beforeAll(async () => {
  await initStreamBroker();
  await db.insert(user).values({
    id: userId,
    name: "Test Handover",
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
});

afterEach(() => {
  requests.length = 0;
});

async function newConversation(): Promise<string> {
  const [conv] = await db.insert(conversations).values({ ownerId: userId, title: "handover test", kind: "agent" }).returning();
  convIds.push(conv.id);
  return conv.id;
}

async function waitFor(label: string, check: () => boolean, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function planningTurn(content: string, convId?: string): Promise<string> {
  const id = convId ?? (await newConversation());
  await startAgentRun({ userId, content, model: MODEL, mode: "planning", conversationId: id });
  await waitFor("the run to end", () => getRunByConversation(id) === undefined);
  return id;
}

/** Ordered as the engine replays them. */
async function rowsOf(convId: string) {
  return db.query.messages.findMany({
    where: eq(messages.conversationId, convId),
    orderBy: (m, { asc }) => [asc(m.lamport), asc(m.createdAt)],
  });
}

const callsOf = (rows: Awaited<ReturnType<typeof rowsOf>>) =>
  rows
    .flatMap((r) => r.content as ContentBlock[])
    .filter((b): b is Extract<ContentBlock, { kind: "tool_call" }> => b.kind === "tool_call")
    .map((b) => b.tool);

const textOf = (row: { content: unknown }) =>
  (row.content as ContentBlock[]).find((b): b is Extract<ContentBlock, { kind: "text" }> => b.kind === "text")?.text;

describe("ask_questions", () => {
  it("is offered in planning mode only", async () => {
    const names = async (mode: "planning" | "manual" | "auto") =>
      (await buildToolset(userId, { mode })).openAiTools.map((t) => t.function.name);
    expect(await names("planning")).toContain(QUESTIONS_TOOL_NAME);
    expect(await names("manual")).not.toContain(QUESTIONS_TOOL_NAME);
    expect(await names("auto")).not.toContain(QUESTIONS_TOOL_NAME);
  });

  it("refuses what the panel could not show, saying what to fix", () => {
    const opts = [{ label: "A" }, { label: "B" }];
    expect(questionsProblem({ questions: [{ question: "Which?", options: opts }] })).toBeNull();
    expect(questionsProblem({})).toContain("non-empty array");
    expect(questionsProblem({ questions: Array(5).fill({ question: "Q", options: opts }) })).toContain("at most 4");
    expect(questionsProblem({ questions: [{ question: "Q", options: [{ label: "only" }] }] })).toContain("2-4 options");
    expect(questionsProblem({ questions: [{ question: " ", options: opts }] })).toContain("non-empty question");
    expect(questionsProblem({ questions: [{ question: "Q", options: [{ label: "" }, { label: "B" }] }] })).toContain("without a label");
    expect(questionsProblem({ questions: [{ question: "Q", options: opts, multiSelect: "yes" }] })).toContain("multiSelect");
  });

  it("hands the turn over, with no further model request", async () => {
    const convId = await planningTurn("Before you plan, ask me some questions.");
    const rows = await rowsOf(convId);
    expect(rows.map((r) => r.authorType)).toEqual(["user", "assistant", "tool"]);
    expect(callsOf(rows)).toEqual([QUESTIONS_TOOL_NAME]);
    expect((rows[2].content as ContentBlock[])[0]).toMatchObject({ ok: true, output: QUESTIONS_SUBMITTED });
    expect(requests).toHaveLength(1);
  }, 30_000);
});

describe("a planning turn always ends in a plan or questions", () => {
  it("plans a request that says nothing about planning", async () => {
    const convId = await planningTurn("What's the weather like today?");
    expect(callsOf(await rowsOf(convId))).toEqual([PLAN_TOOL_NAME]);
  }, 30_000);

  it("asks a prose answer once, with tool_choice required, and gets the plan", async () => {
    const convId = await planningTurn("Please answer in prose about the weather.");
    const rows = await rowsOf(convId);
    expect(rows.map((r) => r.authorType)).toEqual(["user", "assistant", "user", "assistant", "tool"]);
    // The nudge is ours, not the user's: fixed text, and nobody's name on it.
    expect(textOf(rows[2])).toBe(PLAN_REQUIRED_NUDGE);
    expect(rows[2].authorUserId).toBeNull();
    expect(callsOf(rows)).toEqual([PLAN_TOOL_NAME]);
    // The plan is of what was asked, not of the nudge.
    const plan = (rows[3].content as ContentBlock[]).find((b) => b.kind === "tool_call") as { args: { plan: string } };
    expect(plan.args.plan).toContain("answer in prose about the weather");
    expect(requests.map((r) => r.toolChoice)).toEqual([undefined, "required"]);
  }, 30_000);

  it("asks once only: prose again ends the turn", async () => {
    const marker = `stubborn ${uuid()}`;
    stubborn.add(marker);
    try {
      const convId = await planningTurn(`${marker}: answer in prose.`);
      const rows = await rowsOf(convId);
      expect(rows.map((r) => r.authorType)).toEqual(["user", "assistant", "user", "assistant"]);
      expect(rows.filter((r) => textOf(r) === PLAN_REQUIRED_NUDGE)).toHaveLength(1);
      expect(requests).toHaveLength(2);
    } finally {
      stubborn.delete(marker);
    }
  }, 30_000);

  it("forces a tool on the nudged request only, not on the requests after it", async () => {
    const marker = `detour ${uuid()}`;
    detours.add(marker);
    try {
      const convId = await planningTurn(`${marker}: answer in prose.`);
      // Prose, the nudge, a read tool instead of a hand-over, then the plan —
      // decided freely: a model still forced to call tools could never answer.
      expect(callsOf(await rowsOf(convId))).toEqual(["todo_write", PLAN_TOOL_NAME]);
      expect(requests.map((r) => r.toolChoice)).toEqual([undefined, "required", undefined]);
    } finally {
      detours.delete(marker);
    }
  }, 30_000);

  it("answers a rejected plan with questions, not another plan", async () => {
    // The mock does what the words ask, as a model would: the rejection has to
    // ask for questions itself, agreeing with the planning prompt rather than
    // telling the model to wait (which a real model answered with prose).
    const convId = await planningTurn("Look around, then propose a plan.");
    await planningTurn(PLAN_REJECTED_MESSAGE, convId);
    expect(callsOf(await rowsOf(convId))).toEqual([PLAN_TOOL_NAME, QUESTIONS_TOOL_NAME]);
  }, 30_000);

  it("never asks after 'answer now', which is the user asking for prose", async () => {
    await db
      .insert(userPrefs)
      .values({ userId, maxIterations: 1 })
      .onConflictDoUpdate({ target: userPrefs.userId, set: { maxIterations: 1 } });
    try {
      const convId = await newConversation();
      // "todo" makes the mock call todo_write — offered in planning, no
      // sandbox — so the one-step window ends on a tool and asks.
      await startAgentRun({ userId, content: "make a todo list first", model: MODEL, mode: "planning", conversationId: convId });
      await waitFor("the check-in", () => !!getRunByConversation(convId)?.stepsDecision);
      getRunByConversation(convId)?.stepsDecision?.("answer", userId);
      await waitFor("the run to end", () => getRunByConversation(convId) === undefined);
      const rows = await rowsOf(convId);
      expect(rows.some((r) => textOf(r) === CHECKIN_ANSWER_NUDGE)).toBe(true);
      expect(rows.some((r) => textOf(r) === PLAN_REQUIRED_NUDGE)).toBe(false);
      expect(requests.map((r) => r.toolChoice)).toEqual([undefined, "none"]);
    } finally {
      await db.delete(userPrefs).where(eq(userPrefs.userId, userId));
    }
  }, 30_000);
});
