import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { v4 as uuid } from "uuid";
import { db, eq, inArray } from "@loxaic/db";
import { conversationShares, conversations, messages, usageRecords, user } from "@loxaic/db/schema";
import {
  MAX_SUBAGENTS_PER_MESSAGE,
  SUBAGENT_LOST_ERROR,
  SUBAGENT_TOOL_NAME,
  type ContentBlock,
  type SubAgentInfo,
} from "@loxaic/types";
import { isToolName } from "@loxaic/agent";
import { getStreamBroker, initStreamBroker } from "../../index.ts";
import { NotFoundError, actingRole, assertConversationAccess, resolveAccess } from "../../authz.ts";
import { getRun, getRunByConversation } from "../../registry.ts";
import { startAgentRun } from "../agentRun.ts";
import { startChatRun } from "../chatRun.ts";
import { listSubagents, reconcileOrphanedSubagents, runSubagent } from "../subagentRun.ts";
import { SUBAGENT_SYSTEM_ADDENDUM, tooManySubagentsText } from "../subagent-policy.ts";
import { lastRequestShape } from "../request-shape.ts";
import { recentUses } from "../../../llama/context-stage-policy.ts";
import { buildToolset } from "../../../mcp/registry.ts";
import { purgeConversation } from "../../../conversations/delete.ts";
import { answerApproval, mayActOnRun } from "../../../ws/run-actions.ts";
import { __resetMockScenariosForTest } from "../../../inference/mock-scenarios.ts";

/**
 * Sub-agents, end to end through the real tool loop on the mock model.
 *
 * A parent run hands a task to a child run, which has its own conversation,
 * stream and inference slot, and whose final reply comes back as the parent's
 * tool result. These cases hold the parts that would fail silently:
 *
 * - the parent must give its slot back while it waits, or at concurrency 1 —
 *   the default here, and on most real backends — a child queues behind the
 *   parent that is waiting for it, forever;
 * - a child must never take, or release, its parent's run lock;
 * - a stop must not throw away the report of a child that had finished;
 * - nobody may act *in* a child's conversation, and only someone who may act
 *   on the parent may stop a child or answer its approvals.
 *
 * Sandbox-free: every child here either answers in prose, uses an in-process
 * tool, or is refused at the approval that comes before a sandbox exists.
 */
process.env.MOCK_INFERENCE = "true";

const MODEL = "llama-3.1-8b-instruct";
type ToolResultBlock = Extract<ContentBlock, { kind: "tool_result" }>;
type ToolCallBlock = Extract<ContentBlock, { kind: "tool_call" }>;

describe("sub-agents", () => {
  const userId = `test-subagent-${uuid()}`;
  const editorId = `test-subagent-editor-${uuid()}`;
  const viewerId = `test-subagent-viewer-${uuid()}`;
  const strangerId = `test-subagent-stranger-${uuid()}`;
  const everyone = [userId, editorId, viewerId, strangerId];
  const convIds: string[] = [];
  let dir = "";

  beforeAll(async () => {
    await initStreamBroker();
    dir = mkdtempSync(path.join(tmpdir(), "subagents-"));
    for (const id of everyone) {
      await db.insert(user).values({
        id,
        name: "Test Sub-agent",
        email: `${id}@example.test`,
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }
  });

  afterAll(async () => {
    delete process.env.MOCK_SCENARIOS_FILE;
    __resetMockScenariosForTest();
    rmSync(dir, { recursive: true, force: true });
    // Children first: they are found by their parent, and are this suite's.
    const children = convIds.length
      ? await db.select({ id: conversations.id }).from(conversations).where(inArray(conversations.parentConversationId, convIds))
      : [];
    for (const id of [...children.map((c) => c.id), ...convIds]) {
      await db.delete(messages).where(eq(messages.conversationId, id));
      await db.delete(usageRecords).where(eq(usageRecords.conversationId, id));
      await db.delete(conversations).where(eq(conversations.id, id));
    }
    for (const id of everyone) {
      await db.delete(usageRecords).where(eq(usageRecords.userId, id));
      await db.delete(user).where(eq(user.id, id));
    }
  });

  async function newConversation(kind: "agent" | "chat" | "routine" = "agent"): Promise<string> {
    const [conv] = await db.insert(conversations).values({ ownerId: userId, title: "sub-agent test", kind }).returning();
    convIds.push(conv.id);
    return conv.id;
  }

  async function waitFor(label: string, check: () => boolean | Promise<boolean>, timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  /** Ordered as the engine replays them — never by insertion. */
  async function rowsOf(convId: string) {
    return db.query.messages.findMany({
      where: eq(messages.conversationId, convId),
      orderBy: (m, { asc }) => [asc(m.lamport), asc(m.createdAt)],
    });
  }
  const blocksOf = (rows: Awaited<ReturnType<typeof rowsOf>>) => rows.flatMap((r) => r.content as ContentBlock[]);
  const resultsOf = async (convId: string) =>
    blocksOf(await rowsOf(convId)).filter((b): b is ToolResultBlock => b.kind === "tool_result");
  const callsOf = async (convId: string) =>
    blocksOf(await rowsOf(convId)).filter((b): b is ToolCallBlock => b.kind === "tool_call");

  async function childrenOf(parentId: string) {
    return db.query.conversations.findMany({
      where: eq(conversations.parentConversationId, parentId),
      orderBy: (c, { asc }) => [asc(c.createdAt)],
    });
  }

  async function snapshotOf(streamId: string) {
    const broker = getStreamBroker();
    return broker.foldSnapshot(await broker.readFrom(streamId, 0));
  }

  function useScenario(match: string, steps: unknown[], finalText = "[Mock] Parent finished."): void {
    const file = path.join(dir, `${uuid()}.json`);
    writeFileSync(file, JSON.stringify([{ match, steps, finalText }]));
    process.env.MOCK_SCENARIOS_FILE = file;
    __resetMockScenariosForTest();
  }

  const sub = (description: string, prompt: string) => ({ tool: SUBAGENT_TOOL_NAME, args: { description, prompt } });

  async function agentRun(convId: string, content: string, mode: "planning" | "manual" | "auto" = "auto") {
    const started = await startAgentRun({ userId, content, model: MODEL, mode, conversationId: convId });
    return started.streamId;
  }
  const ended = (convId: string) => () => getRunByConversation(convId) === undefined;

  it("is offered only where the toolset is asked for it, and is not allowlistable", async () => {
    const names = async (opts: Parameters<typeof buildToolset>[1]) =>
      (await buildToolset(userId, opts)).openAiTools.map((t) => t.function.name);
    expect(await names({ mode: "manual" })).not.toContain(SUBAGENT_TOOL_NAME);
    expect(await names({ mode: "manual", subagents: {} })).toContain(SUBAGENT_TOOL_NAME);
    // Not a write tool: a planning run may hand off an investigation.
    expect(await names({ mode: "planning", subagents: {} })).toContain(SUBAGENT_TOOL_NAME);
    // Never asks: starting a child changes nothing, its own tools ask.
    const toolset = await buildToolset(userId, { mode: "manual", subagents: {} });
    const tool = toolset.get(SUBAGENT_TOOL_NAME);
    expect(tool && toolset.requiresApproval(tool, "manual")).toBe(false);
    // Off the "Allow always" list, like the plan tools.
    expect(isToolName(SUBAGENT_TOOL_NAME)).toBe(false);
    // The model argument exists only when there is a choice to make.
    const schemaOf = async (models: string[] | null) =>
      (await buildToolset(userId, { mode: "manual", subagents: { models } })).openAiTools.find(
        (t) => t.function.name === SUBAGENT_TOOL_NAME,
      )?.function.parameters as { properties: Record<string, { enum?: string[] }> };
    expect((await schemaOf(null)).properties.model).toBeUndefined();
    expect((await schemaOf(["only-one"])).properties.model).toBeUndefined();
    expect((await schemaOf(["a", "b"])).properties.model.enum).toEqual(["a", "b"]);
  });

  it("runs a child to its end and hands its report back, without deadlocking on one slot", async () => {
    const convId = await newConversation();
    const streamId = await agentRun(convId, "Use a sub-agent: say hello to the parent");
    await waitFor("the parent to end", ended(convId));

    // The parent's turn: the call, its result, then its own final answer.
    const rows = await rowsOf(convId);
    expect(rows.map((r) => r.authorType)).toEqual(["user", "assistant", "tool", "assistant"]);
    const [result] = await resultsOf(convId);
    expect(result.ok).toBe(true);
    expect(result.output).toContain('<subagent-result description="Mock sub-task">');
    expect(result.output).toContain("[Mock] Echo: say hello to the parent");

    // The child is its own conversation, hung off the parent's call.
    const [child] = await childrenOf(convId);
    const [call] = await callsOf(convId);
    expect(child).toMatchObject({
      kind: "subagent",
      ownerId: userId,
      parentConversationId: convId,
      parentMessageId: rows[1].id,
      parentCallId: call.call_id,
      title: "Mock sub-task",
    });
    const info = child.subagent as SubAgentInfo;
    expect(info).toMatchObject({ description: "Mock sub-task", model: MODEL, mode: "auto", status: "complete" });
    expect(info.endedAt).toBeGreaterThanOrEqual(info.startedAt);

    // Its transcript: the task (which nobody typed), then its reply.
    const childRows = await rowsOf(child.id);
    expect(childRows.map((r) => r.authorType)).toEqual(["user", "assistant"]);
    expect(childRows[0].authorUserId).toBeNull();
    // None of it is in the parent's conversation, where the next turn would
    // replay it.
    expect(rows.some((r) => childRows.some((c) => c.id === r.id))).toBe(false);

    // The parent's stream carries the child, start to end.
    const snapshot = await snapshotOf(streamId);
    expect(snapshot.subagents).toHaveLength(1);
    expect(snapshot.subagents?.[0]).toMatchObject({
      conversation_id: child.id,
      stream_id: info.streamId,
      message_id: rows[1].id,
      call_id: call.call_id,
      status: "complete",
      model: MODEL,
    });
    // Measured by the child's own request, mirrored up.
    expect(snapshot.subagents?.[0].context_used).toBeGreaterThan(0);
    expect(snapshot.subagents?.[0].last_gen_tps).toBeGreaterThan(0);
    expect(snapshot.subagents?.[0].state).toBeUndefined();

    // The child's usage is recorded against the child, not the parent.
    const childUsage = await db.query.usageRecords.findMany({ where: eq(usageRecords.conversationId, child.id) });
    expect(childUsage.length).toBeGreaterThan(0);
    expect(childUsage.every((u) => u.runId === info.streamId)).toBe(true);
  }, 30_000);

  it("tells a run with the tool what a sub-agent's result is, and a run without it nothing", async () => {
    const convId = await newConversation();
    await agentRun(convId, "Use a sub-agent: report back");
    await waitFor("the parent to end", ended(convId));
    // What was actually sent: the marker the result arrives in is explained
    // in the same prompt, as a document's and an MCP result's are.
    expect(lastRequestShape(convId)?.system).toContain(SUBAGENT_SYSTEM_ADDENDUM);
    // A plain chat is never offered the tool, so its prompt is what it was.
    const chatId = await newConversation("chat");
    await startChatRun({ userId, content: "hello there", model: MODEL, conversationId: chatId });
    await waitFor("the chat to end", ended(chatId));
    expect(lastRequestShape(chatId)?.system ?? "").not.toContain("<subagent-result>");
  }, 30_000);

  it("starts a child whose label had to be cut through an emoji", async () => {
    const convId = await newConversation();
    const task = `${"x".repeat(78)}😀 and then say done`;
    useScenario("emoji label", [{ tool: SUBAGENT_TOOL_NAME, args: { prompt: task } }]);
    await agentRun(convId, "emoji label");
    await waitFor("the parent to end", ended(convId));
    const [child] = await childrenOf(convId);
    // Cut by UTF-16 unit the label ended in half an emoji, Postgres refused
    // the row, and the parent was told the server had gone wrong.
    expect((child.subagent as SubAgentInfo).status).toBe("complete");
    expect(child.title.endsWith("😀…")).toBe(true);
    expect((await resultsOf(convId))[0].ok).toBe(true);
  }, 30_000);

  it("never lists a child that is still starting as lost", async () => {
    const convId = await newConversation();
    const broker = getStreamBroker();
    const open = broker.openProducer.bind(broker);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let held = false;
    // The child's row is written before its stream is opened and its run
    // registered. Hold it there: that is the moment a listing used to read
    // "running in the database, unknown to the registry" as a dead process's.
    const spy = vi.spyOn(broker, "openProducer").mockImplementation(async (opts) => {
      if (opts.conversationId !== convId) {
        held = true;
        await gate;
      }
      return open(opts);
    });
    try {
      await agentRun(convId, "Use a sub-agent: say hello");
      await waitFor("the child to reach its stream", () => held);
      const [child] = await childrenOf(convId);
      const info = child.subagent as SubAgentInfo;
      expect(getRun(info.streamId)).toBeUndefined();
      const [listed] = await listSubagents(convId, (streamId) => getRun(streamId) !== undefined);
      expect(listed).toMatchObject({ conversation_id: child.id, status: "running" });
      expect(listed.error).toBeUndefined();
    } finally {
      release();
      spy.mockRestore();
    }
    await waitFor("the parent to end", ended(convId));
    // Once it has ended it is no longer anyone's to call starting.
    expect((await listSubagents(convId, () => false))[0].status).toBe("complete");
  }, 30_000);

  it("refuses to start a child under a conversation that was deleted and kept", async () => {
    const convId = await newConversation();
    await db.update(conversations).set({ deletedAt: new Date() }).where(eq(conversations.id, convId));
    const events: unknown[] = [];
    const outcome = await runSubagent(
      {
        convId,
        streamId: uuid(),
        userId,
        mode: "auto",
        surface: "agent",
        assistantMsgId: uuid(),
        producer: { emit: (e) => { events.push(e); }, end: () => Promise.resolve() },
        signal: new AbortController().signal,
      },
      { callId: "call_0", description: "Too late", prompt: "say hello", model: MODEL },
    );
    expect(outcome).toMatchObject({ ok: false });
    expect(outcome.output).toContain("no longer exists");
    // Nothing was made: no row to hold the task, no stream to hold it either.
    expect(await childrenOf(convId)).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it("stops counting a sub-agent against the model's context once it has ended", async () => {
    // A model nothing else uses, so the answer is this test's rows alone.
    const model = `stage-uses-${uuid()}`;
    const parentId = await newConversation();
    const otherId = await newConversation();
    const child = async (parent: string, status: "running" | "complete") => {
      const [row] = await db
        .insert(conversations)
        .values({
          ownerId: userId,
          title: "Counted?",
          kind: "subagent",
          parentConversationId: parent,
          parentMessageId: uuid(),
          parentCallId: "call_0",
          subagent: { description: "Counted?", model, mode: "auto", streamId: uuid(), status, startedAt: Date.now() } satisfies SubAgentInfo,
        })
        .returning();
      return row.id;
    };
    const finished = await child(parentId, "complete");
    const ownRunning = await child(parentId, "running");
    const othersRunning = await child(otherId, "running");
    const use = (conversationId: string, inputTokens: number) => ({ id: uuid(), userId, conversationId, model, inputTokens, outputTokens: 0 });
    await db.insert(usageRecords).values([
      use(parentId, 1_000),
      use(finished, 50_000),
      use(ownRunning, 40_000),
      use(otherId, 2_000),
      use(othersRunning, 30_000),
    ]);

    // Asked by nobody in particular: two threads. The finished child's 50K is
    // nobody's any more; a running one counts under the thread it works for.
    const all = await recentUses(model);
    expect(all.map((u) => u.conversationId).sort()).toEqual([parentId, otherId].sort());
    expect(all.find((u) => u.conversationId === parentId)?.tokens).toBe(40_000);
    expect(all.find((u) => u.conversationId === otherId)?.tokens).toBe(30_000);

    // Asked from the parent: its own children are not "another conversation",
    // running or not. The other thread and its running child still are.
    const others = await recentUses(model, parentId);
    expect(others).toEqual([expect.objectContaining({ conversationId: otherId, tokens: 30_000 })]);
  });

  it("never offers a child the tool, so sub-agents go one level deep", async () => {
    const convId = await newConversation();
    await agentRun(convId, "Delegate: use a sub-agent: say hi");
    await waitFor("the parent to end", ended(convId));
    const [child] = await childrenOf(convId);
    // The child's task names a sub-agent; with no such tool it just answers.
    expect(await callsOf(child.id)).toEqual([]);
    expect(await childrenOf(child.id)).toEqual([]);
  }, 30_000);

  it("is not offered to a plain chat, and is to a routine's run", async () => {
    const chat = await newConversation("chat");
    await startChatRun({ userId, content: "Use a sub-agent: say hi", model: MODEL, conversationId: chat });
    await waitFor("the chat run to end", ended(chat));
    expect(await childrenOf(chat)).toEqual([]);

    const routine = await newConversation("routine");
    await startChatRun({ userId, content: "Use a sub-agent: say hi", model: MODEL, conversationId: routine, recordUse: false });
    await waitFor("the routine run to end", ended(routine));
    const [child] = await childrenOf(routine);
    expect((child.subagent as SubAgentInfo).status).toBe("complete");
    // A routine's run is manual-mode chat, and so is its child.
    expect((child.subagent as SubAgentInfo).mode).toBe("manual");
  }, 30_000);

  it("keeps the parent's run lock while the child runs, and leaves it alone when the child ends", async () => {
    const convId = await newConversation();
    useScenario("lock check", [sub("Slow task", "take your time and then say done")]);
    const streamId = await agentRun(convId, "lock check");
    let child: Awaited<ReturnType<typeof childrenOf>>[number] | undefined;
    await waitFor("the child to start", async () => (child = (await childrenOf(convId)).at(0)) !== undefined);
    const info = child?.subagent as SubAgentInfo;
    // Two runs, each under its own conversation.
    expect(getRunByConversation(convId)?.streamId).toBe(streamId);
    expect(getRunByConversation(child?.id ?? "")?.streamId).toBe(info.streamId);
    // While it runs, the parent's stream says so.
    await waitFor("the child to be reported running", async () =>
      (await snapshotOf(streamId)).subagents?.[0]?.state === "running",
    );
    // Stop the child alone: the parent is told, and carries on to its answer.
    getRun(info.streamId)?.abort.abort();
    await waitFor("the child's run to end", () => getRun(info.streamId) === undefined);
    // The child ending released nothing of the parent's.
    await waitFor("the parent to end", ended(convId));
    const [result] = await resultsOf(convId);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("This sub-agent was stopped before it finished.");
    const rows = await rowsOf(convId);
    expect(rows.at(-1)?.authorType).toBe("assistant");
    expect(rows.at(-1)?.status).toBe("complete");
    const [after] = await childrenOf(convId);
    expect((after.subagent as SubAgentInfo).status).toBe("cancelled");
    expect((await snapshotOf(streamId)).subagents?.[0].status).toBe("cancelled");
  }, 40_000);

  it("records a batch's results in call order, and refuses calls past the cap", async () => {
    const convId = await newConversation();
    const many = Array.from({ length: MAX_SUBAGENTS_PER_MESSAGE + 1 }, (_, i) => sub(`Task ${String(i)}`, `say number ${String(i)}`));
    useScenario("ordered batch", [
      {
        calls: [
          many[0],
          { tool: "todo_write", args: { todos: [{ id: "1", text: "between", status: "pending" }] } },
          ...many.slice(1),
        ],
      },
    ]);
    await agentRun(convId, "ordered batch");
    await waitFor("the parent to end", ended(convId));

    const calls = await callsOf(convId);
    const results = await resultsOf(convId);
    // One result per call, in the order the calls were made — the order the
    // next turn's replay reproduces.
    expect(results.map((r) => r.call_id)).toEqual(calls.map((c) => c.call_id));
    expect(results[0].output).toContain("[Mock] Echo: say number 0");
    expect(results[1].output).not.toContain("subagent-result");
    for (let i = 1; i < MAX_SUBAGENTS_PER_MESSAGE; i++) {
      expect(results[i + 1].output).toContain(`[Mock] Echo: say number ${String(i)}`);
      expect(results[i + 1].ok).toBe(true);
    }
    // The one past the cap is answered, not dropped: an unanswered call is an
    // orphan the next replay cannot load.
    expect(results.at(-1)).toMatchObject({ ok: false, output: tooManySubagentsText(MAX_SUBAGENTS_PER_MESSAGE) });
    expect(await childrenOf(convId)).toHaveLength(MAX_SUBAGENTS_PER_MESSAGE);
  }, 60_000);

  it("runs children in the order they were called, when there is one slot", async () => {
    const convId = await newConversation();
    // The first is the slow one: started all at once, the quick children's
    // setup would beat it into the queue most of the time.
    useScenario("in call order", [
      { calls: [sub("First", "take your time and then say first"), sub("Second", "say second"), sub("Third", "say third")] },
    ]);
    await agentRun(convId, "in call order");
    await waitFor("the parent to end", ended(convId), 40_000);
    const byName = new Map((await childrenOf(convId)).map((k) => [(k.subagent as SubAgentInfo).description, k.subagent as SubAgentInfo]));
    const first = byName.get("First");
    const second = byName.get("Second");
    const third = byName.get("Third");
    // One slot (the default here): each ran only once the one called before
    // it had finished.
    expect(first?.endedAt).toBeLessThanOrEqual(second?.endedAt ?? 0);
    expect(second?.endedAt).toBeLessThanOrEqual(third?.endedAt ?? 0);
    // And the slow first one really did hold the others up.
    expect((second?.endedAt ?? 0) - (first?.startedAt ?? 0)).toBeGreaterThanOrEqual(7_000);
  }, 50_000);

  it("refuses a call with no task rather than starting a child on nothing", async () => {
    const convId = await newConversation();
    useScenario("empty task", [{ tool: SUBAGENT_TOOL_NAME, args: { description: "Nothing" } }]);
    await agentRun(convId, "empty task");
    await waitFor("the parent to end", ended(convId));
    const [result] = await resultsOf(convId);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("needs a `prompt`");
    expect(await childrenOf(convId)).toEqual([]);
  }, 30_000);

  it("keeps a finished child's report when the parent is stopped mid-batch", async () => {
    const convId = await newConversation();
    // Two slots, so both children are running at once and which of them the
    // queue admits first is not what decides the outcome.
    process.env.INFERENCE_MAX_CONCURRENT_RUNS = "2";
    let streamId = "";
    try {
      useScenario("stop mid batch", [
        { calls: [sub("Quick", "say quick is done"), sub("Slow", "take your time and then say slow is done")] },
      ]);
      streamId = await agentRun(convId, "stop mid batch");
      // Wait for the quick child to finish while the slow one is still going.
      await waitFor("the quick child to finish", async () => {
        const kids = await childrenOf(convId);
        return kids.length === 2 && kids.some((k) => (k.subagent as SubAgentInfo).status === "complete");
      });
      expect((await childrenOf(convId)).some((k) => (k.subagent as SubAgentInfo).status === "running")).toBe(true);
      getRun(streamId)?.abort.abort();
      await waitFor("the parent to end", ended(convId));
    } finally {
      Reflect.deleteProperty(process.env, "INFERENCE_MAX_CONCURRENT_RUNS");
    }

    const results = await resultsOf(convId);
    expect(results).toHaveLength(2);
    // The child that finished is recorded with what it said — not "stopped
    // before this tool call ran", which is what a stop used to leave.
    expect(results[0].ok).toBe(true);
    expect(results[0].output).toContain("[Mock] Echo: say quick is done");
    expect(results[1].ok).toBe(false);
    expect(results[1].output).toContain("This sub-agent was stopped before it finished.");
    // Stopping the parent stopped its child.
    const kids = await childrenOf(convId);
    expect(kids.map((k) => (k.subagent as SubAgentInfo).status).sort()).toEqual(["cancelled", "complete"]);
    for (const kid of kids) expect(getRunByConversation(kid.id)).toBeUndefined();
    // And the parent's turn ended as a stop, with no further request.
    expect((await rowsOf(convId)).map((r) => r.authorType)).toEqual(["user", "assistant", "tool"]);
    expect((await getStreamBroker().getMeta(streamId))?.status).toBe("cancelled");
  }, 40_000);

  it("runs children side by side when the backend has the slots", async () => {
    const convId = await newConversation();
    process.env.INFERENCE_MAX_CONCURRENT_RUNS = "2";
    try {
      useScenario("side by side", [
        { calls: [sub("One", "take your time and then say one"), sub("Two", "take your time and then say two")] },
      ]);
      const started = Date.now();
      await agentRun(convId, "side by side");
      await waitFor("the parent to end", ended(convId), 40_000);
      // Each child's request takes the mock's 8 s; in series that is 16 s.
      expect(Date.now() - started).toBeLessThan(15_000);
      const kids = await childrenOf(convId);
      const spans = kids.map((k) => k.subagent as SubAgentInfo);
      expect(spans[0].startedAt).toBeLessThan(spans[1].endedAt ?? 0);
      expect(spans[1].startedAt).toBeLessThan(spans[0].endedAt ?? 0);
    } finally {
      Reflect.deleteProperty(process.env, "INFERENCE_MAX_CONCURRENT_RUNS");
    }
  }, 50_000);

  it("shows a child's approval on the parent's stream, and answers only the run that is named", async () => {
    const convId = await newConversation();
    const streamId = await agentRun(convId, "Use a sub-agent: write a file called notes", "manual");
    let approval: NonNullable<Awaited<ReturnType<typeof snapshotOf>>["subagents"]>[number]["pending_approval"];
    await waitFor("the child's approval to reach the parent's stream", async () => {
      approval = (await snapshotOf(streamId)).subagents?.[0]?.pending_approval;
      return approval !== undefined;
    });
    const [child] = await childrenOf(convId);
    const info = child.subagent as SubAgentInfo;
    expect(approval).toMatchObject({ stream_id: info.streamId, tool: "fs_write" });
    expect(approval?.expires_at).toBeGreaterThan(Date.now());
    expect((await snapshotOf(streamId)).subagents?.[0].state).toBe("awaiting_approval");
    // The parent itself is not waiting on anyone.
    expect((await snapshotOf(streamId)).pending_approval).toBeUndefined();
    const callId = approval?.call_id ?? "";

    // Naming the wrong run answers nothing — the parent holds no such call.
    await answerApproval(userId, callId, false, streamId);
    expect(getRun(info.streamId)?.approvals.has(callId)).toBe(true);
    // A stranger, a viewer: nothing.
    await answerApproval(strangerId, callId, false, info.streamId);
    expect(getRun(info.streamId)?.approvals.has(callId)).toBe(true);

    // The owner, naming the child's run.
    await answerApproval(userId, callId, false, info.streamId);
    await waitFor("the parent to end", ended(convId));
    const [childResult] = await resultsOf(child.id);
    expect(childResult).toMatchObject({ ok: false, output: "User denied this tool call." });
    // Cleared on the parent's stream once answered.
    const after = (await snapshotOf(streamId)).subagents?.[0];
    expect(after?.pending_approval).toBeUndefined();
    expect(after?.status).toBe("complete");
  }, 40_000);

  it("gives a planning parent a read-only child with nothing to hand over", async () => {
    const convId = await newConversation();
    await agentRun(convId, "Delegate: propose a plan", "planning");
    await waitFor("the parent to end", ended(convId));
    const [child] = await childrenOf(convId);
    expect((child.subagent as SubAgentInfo).mode).toBe("planning");
    // The same words make a planning *parent* propose; its child has no such
    // tool, so they fall through to the todo list — and it is not nudged to
    // hand over, since its prose is its report.
    const childCalls = await callsOf(child.id);
    expect(childCalls.map((c) => c.tool)).not.toContain("propose_plan");
    expect((await rowsOf(child.id)).filter((r) => r.authorType === "user")).toHaveLength(1);
    // The parent still ends its own turn in a plan.
    expect((await callsOf(convId)).map((c) => c.tool)).toEqual([SUBAGENT_TOOL_NAME, "propose_plan"]);
  }, 30_000);

  describe("access", () => {
    let parentId = "";
    let childId = "";

    beforeAll(async () => {
      parentId = await newConversation();
      await agentRun(parentId, "Use a sub-agent: say hi for the access test");
      await waitFor("the parent to end", ended(parentId));
      childId = (await childrenOf(parentId))[0].id;
      await db.insert(conversationShares).values([
        { conversationId: parentId, userId: editorId, role: "editor", createdBy: userId },
        { conversationId: parentId, userId: viewerId, role: "viewer", createdBy: userId },
      ]);
    }, 30_000);

    it("lets whoever can see the parent see the child, and nobody else", async () => {
      for (const id of [userId, editorId, viewerId]) {
        expect(await resolveAccess(id, childId)).toMatchObject({ kind: "subagent", role: "viewer" });
      }
      expect(await resolveAccess(strangerId, childId)).toBeNull();
    });

    it("grants nobody more than viewer in the child itself — not even its owner", async () => {
      // Which is what closes every editor- and owner-gated path on it: sends,
      // compaction, rename, delete, shares, sandboxes, git, the terminal.
      await expect(assertConversationAccess(userId, childId, "editor")).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        startAgentRun({ userId, content: "hello child", model: MODEL, mode: "auto", conversationId: childId }),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        startChatRun({ userId, content: "hello child", model: MODEL, conversationId: childId }),
      ).rejects.toBeInstanceOf(NotFoundError);
      expect((await rowsOf(childId)).filter((r) => r.authorType === "user")).toHaveLength(1);
    });

    it("decides who may stop a child, or answer it, by their role on the parent", async () => {
      const grant = async (id: string) => {
        const g = await resolveAccess(id, childId);
        return g ? actingRole(g) : null;
      };
      expect(await grant(userId)).toBe("owner");
      expect(await grant(editorId)).toBe("editor");
      expect(await grant(viewerId)).toBe("viewer");
      expect(await mayActOnRun(userId, childId)).toBe(true);
      expect(await mayActOnRun(editorId, childId)).toBe(true);
      expect(await mayActOnRun(viewerId, childId)).toBe(false);
      expect(await mayActOnRun(strangerId, childId)).toBe(false);
    });

    it("follows the parent's shares as they change", async () => {
      await db.delete(conversationShares).where(eq(conversationShares.userId, viewerId));
      expect(await resolveAccess(viewerId, childId)).toBeNull();
    });

    it("lists a thread's children from what is stored", async () => {
      const list = await listSubagents(parentId, () => false);
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ conversation_id: childId, status: "complete", model: MODEL, description: "Mock sub-task" });
      expect(list[0].context_used).toBeGreaterThan(0);
      expect(list[0].last_gen_tps).toBeGreaterThan(0);
      expect(list[0].tokens_out).toBeGreaterThan(0);
    });
  });

  it("marks a child a dead process left running as lost", async () => {
    const parentId = await newConversation();
    const lostStream = uuid();
    const info: SubAgentInfo = {
      description: "Left behind",
      model: MODEL,
      mode: "auto",
      streamId: lostStream,
      status: "running",
      // Before this process started.
      startedAt: Date.now() - 24 * 60 * 60 * 1000,
    };
    const [child] = await db
      .insert(conversations)
      .values({
        ownerId: userId,
        title: "Left behind",
        kind: "subagent",
        parentConversationId: parentId,
        parentMessageId: uuid(),
        parentCallId: "call_0",
        subagent: info,
      })
      .returning();
    // Before the reconcile: the row says running, but no run is driving it.
    expect((await listSubagents(parentId, () => false))[0]).toMatchObject({ status: "error", error: SUBAGENT_LOST_ERROR });
    expect(await reconcileOrphanedSubagents(userId)).toBeGreaterThanOrEqual(1);
    const after = await db.query.conversations.findFirst({ where: eq(conversations.id, child.id) });
    expect(after?.subagent).toMatchObject({ status: "error", error: SUBAGENT_LOST_ERROR });
  });

  it("erases a child that is still running when its thread is deleted, and stops it", async () => {
    const convId = await newConversation();
    process.env.DELETE_RUN_UNWIND_TIMEOUT_MS = "20000";
    try {
      useScenario("delete while delegating", [sub("Slow", "take your time and then say done")]);
      const streamId = await agentRun(convId, "delete while delegating");
      let child: Awaited<ReturnType<typeof childrenOf>>[number] | undefined;
      await waitFor("the child to start", async () => (child = (await childrenOf(convId)).at(0)) !== undefined);
      const childId = child?.id ?? "";
      const info = child?.subagent as SubAgentInfo;
      await waitFor("the child's request to be out", () => getRun(info.streamId) !== undefined);

      await purgeConversation(convId, { warn: () => undefined });
      // Deleting stops the parent's run, and the child's with it.
      await waitFor("both runs to end", () => getRun(streamId) === undefined && getRun(info.streamId) === undefined);
      // The cleanup's second pass runs once the runs have unwound: whatever
      // either wrote on its way out — a cancelled reply, a "stopped" result —
      // references a conversation that is gone, and must not be left behind
      // holding its content.
      await waitFor("the rows the unwinding runs wrote to be collected", async () =>
        (await rowsOf(childId)).length === 0 && (await rowsOf(convId)).length === 0,
      );
      expect(await db.query.conversations.findFirst({ where: eq(conversations.id, childId) })).toBeUndefined();
      expect(await db.query.conversations.findFirst({ where: eq(conversations.id, convId) })).toBeUndefined();
    } finally {
      Reflect.deleteProperty(process.env, "DELETE_RUN_UNWIND_TIMEOUT_MS");
    }
  }, 40_000);

  it("erases a thread's children with it", async () => {
    const convId = await newConversation();
    await agentRun(convId, "Use a sub-agent: say hi before the delete");
    await waitFor("the parent to end", ended(convId));
    const [child] = await childrenOf(convId);
    const info = child.subagent as SubAgentInfo;
    expect((await rowsOf(child.id)).length).toBeGreaterThan(0);

    await purgeConversation(convId, { warn: () => undefined });
    expect(await db.query.conversations.findFirst({ where: eq(conversations.id, child.id) })).toBeUndefined();
    expect(await rowsOf(child.id)).toEqual([]);
    // Usage is kept and detached, as a parent's is.
    expect(await db.query.usageRecords.findMany({ where: eq(usageRecords.conversationId, child.id) })).toEqual([]);
    expect((await db.query.usageRecords.findMany({ where: eq(usageRecords.runId, info.streamId) })).length).toBeGreaterThan(0);
    // The stream log held its transcript too.
    await waitFor("the child's stream log to go", async () => (await getStreamBroker().getMeta(info.streamId)) === null);
  }, 30_000);
});
