import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { v4 as uuid } from "uuid";
import { asc, db, eq } from "@loxaic/db";
import { conversations, messages, usageRecords, user } from "@loxaic/db/schema";
import type { ContentBlock } from "@loxaic/types";
import { SUBAGENT_TOOL_NAME } from "@loxaic/types";
import type * as Executor from "../../../agent/executor.ts";
import { __resetMockScenariosForTest } from "../../../inference/mock-scenarios.ts";
import { TOOL_FAILED } from "../../error-text.ts";
import { getStreamBroker, initStreamBroker } from "../../index.ts";
import { getRunByConversation } from "../../registry.ts";
import { startAgentRun } from "../agentRun.ts";
import type * as SubagentRun from "../subagentRun.ts";

/** A fault of our own inside a tool call, past `executeTool`'s own catch: its
 * message is shaped like a Postgres one because that is the kind of text that
 * must reach neither the card nor the model. */
const fault = vi.hoisted(() => ({
  on: false,
  message: 'insert into "messages" failed: relation "secret_ledger"',
  /** Runs just before the throw: a stop arriving as the call falls over. */
  before: null as (() => void) | null,
  subagent: false,
  /** What every sub-agent reports, in place of running. */
  report: null as string | null,
  /** Answered once in place of the real tool: bytes that cannot go in a row. */
  output: null as string | null,
}));
vi.mock("../../../agent/executor.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof Executor>();
  return {
    ...actual,
    executeTool: async (...args: Parameters<typeof actual.executeTool>) => {
      // Only the first of a batch, so "the next call still runs" means something.
      if (fault.output !== null) {
        const output = fault.output;
        fault.output = null;
        return { ok: true, output };
      }
      if (fault.on) {
        fault.on = false;
        fault.before?.();
        throw new Error(fault.message);
      }
      return actual.executeTool(...args);
    },
  };
});
vi.mock("../subagentRun.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof SubagentRun>();
  return {
    ...actual,
    runSubagent: (...args: Parameters<typeof actual.runSubagent>) => {
      if (fault.report !== null) return Promise.resolve({ output: fault.report, ok: true });
      return fault.subagent ? Promise.reject(new Error(fault.message)) : actual.runSubagent(...args);
    },
  };
});

process.env.MOCK_INFERENCE = "true";

/**
 * A tool call that fails shows its error on the card and the run carries on
 * without it. Both of these used to end the run: the turn stopped at the
 * tool_call and the other calls' results were thrown away.
 */
describe("a failed tool call does not end the run", () => {
  const userId = `test-tool-failure-${uuid()}`;
  const convIds: string[] = [];
  const dir = mkdtempSync(path.join(tmpdir(), "tool-failure-"));

  beforeAll(async () => {
    await initStreamBroker();
    await db.insert(user).values({
      id: userId,
      name: "Test Tool Failure",
      email: `${userId}@example.test`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  afterEach(() => {
    delete process.env.MOCK_SCENARIOS_FILE;
    __resetMockScenariosForTest();
    fault.on = false;
    fault.before = null;
    fault.subagent = false;
    fault.report = null;
    fault.output = null;
  });

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    for (const id of convIds) {
      await db.delete(messages).where(eq(messages.conversationId, id));
      await db.delete(usageRecords).where(eq(usageRecords.conversationId, id));
      await db.delete(conversations).where(eq(conversations.id, id));
    }
    await db.delete(user).where(eq(user.id, userId));
  });

  async function waitFor(label: string, check: () => boolean, timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  function scenario(match: string, steps: unknown[], finalText: string): void {
    const file = path.join(dir, `${uuid()}.json`);
    writeFileSync(file, JSON.stringify([{ match, steps, finalText }]));
    process.env.MOCK_SCENARIOS_FILE = file;
    __resetMockScenariosForTest();
  }

  /** The stream ids of each conversation's runs, for reading what went out live. */
  const streamOf = new Map<string, string>();

  async function run(content: string, onStart?: (convId: string) => void): Promise<string> {
    const [conv] = await db.insert(conversations).values({ ownerId: userId, title: "tool failure", kind: "agent" }).returning();
    convIds.push(conv.id);
    onStart?.(conv.id);
    const { streamId } = await startAgentRun({ userId, content, model: "llama-3.1-8b-instruct", mode: "auto", conversationId: conv.id });
    streamOf.set(conv.id, streamId);
    await waitFor("the run to register", () => getRunByConversation(conv.id) !== undefined);
    await waitFor("the run to end", () => getRunByConversation(conv.id) === undefined, 30_000);
    return conv.id;
  }

  async function blocks(convId: string) {
    const rows = await db.query.messages.findMany({
      where: eq(messages.conversationId, convId),
      orderBy: [asc(messages.lamport), asc(messages.createdAt)],
    });
    return rows.flatMap((r) => (r.content as ContentBlock[]).map((b) => ({ row: r, block: b })));
  }

  const TODO = (content: string) => ({
    tool: "todo_write",
    args: { todos: [{ id: "1", content, status: "pending", activeForm: content }] },
  });

  it("records a call that threw as failed, runs the next, and lets the model answer", async () => {
    scenario("tool throw batch", [{ calls: [TODO("first"), TODO("second")] }], "Answered without it.");
    fault.on = true;
    const convId = await run("tool throw batch");

    const stored = await blocks(convId);
    const results = stored.flatMap(({ block }) => (block.kind === "tool_result" ? [block] : []));
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ ok: false, output: TOOL_FAILED });
    expect(results[0].output).not.toContain("secret_ledger");
    // The call after it ran, and its result was not lost with the first.
    expect(results[1].ok).toBe(true);
    expect(stored.at(-1)).toMatchObject({ row: { status: "complete" }, block: { kind: "text", text: "Answered without it." } });
  });

  it.each([
    ["NUL", "binary\u0000bytes", "binary\ufffdbytes"],
    ["a lone surrogate", "cut emoji \ud83d", "cut emoji \ufffd"],
  ])("stores a result holding %s, keeps the rest of the batch, and finishes", async (_name, output, cleaned) => {
    scenario("unstorable bytes", [{ calls: [TODO("first"), TODO("second")] }], "Answered with it.");
    fault.output = output;
    const convId = await run("unstorable bytes");

    const stored = await blocks(convId);
    const results = stored.flatMap(({ block }) => (block.kind === "tool_result" ? [block] : []));
    expect(results.map((r) => r.ok)).toEqual([true, true]);
    expect(results[0].output).toBe(cleaned);
    // The live card reads as the reload will.
    const records = await getStreamBroker().readFrom(streamOf.get(convId) ?? "", 0);
    expect(JSON.stringify(records)).toContain(JSON.stringify(cleaned));
    expect(stored.at(-1)).toMatchObject({ block: { kind: "text", text: "Answered with it." } });
  });

  it("stores a result from outside the built-in tools, a sub-agent's report", async () => {
    scenario("odd report", [{ tool: SUBAGENT_TOOL_NAME, args: { description: "look", prompt: "look around" } }], "Read the report.");
    fault.report = "found\u0000this";
    const convId = await run("odd report");

    const results = (await blocks(convId)).flatMap(({ block }) => (block.kind === "tool_result" ? [block] : []));
    expect(results.map((r) => r.output)).toEqual(["found\ufffdthis"]);
    expect((await blocks(convId)).at(-1)).toMatchObject({ block: { kind: "text", text: "Read the report." } });
  });

  it("stores a web page whose 100 KB cap falls inside an emoji", async () => {
    const server = createServer((_req, res) => {
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end(`${"x".repeat(100 * 1024 - 1)}\u{1F600} and the rest`);
    });
    await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
    const { port } = server.address() as AddressInfo;
    process.env.LOXAIC_E2E_FETCH_ALLOW = `127.0.0.1:${String(port)}`;
    try {
      scenario("page cut in an emoji", [{ tool: "web_fetch", args: { url: `http://127.0.0.1:${String(port)}/page.txt` } }], "Read it.");
      const convId = await run("page cut in an emoji");

      const stored = await blocks(convId);
      const results = stored.flatMap(({ block }) => (block.kind === "tool_result" ? [block] : []));
      expect(results).toHaveLength(1);
      expect(results[0].ok).toBe(true);
      expect(results[0].output).toContain("x\ufffd\n… [truncated");
      // A result this size compacts the mock's small window, so the scenario's
      // own answer is not what comes next; what matters is that the run went on.
      expect(stored.at(-1)?.block.kind).not.toBe("tool_result");
      expect(stored.every(({ row }) => row.status === "complete")).toBe(true);
    } finally {
      delete process.env.LOXAIC_E2E_FETCH_ALLOW;
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("reads as stopped, not failed, when the throw is a stop arriving", async () => {
    scenario("tool throw stop", [{ calls: [TODO("first"), TODO("second")] }], "Must not be reached.");
    fault.on = true;
    const convId = await run("tool throw stop", (id) => {
      fault.before = () => { getRunByConversation(id)?.abort.abort(); };
    });

    const stored = await blocks(convId);
    const results = stored.flatMap(({ block }) => (block.kind === "tool_result" ? [block] : []));
    expect(results.map((r) => r.output)).toEqual([
      "Stopped by the user before this tool call ran.",
      "Stopped by the user before this tool call ran.",
    ]);
    expect(stored.some(({ block }) => block.kind === "text" && block.text === "Must not be reached.")).toBe(false);
  });

  it("gives every call in a sub-agent group a failed result when the group falls over", async () => {
    const call = { tool: SUBAGENT_TOOL_NAME, args: { description: "look", prompt: "look around" } };
    scenario("sub-agent throw", [{ calls: [call, call] }], "Answered without them.");
    fault.subagent = true;
    const convId = await run("sub-agent throw");

    const stored = await blocks(convId);
    const results = stored.flatMap(({ block }) => (block.kind === "tool_result" ? [block] : []));
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.ok === false && r.output === TOOL_FAILED)).toBe(true);
    expect(stored.at(-1)).toMatchObject({ block: { kind: "text", text: "Answered without them." } });
  });
});
