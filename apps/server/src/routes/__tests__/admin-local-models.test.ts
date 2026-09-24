import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { v4 as uuid } from "uuid";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db, eq } from "@loxaic/db";
import { localModels } from "@loxaic/db/schema";

/**
 * `/v1/admin/local-models` through a real Fastify instance; only
 * authentication is stubbed, as in admin-providers.test.ts. What is held here:
 * `requireAdmin` is the boundary on every verb, enabling is refused for a model
 * that has not finished, load settings are validated before they are stored,
 * and enabling is what makes a model usable — at send time, not just listed.
 *
 * Attached to a dead port rather than `off`: `off` is refused at send-time
 * pre-flight (nothing local can ever be usable then), while `attach` to
 * nothing starts and installs no runtime and still lets enabling be tested.
 */
const currentUser = { id: "" };

vi.mock("../../auth/middleware", () => ({
  authenticate: () => Promise.resolve(currentUser.id),
  requireAdmin: (_req: unknown, reply: { code: (n: number) => { send: (b: unknown) => void } }) => {
    if (!currentUser.id.startsWith("admin")) {
      reply.code(403).send({ error: "Admin access required" });
      throw new Error("Forbidden");
    }
    return Promise.resolve(currentUser.id);
  },
}));

const { adminLocalModelRoutes } = await import("../admin-local-models.ts");
const { resolveModelRef } = await import("../../inference/providers.ts");

const host = `test-lm-routes-${uuid()}`;
const ready = `test/ready-${uuid().slice(0, 8)}:Q4_K_M`;
const pending = `test/pending-${uuid().slice(0, 8)}:Q4_K_M`;
const dir = mkdtempSync(path.join(os.tmpdir(), "loxaic-lm-routes-"));
const app = Fastify();
adminLocalModelRoutes(app);

function row(id: string, status: "ready" | "downloading") {
  return {
    id,
    hostId: host,
    repo: id.split(":")[0],
    revision: "0".repeat(40),
    quant: "Q4_K_M",
    files: [{ path: "m.gguf", size: 1000, sha256: null }],
    sizeBytes: 1000,
    status,
    enabled: false,
    displayName: id,
    publisher: "test",
    meta: { nLayers: 28, nCtxTrain: 40960 },
  };
}

beforeAll(async () => {
  vi.stubEnv("LOXAIC_INSTANCE_ID", host);
  vi.stubEnv("LLAMA_MODE", "attach");
  vi.stubEnv("LLAMA_ROUTER_URL", "http://127.0.0.1:1");
  vi.stubEnv("LLAMA_DIR", dir);
  vi.stubEnv("MOCK_INFERENCE", "false");
  await app.ready();
  await db.insert(localModels).values([row(ready, "ready"), row(pending, "downloading")]);
  currentUser.id = `admin-${uuid()}`;
});

afterAll(async () => {
  await db.delete(localModels).where(eq(localModels.hostId, host));
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
  await app.close();
});

describe("admin local models", () => {
  it("every verb is admin-only", async () => {
    const saved = currentUser.id;
    currentUser.id = "plain-user";
    try {
      const calls = [
        app.inject({ method: "GET", url: "/v1/admin/local-models" }),
        app.inject({ method: "GET", url: "/v1/admin/local-models/hf/search?q=x" }),
        app.inject({ method: "POST", url: "/v1/admin/local-models/downloads", payload: {} }),
        app.inject({ method: "PATCH", url: "/v1/admin/local-models/model", payload: { id: ready, enabled: true } }),
        app.inject({ method: "PATCH", url: "/v1/admin/local-models/settings", payload: { backend: "cpu" } }),
        app.inject({ method: "DELETE", url: `/v1/admin/local-models/model?id=${encodeURIComponent(ready)}` }),
      ];
      for (const res of await Promise.all(calls)) expect(res.statusCode).toBe(403);
    } finally {
      currentUser.id = saved;
    }
  });

  it("lists this host's models with a fit label and the setting specs", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/admin/local-models" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      models: { id: string; fit: { label: string } }[];
      settingSpecs: { key: string }[];
      runtime: { state: string; reason: string | null };
    }>();
    expect(body.models.map((m) => m.id)).toEqual(expect.arrayContaining([ready, pending]));
    expect(body.settingSpecs.map((s) => s.key)).toContain("gpuLayers");
    // Opening the screen asks the attached router afresh, and there is none
    // at this address: the admin is told so, not shown a stale "starting".
    expect(body.runtime.state).toBe("error");
    expect(body.runtime.reason).toMatch(/not answering/);
  });

  it("enabling is what makes a model usable at send time", async () => {
    await expect(resolveModelRef(ready)).rejects.toMatchObject({ code: "local_model_unavailable" });
    const res = await app.inject({ method: "PATCH", url: "/v1/admin/local-models/model", payload: { id: ready, enabled: true } });
    expect(res.statusCode).toBe(200);
    await expect(resolveModelRef(ready)).resolves.toMatchObject({ upstreamModel: ready });
  });

  it("refuses to enable a model that has not finished downloading", async () => {
    const res = await app.inject({ method: "PATCH", url: "/v1/admin/local-models/model", payload: { id: pending, enabled: true } });
    expect(res.statusCode).toBe(409);
  });

  it("validates load settings against the model before storing them", async () => {
    const bad = await app.inject({
      method: "PATCH",
      url: "/v1/admin/local-models/model",
      payload: { id: ready, loadSettings: { ctxSize: 100_000 } },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json<{ error: string }>().error).toMatch(/40960/);
    const unknown = await app.inject({ method: "PATCH", url: "/v1/admin/local-models/model", payload: { id: ready, loadSettings: { mlock: true } } });
    expect(unknown.statusCode).toBe(400);
    const good = await app.inject({
      method: "PATCH",
      url: "/v1/admin/local-models/model",
      payload: { id: ready, loadSettings: { ctxSize: 8192, gpuLayers: "all", flashAttention: "on" } },
    });
    expect(good.statusCode).toBe(200);
    expect(good.json<{ loadSettings: unknown }>().loadSettings).toEqual({ ctxSize: 8192, gpuLayers: "all", flashAttention: "on" });
  });

  it("estimates unsaved settings", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/admin/local-models/estimate", payload: { id: ready, loadSettings: { ctxSize: 32768 } } });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ fit: { requiredBytes: number } }>().fit.requiredBytes).toBeGreaterThan(1000);
  });

  it("refuses CPU without the acknowledgement", async () => {
    const res = await app.inject({ method: "PATCH", url: "/v1/admin/local-models/settings", payload: { backend: "cpu" } });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toMatch(/cpuAcknowledged/);
  });

  it("a model still downloading is cancelled, not deleted", async () => {
    const res = await app.inject({ method: "DELETE", url: `/v1/admin/local-models/model?id=${encodeURIComponent(pending)}` });
    expect(res.statusCode).toBe(409);
  });

  it("deletes a finished model", async () => {
    const res = await app.inject({ method: "DELETE", url: `/v1/admin/local-models/model?id=${encodeURIComponent(ready)}` });
    expect(res.statusCode).toBe(200);
    await expect(resolveModelRef(ready)).rejects.toMatchObject({ code: "local_model_unavailable" });
  });
});
