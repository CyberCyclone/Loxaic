import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { v4 as uuid } from "uuid";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, eq } from "@loxaic/db";
import { localModels } from "@loxaic/db/schema";
import type { ContextStageStatus } from "@loxaic/types";
import { __resetSchedulerForTest, acquireRunSlot, resetSlotProbe } from "../../inference/scheduler.ts";
import { __resetModelCachesForTest, listBackendModels } from "../../inference/models.ts";
import { registerRun, unregisterRun } from "../../streams/registry.ts";
import { getLocalModelRow, invalidateLocalModelCache } from "../catalog.ts";
import { __resetStageSwitchForTest, applyStageChange, pendingStage, withdrawStageChange } from "../context-stage-switch.ts";
import { presetPath } from "../paths.ts";
import { routerModelName } from "../preset.ts";
import { __resetRoomForTest } from "../room.ts";
import { __resetRouterForTest, __setHardwareForTest, ensureRuntime, routerModelStatuses, syncPreset } from "../router.ts";

/**
 * A context-stage switch end to end against the fake router: it waits for
 * the reply in progress, lets nothing start behind it, reloads the model with
 * the stage's YaRN keys, and can be withdrawn before it applies. A load that
 * fails puts the model back at the stage it had.
 */

const FAKE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../test-fixtures/fake-llama-server.mjs");
const dir = mkdtempSync(path.join(os.tmpdir(), "loxaic-stage-switch-"));
const host = `test-stage-switch-${uuid()}`;
const model = `test/staged-${uuid().slice(0, 8)}:Q4_K_M`;
const loadLog = path.join(dir, "loads.jsonl");
const HW_GPU = { platform: "linux" as const, arch: "x64", gpus: [], flavour: "vulkan" as const, reason: null, ramBytes: 16 * 1024 ** 3 };
const live = () => new AbortController().signal;
const noop = () => undefined;

function loads(): { event: string; model: string; section?: Record<string, string> }[] {
  if (!existsSync(loadLog)) return [];
  return readFileSync(loadLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as never);
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
  // Without a GPU the runtime re-detects, finds none in a container, and
  // `routerEndpoint()` is null — the "load fails, stage reverts" case then
  // passes by never loading. The suite pins its own hardware.
  vi.stubEnv("LOXAIC_FAKE_HARDWARE", "gpu");
  vi.stubEnv("LOXAIC_FAKE_DEVICES", "FAKE0: Fake GPU (24576 MiB, 24000 MiB free)");
  vi.stubEnv("MOCK_INFERENCE", "false");
  vi.stubEnv("LLAMA_MODE", "managed");
  vi.stubEnv("INFERENCE_MAX_CONCURRENT_RUNS", "1");
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
    displayName: "Staged",
    publisher: "test",
    meta: { nCtxTrain: 8192, nLayers: 28 },
    loadSettings: { ctxSize: 8192 },
    contextStages: { enabled: true, stages: [{ ctxSize: 16384 }, { ctxSize: 32768, cacheTypeK: "q8_0", cacheTypeV: "q8_0" }] },
  });
  invalidateLocalModelCache();
  await __resetRouterForTest();
  __resetRoomForTest();
  __setHardwareForTest(HW_GPU);
  await ensureRuntime();
});

afterAll(async () => {
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

describe("a context-stage switch", () => {
  it("waits for the reply in progress, holds everyone behind it, then reloads with YaRN", async () => {
    // A reply on this model is running.
    const reply = await acquireRunSlot({ signal: live(), onQueued: noop });
    const conv = uuid();
    registerRun({ streamId: uuid(), conversationId: conv, userId: "u", abort: new AbortController(), approvals: new Map(), model });

    const steps: ContextStageStatus[] = [];
    const switching = applyStageChange({
      modelId: model,
      target: 1,
      reason: "chosen",
      auto: false,
      byUserId: "someone",
      conversationId: uuid(),
      signal: live(),
      emit: (s) => steps.push(s),
    });
    // Once the switch is in line, a new run arriving must not overtake it.
    for (let i = 0; i < 100 && !steps.some((s) => s.step === "waiting"); i++) await new Promise((r) => setTimeout(r, 10));
    let laterAdmitted = false;
    const later = acquireRunSlot({ signal: live(), onQueued: noop }).then((s) => { laterAdmitted = true; return s; });
    await new Promise((r) => setTimeout(r, 150));

    expect(pendingStage(model)).toBe(1);
    expect(steps.at(-1)).toMatchObject({ step: "waiting", position: 1, running: 1, from_stage: 0, to_stage: 1, to_tokens: 16384, yarn_factor: 2 });
    expect(await activeStage()).toBe(0);
    expect(laterAdmitted).toBe(false);

    reply?.release();
    for (const s of [conv]) unregisterRun(s);
    expect(await switching).toEqual({ kind: "applied", stage: 1 });
    // "waiting" is re-sent as the line moves; the steps themselves, in order:
    expect(steps.map((s) => s.step).filter((s, i, all) => s !== all[i - 1])).toEqual(["waiting", "reloading", "applied"]);
    expect(await activeStage()).toBe(1);
    expect(pendingStage(model)).toBeNull();

    const load = loads().filter((e) => e.event === "load" && e.model === routerModelName(model)).at(-1);
    expect(load?.section).toMatchObject({ "ctx-size": "16384", "rope-scaling": "yarn", "rope-scale": "2", "yarn-orig-ctx": "8192" });
    expect((await routerModelStatuses()).get(model)?.value).toBe("loaded");

    // The run that queued behind the switch runs now, at the new stage.
    (await later)?.release();
    expect(laterAdmitted).toBe(true);
  });

  it("reports the stage in the model list — its window, and the largest", async () => {
    const info = (await listBackendModels()).find((m) => m.id === model);
    expect(info?.context_stage).toMatchObject({ active: 1, windows: [8192, 16384, 32768], pending: null, who_may_change: "everyone", when_full: "compact" });
    expect(info?.max_context_tokens).toBe(32768);
  });

  it("can be withdrawn before it applies, leaving the stage as it was", async () => {
    const reply = await acquireRunSlot({ signal: live(), onQueued: noop });
    const switching = applyStageChange({ modelId: model, target: 2, reason: "chosen", auto: false, byUserId: "someone", signal: live() });
    for (let i = 0; i < 100 && pendingStage(model) === null; i++) await new Promise((r) => setTimeout(r, 10));
    expect(withdrawStageChange(model)).toBe(true);
    expect(await switching).toEqual({ kind: "cancelled" });
    reply?.release();
    expect(await activeStage()).toBe(1);
    expect(pendingStage(model)).toBeNull();
  });

  it("steps back down to standard, writing no YaRN keys", async () => {
    expect(await applyStageChange({ modelId: model, target: 0, reason: "new-conversation", auto: true, byUserId: null, signal: live() })).toEqual({
      kind: "applied",
      stage: 0,
    });
    const load = loads().filter((e) => e.event === "load" && e.model === routerModelName(model)).at(-1);
    expect(load?.section?.["ctx-size"]).toBe("8192");
    expect(load?.section).not.toHaveProperty("rope-scaling");
  });

  it("puts the stage back when it is cancelled after being written, so `cancelled` means nothing changed", async () => {
    // A load that takes a moment, so there is a window to stop it in.
    vi.stubEnv("LOXAIC_FAKE_LOAD_MS", "3000");
    await __resetRouterForTest();
    await ensureRuntime();
    expect(await activeStage()).toBe(0);

    const stop = new AbortController();
    const steps: ContextStageStatus[] = [];
    const switching = applyStageChange({
      modelId: model,
      target: 1,
      reason: "chosen",
      auto: false,
      byUserId: "someone",
      signal: stop.signal,
      emit: (s) => steps.push(s),
    });
    // "reloading" is emitted just before the row is written; give the write
    // and the first poll of the load a moment, then cancel mid-load.
    for (let i = 0; i < 200 && !steps.some((s) => s.step === "reloading"); i++) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 400));
    expect(await activeStage()).toBe(1); // written, and the load is in flight
    stop.abort();

    expect(await switching).toEqual({ kind: "cancelled" });
    // The row is back where it was, and so is the preset the router reads.
    expect(await activeStage()).toBe(0);
    const info = (await listBackendModels()).find((m) => m.id === model);
    expect(info?.context_stage).toMatchObject({ active: 0, pending: null });
    vi.stubEnv("LOXAIC_FAKE_LOAD_MS", "");
  });

  it("keeps writing the stage's YaRN keys when the preset is rewritten for something unrelated", async () => {
    // What an admin changing `threads`, or the runtime starting, does: rewrite
    // the preset with no stage run involved. The section must still carry the
    // stage, or the router would load the model at standard behind everyone.
    expect(await applyStageChange({ modelId: model, target: 1, reason: "chosen", auto: false, byUserId: "x", signal: live() })).toEqual({ kind: "applied", stage: 1 });
    await db.update(localModels).set({ loadSettings: { ctxSize: 8192, threads: 4 } }).where(eq(localModels.id, model));
    invalidateLocalModelCache();
    await syncPreset();
    const text = readFileSync(presetPath(), "utf8");
    const section = text.slice(text.indexOf(`[${routerModelName(model)}]`)).split(/\n\[/)[0];
    expect(section).toMatch(/threads = 4/);
    expect(section).toMatch(/ctx-size = 16384/);
    expect(section).toMatch(/rope-scaling = yarn/);
    expect(section).toMatch(/rope-scale = 2/);
    expect(section).toMatch(/yarn-orig-ctx = 8192/);

    // Put it back for the cases below.
    await db.update(localModels).set({ loadSettings: { ctxSize: 8192 } }).where(eq(localModels.id, model));
    invalidateLocalModelCache();
    expect(await applyStageChange({ modelId: model, target: 0, reason: "chosen", auto: false, byUserId: "x", signal: live() })).toEqual({ kind: "applied", stage: 0 });
  });

  it("puts the model back at the stage it had when the load fails", async () => {
    // Every load fails from here: each model now needs more than the GPU has.
    vi.stubEnv("LOXAIC_FAKE_MODEL_MIB", "999999");
    vi.stubEnv("LOXAIC_FAKE_VRAM_STATE", path.join(dir, "vram.json"));
    await __resetRouterForTest();
    await ensureRuntime();
    const steps: ContextStageStatus[] = [];
    const outcome = await applyStageChange({ modelId: model, target: 2, reason: "full", auto: true, byUserId: null, signal: live(), emit: (s) => steps.push(s) });
    expect(outcome.kind).toBe("failed");
    expect(steps.at(-1)).toMatchObject({ step: "failed", message: expect.stringMatching(/back at 8K/) as string });
    expect(await activeStage()).toBe(0);
  });
});
