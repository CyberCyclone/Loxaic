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
import { __resetRoomForTest } from "../room.ts";
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

  it("says what happened, that the model was unloaded, and what Retry costs", () => {
    expect(deviceLostMessage("Flash-Next", "Vulkan2", null)).toBe(
      "The GPU (Vulkan2) stopped responding while Flash-Next was working on this, and the system reset it. " +
        "The model has been unloaded and loads again with your next message, which reads the whole conversation again from the start.",
    );
    expect(deviceLostMessage("Flash-Next", null, null)).toMatch(/^The GPU stopped responding/);
  });

  it("blames the driver's limit only when it is short enough to be the cause", () => {
    const short = deviceLostMessage("Flash-Next", "Vulkan2", { driver: "amdgpu", computeMs: 2000, source: "default" });
    expect(short).toContain("resets any GPU job that runs longer than 2 s");
    expect(short).toContain("Settings › Host models says how");
    for (const limit of [
      { driver: "amdgpu" as const, computeMs: 60_000, source: "set" as const },
      { driver: "amdgpu" as const, computeMs: null, source: "set" as const },
    ]) {
      expect(deviceLostMessage("Flash-Next", "Vulkan2", limit)).not.toContain("resets any GPU job");
    }
  });
});

describe("a lost GPU, end to end", () => {
  const FAKE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../test-fixtures/fake-llama-server.mjs");
  const dir = mkdtempSync(path.join(os.tmpdir(), "loxaic-device-lost-"));
  const params = mkdtempSync(path.join(os.tmpdir(), "loxaic-amdgpu-"));
  const host = `test-device-lost-${uuid()}`;
  const model = `test/flash-${uuid().slice(0, 8)}:Q4_K_M`;

  beforeAll(async () => {
    vi.stubEnv("LOXAIC_INSTANCE_ID", host);
    vi.stubEnv("LLAMA_DIR", dir);
    vi.stubEnv("LOXAIC_LLAMA_SERVER_BIN", FAKE);
    vi.stubEnv("LOXAIC_FAKE_DEVICES", "Vulkan0: Fake GPU (24576 MiB, 24000 MiB free)");
    vi.stubEnv("MOCK_INFERENCE", "false");
    vi.stubEnv("LLAMA_MODE", "managed");
    // Stands in for /sys/module/amdgpu/parameters: kernel 7.0's two seconds.
    writeFileSync(path.join(params, "lockup_timeout"), "2000\n");
    vi.stubEnv("LOXAIC_AMDGPU_PARAMS_DIR", params);
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

  async function ask(text: string): Promise<{ reply: string; error: string | null }> {
    let reply = "";
    try {
      for await (const ev of streamCompletion(model, [{ role: "user", content: text }])) {
        if (ev.type === "delta") reply += ev.content;
      }
      return { reply, error: null };
    } catch (err) {
      return { reply, error: err instanceof Error ? err.message : String(err) };
    }
  }

  it("reports the driver's limit on the runtime card", () => {
    expect(runtimeView().gpuJobLimit).toEqual({ driver: "amdgpu", computeMs: 2000, source: "set" });
  });

  it("explains the loss, unloads the broken process, and answers the next message", async () => {
    const lost = await ask("Please lose the device.");
    expect(lost.error).toContain("The GPU (Vulkan0) stopped responding while Flash Next was working on this");
    expect(lost.error).toContain("longer than 2 s");
    expect(lost.error).not.toContain("ErrorDeviceLost");

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
});
