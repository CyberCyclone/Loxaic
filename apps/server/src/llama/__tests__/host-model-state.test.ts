import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import Fastify from "fastify";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { v4 as uuid } from "uuid";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, eq } from "@loxaic/db";
import { localModels } from "@loxaic/db/schema";
import { invalidateLocalModelCache } from "../catalog.ts";
import { routerModelName } from "../preset.ts";
import { __resetRoomForTest, trackRequest } from "../room.ts";
import { __resetRouterForTest, __setHardwareForTest, ensureRuntime, loadModel, routerModelStatuses, runtimeView } from "../router.ts";
import { acquireRunSlot } from "../../inference/scheduler.ts";
import { __resetModelCachesForTest } from "../../inference/models.ts";

vi.mock("../../auth/middleware", () => ({
  authenticate: () => Promise.resolve("admin-host-state-test"),
  requireAdmin: () => Promise.resolve("admin-host-state-test"),
}));
const { adminLocalModelRoutes } = await import("../../routes/admin-local-models.ts");
const app = Fastify();
adminLocalModelRoutes(app);

/**
 * The Host models list as an admin drives it, end to end against the fake
 * router: one 24 GB fake GPU on which each loaded model holds 23.5 GB, so only
 * one fits at a time.
 *
 * - Load and Unload from the list, refused where they would do harm;
 * - saving a loaded model's settings reloads it with them;
 * - a restart says what it is doing until its pinned models are back;
 * - a loaded model says where its memory went, the lookup table included.
 */

const FAKE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../test-fixtures/fake-llama-server.mjs");
const dir = mkdtempSync(path.join(os.tmpdir(), "loxaic-host-state-"));
const host = `test-host-state-${uuid()}`;
const a = `test/a-${uuid().slice(0, 8)}:Q4_K_M`;
const b = `test/b-${uuid().slice(0, 8)}:Q4_K_M`;
const table = `test/table-${uuid().slice(0, 8)}:Q4_K_M`;
const crashy = `test/crashy-${uuid().slice(0, 8)}:Q4_K_M`;
const loadLog = path.join(dir, "loads.jsonl");
/** Present, the fake router refuses every reload of the preset. */
const reloadFail = path.join(dir, "reload-fail");
const MiB = 1024 ** 2;

const HW_GPU = { platform: "linux" as const, arch: "x64", gpus: [], flavour: "vulkan" as const, reason: null, ramBytes: 16 * 1024 ** 3 };

function row(id: string, name: string, file: string, createdAt: Date, meta: Record<string, unknown> = {}) {
  return {
    id,
    hostId: host,
    repo: id.split(":")[0],
    revision: "0".repeat(40),
    quant: "Q4_K_M",
    files: [{ path: file, size: 1, sha256: null }],
    sizeBytes: 1,
    status: "ready" as const,
    enabled: true,
    displayName: name,
    publisher: "test",
    createdAt,
    meta,
  };
}

interface Event {
  event: string;
  model: string;
  section?: Record<string, string>;
}
function events(): Event[] {
  if (!existsSync(loadLog)) return [];
  return readFileSync(loadLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Event);
}

async function statusOf(id: string): Promise<string> {
  return (await routerModelStatuses()).get(id)?.value ?? "unloaded";
}

async function waitFor(pred: () => Promise<boolean> | boolean, what: string, ms = 15_000): Promise<void> {
  const until = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

interface ModelView {
  id: string;
  runtimeStatus: string | null;
  loadError: string | null;
  reloading?: boolean;
  appliesOnNextLoad?: boolean;
  reloadPending?: boolean;
  placement: {
    parts: { part: string; tier: string; device: string | null; bytes: number }[];
    splits: number | null;
    gpuCount: number;
  } | null;
}

async function view(): Promise<{ runtime: ReturnType<typeof runtimeView>; models: ModelView[] }> {
  const res = await app.inject({ method: "GET", url: "/v1/admin/local-models" });
  return res.json();
}
async function modelOf(id: string): Promise<ModelView> {
  const m = (await view()).models.find((x) => x.id === id);
  if (!m) throw new Error(`${id} is not listed`);
  return m;
}
async function post(action: "load" | "unload", id: string) {
  const res = await app.inject({ method: "POST", url: `/v1/admin/local-models/model/${action}`, payload: { id } });
  return { status: res.statusCode, body: res.json<ModelView & { error?: string }>() };
}
async function patchModel(body: Record<string, unknown>) {
  const res = await app.inject({ method: "PATCH", url: "/v1/admin/local-models/model", payload: body });
  return { status: res.statusCode, body: res.json<ModelView & { error?: string }>() };
}

beforeAll(async () => {
  await app.ready();
  vi.stubEnv("LOXAIC_INSTANCE_ID", host);
  vi.stubEnv("LLAMA_DIR", dir);
  vi.stubEnv("LOXAIC_LLAMA_SERVER_BIN", FAKE);
  vi.stubEnv("LOXAIC_FAKE_ROUTER_LOG", loadLog);
  vi.stubEnv("LOXAIC_FAKE_RELOAD_FAIL", reloadFail);
  vi.stubEnv("LOXAIC_FAKE_DEVICES", "FAKE0: Fake GPU (24576 MiB, 24000 MiB free)");
  vi.stubEnv("LOXAIC_FAKE_MODEL_MIB", "23500");
  vi.stubEnv("LOXAIC_FAKE_VRAM_STATE", path.join(dir, "vram.json"));
  vi.stubEnv("MOCK_INFERENCE", "false");
  vi.stubEnv("LLAMA_MODE", "managed");
  await db.insert(localModels).values([
    row(a, "Model A", "a.gguf", new Date(1_000)),
    row(b, "Model B", "b.gguf", new Date(2_000)),
    // A model the fake gives a 2 MiB per-layer table, and a graph llama.cpp's
    // automatic GPU layers split 17 ways.
    row(table, "Table Model", "Table-Splitty.gguf", new Date(3_000), { lookupTable: { tensor: "per_layer_token_embd.weight", bytes: 2 * MiB } }),
    // The fake fails to load a "Crashy" model with MTP on.
    { ...row(crashy, "Crashy Model", "Crashy.gguf", new Date(4_000), { mtp: { layers: 1 } }), loadSettings: { mtp: true } },
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

describe("loading and unloading from the list", () => {
  it("loads a model on request, answering at once, and says where it went", async () => {
    const res = await post("load", a);
    expect(res.status).toBe(202);
    expect(res.body.runtimeStatus).toBe("loading");
    await waitFor(async () => (await statusOf(a)) === "loaded", "A to load");
    const placement = (await modelOf(a)).placement;
    expect(placement?.gpuCount).toBe(1);
    expect(placement?.parts.find((p) => p.part === "weights" && p.tier === "gpu")).toMatchObject({ device: "FAKE0", bytes: 23500 * MiB });
    expect(placement?.parts.some((p) => p.part === "kv" && p.device === "FAKE0")).toBe(true);
  });

  it("unloads it on request, and then it has no placement", async () => {
    const res = await post("unload", a);
    expect(res.status).toBe(200);
    expect(await statusOf(a)).toBe("unloaded");
    expect(events().at(-1)).toMatchObject({ event: "unload", model: routerModelName(a) });
    expect((await modelOf(a)).placement).toBeNull();
  });

  it("refuses to unload a model answering someone, and one that is kept loaded", async () => {
    await post("load", a);
    await waitFor(async () => (await statusOf(a)) === "loaded", "A to load");
    const done = trackRequest(a);
    try {
      const busy = await post("unload", a);
      expect(busy.status).toBe(409);
      expect(busy.body.error).toMatch(/answering someone/);
    } finally {
      done();
    }
    // Pinning B makes room by unloading A, B being the one kept.
    expect((await patchModel({ id: b, pinned: true })).status).toBe(200);
    await waitFor(async () => (await statusOf(b)) === "loaded", "B to load once pinned");
    const pinned = await post("unload", b);
    expect(pinned.status).toBe(409);
    expect(pinned.body.error).toMatch(/Keep loaded/);
    expect(await statusOf(b)).toBe("loaded");
  });

  it("refuses a load that pinned models leave no room for, saying which", async () => {
    const res = await post("load", a);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Model B/);
    expect(await statusOf(b)).toBe("loaded");
  });

  it("refuses a model nobody may use", async () => {
    expect((await patchModel({ id: b, pinned: false })).status).toBe(200);
    await post("unload", b);
    expect((await patchModel({ id: a, enabled: false })).status).toBe(200);
    expect((await post("load", a)).status).toBe(409);
    expect((await patchModel({ id: a, enabled: true })).status).toBe(200);
  });
});

describe("a load that failed", () => {
  it("stops saying why once the model loads, however it was loaded", async () => {
    // A chat loads a model through the router, never through room.ts: the
    // error from an admin's earlier Load must not sit under a Loaded badge.
    expect((await post("load", crashy)).status).toBe(202);
    await waitFor(async () => (await modelOf(crashy)).loadError !== null, "the load to fail");
    expect((await patchModel({ id: crashy, loadSettings: {} })).status).toBe(200);
    await loadModel(crashy);
    await waitFor(async () => (await statusOf(crashy)) === "loaded", "Crashy to load without MTP");
    expect((await modelOf(crashy)).loadError).toBeNull();
    await post("unload", crashy);
    // Unloaded again, the old failure does not come back either.
    expect((await modelOf(crashy)).loadError).toBeNull();
  });
});

describe("saving a loaded model's settings", () => {
  it("reloads it with them, without waiting for anyone to ask it", async () => {
    await post("load", a);
    await waitFor(async () => (await statusOf(a)) === "loaded", "A to load");
    const res = await patchModel({ id: a, loadSettings: { ctxSize: 3072 } });
    expect(res.status).toBe(200);
    expect(res.body.reloading).toBe(true);
    expect(res.body.appliesOnNextLoad).toBe(false);
    await waitFor(
      async () =>
        events().filter((e) => e.event === "load" && e.model === routerModelName(a)).at(-1)?.section?.["ctx-size"] === "3072" &&
        (await statusOf(a)) === "loaded",
      "A to come back at 3072",
    );
    const mine = events().filter((e) => e.model === routerModelName(a));
    expect(mine.at(-2)?.event).toBe("unload");
  });

  it("leaves it unloaded when the same write takes it away from everyone", async () => {
    const before = events().length;
    expect((await patchModel({ id: a, enabled: false, loadSettings: { ctxSize: 2048 } })).status).toBe(200);
    await waitFor(async () => (await statusOf(a)) === "unloaded", "A to unload");
    await new Promise((r) => setTimeout(r, 500));
    expect(events().slice(before).some((e) => e.event === "load" && e.model === routerModelName(a))).toBe(false);
    expect((await patchModel({ id: a, enabled: true })).status).toBe(200);
  });

  it("says a reload is pending while someone is answered, and reloads once they are done", async () => {
    await post("load", a);
    await waitFor(async () => (await statusOf(a)) === "loaded", "A to load");
    const holder = new AbortController();
    const slot = await acquireRunSlot({ signal: holder.signal, onQueued: () => undefined });
    if (!slot) throw new Error("no run slot");
    try {
      const res = await patchModel({ id: a, loadSettings: { ctxSize: 4096 } });
      expect(res.body.appliesOnNextLoad).toBe(true);
      expect((await modelOf(a)).reloadPending).toBe(true);
    } finally {
      slot.release();
    }
    await waitFor(
      async () =>
        events().filter((e) => e.event === "load" && e.model === routerModelName(a)).at(-1)?.section?.["ctx-size"] === "4096" &&
        (await statusOf(a)) === "loaded",
      "A to come back at 4096",
    );
    expect((await modelOf(a)).reloadPending).toBe(false);
  });

  it("does not come back later for a reload the router refused", async () => {
    // The router keeps its old list when it refuses a reload, so nothing was
    // unloaded and nothing is owed: a later, unrelated reload must not load A
    // after an admin has unloaded it.
    expect(await statusOf(a)).toBe("loaded");
    writeFileSync(reloadFail, "");
    try {
      const res = await patchModel({ id: a, loadSettings: { ctxSize: 2048 } });
      expect(res.status).toBe(200);
      expect(res.body.reloading).toBe(false);
    } finally {
      unlinkSync(reloadFail);
    }
    expect((await post("unload", a)).status).toBe(200);
    const before = events().length;
    expect((await patchModel({ id: b, loadSettings: { ctxSize: 3072 } })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 500));
    expect(events().slice(before).some((e) => e.event === "load" && e.model === routerModelName(a))).toBe(false);
    expect(await statusOf(a)).toBe("unloaded");
  });

  it("does not load a model that was not loaded", async () => {
    const before = events().length;
    const res = await patchModel({ id: b, loadSettings: { ctxSize: 2048 } });
    expect(res.body.reloading).toBe(false);
    await new Promise((r) => setTimeout(r, 500));
    expect(events().slice(before).some((e) => e.event === "load" && e.model === routerModelName(b))).toBe(false);
  });
});

describe("the lookup table and the graph", () => {
  it("shows the table read from the SSD, and the 17-way split automatic GPU layers made", async () => {
    await post("unload", a);
    await post("load", table);
    await waitFor(async () => (await statusOf(table)) === "loaded", "the table model to load");
    const p = (await modelOf(table)).placement;
    expect(p?.parts.find((x) => x.part === "table")).toEqual({ part: "table", tier: "ssd", device: null, bytes: 2 * MiB });
    expect(p?.splits).toBe(17);
  });

  it("moves it into RAM, and the split goes with all layers on the GPU", async () => {
    const res = await patchModel({ id: table, loadSettings: { tablePlacement: "ram", gpuLayers: "all" } });
    expect(res.status).toBe(200);
    expect(res.body.reloading).toBe(true);
    await waitFor(async () => {
      const p = (await modelOf(table)).placement;
      return p?.parts.find((x) => x.part === "table")?.tier === "ram";
    }, "the table to be in RAM");
    const p = (await modelOf(table)).placement;
    expect(p?.splits).toBe(2);
    const section = events().filter((e) => e.event === "load" && e.model === routerModelName(table)).at(-1)?.section;
    expect(section?.["lazy-mode"]).toBe("off");
    expect(section?.["load-mode"]).toBe("none");
  });

  it("is refused for a model without one", async () => {
    await db.update(localModels).set({ meta: { lookupTable: null } }).where(eq(localModels.id, b));
    invalidateLocalModelCache();
    const res = await patchModel({ id: b, loadSettings: { tablePlacement: "ram" } });
    expect(res.status).toBe(400);
  });
});

describe("restarting", () => {
  it("says it is restarting from the moment it is asked until the pinned models are back", async () => {
    vi.stubEnv("LOXAIC_FAKE_LOAD_MS", "600");
    try {
      expect((await patchModel({ id: b, pinned: true })).status).toBe(200);
      await waitFor(async () => (await statusOf(b)) === "loaded", "B to load once pinned");
      const seen = new Set<string>();
      const res = await app.inject({ method: "POST", url: "/v1/admin/local-models/runtime/restart" });
      const first = res.json<{ runtime: ReturnType<typeof runtimeView> }>().runtime.restart;
      expect(first?.cause).toBe("requested");
      if (first) seen.add(first.phase);
      await waitFor(() => {
        const r = runtimeView().restart;
        if (r) seen.add(r.phase);
        return r === null;
      }, "the restart to finish");
      expect(seen.has("loading-pinned")).toBe(true);
      expect(await statusOf(b)).toBe("loaded");
      expect(runtimeView().state).toBe("running");
    } finally {
      vi.unstubAllEnvs();
      vi.stubEnv("LOXAIC_INSTANCE_ID", host);
      vi.stubEnv("LLAMA_DIR", dir);
      vi.stubEnv("LOXAIC_LLAMA_SERVER_BIN", FAKE);
      vi.stubEnv("LOXAIC_FAKE_ROUTER_LOG", loadLog);
      vi.stubEnv("LOXAIC_FAKE_DEVICES", "FAKE0: Fake GPU (24576 MiB, 24000 MiB free)");
      vi.stubEnv("LOXAIC_FAKE_MODEL_MIB", "23500");
      vi.stubEnv("LOXAIC_FAKE_VRAM_STATE", path.join(dir, "vram.json"));
      vi.stubEnv("MOCK_INFERENCE", "false");
      vi.stubEnv("LLAMA_MODE", "managed");
    }
  });

  it("has nothing to say when nobody restarted it", () => {
    expect(runtimeView().restart).toBeNull();
  });
});
