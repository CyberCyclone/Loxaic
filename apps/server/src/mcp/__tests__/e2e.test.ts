import "./force-mock-inference.ts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { v4 as uuid } from "uuid";
import { db, eq, inArray } from "@shannon/db";
import { conversations, mcpServers, messages, sandboxes, usageRecords, user } from "@shannon/db/schema";
import type { ContentBlock } from "@shannon/types";
import { getStreamBroker, initStreamBroker } from "../../streams/index.ts";
import { getRun } from "../../streams/registry.ts";
import { startAgentRun } from "../../streams/runs/agentRun.ts";
import { startChatRun } from "../../streams/runs/chatRun.ts";
import { getProviderByKind } from "../../sandbox/provider.ts";
import type { PermissionMode } from "@shannon/agent";
import Docker from "dockerode";

/**
 * Full-loop e2e against real Postgres + the mock inference loop + the stdio
 * fixture server: startAgentRun/startChatRun → mock model emits an MCP tool
 * call (only possible when the registry actually offered the tool) →
 * approval gate → dispatch → wrapped result persisted as ContentBlocks. Chat
 * is tool-capable too now, so every case below runs through both starters
 * except where a case is specific to one surface (planning mode is
 * agent-only; incognito is chat-only today).
 */

const userId = `test-mcp-e2e-${uuid()}`;
const convIds: string[] = [];
let serverId: string;

/**
 * Every case here runs on the mock inference loop, so only the one builtin
 * case that actually *executes* (bash) needs a container. Building
 * `shannon-sandbox` is a multi-minute ubuntu + build-essential + Node + Python
 * image — far too much to add to every CI run for a single assertion — so CI
 * has no such image and that one case is skipped there, the same way
 * drivers.test.ts skips its Redis contract when no Redis is reachable. It
 * reports as a skipped test rather than silently passing.
 */
const sandboxImage = await (async () => {
  try {
    const docker = process.env.CONTAINER_SOCKET
      ? new Docker({ socketPath: process.env.CONTAINER_SOCKET })
      : new Docker();
    await docker.getImage("shannon-sandbox").inspect();
    return true;
  } catch {
    return false;
  }
})();

async function waitFor<T>(fn: () => T | null | Promise<T | null>, timeoutMs = 20_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value !== null) return value;
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 100));
  }
}

type Surface = "agent" | "chat";

/** Run one turn (either surface) to completion, resolving any approval
 * request. Passing `conversationId` continues an existing conversation —
 * used to test that a second turn's history round-trips the first turn's
 * persisted tool_call/tool_result blocks without a dangling-call rejection. */
async function runTurn(
  content: string,
  mode: PermissionMode,
  approve: boolean | null,
  opts: { surface?: Surface; conversationId?: string; incognito?: boolean } = {},
) {
  const surface = opts.surface ?? "agent";
  const { streamId, conversationId } =
    surface === "agent"
      ? await startAgentRun({ userId, content, model: "mock", mode, conversationId: opts.conversationId })
      : await startChatRun({
          userId,
          content,
          model: "mock",
          conversationId: opts.conversationId,
          incognito: opts.incognito,
        });
  if (!convIds.includes(conversationId)) convIds.push(conversationId);

  let sawApproval = false;
  if (approve !== null) {
    await waitFor(() => {
      const run = getRun(streamId);
      if (!run) return true; // finished without asking
      const entry = run.approvals.entries().next();
      if (!entry.done) {
        sawApproval = true;
        entry.value[1](approve);
        return true;
      }
      return null;
    });
  }

  // Wait for the run to unregister (turn complete).
  await waitFor(() => (getRun(streamId) ? null : true));

  const rows = await db.query.messages.findMany({
    where: eq(messages.conversationId, conversationId),
    orderBy: (m, { asc }) => [asc(m.lamport)],
  });
  const blocks = rows.flatMap((r) => (r.content ?? []) as ContentBlock[]);
  return {
    streamId,
    conversationId,
    sawApproval,
    toolCalls: blocks.filter((b): b is Extract<ContentBlock, { kind: "tool_call" }> => b.kind === "tool_call"),
    toolResults: blocks.filter((b): b is Extract<ContentBlock, { kind: "tool_result" }> => b.kind === "tool_result"),
  };
}

/** Incognito's counterpart: no Postgres row ever exists, so read back from
 * the stream log's folded snapshot instead. */
async function runIncognitoChatTurn(content: string, conversationId: string | undefined, approve: boolean | null) {
  const { streamId, conversationId: convId } = await startChatRun({
    userId,
    content,
    model: "mock",
    conversationId,
    incognito: !conversationId, // only the first turn creates the ephemeral conv
  });

  let sawApproval = false;
  if (approve !== null) {
    await waitFor(() => {
      const run = getRun(streamId);
      if (!run) return true;
      const entry = run.approvals.entries().next();
      if (!entry.done) {
        sawApproval = true;
        entry.value[1](approve);
        return true;
      }
      return null;
    });
  }
  await waitFor(() => (getRun(streamId) ? null : true));

  const broker = getStreamBroker();
  const records = await broker.readFrom(streamId, 0);
  const snapshot = broker.foldSnapshot(records);
  return { conversationId: convId, sawApproval, snapshot };
}

beforeAll(async () => {
  await initStreamBroker();
  await db.insert(user).values({
    id: userId,
    name: "MCP E2E",
    email: `${userId}@example.test`,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const [row] = await db
    .insert(mcpServers)
    .values({
      ownerId: userId,
      name: "Mock MCP",
      slug: "mockmcp",
      transport: "stdio",
      command: "node_modules/.bin/tsx",
      args: ["test-fixtures/mock-mcp-server.ts"],
    })
    .returning();
  serverId = row.id;
}, 30_000);

afterAll(async () => {
  if (convIds.length) {
    // The chat-surface bash test creates a real sandbox — stop the
    // container itself, not just its bookkeeping row, before the row (and
    // the user it references) are deleted.
    const rows = await db.query.sandboxes.findMany({ where: inArray(sandboxes.conversationId, convIds) });
    for (const row of rows) {
      const provider = await getProviderByKind(row.provider as "container" | "host");
      const handle = await provider.attach(row.containerId);
      await handle.stop().catch(() => undefined);
    }
    await db.delete(sandboxes).where(inArray(sandboxes.conversationId, convIds));
    await db.delete(messages).where(inArray(messages.conversationId, convIds));
    await db.delete(usageRecords).where(inArray(usageRecords.conversationId, convIds));
    await db.delete(conversations).where(inArray(conversations.id, convIds));
  }
  await db.delete(mcpServers).where(eq(mcpServers.ownerId, userId));
  await db.delete(user).where(eq(user.id, userId));
}, 30_000);

describe("MCP end-to-end through the agent loop", () => {
  it("runs an approved MCP call and persists the wrapped result", async () => {
    const turn = await runTurn("please use mcp echo", "manual", true);
    expect(turn.sawApproval).toBe(true);
    expect(turn.toolCalls.map((c) => c.tool)).toContain("mockmcp__echo");
    const result = turn.toolResults[0];
    expect(result.output).toContain('<mcp-tool-result server="mockmcp" tool="echo"');
    expect(result.output).toContain("echo: hello from mcp");
  }, 30_000);

  it("still asks for approval in auto mode, and records a denial", async () => {
    const turn = await runTurn("please use mcp echo", "auto", false);
    expect(turn.sawApproval).toBe(true);
    expect(turn.toolResults[0].output).toBe("User denied this tool call.");
  }, 30_000);

  it("does not offer non-readOnly MCP tools in planning mode", async () => {
    const turn = await runTurn("please use mcp echo", "planning", null);
    expect(turn.toolCalls).toEqual([]);
  }, 30_000);

  it("skips approval for allowlisted tools", async () => {
    await db
      .update(mcpServers)
      .set({ toolPolicies: { echo: { enabled: true, approval: "allow", readOnly: false } } })
      .where(eq(mcpServers.id, serverId));
    const turn = await runTurn("please use mcp echo", "manual", null);
    expect(turn.sawApproval).toBe(false);
    expect(turn.toolResults[0].output).toContain("echo: hello from mcp");
    await db
      .update(mcpServers)
      .set({ toolPolicies: {}, knownTools: {} })
      .where(eq(mcpServers.id, serverId));
  }, 30_000);

  it("neutralizes wrapper-escape attempts before persistence", async () => {
    const turn = await runTurn("please use mcp evil", "manual", true);
    const output = turn.toolResults[0].output;
    // Exactly one genuine closing tag: the wrapper's own.
    expect(output.split("</mcp-tool-result").length).toBe(2);
    expect(output).toContain("unrestricted mode"); // payload preserved as inert text
  }, 30_000);
});

describe("MCP end-to-end through the chat loop", () => {
  it("runs an approved MCP call and persists the wrapped result, same as agent", async () => {
    const turn = await runTurn("please use mcp echo", "manual", true, { surface: "chat" });
    expect(turn.sawApproval).toBe(true);
    expect(turn.toolCalls.map((c) => c.tool)).toContain("mockmcp__echo");
    expect(turn.toolResults[0].output).toContain("echo: hello from mcp");
  }, 30_000);

  it("records a denial", async () => {
    const turn = await runTurn("please use mcp echo", "manual", false, { surface: "chat" });
    expect(turn.sawApproval).toBe(true);
    expect(turn.toolResults[0].output).toBe("User denied this tool call.");
  }, 30_000);

  it("a second send in the same conversation replays the first turn's tool exchange without erroring", async () => {
    const first = await runTurn("please use mcp echo", "manual", true, { surface: "chat" });
    // The mock model only ever looks at the *current* turn, so this can't
    // assert on what the second call was actually shown — what it proves is
    // that loadHistory successfully replayed the first turn's persisted
    // tool_call + tool_result as a resolved pair without the run erroring; a
    // real backend would 400 on a dangling, unresolved tool_call, and this is
    // exactly the shape `loadHistory` guards against (see the dedicated
    // "replays tool turns and strips dangling calls" test in
    // compaction-history.test.ts for the precise assertion on that logic).
    const second = await runTurn("thanks", "manual", null, {
      surface: "chat",
      conversationId: first.conversationId,
    });
    const rows = await db.query.messages.findMany({ where: eq(messages.conversationId, second.conversationId) });
    expect(rows.some((r) => r.status === "error")).toBe(false);
    expect(second.sawApproval).toBe(false);
  }, 30_000);

  it("bash asks in chat too", async () => {
    // bash is a builtin with no MCP wiring — proves chat's approval gate
    // covers builtins, not just MCP tools. The gate fires before the
    // container is ever touched, so this needs no sandbox image.
    const turn = await runTurn("please run a bash command", "manual", true, { surface: "chat" });
    expect(turn.sawApproval).toBe(true);
    expect(turn.toolCalls.map((c) => c.tool)).toContain("bash");
  }, 30_000);

  it.runIf(sandboxImage)("runs the approved bash call in a real sandbox", async () => {
    const turn = await runTurn("please run a bash command", "manual", true, { surface: "chat" });
    expect(turn.toolResults[0].output).toContain("hello from the sandbox");
  }, 30_000);
});

describe("Incognito chat with tools", () => {
  it("offers and runs tools with zero Postgres writes, and rebuilds history from the stream log", async () => {
    const first = await runIncognitoChatTurn("please use mcp echo", undefined, true);
    expect(first.sawApproval).toBe(true);
    const firstCall = first.snapshot.messages.flatMap((m) => m.tool_calls).find((c) => c.tool === "mockmcp__echo");
    expect(firstCall?.output).toContain("echo: hello from mcp");

    // Zero rows anywhere conversation-scoped — the whole point of incognito.
    const msgRows = await db.query.messages.findMany({ where: eq(messages.conversationId, first.conversationId) });
    const usageRows = await db.query.usageRecords.findMany({
      where: eq(usageRecords.conversationId, first.conversationId),
    });
    expect(msgRows).toHaveLength(0);
    expect(usageRows).toHaveLength(0);

    // The precise claim — loadEphemeralHistory rebuilds the resolved
    // call+result from the stream log as a replayable pair — called directly
    // rather than inferred from a second turn's response (the mock model
    // only ever looks at its own turn, so it can't prove this indirectly).
    const { loadEphemeralHistory } = await import("../../streams/runs/engine.ts");
    const history = await loadEphemeralHistory(first.conversationId);
    // Asserted field-by-field rather than against one literal: the call id is
    // generated, and matching it with expect.any() would put `any` values
    // into the expected object.
    const [userMsg, assistantMsg, toolMsg, closingMsg] = history.messages;
    expect(history.messages).toHaveLength(4);
    expect(userMsg).toEqual({ role: "user", content: "please use mcp echo" });

    expect(assistantMsg.role).toBe("assistant");
    expect(assistantMsg.content).toBe("[Mock] I'll use the mockmcp__echo tool.");
    const calls = assistantMsg.role === "assistant" ? (assistantMsg.tool_calls ?? []) : [];
    expect(calls).toHaveLength(1);
    expect(calls[0].function).toEqual({
      name: "mockmcp__echo",
      arguments: JSON.stringify({ text: "hello from mcp" }),
    });

    // The pairing is the point: the tool message must carry the same call_id
    // the assistant's call announced, or a real backend rejects the list.
    expect(toolMsg.role).toBe("tool");
    expect(toolMsg.role === "tool" ? toolMsg.tool_call_id : null).toBe(calls[0].id);
    expect(toolMsg.content).toContain("echo: hello from mcp");
    expect(closingMsg.role).toBe("assistant");
    expect(closingMsg.content).toContain("echo: hello from mcp");

    // A second turn on the same ephemeral conversation must actually
    // complete (not error) using that replayed history as its prompt.
    const second = await runIncognitoChatTurn("thanks", first.conversationId, null);
    expect(second.snapshot.messages.some((m) => m.status === "error")).toBe(false);
  }, 30_000);
});
