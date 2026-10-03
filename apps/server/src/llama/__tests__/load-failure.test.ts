import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { v4 as uuid } from "uuid";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db, eq } from "@loxaic/db";
import { localModels } from "@loxaic/db/schema";
import { invalidateLocalModelCache } from "../catalog.ts";
import { isLoadFailure, loadFailureMessage } from "../load-failure.ts";
import { __resetRoomForTest } from "../room.ts";
import { __resetRouterForTest, __setHardwareForTest, ensureRuntime, explainModelLoadFailure } from "../router.ts";
import { streamCompletion } from "../../inference/provider.ts";

/**
 * A host model llama.cpp could not load says why, and what to change.
 *
 * Nothing refuses a combination ahead of time — a patched llama.cpp may run
 * what the bundled one cannot — so the failure itself has to be readable. The
 * router answers only `model name=… failed to load`; the cause is in the
 * model's own output, which the router forwards as `[    P] line`.
 */

const NAME = "unsloth/Qwen3.8-Flash-Next-GGUF@UD-IQ4_XS";

/** The shape of Pheonix's router output when Flash-Next died loading with
 * unsloth's MTP head (b11342), with another model's lines interleaved. */
const PHEONIX = [
  "0.03.068.282 I srv  llama_server: starting server in router mode",
  `0.10.001.000 I srv    operator(): spawning server instance with name=${NAME} on port 51234`,
  "[51234] 0.28.431.536 I common_speculative_init_result: loading draft model '/home/cgibson/mtp-bench/mtp-Qwen3.8-Flash-Next-Q8_0.gguf'",
  "[38001] 1.00.000.000 E slot  other model: an error that is not ours",
  "[51234] 0.33.703.461 I spec common_specu: adding speculative implementation 'draft-mtp'",
  "[51234] /home/runner/work/llama.cpp/llama.cpp/ggml/src/ggml-backend.cpp:205: GGML_ASSERT(buffer) failed",
  "[51234] ⚠️ warning: 49	./nptl/cancellation.c: No such file or directory",
  "[51234] #5  0x00007bed0de6f0e2 in ggml_abort () from /home/cgibson/.config/Loxaic Beta/llama/runtime/libggml-base.so.0",
  "[51234] [Inferior 1 (process 360727) detached]",
  `0.34.000.000 I srv    operator(): instance name=${NAME} exited with status 134`,
];

describe("why a model failed to load", () => {
  it("quotes the model's own assertion, without paths, backtrace frames or another model's errors", () => {
    expect(explainModelLoadFailure(PHEONIX, NAME)).toBe("ggml-backend.cpp:205: GGML_ASSERT(buffer) failed");
  });

  it("reads only the newest load of that model, on its own port", () => {
    const again = [...PHEONIX, `0.40.000.000 I srv    operator(): spawning server instance with name=${NAME} on port 51300`, "[51300] 0.40.100.000 E llama_model_load: error loading model: tensor 'blk.0.attn_q.weight' not found"];
    expect(explainModelLoadFailure(again, NAME)).toBe("error loading model: tensor 'blk.0.attn_q.weight' not found");
    // A port padded to five characters, as the router prints a short one.
    expect(explainModelLoadFailure([`spawning server instance with name=${NAME} on port 8080`, "[ 8080] 0.1 E srv  load: failed to open file"], NAME)).toBe(
      "load: failed to open file",
    );
  });

  it("says nothing it cannot back: no spawn seen, or nothing that reads as an error", () => {
    expect(explainModelLoadFailure(PHEONIX, "someone/else@Q4_K_M")).toBeNull();
    expect(explainModelLoadFailure([`spawning server instance with name=${NAME} on port 51234`, "[51234] 0.1 I all is well"], NAME)).toBeNull();
  });

  const row = (over: Record<string, unknown>) =>
    ({ displayName: "Flash-Next", meta: {}, mtpHead: null, loadSettings: {}, contextStages: null, activeStage: 0, ...over }) as never;

  it("names multi-token prediction, and where to turn it off, when the model loads with it", () => {
    const own = loadFailureMessage(row({ loadSettings: { mtp: true }, meta: { mtp: { layers: 1 } } }), "GGML_ASSERT(buffer) failed");
    expect(own).toBe(
      "Flash-Next could not be loaded: llama.cpp stopped while loading it (GGML_ASSERT(buffer) failed). It loads with multi-token prediction on, which this llama.cpp may not support for this model. An admin can turn multi-token prediction off in Settings › Host models › Flash-Next.",
    );
    const head = { path: "MTP/mtp-Qwen3.8-Flash-Next-Q8_0.gguf", size: 1, sha256: null, revision: "a".repeat(40), status: "ready", bytesDone: 1, error: null, layers: 1 };
    expect(loadFailureMessage(row({ loadSettings: { mtp: true }, mtpHead: head }), null)).toContain(
      "could not be loaded: llama.cpp stopped while loading it. It loads with multi-token prediction on, drafting with mtp-Qwen3.8-Flash-Next-Q8_0.gguf,",
    );
  });

  it("does not blame MTP when the load did not use it", () => {
    // On, but its head still downloading: nothing was written, so not the cause.
    const pending = { path: "MTP/x.gguf", size: 1, sha256: null, revision: "a".repeat(40), status: "downloading", bytesDone: 0, error: null, layers: null };
    for (const r of [row({}), row({ loadSettings: { mtp: true }, mtpHead: pending })]) {
      const text = loadFailureMessage(r, "out of memory");
      expect(text).not.toContain("multi-token");
      expect(text).toContain("An admin can check its load settings");
    }
    expect(isLoadFailure("model name=a/b@Q4 failed to load")).toBe(true);
    expect(isLoadFailure('Model server error 500: {"error":{"code":500,"message":"model name=a/b@Q4 failed to load"}}')).toBe(true);
    expect(isLoadFailure("Could not reach the model server")).toBe(false);
    // b11342's other "failed to load": a request's image or audio it could not
    // decode, from a model that is loaded and fine. Calling that a failed load
    // would blame the model's settings for a bad attachment.
    expect(isLoadFailure('Model server error 500: {"error":{"code":500,"message":"Failed to load image or audio file"}}')).toBe(false);
  });
});

describe("a load that fails, end to end", () => {
  const FAKE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../test-fixtures/fake-llama-server.mjs");
  const dir = mkdtempSync(path.join(os.tmpdir(), "loxaic-load-failure-"));
  const host = `test-load-failure-${uuid()}`;
  const crashy = `test/crashy-${uuid().slice(0, 8)}:Q4_K_M`;
  const base = {
    hostId: host,
    revision: "0".repeat(40),
    quant: "Q4_K_M",
    sizeBytes: 1,
    status: "ready" as const,
    enabled: true,
    publisher: "test",
  };

  beforeAll(async () => {
    vi.stubEnv("LOXAIC_INSTANCE_ID", host);
    vi.stubEnv("LLAMA_DIR", dir);
    vi.stubEnv("LOXAIC_LLAMA_SERVER_BIN", FAKE);
    vi.stubEnv("LOXAIC_FAKE_DEVICES", "FAKE0: Fake GPU (24576 MiB, 24000 MiB free)");
    vi.stubEnv("MOCK_INFERENCE", "false");
    vi.stubEnv("LLAMA_MODE", "managed");
    // The fake fails a load with MTP on for a model file named "Crashy", the
    // way b11342 fails Qwen3.8-Flash-Next with unsloth's head.
    await db.insert(localModels).values({
      ...base,
      id: crashy,
      repo: crashy.split(":")[0],
      files: [{ path: "Crashy-Q4_K_M.gguf", size: 1, sha256: null }],
      displayName: "Crashy Next",
      meta: { mtp: { layers: 1 } },
      loadSettings: { mtp: true },
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
  });

  it("tells the person in the chat what stopped it, and that MTP is the setting to change", async () => {
    let message = "";
    try {
      for await (const ev of streamCompletion(crashy, [{ role: "user", content: "hi" }])) void ev;
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("Crashy Next could not be loaded: llama.cpp stopped while loading it (ggml-backend.cpp:205: GGML_ASSERT(buffer) failed).");
    expect(message).toContain("turn multi-token prediction off in Settings › Host models › Crashy Next");
    expect(message).not.toContain("/home/runner");
  });
});
