import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { v4 as uuid } from "uuid";
import { db, eq } from "@loxaic/db";
import { conversations, messages, usageRecords, user } from "@loxaic/db/schema";
import type { ContentBlock, StreamEventKind } from "@loxaic/types";
import { PLAN_TOOL_NAME } from "@loxaic/agent";
import { getStreamBroker, initStreamBroker } from "../../index.ts";
import { getRunByConversation } from "../../registry.ts";
import { planningSystemPrompt, startAgentRun } from "../agentRun.ts";
import { startChatRun } from "../chatRun.ts";
import { PLAN_ALREADY_SUBMITTED } from "../engine.ts";
import { buildToolset } from "../../../mcp/registry.ts";
import { PLAN_SUBMITTED } from "../../../agent/executor.ts";
import { __resetMockScenariosForTest } from "../../../inference/mock-scenarios.ts";

/**
 * Planning mode hands its plan over with `propose_plan`, and a successful call
 * ends the turn (#199).
 *
 * It has to end *there*, with no further model request: the next step is the
 * user's decision, which arrives as their next message, and a loop that ran on
 * would restate the plan or start on one nobody accepted. Only a successful
 * call ends it — an empty plan is refused with a reason and the model tries
 * again — and nothing queued behind a plan in the same message runs.
 *
 * Sandbox-free throughout: the plan call runs in-process.
 */
process.env.MOCK_INFERENCE = "true";

const MODEL = "llama-3.1-8b-instruct";
type ToolResultBlock = Extract<ContentBlock, { kind: "tool_result" }>;
type ToolCallBlock = Extract<ContentBlock, { kind: "tool_call" }>;

describe("propose_plan", () => {
  const userId = `test-plan-${uuid()}`;
  const convIds: string[] = [];
  let dir = "";

  beforeAll(async () => {
    await initStreamBroker();
    dir = mkdtempSync(path.join(tmpdir(), "plan-proposal-"));
    await db.insert(user).values({
      id: userId,
      name: "Test Plan",
      email: `${userId}@example.test`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  afterAll(async () => {
    delete process.env.MOCK_SCENARIOS_FILE;
    __resetMockScenariosForTest();
    rmSync(dir, { recursive: true, force: true });
    for (const id of convIds) {
      await db.delete(messages).where(eq(messages.conversationId, id));
      await db.delete(usageRecords).where(eq(usageRecords.conversationId, id));
      await db.delete(conversations).where(eq(conversations.id, id));
    }
    await db.delete(user).where(eq(user.id, userId));
  });

  async function newConversation(kind: "agent" | "chat" = "agent"): Promise<string> {
    const [conv] = await db.insert(conversations).values({ ownerId: userId, title: "plan test", kind }).returning();
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

  /** Ordered as the engine replays them — see step-checkin.test.ts's rowsOf. */
  async function rowsOf(convId: string) {
    return db.query.messages.findMany({
      where: eq(messages.conversationId, convId),
      orderBy: (m, { asc }) => [asc(m.lamport), asc(m.createdAt)],
    });
  }

  const blocksOf = (rows: Awaited<ReturnType<typeof rowsOf>>) => rows.flatMap((r) => r.content as ContentBlock[]);

  function useScenario(match: string, steps: unknown[]): void {
    const file = path.join(dir, `${uuid()}.json`);
    writeFileSync(file, JSON.stringify([{ match, steps, finalText: "unreachable: the plan ends the turn" }]));
    process.env.MOCK_SCENARIOS_FILE = file;
    __resetMockScenariosForTest();
  }

  async function planningRun(convId: string, content: string): Promise<string> {
    const { streamId } = await startAgentRun({ userId, content, model: MODEL, mode: "planning", conversationId: convId });
    await waitFor("the run to end", () => getRunByConversation(convId) === undefined);
    return streamId;
  }

  it("is offered in planning mode only", async () => {
    const names = async (mode: "planning" | "manual" | "auto") =>
      (await buildToolset(userId, { mode })).openAiTools.map((t) => t.function.name);
    expect(await names("planning")).toContain(PLAN_TOOL_NAME);
    expect(await names("manual")).not.toContain(PLAN_TOOL_NAME);
    expect(await names("auto")).not.toContain(PLAN_TOOL_NAME);
    // Not merely hidden: named anyway outside planning, it is an unknown tool.
    expect((await buildToolset(userId, { mode: "manual" })).get(PLAN_TOOL_NAME)).toBeUndefined();
  });

  it("is never offered to a chat run — which is also what a routine runs", async () => {
    const convId = await newConversation("chat");
    // The same prompt that makes a planning run propose; chat has no plan to
    // offer, so the mock falls through to its ordinary `plan` trigger.
    await startChatRun({ userId, content: "look around and propose a plan", model: MODEL, conversationId: convId });
    await waitFor("the run to end", () => getRunByConversation(convId) === undefined);
    const calls = blocksOf(await rowsOf(convId)).filter((b): b is ToolCallBlock => b.kind === "tool_call");
    expect(calls.map((c) => c.tool)).not.toContain(PLAN_TOOL_NAME);
  }, 30_000);

  it("ends the turn on the plan, with no further model request", async () => {
    const convId = await newConversation();
    const streamId = await planningRun(convId, "look around and propose a plan");

    const rows = await rowsOf(convId);
    // user, assistant (the call), tool (the result) — and nothing after it. A
    // second assistant row would be the model talking past its own plan.
    expect(rows.map((r) => r.authorType)).toEqual(["user", "assistant", "tool"]);
    const call = (rows[1].content as ContentBlock[]).find((b): b is ToolCallBlock => b.kind === "tool_call");
    expect(call?.tool).toBe(PLAN_TOOL_NAME);
    // The plan is in the call's own arguments — what the client renders, after
    // a reload as much as live.
    expect(String((call?.args as { plan?: unknown } | undefined)?.plan)).toContain("## Mock plan");
    expect((rows[2].content as ContentBlock[])[0]).toMatchObject({
      kind: "tool_result",
      call_id: call?.call_id,
      ok: true,
      output: PLAN_SUBMITTED,
    });

    // A success, with the result as the leaf, so the user's decision threads
    // after it.
    const conv = await db.query.conversations.findFirst({ where: eq(conversations.id, convId) });
    expect(conv?.activeLeafId).toBe(rows[2].id);
    const events: StreamEventKind[] = (await getStreamBroker().readFrom(streamId, 0)).map((r) => r.event);
    // Once: message.end follows the tool results, and ending the turn must not
    // send it again.
    expect(events.filter((e) => e.kind === "message.end" && e.message_id === rows[1].id)).toHaveLength(1);
    expect(events.filter((e) => e.kind === "iteration")).toHaveLength(1);
  }, 30_000);

  it("keeps going after an empty plan, so the model can submit a real one", async () => {
    const match = `empty plan first ${uuid()}`;
    useScenario(match, [
      { tool: PLAN_TOOL_NAME, args: { plan: "   " } },
      { tool: PLAN_TOOL_NAME, args: { plan: "1. Do the thing." } },
    ]);
    const convId = await newConversation();
    await planningRun(convId, match);

    const rows = await rowsOf(convId);
    expect(rows.map((r) => r.authorType)).toEqual(["user", "assistant", "tool", "assistant", "tool"]);
    const results = blocksOf(rows).filter((b): b is ToolResultBlock => b.kind === "tool_result");
    expect(results.map((r) => r.ok)).toEqual([false, true]);
    expect(results[0].output).toContain("non-empty");
  }, 30_000);

  it("runs nothing queued behind a plan in the same message", async () => {
    const match = `plan then more ${uuid()}`;
    // todo_write rather than a write tool: it is offered in planning mode, so
    // the step fires — and it would succeed if it ran, so "not run" is not a
    // failure of the tool itself.
    useScenario(match, [
      {
        calls: [
          { tool: PLAN_TOOL_NAME, args: { plan: "1. Do the thing." } },
          { tool: "todo_write", args: { todos: [{ text: "after the plan", status: "pending" }] } },
        ],
      },
    ]);
    const convId = await newConversation();
    await planningRun(convId, match);

    const rows = await rowsOf(convId);
    expect(rows.map((r) => r.authorType)).toEqual(["user", "assistant", "tool"]);
    const results = blocksOf(rows).filter((b): b is ToolResultBlock => b.kind === "tool_result");
    expect(results.map((r) => [r.ok, r.output])).toEqual([
      [true, PLAN_SUBMITTED],
      [false, PLAN_ALREADY_SUBMITTED],
    ]);
  }, 30_000);

  it("is what the planning prompt tells the model to finish with", () => {
    const prompt = planningSystemPrompt({ kind: "scratch" });
    expect(prompt).toContain("propose_plan");
    expect(prompt).not.toContain("Finish with the plan as prose");
  });
});
