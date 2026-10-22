import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { v4 as uuid } from "uuid";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, desc, eq } from "@loxaic/db";
import { conversations, localModels, messages, usageRecords, user } from "@loxaic/db/schema";
import type { ContentBlock } from "@loxaic/types";
import { __resetSchedulerForTest, resetSlotProbe } from "../../inference/scheduler.ts";
import { __resetModelCachesForTest } from "../../inference/models.ts";
import { initStreamBroker } from "../../streams/index.ts";
import { getRunByConversation } from "../../streams/registry.ts";
import { startChatRun } from "../../streams/runs/chatRun.ts";
import { invalidateLocalModelCache } from "../catalog.ts";
import { __resetStageSwitchForTest } from "../context-stage-switch.ts";
import { presetPath, slotSaveDir } from "../paths.ts";
import { routerModelName } from "../preset.ts";
import { __resetRoomForTest, requestUnload } from "../room.ts";
import { __resetRouterForTest, __setHardwareForTest, ensureRuntime, routerModelStatuses, syncPreset, waitForModelStatus } from "../router.ts";
import { __resetSlotStoreForTest, conversationCacheView, recordWarmed, sweepSlotCache } from "../slot-store.ts";

/**
 * A conversation's KV cache kept across a reload, end to end on the fake
 * router — which, like the hybrid models on Pheonix, reuses a restored slot
 * only when the next request extends it exactly: so these pass only if the
 * slot is warmed before it is saved (slot-cache.ts).
 */

const FAKE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../test-fixtures/fake-llama-server.mjs");
const dir = mkdtempSync(path.join(os.tmpdir(), "loxaic-slot-store-"));
const host = `test-slot-store-${uuid()}`;
const model = `test/kept-${uuid().slice(0, 8)}:Q4_K_M`;
const name = routerModelName(model);
const loadLog = path.join(dir, "loads.jsonl");
const userId = `test-slot-store-${uuid()}`;
const convIds: string[] = [];
const HW_GPU = { platform: "linux" as const, arch: "x64", gpus: [], flavour: "vulkan" as const, reason: null, ramBytes: 16 * 1024 ** 3 };

interface Logged { event: string; model: string; slot?: number; tokens?: number; file?: string; reason?: string }
function logged(): Logged[] {
  if (!existsSync(loadLog)) return [];
  return readFileSync(loadLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Logged);
}
const mine = (from: number) => logged().slice(from).filter((e) => e.model === name);

async function setSettings(loadSettings: Record<string, unknown>): Promise<void> {
  await db.update(localModels).set({ loadSettings }).where(eq(localModels.id, model));
  invalidateLocalModelCache();
}

beforeAll(async () => {
  vi.stubEnv("LOXAIC_INSTANCE_ID", host);
  vi.stubEnv("LLAMA_DIR", dir);
  vi.stubEnv("LOXAIC_LLAMA_SERVER_BIN", FAKE);
  vi.stubEnv("LOXAIC_FAKE_ROUTER_LOG", loadLog);
  vi.stubEnv("LOXAIC_FAKE_HARDWARE", "gpu");
  vi.stubEnv("LOXAIC_FAKE_DEVICES", "FAKE0: Fake GPU (24576 MiB, 24000 MiB free)");
  vi.stubEnv("LOXAIC_FAKE_SLOT_FAIL", "");
  vi.stubEnv("LOXAIC_FAKE_RESTORE_MS", "0");
  vi.stubEnv("MOCK_INFERENCE", "false");
  vi.stubEnv("LLAMA_MODE", "managed");
  vi.stubEnv("INFERENCE_MAX_CONCURRENT_RUNS", "2");
  await initStreamBroker();
  await db.insert(user).values({
    id: userId,
    name: "Test Slots",
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
    displayName: "Kept",
    publisher: "test",
    meta: { nCtxTrain: 8192, nLayers: 28 },
    // Two slots, so two conversations are held at once.
    loadSettings: { ctxSize: 8192, parallel: 2, kvUnified: true },
  });
  invalidateLocalModelCache();
  await __resetRouterForTest();
  __resetRoomForTest();
  __resetSlotStoreForTest();
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
  __resetSlotStoreForTest();
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

/** A conversation with a turn already in it — not a new one. */
async function conversation(): Promise<string> {
  const [conv] = await db.insert(conversations).values({ ownerId: userId, title: "slots test" }).returning();
  convIds.push(conv.id);
  return conv.id;
}

async function runToEnd(convId: string, content: string): Promise<void> {
  await startChatRun({ userId, content, model, conversationId: convId });
  const deadline = Date.now() + 60_000;
  while (getRunByConversation(convId)) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the run to finish");
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** What the backend said it reused on the conversation's newest turn. */
async function lastCached(convId: string): Promise<number | null> {
  const rows = await db
    .select({ cached: usageRecords.cachedTokens })
    .from(usageRecords)
    .where(eq(usageRecords.conversationId, convId))
    .orderBy(desc(usageRecords.createdAt))
    .limit(1);
  return rows.at(0)?.cached ?? null;
}

async function reloadedWith(loadSettings: Record<string, unknown>): Promise<void> {
  await setSettings(loadSettings);
  const { deferred } = await syncPreset({ restoreLoaded: true });
  expect(deferred).toBe(false);
  await waitForModelStatus(model, "loaded", 10_000);
}

const binFiles = () => (existsSync(slotSaveDir()) ? readdirSync(slotSaveDir()).filter((f) => f.endsWith(".bin")) : []);

describe("a host model reloaded with settings that keep its cache", () => {
  it("writes llama.cpp's slot directory into the preset, Loxaic's own and private", () => {
    expect(readFileSync(presetPath(), "utf8")).toContain(`slot-save-path = ${slotSaveDir()}`);
    expect(statSync(slotSaveDir()).mode & 0o777).toBe(0o700);
  });

  it("saves each conversation it holds, and each one's next turn reads its own back", async () => {
    const a = await conversation();
    const b = await conversation();
    await runToEnd(a, "tell me about otters");
    await runToEnd(b, "tell me about beavers");
    // Both turns cost the same; the slots' prompts tell them apart.
    const from = logged().length;
    await reloadedWith({ ctxSize: 8192, parallel: 2, kvUnified: true, temperature: 0.3 });

    const events = mine(from);
    const saves = events.filter((e) => e.event === "slot-save");
    expect(saves).toHaveLength(2);
    expect(saves.map((s) => s.file).sort()).toEqual(binFiles().sort());
    // Saved before the reload took the model away.
    expect(events.findIndex((e) => e.event === "unload")).toBeGreaterThan(events.lastIndexOf(saves[1]));
    for (const f of binFiles()) expect(statSync(path.join(slotSaveDir(), f)).mode & 0o777, f).toBe(0o600);
    expect(await conversationCacheView(a, model, true)).toMatchObject({ state: "saved" });

    const before = logged().length;
    await runToEnd(a, "and their diet?");
    const restored = mine(before).filter((e) => e.event === "slot-restore");
    expect(restored).toHaveLength(1);
    expect(restored[0].file).toContain(a);
    expect(await lastCached(a)).toBeGreaterThan(0);
    // Used once: only b's is left.
    expect(binFiles()).toHaveLength(1);
    expect(binFiles()[0]).toContain(b);

    await runToEnd(b, "and their dams?");
    expect(await lastCached(b)).toBeGreaterThan(0);
    expect(binFiles()).toHaveLength(0);
  });

  it("saves nothing when the change touches what the cache was computed with, and says it is gone", async () => {
    const c = await conversation();
    await runToEnd(c, "a question");
    const from = logged().length;
    await reloadedWith({ ctxSize: 8192, parallel: 2, kvUnified: true, temperature: 0.3, cacheTypeK: "q8_0" });
    expect(mine(from).some((e) => e.event === "slot-save")).toBe(false);
    expect(mine(from).some((e) => e.event === "unload")).toBe(true);
    expect(await conversationCacheView(c, model, true)).toMatchObject({ state: "lost", reason: "settings" });
    // A context-stage switch re-reads the conversation that asked for it: no
    // turn of its own, but its cache is back.
    const other = await conversation();
    await runToEnd(other, "warm me");
    await reloadedWith({ ctxSize: 8192, parallel: 2, kvUnified: true, temperature: 0.3, cacheTypeK: "q4_0" });
    expect(await conversationCacheView(other, model, true)).toMatchObject({ state: "lost" });
    recordWarmed(model, other);
    expect(await conversationCacheView(other, model, true)).toEqual({ state: "warm" });
    await runToEnd(c, "another");
    expect(await lastCached(c)).toBe(0);
    expect(await conversationCacheView(c, model, true)).toEqual({ state: "warm" });
  });

  it("saves before an admin's Unload, and the next turn reads it back", async () => {
    const d = await conversation();
    await runToEnd(d, "unload me");
    const from = logged().length;
    await requestUnload(model, false);
    // Every conversation the slots hold, each warmed first, then the unload.
    const events = mine(from).map((e) => (e.event === "slot-save" ? `save:${e.file?.includes(d) ? "d" : "other"}` : e.event));
    expect(events.at(-1)).toBe("unload");
    expect(events).toContain("save:d");
    expect(await conversationCacheView(d, model, true)).toMatchObject({ state: "saved" });
    await runToEnd(d, "back again");
    expect(mine(from).some((e) => e.event === "slot-restore")).toBe(true);
    expect(await lastCached(d)).toBeGreaterThan(0);
  });

  it("keeps it across a restart of the runtime", async () => {
    const e = await conversation();
    await runToEnd(e, "before the restart");
    const from = logged().length;
    await ensureRuntime({ restart: true });
    expect(mine(from).some((x) => x.event === "slot-save")).toBe(true);
    await runToEnd(e, "after the restart");
    expect(await lastCached(e)).toBeGreaterThan(0);
  });

  it("a restore that fails costs a re-read and nothing else", async () => {
    const f = await conversation();
    await runToEnd(f, "fragile");
    await requestUnload(model, false);
    expect(binFiles().some((x) => x.includes(f))).toBe(true);
    // The fake reads its environment at spawn.
    vi.stubEnv("LOXAIC_FAKE_SLOT_FAIL", "restore");
    await __resetRouterForTest();
    await ensureRuntime();
    try {
      await runToEnd(f, "still answered");
      const rows = await db.query.messages.findMany({ where: eq(messages.conversationId, f) });
      const last = rows.filter((r) => r.authorType === "assistant").sort((x, y) => y.lamport - x.lamport)[0];
      expect(last.status).toBe("complete");
      expect((last.content as ContentBlock[]).some((b) => b.kind === "text")).toBe(true);
      expect(await lastCached(f)).toBe(0);
      expect(binFiles().some((x) => x.includes(f))).toBe(false);
    } finally {
      vi.stubEnv("LOXAIC_FAKE_SLOT_FAIL", "");
      await __resetRouterForTest();
      await ensureRuntime();
    }
  });

  it("sweeps files nothing names and entries past their time", async () => {
    const g = await conversation();
    await runToEnd(g, "to be swept");
    await requestUnload(model, false);
    const manifestFile = readdirSync(slotSaveDir()).find((x) => x.endsWith(".json"));
    expect(manifestFile).toBeDefined();
    const manifest = path.join(slotSaveDir(), manifestFile ?? "");
    const m = JSON.parse(readFileSync(manifest, "utf8")) as { entries: { savedAt: number }[] };
    for (const entry of m.entries) entry.savedAt = 0;
    writeFileSync(manifest, JSON.stringify(m));
    writeFileSync(path.join(slotSaveDir(), "orphan.bin"), "x");
    await sweepSlotCache();
    expect(binFiles()).toEqual([]);
    expect((await routerModelStatuses()).get(model)?.value).toBe("unloaded");
  });
});
