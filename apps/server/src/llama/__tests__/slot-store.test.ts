import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
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
import { deleteConversation } from "../../conversations/delete.ts";
import { UnloadRefusedError, __resetRoomForTest, requestUnload } from "../room.ts";
import { __resetRouterForTest, __setHardwareForTest, ensureRuntime, routerModelStatuses, syncPreset, waitForModelStatus } from "../router.ts";
import {
  __resetSlotStoreForTest,
  conversationCacheView,
  recordWarmed,
  restoreConversation,
  saveModel,
  slotCacheDiskWarning,
  sweepSlotCache,
} from "../slot-store.ts";
import { getCacheIdentity } from "../router.ts";

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

interface Logged {
  event: string;
  model: string;
  slot?: number;
  tokens?: number;
  file?: string;
  reason?: string;
  id_slot?: number | null;
  last_role?: string | null;
  last_user?: string;
}
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
  vi.stubEnv("LOXAIC_FAKE_SAVE_MS", "0");
  vi.stubEnv("LOXAIC_SLOT_FREE_FILE", path.join(dir, "free-bytes"));
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
    await db.delete(conversations).where(eq(conversations.id, id));
  }
  // By user, not conversation: an erased conversation's usage rows survive it
  // with no conversation to find them by.
  await db.delete(usageRecords).where(eq(usageRecords.userId, userId));
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
    // A file no manifest names: an old one is an orphan, a new one a save
    // still being written.
    writeFileSync(path.join(slotSaveDir(), "orphan.bin"), "x");
    const old = new Date(Date.now() - 2 * 60 * 60_000);
    utimesSync(path.join(slotSaveDir(), "orphan.bin"), old, old);
    writeFileSync(path.join(slotSaveDir(), "being-written.bin"), "x");
    await sweepSlotCache();
    expect(binFiles()).toEqual(["being-written.bin"]);
    unlinkSync(path.join(slotSaveDir(), "being-written.bin"));
    expect((await routerModelStatuses()).get(model)?.value).toBe("unloaded");
  });
});

/** The fake reads its environment at spawn: restart it with `env` set. */
async function fakeWith(env: Record<string, string>, fn: () => Promise<void>): Promise<void> {
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  await __resetRouterForTest();
  await ensureRuntime();
  try {
    await fn();
  } finally {
    for (const k of Object.keys(env)) vi.stubEnv(k, k === "LOXAIC_FAKE_SLOT_FAIL" ? "" : "0");
    await __resetRouterForTest();
    await ensureRuntime();
  }
}

/** The settings the earlier cases leave the model at, cache type included:
 * a case below changes only the setting it is about. */
const SAME_CACHE = { ctxSize: 8192, parallel: 2, kvUnified: true, cacheTypeK: "q4_0" };

const manifestJson = (): { entries: { conversationId: string }[]; bytesPerToken?: number } | null => {
  const file = existsSync(slotSaveDir()) ? readdirSync(slotSaveDir()).find((x) => x.endsWith(".json")) : undefined;
  return file ? (JSON.parse(readFileSync(path.join(slotSaveDir(), file), "utf8")) as never) : null;
};

describe("when a save cannot be made", () => {
  const freeFile = () => path.join(dir, "free-bytes");

  it("a disk too full skips it, and the conversation and the admin are told why", async () => {
    const c = await conversation();
    await runToEnd(c, "a conversation the disk cannot hold");
    writeFileSync(freeFile(), "1");
    try {
      const from = logged().length;
      await reloadedWith({ ...SAME_CACHE, temperature: 0.5 });
      expect(mine(from).some((e) => e.event === "slot-save")).toBe(false);
      const view = await conversationCacheView(c, model, true);
      expect(view).toMatchObject({ state: "lost", reason: "no_disk", free_bytes: 1 });
      expect(view.state === "lost" ? view.need_bytes : 0).toBeGreaterThan(0);
      expect(slotCacheDiskWarning()).toMatchObject({ model, freeBytes: 1 });
    } finally {
      unlinkSync(freeFile());
    }
    // Room again: the next save works, records its measured size, and the
    // admin's warning goes.
    await runToEnd(c, "and now there is room");
    await reloadedWith({ ...SAME_CACHE, temperature: 0.6 });
    expect(await conversationCacheView(c, model, true)).toMatchObject({ state: "saved" });
    expect(slotCacheDiskWarning()).toBeNull();
    expect(manifestJson()?.bytesPerToken).toBeGreaterThan(0);
    // Kept on disk, so a restarted server sizes its first save by it.
    __resetSlotStoreForTest();
    expect(manifestJson()?.bytesPerToken).toBeGreaterThan(0);
    await runToEnd(c, "use it");
  });

  it("warms the very slot it saves, named to llama.cpp", async () => {
    const c = await conversation();
    await runToEnd(c, "name my slot");
    const from = logged().length;
    await reloadedWith({ ...SAME_CACHE, temperature: 0.7 });
    const events = mine(from);
    const save = events.find((e) => e.event === "slot-save" && (e.file ?? "").includes(c));
    const warm = events.find((e) => e.event === "chat" && e.last_role === "assistant" && e.last_user === "name my slot");
    expect(save).toBeDefined();
    expect(warm?.id_slot).toBe(save?.slot);
    await runToEnd(c, "done");
  });

  it("keeps nothing when the slot held something else by the time it was written", async () => {
    const c = await conversation();
    await fakeWith({ LOXAIC_FAKE_SLOT_FAIL: "drift" }, async () => {
      await runToEnd(c, "drifting");
      const from = logged().length;
      await reloadedWith({ ...SAME_CACHE, temperature: 0.8 });
      expect(mine(from).some((e) => e.event === "slot-save" && (e.file ?? "").includes(c))).toBe(true);
      expect(binFiles().some((f) => f.includes(c))).toBe(false);
      expect(await conversationCacheView(c, model, true)).toMatchObject({ state: "lost" });
    });
  });

  it("one conversation whose warm-up fails costs that one alone", async () => {
    const a = await conversation();
    const b = await conversation();
    await runToEnd(a, "an ordinary one");
    await runToEnd(b, "fail my warm-up");
    await reloadedWith({ ...SAME_CACHE, temperature: 0.9 });
    // b was newer, so warmed first, and refused; a was still saved after it.
    expect(await conversationCacheView(a, model, true)).toMatchObject({ state: "saved" });
    expect(await conversationCacheView(b, model, true)).toMatchObject({ state: "lost" });
    expect(manifestJson()?.entries.map((e) => e.conversationId)).toContain(a);
    await runToEnd(a, "done");
  });

  it("matches a slot by its conversation's live messages, never one a rewind removed", async () => {
    const x = await conversation();
    const y = await conversation();
    await runToEnd(x, "otter facts please");
    await runToEnd(y, "beaver facts please");
    // Both turns cost the same; x also has a newer user message a rewind took.
    await db.insert(messages).values({
      id: uuid(),
      conversationId: x,
      authorType: "user",
      origin: "server",
      lamport: 1_000_000,
      content: [{ kind: "text", text: "a message that was rewound away" }] as ContentBlock[],
      status: "complete",
      deletedAt: new Date(),
      createdAt: new Date(),
    });
    const from = logged().length;
    await reloadedWith({ ...SAME_CACHE, temperature: 1.0 });
    const saved = mine(from).filter((e) => e.event === "slot-save").map((e) => e.file ?? "");
    expect(saved.some((f) => f.includes(x))).toBe(true);
    expect(saved.some((f) => f.includes(y))).toBe(true);
  });

  it("stops at its deadline, however long a save takes", async () => {
    const c = await conversation();
    await fakeWith({ LOXAIC_FAKE_SAVE_MS: "5000" }, async () => {
      await runToEnd(c, "a slow save");
      const identity = getCacheIdentity(model);
      expect(identity).not.toBeNull();
      // The fake's warm-up alone takes about four seconds: each step is cut to
      // what is left, so the pass ends at its deadline, not after it.
      const started = Date.now();
      const from = logged().length;
      await saveModel(model, identity ?? "", { deadline: Date.now() + 2_500 });
      expect(Date.now() - started).toBeLessThan(3_500);
      // It did start: the warm-up went out, and was cut off.
      expect(mine(from).some((e) => e.event === "chat" && e.last_role === "assistant")).toBe(true);
      expect(binFiles().some((f) => f.includes(c))).toBe(false);
    });
  }, 40_000);
});

describe("a save never cuts a reply off", () => {
  it("an Unload is refused when a reply starts while the caches are saved", async () => {
    const quiet = await conversation();
    const busy = await conversation();
    await fakeWith({ LOXAIC_FAKE_SAVE_MS: "1500" }, async () => {
      await runToEnd(quiet, "saved while someone asks");
      await runToEnd(busy, "a first turn");
      const from = logged().length;
      const unloading = requestUnload(model, false);
      await new Promise((r) => setTimeout(r, 400));
      await startChatRun({ userId, content: "take your time 6000", model, conversationId: busy });
      await expect(unloading).rejects.toBeInstanceOf(UnloadRefusedError);
      expect(mine(from).some((e) => e.event === "unload")).toBe(false);
      while (getRunByConversation(busy)) await new Promise((r) => setTimeout(r, 50));
      expect((await routerModelStatuses()).get(model)?.value).toBe("loaded");
      // Never unloaded, so what was saved is not offered back: the live cache
      // is still there, and the next turn uses it as it is.
      expect(await conversationCacheView(quiet, model, true)).toEqual({ state: "warm" });
      const next = logged().length;
      await runToEnd(quiet, "still here");
      expect(mine(next).some((e) => e.event === "slot-restore")).toBe(false);
    });
  }, 60_000);

  it("a settings reload waits for a reply that started while the caches were saved", async () => {
    const quiet = await conversation();
    const busy = await conversation();
    await fakeWith({ LOXAIC_FAKE_SAVE_MS: "1500" }, async () => {
      await runToEnd(quiet, "saved before a reload");
      await runToEnd(busy, "a first turn too");
      await setSettings({ ...SAME_CACHE, temperature: 1.1 });
      const syncing = syncPreset({ restoreLoaded: true });
      await new Promise((r) => setTimeout(r, 400));
      await startChatRun({ userId, content: "take your time 6000", model, conversationId: busy });
      const { deferred } = await syncing;
      expect(deferred).toBe(true);
      // The reply ends whole, and only then is the model reloaded.
      const from = logged().length;
      while (getRunByConversation(busy)) await new Promise((r) => setTimeout(r, 50));
      const rows = await db.query.messages.findMany({ where: eq(messages.conversationId, busy) });
      expect(rows.filter((r) => r.authorType === "assistant").sort((p, q) => q.lamport - p.lamport)[0].status).toBe("complete");
      expect(mine(from).some((e) => e.event === "unload")).toBe(false);
      const deadline = Date.now() + 30_000;
      while (!logged().slice(from).some((e) => e.event === "unload" && e.model === name) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(logged().slice(from).some((e) => e.event === "unload" && e.model === name)).toBe(true);
      await waitForModelStatus(model, "loaded", 10_000);
    });
  }, 60_000);
});

describe("a deleted conversation and a stopped turn", () => {
  it("deleting a conversation removes its saved cache at once", async () => {
    const c = await conversation();
    await runToEnd(c, "forget me");
    await requestUnload(model, false);
    expect(binFiles().some((f) => f.includes(c))).toBe(true);
    await deleteConversation(c, { warn: () => undefined });
    const deadline = Date.now() + 20_000;
    while (binFiles().some((f) => f.includes(c)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    expect(binFiles().some((f) => f.includes(c))).toBe(false);
    expect(manifestJson()?.entries.some((e) => e.conversationId === c) ?? false).toBe(false);
  });

  it("a Stop ends a restore at once", async () => {
    const c = await conversation();
    await fakeWith({ LOXAIC_FAKE_RESTORE_MS: "6000" }, async () => {
      await runToEnd(c, "stop my restore");
      await requestUnload(model, false);
      const controller = new AbortController();
      const started = Date.now();
      setTimeout(() => { controller.abort(); }, 1500);
      const steps: string[] = [];
      for await (const p of restoreConversation(model, c, controller.signal)) steps.push(p.step);
      expect(Date.now() - started).toBeLessThan(4_000);
      expect(steps.at(-1)).toBe("failed");
    });
  });
});
