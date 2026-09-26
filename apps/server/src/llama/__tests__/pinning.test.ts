import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import Fastify from "fastify";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { v4 as uuid } from "uuid";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, eq } from "@loxaic/db";
import { localModels } from "@loxaic/db/schema";
import { invalidateLocalModelCache } from "../catalog.ts";
import { __resetRoomForTest, NoRoomError } from "../room.ts";
import {
  __resetRouterForTest,
  __routerPidForTest,
  __setHardwareForTest,
  ensureRuntime,
  remeasureDevices,
  routerModelStatuses,
  runtimeView,
} from "../router.ts";
import { routerModelName } from "../preset.ts";
import { __resetModelCachesForTest, listBackendModels } from "../../inference/models.ts";
import { assertModelUsable, ModelRefError } from "../../inference/providers.ts";
import { streamCompletion } from "../../inference/provider.ts";

vi.mock("../../auth/middleware", () => ({
  authenticate: () => Promise.resolve("admin-pinning-test"),
  requireAdmin: () => Promise.resolve("admin-pinning-test"),
}));
const { adminLocalModelRoutes } = await import("../../routes/admin-local-models.ts");
const app = Fastify();
adminLocalModelRoutes(app);

/**
 * Pinning and making room, end to end against the fake router with a memory
 * budget: one 24 GB fake GPU on which each loaded model holds 23.5 GB, so two
 * models never fit together. Loxaic, not llama.cpp, decides what is unloaded
 * (the router runs with `--models-max 0`):
 *
 * - an unpinned model is unloaded to make room for another;
 * - a pinned one is not, and a model that needs its room is refused with the
 *   no-room error the client shows as a modal — at send time, before any row;
 * - a pinned model is loaded when pinned and again after a restart;
 * - free memory is re-measured rather than read from the router's start.
 */

const FAKE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../test-fixtures/fake-llama-server.mjs");
const dir = mkdtempSync(path.join(os.tmpdir(), "loxaic-pinning-"));
const host = `test-pinning-${uuid()}`;
const a = `test/a-${uuid().slice(0, 8)}:Q4_K_M`;
const b = `test/b-${uuid().slice(0, 8)}:Q4_K_M`;
const disabled = `test/off-${uuid().slice(0, 8)}:Q4_K_M`;
const loadLog = path.join(dir, "loads.jsonl");
const MiB = 1024 ** 2;

const HW_GPU = { platform: "linux" as const, arch: "x64", gpus: [], flavour: "vulkan" as const, reason: null, ramBytes: 16 * 1024 ** 3 };

function row(id: string, name: string, enabled: boolean, createdAt: Date) {
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
    displayName: name,
    publisher: "test",
    createdAt,
  };
}

async function collect(ref: string): Promise<string> {
  let text = "";
  for await (const ev of streamCompletion(ref, [{ role: "user", content: "hi" }])) {
    if (ev.type === "delta") text += ev.content;
  }
  return text;
}

async function statusOf(id: string): Promise<string> {
  return (await routerModelStatuses()).get(id)?.value ?? "unloaded";
}

async function waitForStatus(id: string, want: string, ms = 15_000): Promise<void> {
  const until = Date.now() + ms;
  while ((await statusOf(id)) !== want) {
    if (Date.now() > until) throw new Error(`${id} never became ${want} (is ${await statusOf(id)})`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

function events(): { event: string; model: string }[] {
  if (!existsSync(loadLog)) return [];
  return readFileSync(loadLog, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { event: string; model: string });
}

async function patchModel(body: Record<string, unknown>) {
  const res = await app.inject({ method: "PATCH", url: "/v1/admin/local-models/model", payload: body });
  return { status: res.statusCode, body: res.json<Record<string, unknown>>() };
}

beforeAll(async () => {
  await app.ready();
  vi.stubEnv("LOXAIC_INSTANCE_ID", host);
  vi.stubEnv("LLAMA_DIR", dir);
  vi.stubEnv("LOXAIC_LLAMA_SERVER_BIN", FAKE);
  vi.stubEnv("LOXAIC_FAKE_ROUTER_LOG", loadLog);
  vi.stubEnv("LOXAIC_FAKE_DEVICES", "FAKE0: Fake GPU (24576 MiB, 24000 MiB free)");
  vi.stubEnv("LOXAIC_FAKE_MODEL_MIB", "23500");
  vi.stubEnv("LOXAIC_FAKE_VRAM_STATE", path.join(dir, "vram.json"));
  vi.stubEnv("MOCK_INFERENCE", "false");
  vi.stubEnv("LLAMA_MODE", "managed");
  await db.insert(localModels).values([
    row(a, "Model A", true, new Date(1_000)),
    row(b, "Model B", true, new Date(2_000)),
    row(disabled, "Model Off", false, new Date(3_000)),
  ]);
  invalidateLocalModelCache();
  await __resetRouterForTest();
  __resetRoomForTest();
  __setHardwareForTest(HW_GPU);
  await ensureRuntime();
});

afterAll(async () => {
  await app.close();
  await __resetRouterForTest();
  await db.delete(localModels).where(eq(localModels.hostId, host));
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  __resetModelCachesForTest();
  invalidateLocalModelCache();
});

describe("making room", () => {
  it("runs the router with no count limit of its own", () => {
    expect(runtimeView().state).toBe("running");
  });

  it("unloads an unpinned model when another needs its room", async () => {
    expect(await collect(a)).toBe(`Hello from ${routerModelName(a)}`);
    expect(await statusOf(a)).toBe("loaded");

    expect(await collect(b)).toBe(`Hello from ${routerModelName(b)}`);
    expect(await statusOf(a)).toBe("unloaded");
    expect(await statusOf(b)).toBe("loaded");
    // Unloaded by us, before B was asked for — not a failed load of B.
    const log = events();
    const unloadA = log.findIndex((e) => e.event === "unload" && e.model === routerModelName(a));
    const loadB = log.findIndex((e) => e.event === "load" && e.model === routerModelName(b));
    expect(unloadA).toBeGreaterThanOrEqual(0);
    expect(unloadA).toBeLessThan(loadB);
    expect(log.some((e) => e.event === "load-failed")).toBe(false);
  });

  it("measures free memory now, not as it was when the router started", async () => {
    await remeasureDevices({ force: true });
    const fake = runtimeView().devices.find((d) => d.name === "FAKE0");
    // B holds 23,500 of the 24,000 MiB that were free at start.
    expect(fake?.freeBytes).toBe(500 * MiB);
  });
});

describe("pinning", () => {
  it("refuses a model that a pinned one leaves no room for, at send time and at request time", async () => {
    const pinned = await patchModel({ id: b, pinned: true });
    expect(pinned.status).toBe(200);
    expect(pinned.body.pinned).toBe(true);

    // At send time: a typed error, before any conversation row exists.
    await expect(assertModelUsable(a)).rejects.toMatchObject({ code: "local_model_no_room" });
    await expect(assertModelUsable(a)).rejects.toBeInstanceOf(ModelRefError);
    await expect(assertModelUsable(a)).rejects.toThrow(/while "Model B" is pinned/);
    // At request time, the same refusal — and B is never unloaded for it.
    await expect(collect(a)).rejects.toBeInstanceOf(NoRoomError);
    expect(await statusOf(b)).toBe("loaded");
    // The loaded, pinned model itself is still fine to use.
    await expect(assertModelUsable(b)).resolves.toBeUndefined();
  });

  it("tells the picker which models are loaded and pinned", async () => {
    const models = await listBackendModels();
    const mb = models.find((m) => m.id === b);
    const ma = models.find((m) => m.id === a);
    expect(mb).toMatchObject({ loaded: true, pinned: true });
    expect(ma).toMatchObject({ loaded: false, pinned: false });
  });

  it("loads a model as soon as it is pinned, unloading an unpinned one for it", async () => {
    expect((await patchModel({ id: b, pinned: false })).body.pinned).toBe(false);
    expect((await patchModel({ id: a, pinned: true })).body.pinned).toBe(true);
    await waitForStatus(a, "loaded");
    expect(await statusOf(b)).toBe("unloaded");
  });

  it("loads a pinned model again after the runtime restarts", async () => {
    await ensureRuntime({ restart: true });
    expect(runtimeView().state).toBe("running");
    await waitForStatus(a, "loaded");
  });

  it("reports why a pinned model could not be loaded", async () => {
    // Both pinned, room for one: whichever is not loaded says why.
    expect((await patchModel({ id: b, pinned: true })).status).toBe(200);
    const until = Date.now() + 15_000;
    let pinError: unknown = null;
    while (Date.now() < until) {
      const res = await app.inject({ method: "GET", url: "/v1/admin/local-models" });
      const view = res.json<{ models: { id: string; pinError: string | null }[] }>();
      pinError = view.models.find((m) => m.id === b)?.pinError;
      if (pinError) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(pinError).toMatch(/isn't enough GPU memory while "Model A" is pinned too/);
    expect(await statusOf(a)).toBe("loaded");
  });

  it("pins only an enabled model, and disabling one unpins it", async () => {
    const refused = await patchModel({ id: disabled, pinned: true });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/enabled for everyone/);

    const off = await patchModel({ id: b, enabled: false });
    expect(off.body).toMatchObject({ enabled: false, pinned: false });
  });
});

describe("restarting", () => {
  it("does not drop a restart asked for while another is still running", async () => {
    const first = ensureRuntime({ restart: true });
    const second = ensureRuntime({ restart: true });
    await first;
    const afterFirst = __routerPidForTest();
    await second;
    expect(runtimeView().state).toBe("running");
    // The second restart really happened: a new router, not the first's.
    expect(__routerPidForTest()).not.toBe(afterFirst);
  });
});
