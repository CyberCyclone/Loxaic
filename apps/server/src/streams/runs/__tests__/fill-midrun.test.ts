import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { v4 as uuid } from "uuid";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, eq } from "@loxaic/db";
import { conversations, localModels, messages, usageRecords, user } from "@loxaic/db/schema";
import { COMPACTION_CONTINUE_NUDGE, type ContentBlock } from "@loxaic/types";
import { __resetSchedulerForTest, resetSlotProbe } from "../../../inference/scheduler.ts";
import { __resetModelCachesForTest } from "../../../inference/models.ts";
import { getLocalModelRow, invalidateLocalModelCache } from "../../../llama/catalog.ts";
import { __resetStageSwitchForTest } from "../../../llama/context-stage-switch.ts";
import { __resetRoomForTest } from "../../../llama/room.ts";
import { __resetRouterForTest, __setHardwareForTest, ensureRuntime } from "../../../llama/router.ts";
import { initStreamBroker } from "../../index.ts";
import { getRunByConversation } from "../../registry.ts";
import { startChatRun } from "../chatRun.ts";

/**
 * A conversation that fills the model's context in the middle of a run, on a
 * real (fake) llama.cpp router: the run makes room between two of its own
 * requests, so nothing is sent that llama.cpp would cut off.
 *
 * A model set to extend moves up a stage inside the run — handing its slot
 * back for the switch, which needs the whole backend, and taking it again —
 * and the run carries on at the larger window. With no stage left it compacts
 * instead. The fake router reports "overflow the context" as 90% of the
 * window the model was loaded with, and "work in steps" makes one tool call
 * per turn, which is what gives a run a second request.
 */

const FAKE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../test-fixtures/fake-llama-server.mjs");
const dir = mkdtempSync(path.join(os.tmpdir(), "loxaic-fill-midrun-"));
const host = `test-fill-midrun-${uuid()}`;
const model = `test/filling-${uuid().slice(0, 8)}:Q4_K_M`;
const loadLog = path.join(dir, "loads.jsonl");
const userId = `test-fill-midrun-${uuid()}`;
const convIds: string[] = [];
const HW_GPU = { platform: "linux" as const, arch: "x64", gpus: [], flavour: "vulkan" as const, reason: null, ramBytes: 16 * 1024 ** 3 };

interface Logged { event: string; model: string; ctx_size?: number; prompt_tokens?: number; last_role?: string; section?: Record<string, string> }
function logged(): Logged[] {
  if (!existsSync(loadLog)) return [];
  return readFileSync(loadLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Logged);
}

async function activeStage(): Promise<number> {
  invalidateLocalModelCache();
  return (await getLocalModelRow(model))?.activeStage ?? -1;
}

beforeAll(async () => {
  vi.stubEnv("LOXAIC_INSTANCE_ID", host);
  vi.stubEnv("LLAMA_DIR", dir);
  vi.stubEnv("LOXAIC_LLAMA_SERVER_BIN", FAKE);
  vi.stubEnv("LOXAIC_FAKE_ROUTER_LOG", loadLog);
  vi.stubEnv("LOXAIC_FAKE_HARDWARE", "gpu");
  vi.stubEnv("LOXAIC_FAKE_DEVICES", "FAKE0: Fake GPU (24576 MiB, 24000 MiB free)");
  vi.stubEnv("MOCK_INFERENCE", "false");
  vi.stubEnv("LLAMA_MODE", "managed");
  vi.stubEnv("INFERENCE_MAX_CONCURRENT_RUNS", "1");
  await initStreamBroker();
  await db.insert(user).values({
    id: userId,
    name: "Test Fill",
    email: `${userId}@example.test`,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.insert(localModels).values({
    id: model,
    hostId: host,
    repo: model.split(":")[0],
    revision: "0".repeat(40),
    quant: "Q4_K_M",
    files: [{ path: "m.gguf", size: 1, sha256: null }],
    sizeBytes: 1,
    status: "ready",
    enabled: true,
    displayName: "Filling",
    publisher: "test",
    meta: { nCtxTrain: 8192, nLayers: 28 },
    loadSettings: { ctxSize: 8192 },
    contextStages: { enabled: true, whenFull: "extend", stages: [{ ctxSize: 16384 }] },
  });
  invalidateLocalModelCache();
  await __resetRouterForTest();
  __resetRoomForTest();
  __setHardwareForTest(HW_GPU);
  await ensureRuntime();
});

afterAll(async () => {
  for (const id of convIds) {
    await db.delete(messages).where(eq(messages.conversationId, id));
    await db.delete(usageRecords).where(eq(usageRecords.conversationId, id));
    await db.delete(conversations).where(eq(conversations.id, id));
  }
  await db.delete(user).where(eq(user.id, userId));
  __resetStageSwitchForTest();
  __resetSchedulerForTest();
  await __resetRouterForTest();
  await db.delete(localModels).where(eq(localModels.hostId, host));
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  __resetModelCachesForTest();
  invalidateLocalModelCache();
  resetSlotProbe();
});

/** A conversation with `count` messages already in it — never a new one,
 * whose first run would step the model back down to its standard stage. */
async function conversationWith(count: number): Promise<string> {
  const [conv] = await db.insert(conversations).values({ ownerId: userId, title: "fill test" }).returning();
  convIds.push(conv.id);
  await db.insert(messages).values(
    Array.from({ length: count }, (_, i) => ({
      id: uuid(),
      conversationId: conv.id,
      authorType: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      origin: "server" as const,
      lamport: 1000 + i,
      content: [{ kind: "text", text: `earlier ${String(i)}` }] as ContentBlock[],
      status: "complete" as const,
      createdAt: new Date(1_700_000_000_000 + i),
    })),
  );
  return conv.id;
}

async function runToEnd(convId: string, content: string): Promise<void> {
  await startChatRun({ userId, content, model, conversationId: convId });
  const deadline = Date.now() + 60_000;
  while (getRunByConversation(convId)) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the run to finish");
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe("a conversation that fills up in the middle of a run", () => {
  it("extends the model's context between two requests, and the run carries on at the larger window", async () => {
    const convId = await conversationWith(2);
    const before = logged().length;
    await runToEnd(convId, "work in steps and overflow the context");

    const after = logged().slice(before);
    const chats = after.filter((e) => e.event === "chat" && e.model.includes("filling"));
    // The first request at the standard 8K, then — after the switch — the next
    // at 16K. Nothing was sent at 8K once it would not fit.
    expect(chats.map((c) => c.ctx_size)).toEqual([8192, 16384]);
    const reload = after.findIndex((e) => e.event === "load" && e.section?.["ctx-size"] === "16384");
    expect(reload).toBeGreaterThan(after.indexOf(chats[0]));
    expect(reload).toBeLessThan(after.indexOf(chats[1]));
    expect(await activeStage()).toBe(1);

    // Extended, not compacted: nothing was summarised.
    const rows = await db.query.messages.findMany({ where: eq(messages.conversationId, convId) });
    expect(rows.some((r) => r.authorType === "summary")).toBe(false);
    expect(rows.filter((r) => r.authorType === "assistant" && r.status === "complete" && r.model)).toHaveLength(2);
  });

  it("compacts once there is no stage left, and the request after the summary is small", async () => {
    // At its last stage now (16K), with enough after any summary to compact.
    expect(await activeStage()).toBe(1);
    const convId = await conversationWith(8);
    const before = logged().length;
    await runToEnd(convId, "work in steps and overflow the context");

    const rows = await db.query.messages.findMany({
      where: eq(messages.conversationId, convId),
      orderBy: (m, { asc }) => [asc(m.lamport), asc(m.createdAt)],
    });
    const summaries = rows.filter((r) => r.authorType === "summary");
    expect(summaries).toHaveLength(1);
    expect(summaries[0].status).toBe("complete");
    const at = rows.indexOf(summaries[0]);
    expect(rows[at - 1].authorType).toBe("tool");
    expect((rows[at + 1].content as ContentBlock[])[0]).toEqual({ kind: "text", text: COMPACTION_CONTINUE_NUDGE });

    const chats = logged().slice(before).filter((e) => e.event === "chat" && e.model.includes("filling"));
    // The tool step at 90%, the summary, then the run's next request — read
    // from the summary and the nudge, so small again.
    expect(chats[0].prompt_tokens).toBe(Math.round(16384 * 0.9));
    expect(chats.at(-1)?.prompt_tokens).toBe(10);
    expect(await activeStage()).toBe(1);
  });
});
