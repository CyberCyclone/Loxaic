import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { v4 as uuid } from "uuid";
import { db, eq } from "@loxaic/db";
import { conversations, messages, sandboxes, usageRecords, user } from "@loxaic/db/schema";
import type { ContentBlock } from "@loxaic/types";
import { initStreamBroker } from "../../index.ts";
import { getRunByConversation } from "../../registry.ts";
import { startAgentRun } from "../agentRun.ts";
import { __resetMockScenariosForTest } from "../../../inference/mock-scenarios.ts";
import { sandboxImageReady } from "../../../sandbox/__tests__/docker-available.ts";
import { destroyConversationSandboxes } from "../../../agent/sandbox-manager.ts";

/**
 * Stop has to actually stop the run — #113.
 *
 * Two independent places ignored `abort.signal`, and both are only visible
 * from a real run:
 *
 *   1. `waitForApproval` settled on approve/deny or the five-minute
 *      APPROVAL_TIMEOUT_MS and nothing else, so a stop at a permission prompt
 *      — manual mode, the default — parked the run for up to five minutes.
 *   2. The per-call loop never re-checked abort, so a stop during a batch of
 *      tool calls still ran every remaining one. A real session issued five
 *      in a single message and took 6m39s over them.
 *
 * Both cases assert against a deadline far below the timeouts they used to
 * wait out: before the fix each of these times out rather than failing
 * slowly, which is the point — "eventually" was exactly the bug.
 */
process.env.MOCK_INFERENCE = "true";

/** Generous next to the sub-second path being asserted, tight next to the
 * 5-minute approval timeout and the 60s-per-`bash` batch it replaces. */
const STOP_DEADLINE_MS = 10_000;

/** The batch case needs a real sandbox: `bash` is the only builtin slow
 * enough to abort *during*. Gated the same way every other container test is
 * — see docker-available.ts for why a cold runner skips rather than fails. */
const dockerReady = await sandboxImageReady();

describe("stopping a run", () => {
  const userId = `test-stop-${uuid()}`;
  const convIds: string[] = [];
  let dir: string;

  beforeAll(async () => {
    await initStreamBroker();
    await db.insert(user).values({
      id: userId,
      name: "Test Stop",
      email: `${userId}@example.test`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    dir = mkdtempSync(path.join(tmpdir(), "stop-abort-"));
  });

  afterAll(async () => {
    for (const id of convIds) {
      // Scoped to this suite's own conversations — a global sweep would take
      // out sandboxes another suite is mid-assertion on. The batch case
      // creates a real container, so this is not optional tidiness.
      await destroyConversationSandboxes(id);
      await db.delete(messages).where(eq(messages.conversationId, id));
      await db.delete(usageRecords).where(eq(usageRecords.conversationId, id));
      await db.delete(conversations).where(eq(conversations.id, id));
    }
    // destroyConversationSandboxes removes the *container* but leaves the row
    // marked destroyed, and that row still references this user — so the row
    // goes too, scoped by ownerId like every other sandbox suite's cleanup.
    await db.delete(sandboxes).where(eq(sandboxes.ownerId, userId));
    await db.delete(user).where(eq(user.id, userId));
    delete process.env.MOCK_SCENARIOS_FILE;
    __resetMockScenariosForTest();
    rmSync(dir, { recursive: true, force: true });
  });

  async function newConversation(): Promise<string> {
    const [conv] = await db
      .insert(conversations)
      .values({ ownerId: userId, title: "stop test", kind: "agent" })
      .returning();
    convIds.push(conv.id);
    return conv.id;
  }

  async function waitFor(label: string, check: () => boolean | Promise<boolean>, timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await check()) return;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  /** Resolves when the conversation has no run left in the registry — the
   * same signal `active_run` reports to a client. */
  async function waitForRunGone(convId: string, timeoutMs: number): Promise<number> {
    const started = Date.now();
    await waitFor("the run to end", () => getRunByConversation(convId) === undefined, timeoutMs);
    return Date.now() - started;
  }

  it("ends a run stopped while it waits for an approval, instead of parking it for five minutes", async () => {
    const convId = await newConversation();
    // Manual mode: fs_write asks. The run then sits in waitForApproval, which
    // is exactly where a user reaches for Stop.
    await startAgentRun({
      userId,
      content: "write a file called notes",
      model: "llama-3.1-8b-instruct",
      mode: "manual",
      conversationId: convId,
    });

    const run = await (async () => {
      await waitFor("the run to register", () => getRunByConversation(convId) !== undefined);
      const found = getRunByConversation(convId);
      if (!found) throw new Error("run vanished");
      return found;
    })();
    await waitFor("the approval to be pending", () => run.approvals.size > 0);

    // What the WS handler does for a `stream.stop` frame.
    run.abort.abort();

    const took = await waitForRunGone(convId, STOP_DEADLINE_MS);
    expect(took).toBeLessThan(STOP_DEADLINE_MS);
  });

  it("skips the rest of a tool batch when stopped part-way through it", async () => {
    // Three calls in ONE assistant message, which is what made the real
    // failure last minutes: they run in series, and a stop on the first still
    // ran the other two.
    //
    // Manual mode, so the batch parks at the *first* call's approval — the
    // one point in a batch that is deterministic to catch. Waiting for a tool
    // result instead would always be too late: results are persisted as a
    // single message after every call in the batch has run, so by the time
    // one exists there is nothing left to skip. It is also the honest
    // pairing, since this is precisely how the two bugs compound in manual
    // mode: park at an approval, stop, and the rest of the batch runs anyway.
    const file = path.join(dir, "batch.json");
    writeFileSync(
      file,
      JSON.stringify([
        {
          match: "scaffold the project",
          steps: [
            {
              calls: [
                { tool: "fs_write", args: { path: "one.txt", content: "one\n" } },
                { tool: "fs_write", args: { path: "two.txt", content: "two\n" } },
                { tool: "fs_write", args: { path: "three.txt", content: "three\n" } },
              ],
            },
          ],
          finalText: "[Mock] scaffolded.\n",
        },
      ]),
    );
    process.env.MOCK_SCENARIOS_FILE = file;
    __resetMockScenariosForTest();

    const convId = await newConversation();
    await startAgentRun({
      userId,
      content: "scaffold the project",
      model: "llama-3.1-8b-instruct",
      mode: "manual",
      conversationId: convId,
    });

    await waitFor("the run to register", () => getRunByConversation(convId) !== undefined);
    const run = getRunByConversation(convId);
    if (!run) throw new Error("run vanished");
    // Parked at the first call's approval, with two calls still unrun — and
    // no sandbox has been created, since execution never got that far.
    await waitFor("the first approval to be pending", () => run.approvals.size > 0);
    run.abort.abort();

    const took = await waitForRunGone(convId, STOP_DEADLINE_MS);
    expect(took).toBeLessThan(STOP_DEADLINE_MS);

    const rows = await db.query.messages.findMany({ where: eq(messages.conversationId, convId) });
    const blocks = rows.flatMap((r) => r.content as ContentBlock[]);
    // It really was a batch — three calls in one assistant message.
    expect(blocks.filter((b) => b.kind === "tool_call").length).toBe(3);
    // And none of them ran. Aborting the approval unwinds through
    // `slot.yieldWhile`, which refuses to re-enter the queue for an aborted
    // run (RunSlotAbortedError) and ends the turn before any tool executes —
    // so the assistant message keeps its calls with no results, which is the
    // orphan case `loadHistory` already strips from both directions on the
    // next turn. What matters here is that calls 2 and 3 never ran.
    expect(blocks.filter((b) => b.kind === "tool_result").length).toBe(0);
  });

  it.skipIf(!dockerReady)("stops during a batch without running the calls behind it", async () => {
    // The auto-mode half, and the shape of the real 6m39s failure: no
    // approval to park at, three genuinely slow calls in one message, and a
    // stop that lands while the first is still executing. Needs a real
    // sandbox — `bash` is the only builtin slow enough to abort *during*.
    const file = path.join(dir, "slow-batch.json");
    writeFileSync(
      file,
      JSON.stringify([
        {
          match: "run the slow batch",
          steps: [
            {
              calls: [
                { tool: "bash", args: { command: "sleep 3; echo one" } },
                { tool: "bash", args: { command: "sleep 3; echo two" } },
                { tool: "bash", args: { command: "sleep 3; echo three" } },
              ],
            },
          ],
          finalText: "[Mock] done.\n",
        },
      ]),
    );
    process.env.MOCK_SCENARIOS_FILE = file;
    __resetMockScenariosForTest();

    const convId = await newConversation();
    await startAgentRun({
      userId,
      content: "run the slow batch",
      model: "llama-3.1-8b-instruct",
      mode: "auto",
      conversationId: convId,
    });

    await waitFor("the run to register", () => getRunByConversation(convId) !== undefined);
    const run = getRunByConversation(convId);
    if (!run) throw new Error("run vanished");
    // Keyed on a real signal rather than a fixed sleep: the sandbox row is
    // written when the first call creates it, so its appearance means the
    // batch is genuinely under way. A wall-clock guess passed alone and
    // failed in a full suite run, where Docker is contended.
    await waitFor("the sandbox to be created", async () => {
      const rows = await db.query.sandboxes.findMany({ where: eq(sandboxes.conversationId, convId) });
      return rows.length > 0;
    }, 30_000);
    run.abort.abort();

    // The in-flight exec still has to finish — cancelling mid-`exec` is a
    // separate, larger change across all three providers — so the bound is
    // one call, not three.
    const took = await waitForRunGone(convId, 30_000);
    expect(took).toBeLessThan(8_000);

    const rows = await db.query.messages.findMany({ where: eq(messages.conversationId, convId) });
    const blocks = rows.flatMap((r) => r.content as ContentBlock[]);
    const results = blocks.filter((b) => b.kind === "tool_result");
    // Every call keeps its partner, and the ones behind the stop say why
    // rather than silently running.
    const callIds = blocks.filter((b) => b.kind === "tool_call").map((b) => b.call_id);
    expect(callIds.length).toBe(3);
    expect([...results.map((r) => r.call_id)].sort()).toEqual([...callIds].sort());
    // At least one, not exactly two: whether the stop lands before or during
    // the first call is a genuine race, and both outcomes are correct. What
    // must hold either way is that nothing *behind* the stop ran — asserted
    // on the output, since a skipped call cannot have echoed.
    expect(results.filter((r) => r.output.includes("Stopped by the user")).length).toBeGreaterThan(0);
    expect(results.filter((r) => r.output.includes("two") || r.output.includes("three")).length).toBe(0);
  }, 60_000);
});
