import "./force-mock-inference.ts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { v4 as uuid } from "uuid";
import { db, eq, inArray } from "@shannon/db";
import { conversations, mcpServers, messages, usageRecords, user } from "@shannon/db/schema";
import type { ContentBlock } from "@shannon/types";
import { initStreamBroker } from "../../streams/index.ts";
import { getRun } from "../../streams/registry.ts";
import { startAgentRun } from "../../streams/runs/agentRun.ts";
import type { PermissionMode } from "@shannon/agent";

/**
 * Full-loop e2e against real Postgres + the mock inference loop + the stdio
 * fixture server: startAgentRun → mock model emits an MCP tool call (only
 * possible when the registry actually offered the tool) → approval gate →
 * dispatch → wrapped result persisted as ContentBlocks.
 */

const userId = `test-mcp-e2e-${uuid()}`;
const convIds: string[] = [];
let serverId: string;

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs = 20_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value !== null) return value;
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Run one agent turn to completion, resolving any approval request. */
async function runTurn(content: string, mode: PermissionMode, approve: boolean | null) {
  const { streamId, conversationId } = await startAgentRun({ userId, content, model: "mock", mode });
  convIds.push(conversationId);

  let sawApproval = false;
  if (approve !== null) {
    await waitFor(async () => {
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
  await waitFor(async () => (getRun(streamId) ? null : true));

  const rows = await db.query.messages.findMany({
    where: eq(messages.conversationId, conversationId),
    orderBy: (m, { asc }) => [asc(m.lamport)],
  });
  const blocks = rows.flatMap((r) => (r.content as ContentBlock[]) ?? []);
  return {
    sawApproval,
    toolCalls: blocks.filter((b): b is Extract<ContentBlock, { kind: "tool_call" }> => b.kind === "tool_call"),
    toolResults: blocks.filter((b): b is Extract<ContentBlock, { kind: "tool_result" }> => b.kind === "tool_result"),
  };
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
    await db.delete(messages).where(inArray(messages.conversationId, convIds));
    await db.delete(usageRecords).where(inArray(usageRecords.conversationId, convIds));
    await db.delete(conversations).where(inArray(conversations.id, convIds));
  }
  await db.delete(mcpServers).where(eq(mcpServers.ownerId, userId));
  await db.delete(user).where(eq(user.id, userId));
});

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
