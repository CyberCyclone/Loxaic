import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { v4 as uuid } from "uuid";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db, eq } from "@loxaic/db";
import { localModels } from "@loxaic/db/schema";
import { invalidateLocalModelCache } from "../catalog.ts";
import { deviceLostMessage, isDeviceLost, lostDevice } from "../device-lost.ts";
import { __resetRoomForTest, discardLostModel, loadErrorFor } from "../room.ts";
import { __resetRouterForTest, __setHardwareForTest, ensureRuntime, routerModelStatuses, runtimeView } from "../router.ts";
import { routerModelName } from "../preset.ts";
import { streamCompletion } from "../../inference/provider.ts";

/**
 * A GPU reset under a host model is explained, and the model is unloaded so
 * the next request gets a working process.
 *
 * On Pheonix the amdgpu driver reset a card 31 minutes into re-reading a
 * 221K-token conversation; the chat said `vk::Queue::submit: ErrorDeviceLost`,
 * and the model's process stayed up with its device gone until the next
 * request, hours later, crashed it.
 */

const NAME = "unsloth/Qwen3.8-Flash-Next-GGUF@UD-Q4_K_XL";

/** Pheonix's router output for the failure (b11457), with another model's
 * lines interleaved and an earlier load of the same model on another port. */
const PHEONIX = [
  `188.29.897.213 I srv          load: spawning server instance with name=${NAME} on port 41000`,
  "[41000] 0.10.000.000 E ggml_vulkan: device lost on Vulkan3",
  `188.29.897.213 I srv          load: spawning server instance with name=${NAME} on port 44687`,
  "[44687] 31.53.535.133 I slot print_timing: id  3 | task 0 | prompt processing, n_tokens = 206572, progress = 0.93",
  "[38001] 1.00.000.000 E ggml_vulkan: device lost on Vulkan1",
  "[44687] radv/amdgpu: The CS has been cancelled because the context is lost. This context is innocent.",
  "[44687] 31.58.475.088 E ggml_vulkan: device lost on Vulkan2",
  "[44687] 31.58.475.859 E srv  update_slots: decode() failed: vk::Queue::submit: ErrorDeviceLost",
];

describe("a lost GPU, in words", () => {
  it("is recognised in llama.cpp's three ways of saying it, and nothing else", () => {
    expect(isDeviceLost("Inference backend error: decode() failed: vk::Queue::submit: ErrorDeviceLost")).toBe(true);
    expect(isDeviceLost("terminate called after throwing an instance of 'vk::DeviceLostError'")).toBe(true);
    expect(isDeviceLost("ggml_vulkan: device lost on Vulkan2")).toBe(true);
    expect(isDeviceLost("Inference backend error: Context size has been exceeded.")).toBe(false);
    expect(isDeviceLost("the device was lost in the post")).toBe(false);
  });

  it("names the device from the model's newest process, never another model's or an older one's", () => {
    expect(lostDevice(PHEONIX, NAME)).toBe("Vulkan2");
    expect(lostDevice(PHEONIX, "someone/else@Q4_K_M")).toBeNull();
    // A fresh process that has not lost anything says nothing yet.
    expect(lostDevice([...PHEONIX, `spawning server instance with name=${NAME} on port 50000`], NAME)).toBeNull();
  });

  it("stops reading a port once another model is given it, and not before", () => {
    // Ours exited and the router handed its port to another model, whose
    // device then went: not ours to report.
    const reused = [...PHEONIX.slice(0, 4), "spawning server instance with name=someone/else@Q4_K_M on port 44687", "[44687] 2.00.000.000 E ggml_vulkan: device lost on Vulkan3"];
    expect(lostDevice(reused, NAME)).toBeNull();
    // Another model starting on another port does not end ours: several are
    // loaded at once.
    const beside = [...PHEONIX.slice(0, 4), "spawning server instance with name=someone/else@Q4_K_M on port 45000", ...PHEONIX.slice(4)];
    expect(lostDevice(beside, NAME)).toBe("Vulkan2");
  });

  it("says what happened, that the model was unloaded, and what Retry costs", () => {
    expect(deviceLostMessage("Flash-Next", null)).toBe(
      "The GPU stopped responding while Flash-Next was working on this, and the system reset it. " +
        "The model has been unloaded and loads again with your next message, which reads the whole conversation again from the start.",
    );
  });

  it("says when it happened while loading, and promises no unload it did not do", () => {
    const text = deviceLostMessage("Flash-Next", null, { atLoad: true });
    expect(text).toMatch(/^The GPU stopped responding while Flash-Next was loading/);
    expect(text).toContain("It loads again with your next message");
    expect(text).not.toContain("has been unloaded");
  });

  it("stops promising a fresh load once the model would not unload", () => {
    const text = deviceLostMessage("Flash-Next", null, { stuck: true });
    expect(text).toContain("could not be unloaded after an earlier reset");
    expect(text).toContain("an admin restarts llama.cpp in Settings › Host models");
    expect(text).not.toContain("loads again with your next message");
  });

  it("blames a short driver limit without saying the limit, to a reader who may not be an admin", () => {
    const short = deviceLostMessage("Flash-Next", { driver: "amdgpu", computeMs: 2000, source: "default" });
    expect(short).toContain("can need more GPU time than this host's GPU driver allows");
    expect(short).toContain("an admin can see the limit and raise it in Settings › Host models");
    expect(short).not.toMatch(/\d+ (s|ms)\b/);
    for (const limit of [
      { driver: "amdgpu" as const, computeMs: 60_000, source: "set" as const },
      { driver: "amdgpu" as const, computeMs: null, source: "set" as const },
    ]) {
      expect(deviceLostMessage("Flash-Next", limit)).not.toContain("GPU time");
    }
  });
});

describe("a lost GPU, end to end", () => {
  const FAKE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../test-fixtures/fake-llama-server.mjs");
  const dir = mkdtempSync(path.join(os.tmpdir(), "loxaic-device-lost-"));
  const params = mkdtempSync(path.join(os.tmpdir(), "loxaic-amdgpu-"));
  const host = `test-device-lost-${uuid()}`;
  const model = `test/flash-${uuid().slice(0, 8)}:Q4_K_M`;
  // Its file is named so that the fake loses the device during its first load.
  const lostAtLoad = `test/lostload-${uuid().slice(0, 8)}:Q4_K_M`;
  const stuckFile = path.join(dir, "unload-stuck");

  beforeAll(async () => {
    vi.stubEnv("LOXAIC_INSTANCE_ID", host);
    vi.stubEnv("LLAMA_DIR", dir);
    vi.stubEnv("LOXAIC_LLAMA_SERVER_BIN", FAKE);
    vi.stubEnv("LOXAIC_FAKE_DEVICES", "Vulkan0: Fake GPU (24576 MiB, 24000 MiB free)");
    vi.stubEnv("MOCK_INFERENCE", "false");
    vi.stubEnv("LLAMA_MODE", "managed");
    // Stands in for /sys/module/amdgpu/parameters: kernel 7.0's two seconds.
    writeFileSync(path.join(params, "lockup_timeout"), "2000\n");
    // What `modinfo -p amdgpu` says on that kernel: one value is for every job.
    writeFileSync(
      path.join(params, "modinfo"),
      "lockup_timeout:GPU lockup timeout in ms (default: 2000. 0: keep default value. negative: infinity timeout), format: [single value for all] or [GFX,Compute,SDMA,Video]. (string)\n",
    );
    vi.stubEnv("LOXAIC_AMDGPU_PARAMS_DIR", params);
    vi.stubEnv("LOXAIC_FAKE_UNLOAD_STUCK", stuckFile);
    vi.stubEnv("LLAMA_DISCARD_WAIT_MS", "500");
    const row = (id: string, file: string, displayName: string) => ({
      hostId: host,
      id,
      repo: id.split(":")[0],
      revision: "0".repeat(40),
      quant: "Q4_K_M",
      sizeBytes: 1,
      status: "ready" as const,
      enabled: true,
      publisher: "test",
      files: [{ path: file, size: 1, sha256: null }],
      displayName,
    });
    await db.insert(localModels).values(row(lostAtLoad, "LostAtLoad-Q4_K_M.gguf", "Flash Lost"));
    await db.insert(localModels).values({
      hostId: host,
      id: model,
      repo: model.split(":")[0],
      revision: "0".repeat(40),
      quant: "Q4_K_M",
      sizeBytes: 1,
      status: "ready",
      enabled: true,
      publisher: "test",
      files: [{ path: "Flash-Q4_K_M.gguf", size: 1, sha256: null }],
      displayName: "Flash Next",
    });
    invalidateLocalModelCache();
    await __resetRouterForTest();
    __resetRoomForTest();
    __setHardwareForTest({ platform: "linux", arch: "x64", gpus: [], flavour: "vulkan", reason: null, ramBytes: 16 * 1024 ** 3 });
    await ensureRuntime();
  });

  afterAll(async () => {
    await __resetRouterForTest();
    await db.delete(localModels).where(eq(localModels.hostId, host));
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
    rmSync(params, { recursive: true, force: true });
  });

  async function ask(text: string, on = model): Promise<{ reply: string; error: string | null }> {
    let reply = "";
    try {
      for await (const ev of streamCompletion(on, [{ role: "user", content: text }])) {
        if (ev.type === "delta") reply += ev.content;
      }
      return { reply, error: null };
    } catch (err) {
      return { reply, error: err instanceof Error ? err.message : String(err) };
    }
  }

  it("reports the driver's limit on the runtime card", () => {
    expect(runtimeView().gpuJobLimit).toEqual({
      driver: "amdgpu",
      computeMs: 2000,
      source: "set",
      short: true,
      suggestedLockupTimeout: "2000,60000,2000,2000",
    });
  });

  it("explains the loss, unloads the broken process, and answers the next message", async () => {
    const lost = await ask("Please lose the device.");
    expect(lost.error).toContain("The GPU stopped responding while Flash Next was working on this");
    expect(lost.error).toContain("more GPU time than this host's GPU driver allows");
    expect(lost.error).not.toContain("ErrorDeviceLost");
    // The device and the limit are the admin's to see, not every viewer's.
    expect(lost.error).not.toContain("Vulkan0");
    expect(lost.error).not.toContain("2 s");

    // Unloaded in the background, so the person was not kept waiting for it.
    await vi.waitFor(async () => {
      expect((await routerModelStatuses()).get(model)?.value).toBe("unloaded");
    }, { timeout: 10_000 });

    // The fake, like the real child, fails every request until it is
    // unloaded: this is what used to happen next.
    const next = await ask("hi");
    expect(next.error).toBeNull();
    expect(next.reply).toContain(routerModelName(model));
  });

  it("answers a message sent straight after the loss, from a fresh process", async () => {
    const lost = await ask("Please lose the device.");
    expect(lost.error).toContain("The model has been unloaded");
    // No wait: sent while the discard is still under way.
    const next = await ask("hi");
    expect(next.error).toBeNull();
    expect(next.reply).toContain(routerModelName(model));
  });

  it("blames the GPU, not the model's settings, when the device goes while it loads", async () => {
    const lost = await ask("hi", lostAtLoad);
    expect(lost.error).toContain("The GPU stopped responding while Flash Lost was loading");
    expect(lost.error).not.toContain("could not be loaded");
    expect(lost.error).not.toContain("load settings");
    const next = await ask("hi", lostAtLoad);
    expect(next.error).toBeNull();
    expect(next.reply).toContain(routerModelName(lostAtLoad));
  });

  it("says so on the model's row, and stops promising a fresh load, when the unload does not take", async () => {
    writeFileSync(stuckFile, "");
    try {
      const lost = await ask("Please lose the device.");
      expect(lost.error).toContain("The model has been unloaded");

      // Sent at once, while the unload is still being waited on: it waits for
      // the verdict rather than reaching the dead process and being promised
      // a fresh load again, and is told what will get it out.
      const again = await ask("hi");
      expect(again.error).toContain("could not be unloaded after an earlier reset");
      expect(again.error).not.toContain("loads again with your next message");
      expect(loadErrorFor(model, "loaded")).toContain("its process could not be unloaded");
      expect(loadErrorFor(model, "loaded")).toContain("Vulkan0");
      // That failure tried the unload again; let it finish failing (a second
      // call joins the one running rather than starting another).
      await discardLostModel(model);
      expect(loadErrorFor(model, "loaded")).toContain("its process could not be unloaded");
    } finally {
      rmSync(stuckFile, { force: true });
    }
    // Every failure on the dead process tries the unload again; once one takes
    // (here, the process lets go), the row clears and the next message answers.
    await ask("hi");
    await vi.waitFor(async () => {
      const status = (await routerModelStatuses()).get(model)?.value ?? null;
      expect(status).toBe("unloaded");
      expect(loadErrorFor(model, status)).toBeNull();
    }, { timeout: 10_000 });
    const next = await ask("hi");
    expect(next.error).toBeNull();
  });
});
