import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { v4 as uuid } from "uuid";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, eq } from "@loxaic/db";
import { localModels } from "@loxaic/db/schema";
import { invalidateLocalModelCache } from "../catalog.ts";
import {
  __resetRouterForTest,
  __routerPidForTest,
  __setHardwareForTest,
  ensureRuntime,
  routerEndpoint,
  runtimeView,
  syncPreset,
} from "../router.ts";
import { presetPath } from "../paths.ts";
import { __resetModelCachesForTest, listBackendModels, modelRunInfo } from "../../inference/models.ts";
import { ModelRefError, resolveModelRef } from "../../inference/providers.ts";
import { streamCompletion } from "../../inference/provider.ts";

/**
 * The managed runtime end to end, against a fake `llama-server` that speaks
 * the router API (test-fixtures/fake-llama-server.mjs): start, list, stream,
 * enabled-is-a-server-side-gate, settings reaching the model on its next load,
 * crash recovery, and the two ways a machine with no usable GPU must *not*
 * quietly end up on the CPU.
 *
 * Rows are scoped by a per-suite `LOXAIC_INSTANCE_ID`, which is what
 * `local_models.host_id` keys on — the database is shared with every other
 * suite, and an enabled model here must not appear in theirs.
 */

const FAKE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../test-fixtures/fake-llama-server.mjs");
const dir = mkdtempSync(path.join(os.tmpdir(), "loxaic-router-"));
const host = `test-router-${uuid()}`;
const servable = `test/servable-${uuid().slice(0, 8)}:Q4_K_M`;
const disabled = `test/disabled-${uuid().slice(0, 8)}:Q4_K_M`;
const loadLog = path.join(dir, "loads.jsonl");

const HW_GPU = { platform: "linux" as const, arch: "x64", gpus: [], flavour: "vulkan" as const, reason: null, ramBytes: 16 * 1024 ** 3 };

function row(id: string, enabled: boolean) {
  return {
    id,
    hostId: host,
    repo: id.split(":")[0],
    revision: "0".repeat(40),
    quant: "Q4_K_M",
    files: [{ path: "m.gguf", size: 1, sha256: null }],
    sizeBytes: 1,
    status: "ready" as const,
    enabled,
    displayName: id,
    publisher: "test",
  };
}

async function collect(ref: string): Promise<string> {
  let text = "";
  for await (const ev of streamCompletion(ref, [{ role: "user", content: "hi" }])) {
    if (ev.type === "delta") text += ev.content;
  }
  return text;
}

async function waitFor(pred: () => boolean, ms = 10_000): Promise<void> {
  const until = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

beforeAll(async () => {
  vi.stubEnv("LOXAIC_INSTANCE_ID", host);
  vi.stubEnv("LLAMA_DIR", dir);
  vi.stubEnv("LOXAIC_LLAMA_SERVER_BIN", FAKE);
  vi.stubEnv("LOXAIC_FAKE_ROUTER_LOG", loadLog);
  vi.stubEnv("MOCK_INFERENCE", "false");
  vi.stubEnv("LLAMA_MODE", "managed");
  await db.insert(localModels).values([row(servable, true), row(disabled, false)]);
  invalidateLocalModelCache();
});

afterAll(async () => {
  await __resetRouterForTest();
  await db.delete(localModels).where(eq(localModels.hostId, host));
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  __resetModelCachesForTest();
  invalidateLocalModelCache();
});

describe("managed runtime", () => {
  it("starts the router and serves only enabled models", async () => {
    await __resetRouterForTest();
    __setHardwareForTest(HW_GPU);
    await ensureRuntime();
    expect(runtimeView().state).toBe("running");
    expect(routerEndpoint()?.apiKey).toMatch(/^[0-9a-f]{48}$/);

    const models = await listBackendModels();
    const ids = models.map((m) => m.id);
    expect(ids).toContain(servable);
    expect(ids).not.toContain(disabled);
    // The preset carries only the servable model, and the default device set.
    const preset = readFileSync(presetPath(), "utf8");
    expect(preset).toContain(`[${servable}]`);
    expect(preset).not.toContain(disabled);
    expect(preset).toContain("device = FAKE0");
  });

  it("streams through the router, with the random key it was started with", async () => {
    expect(await collect(servable)).toBe(`Hello from ${servable}`);
    const info = await modelRunInfo(servable);
    // The first request loaded it; the listing now reports its allocated window.
    __resetModelCachesForTest();
    expect((await modelRunInfo(servable))?.loaded).toBe(true);
    expect(info?.nativeRuntime).toBe(true);
  });

  it("refuses a model that is downloaded but not enabled — at send time, not just in the picker", async () => {
    await expect(resolveModelRef(disabled)).rejects.toMatchObject({ code: "local_model_unavailable" });
    await expect(resolveModelRef("not/a-model:Q4")).rejects.toBeInstanceOf(ModelRefError);
  });

  it("resolves the no-model-named sentinel to a servable model instead of sending it to the router", async () => {
    const { upstreamModel } = await resolveModelRef("default");
    expect(upstreamModel).toBe(servable);
  });

  it("new load settings reach the model on its next load", async () => {
    await db.update(localModels).set({ loadSettings: { ctxSize: 2048, parallel: 2, kvUnified: false } }).where(eq(localModels.id, servable));
    invalidateLocalModelCache();
    const { deferred } = await syncPreset();
    expect(deferred).toBe(false);
    await collect(servable);
    const loads = readFileSync(loadLog, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { model: string; section: Record<string, string> });
    const last = loads.filter((l) => l.model === servable).at(-1);
    expect(last?.section["ctx-size"]).toBe("2048");
    expect(last?.section.parallel).toBe("2");
    // And the window reported to clients is per slot.
    __resetModelCachesForTest();
    expect((await modelRunInfo(servable))?.windowTokens).toBe(1024);
  });

  it("restarts a router that dies", async () => {
    const before = __routerPidForTest();
    if (before === null) throw new Error("expected a live router");
    process.kill(before, "SIGKILL");
    await waitFor(() => runtimeView().state !== "running");
    await waitFor(() => runtimeView().state === "running" && __routerPidForTest() !== before, 15_000);
    expect(await collect(servable)).toContain("Hello");
  });
});

describe("never silently on the CPU", () => {
  it("no GPU: needs-gpu, no router, and a request says why", async () => {
    await __resetRouterForTest();
    __setHardwareForTest({ ...HW_GPU, flavour: null, reason: "No GPU was found on this machine." });
    await ensureRuntime();
    const view = runtimeView();
    expect(view.state).toBe("needs-gpu");
    expect(view.reason).toBe("No GPU was found on this machine.");
    expect(routerEndpoint()).toBeNull();
    await expect(collect(servable)).rejects.toThrow(/isn't running/);
  });

  it("a GPU build that finds no GPU is an error, not a CPU fallback", async () => {
    await __resetRouterForTest();
    __setHardwareForTest(HW_GPU);
    vi.stubEnv("LOXAIC_FAKE_DEVICES", ";");
    try {
      await ensureRuntime();
      expect(runtimeView().state).toBe("error");
      expect(runtimeView().reason).toMatch(/found no GPU/);
    } finally {
      vi.stubEnv("LOXAIC_FAKE_DEVICES", "");
    }
  });

  it("leaves a small display card out of the default device set", async () => {
    await __resetRouterForTest();
    __setHardwareForTest(HW_GPU);
    vi.stubEnv(
      "LOXAIC_FAKE_DEVICES",
      "Vulkan0: NVIDIA GeForce GT 1030 (2048 MiB, 1900 MiB free);Vulkan1: AMD Radeon Pro V620 (30720 MiB, 30000 MiB free)",
    );
    try {
      await ensureRuntime();
      expect(runtimeView().activeDevices).toEqual(["Vulkan1"]);
      expect(readFileSync(presetPath(), "utf8")).toContain("device = Vulkan1\n");
    } finally {
      vi.stubEnv("LOXAIC_FAKE_DEVICES", "");
    }
  });
});
