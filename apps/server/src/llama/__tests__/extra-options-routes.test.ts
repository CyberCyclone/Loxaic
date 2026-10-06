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
import { routerModelName } from "../preset.ts";
import { __resetRoomForTest } from "../room.ts";
import { __resetRouterForTest, __setHardwareForTest, ensureRuntime, routerModelStatuses } from "../router.ts";
import { setRouterExtraOptions } from "../settings.ts";
import { __resetModelCachesForTest } from "../../inference/models.ts";

vi.mock("../../auth/middleware", () => ({
  authenticate: () => Promise.resolve("admin-extra-options-test"),
  requireAdmin: () => Promise.resolve("admin-extra-options-test"),
}));
const { adminLocalModelRoutes } = await import("../../routes/admin-local-models.ts");
const app = Fastify();
adminLocalModelRoutes(app);

/**
 * Extra llama.cpp options as an admin sets them, end to end against the fake
 * router, whose `--help` lists `keep`, `metrics` and `cont-batching` beyond the
 * keys Loxaic writes, and which fails to start on any key it does not list, as
 * the real one does.
 */

const FAKE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../test-fixtures/fake-llama-server.mjs");
const dir = mkdtempSync(path.join(os.tmpdir(), "loxaic-extra-options-"));
const host = `test-extra-options-${uuid()}`;
const a = `test/a-${uuid().slice(0, 8)}:Q4_K_M`;
const stale = `test/stale-${uuid().slice(0, 8)}:Q4_K_M`;
const loadLog = path.join(dir, "loads.jsonl");

const HW_GPU = { platform: "linux" as const, arch: "x64", gpus: [], flavour: "vulkan" as const, reason: null, ramBytes: 16 * 1024 ** 3 };

function row(id: string, file: string, extraOptions: unknown = null) {
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
    displayName: id,
    publisher: "test",
    extraOptions,
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

function preset(): string {
  return readFileSync(path.join(dir, "models.ini"), "utf8");
}

/** The lines of one section of the preset (`*` for the globals). */
function section(name: string): string[] {
  const lines = preset().split("\n");
  const start = lines.indexOf(`[${name}]`);
  if (start < 0) return [];
  const end = lines.findIndex((l, i) => i > start && l.startsWith("["));
  return lines.slice(start + 1, end < 0 ? undefined : end).filter(Boolean);
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
  extraOptions: { key: string; value: string }[];
  extraOptionsSkipped: string[];
  loadError: string | null;
}
interface View {
  runtime: { state: string; extraOptions: { key: string; value: string }[]; extraOptionsSkipped: string[]; optionsUnavailable: string | null };
  models: ModelView[];
}

async function view(): Promise<View> {
  return (await app.inject({ method: "GET", url: "/v1/admin/local-models" })).json();
}
async function patchModel(body: Record<string, unknown>) {
  const res = await app.inject({ method: "PATCH", url: "/v1/admin/local-models/model", payload: body });
  return { status: res.statusCode, body: res.json<ModelView & { error?: string; index?: number | null }>() };
}
async function patchSettings(body: Record<string, unknown>) {
  const res = await app.inject({ method: "PATCH", url: "/v1/admin/local-models/settings", payload: body });
  return { status: res.statusCode, body: res.json<View & { error?: string; index?: number | null }>() };
}
async function load(id: string) {
  const res = await app.inject({ method: "POST", url: "/v1/admin/local-models/model/load", payload: { id } });
  expect(res.statusCode).toBe(202);
}
async function statusOf(id: string) {
  return (await routerModelStatuses()).get(id);
}

beforeAll(async () => {
  await app.ready();
  vi.stubEnv("LOXAIC_INSTANCE_ID", host);
  vi.stubEnv("LLAMA_DIR", dir);
  vi.stubEnv("LOXAIC_LLAMA_SERVER_BIN", FAKE);
  vi.stubEnv("LOXAIC_FAKE_ROUTER_LOG", loadLog);
  vi.stubEnv("LOXAIC_FAKE_DEVICES", "FAKE0: Fake GPU (24576 MiB, 24000 MiB free)");
  vi.stubEnv("MOCK_INFERENCE", "false");
  vi.stubEnv("LLAMA_MODE", "managed");
  await db.insert(localModels).values([
    row(a, "a.gguf"),
    // Stored by another route, or under a build that knew the key: this fake
    // does not, and would refuse to start with it in the preset.
    row(stale, "stale.gguf", [{ key: "bogus-key", value: "1" }, { key: "metrics", value: "true" }]),
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
  await setRouterExtraOptions([]);
  await db.delete(localModels).where(eq(localModels.hostId, host));
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  __resetModelCachesForTest();
  invalidateLocalModelCache();
});

describe("a stored option the build does not know", () => {
  it("is left out of the preset, so the router still starts, and is named as not passed", async () => {
    const v = await view();
    expect(v.runtime.state).toBe("running");
    expect(section(routerModelName(stale))).toContain("metrics = true");
    expect(preset()).not.toContain("bogus-key");
    expect(v.models.find((m) => m.id === stale)?.extraOptionsSkipped).toEqual(["bogus-key"]);
  });

  it("does not stop the model's other settings being saved, and can be removed but not changed", async () => {
    // The sheet sends every field on each save, the stored options included.
    const stored = [{ key: "bogus-key", value: "1" }, { key: "metrics", value: "true" }];
    const renamed = await patchModel({ id: stale, displayName: "Renamed", extraOptions: stored });
    expect(renamed.status).toBe(200);
    expect(renamed.body.extraOptions).toEqual(stored);
    const changed = await patchModel({ id: stale, extraOptions: [{ key: "bogus-key", value: "2" }] });
    expect(changed.status).toBe(400);
    expect(changed.body.error).toMatch(/no option "bogus-key"/);
    expect((await patchModel({ id: stale, extraOptions: [stored[1]] })).body.extraOptionsSkipped).toEqual([]);
  });
});

describe("the options the build lists", () => {
  it("are what --help said, with why any of them may not be set", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/admin/local-models/runtime/options" });
    const body = res.json<{ options: { names: string[]; takesValue: boolean; reserved: string | null }[] | null; unavailable: string | null }>();
    expect(body.unavailable).toBeNull();
    const by = (n: string) => body.options?.find((o) => o.names.includes(n));
    expect(by("keep")).toMatchObject({ takesValue: true, reserved: null });
    expect(by("nocb")).toMatchObject({ takesValue: false, reserved: null });
    expect(by("port")?.reserved).toMatch(/router/);
    expect(by("ctx-size")?.reserved).toMatch(/Context length/);
  });
});

describe("a model's own options", () => {
  it("are written into its section and reach its load", async () => {
    const res = await patchModel({ id: a, extraOptions: [{ key: "--keep", value: "64" }, { key: "no-cont-batching", value: "true" }] });
    expect(res.status).toBe(200);
    expect(res.body.extraOptions).toEqual([{ key: "keep", value: "64" }, { key: "no-cont-batching", value: "true" }]);
    expect(section(routerModelName(a))).toEqual(expect.arrayContaining(["keep = 64", "no-cont-batching = true"]));
    await load(a);
    await waitFor(async () => (await statusOf(a))?.value === "loaded", "A to load");
    expect(events().filter((e) => e.event === "load" && e.model === routerModelName(a)).at(-1)?.section).toMatchObject({ keep: "64", "no-cont-batching": "true" });
  });

  it("refuses the row that cannot be passed, saying which and why, and changes nothing", async () => {
    const before = preset();
    const reserved = await patchModel({ id: a, extraOptions: [{ key: "keep", value: "1" }, { key: "port", value: "9" }] });
    expect(reserved.status).toBe(400);
    expect(reserved.body).toMatchObject({ index: 1 });
    expect(reserved.body.error).toMatch(/router/);
    const unknown = await patchModel({ id: a, extraOptions: [{ key: "mlock", value: "true" }] });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toMatch(/no option "mlock"/);
    expect(preset()).toBe(before);
  });

  it("with a bad value fails that model's load with llama.cpp's own words", async () => {
    expect((await patchModel({ id: a, extraOptions: [{ key: "keep", value: "banana" }] })).status).toBe(200);
    await waitFor(async () => (await statusOf(a))?.value !== "loaded", "A to be unloaded by the reload");
    await load(a);
    await waitFor(async () => Boolean((await view()).models.find((m) => m.id === a)?.loadError), "the load to fail");
    expect((await view()).models.find((m) => m.id === a)?.loadError).toMatch(/error while handling argument "--keep": stoi: no conversion/);
    expect((await patchModel({ id: a, extraOptions: [{ key: "keep", value: "64" }] })).status).toBe(200);
  });
});

describe("options for every model", () => {
  it("go into [*], restart the runtime, and give way to a model's own", async () => {
    const res = await patchSettings({ extraOptions: [{ key: "metrics", value: "true" }, { key: "keep", value: "8" }] });
    expect(res.status).toBe(200);
    expect(res.body.runtime.extraOptions).toEqual([{ key: "metrics", value: "true" }, { key: "keep", value: "8" }]);
    await waitFor(async () => (await view()).runtime.state === "running", "the runtime to come back");
    expect(section("*")).toEqual(expect.arrayContaining(["metrics = true", "keep = 8"]));
    await load(a);
    await waitFor(async () => (await statusOf(a))?.value === "loaded", "A to load");
    // A's own `keep = 64` wins over the `keep = 8` every model gets.
    expect(events().filter((e) => e.event === "load" && e.model === routerModelName(a)).at(-1)?.section).toMatchObject({ keep: "64", metrics: "true" });
  });

  it("refuses a reserved one with the row's index, and leaves the rest of the request unapplied", async () => {
    const res = await patchSettings({ modelsMax: 3, extraOptions: [{ key: "log-file", value: "/tmp/x" }] });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ index: 0 });
    expect((await view()).runtime.extraOptions).toEqual([{ key: "metrics", value: "true" }, { key: "keep", value: "8" }]);
  });

  it("are cleared by an empty list", async () => {
    expect((await patchSettings({ extraOptions: [] })).status).toBe(200);
    await waitFor(async () => (await view()).runtime.state === "running", "the runtime to come back");
    expect(section("*")).not.toContain("metrics = true");
  });
});

describe("without the build's option list", () => {
  it("refuses to set any option, with the reason, and still clears them", async () => {
    await __resetRouterForTest();
    const res = await patchModel({ id: a, extraOptions: [{ key: "keep", value: "1" }] });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/not been started yet/);
    // Sending back what is stored is not setting anything: the sheet does it
    // on every save, and must not be refused while the runtime is down.
    const stored = (await view()).models.find((m) => m.id === a)?.extraOptions ?? [];
    expect(stored.length).toBeGreaterThan(0);
    expect((await patchModel({ id: a, displayName: "A again", extraOptions: stored })).status).toBe(200);
    expect((await patchModel({ id: a, extraOptions: null })).status).toBe(200);
    expect((await view()).runtime.optionsUnavailable).toMatch(/Start the runtime first/);
  });
});
