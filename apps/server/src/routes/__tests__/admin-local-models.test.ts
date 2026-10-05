import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
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
        app.inject({ method: "POST", url: "/v1/admin/local-models/model/mtp-head", payload: { id: ready, path: "MTP/mtp-x.gguf" } }),
        app.inject({ method: "DELETE", url: `/v1/admin/local-models/model/mtp-head?id=${encodeURIComponent(ready)}` }),
        app.inject({ method: "GET", url: "/v1/admin/local-models/hf/mtp-heads?repo=a/b" }),
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
    // Past the trained 40960 is advice, not a limit: RoPE scaling exists to
    // exceed it. Only llama.cpp's own 32-bit ceiling is refused.
    const past = await app.inject({
      method: "PATCH",
      url: "/v1/admin/local-models/model",
      payload: { id: ready, loadSettings: { ctxSize: 100_000 } },
    });
    expect(past.statusCode).toBe(200);
    const bad = await app.inject({
      method: "PATCH",
      url: "/v1/admin/local-models/model",
      payload: { id: ready, loadSettings: { ctxSize: 2 ** 31 } },
    });
    expect(bad.statusCode).toBe(400);
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

  it("offers MTP only to a model with a head, and prices the head when it is on", async () => {
    const refused = await app.inject({ method: "PATCH", url: "/v1/admin/local-models/model", payload: { id: ready, loadSettings: { mtp: true } } });
    expect(refused.statusCode).toBe(400);
    expect(refused.json<{ error: string }>().error).toMatch(/no multi-token-prediction head/);
    const lonely = await app.inject({ method: "PATCH", url: "/v1/admin/local-models/model", payload: { id: ready, loadSettings: { mtpDraftMax: 2 } } });
    expect(lonely.statusCode).toBe(400);
    // A head that was refused is kept to say why, and drafts nothing.
    const refusedHead = { path: "MTP/mtp-x.gguf", size: 1, sha256: "a".repeat(64), revision: "0".repeat(40), status: "failed", bytesDone: 0, error: "no", layers: null };
    await db.update(localModels).set({ mtpHead: refusedHead }).where(eq(localModels.id, ready));
    const onRefused = await app.inject({ method: "PATCH", url: "/v1/admin/local-models/model", payload: { id: ready, loadSettings: { mtp: true } } });
    expect(onRefused.statusCode).toBe(400);
    // While one is still downloading, MTP may be switched on ahead of it.
    await db.update(localModels).set({ mtpHead: { ...refusedHead, status: "downloading", error: null } }).where(eq(localModels.id, ready));
    const ahead = await app.inject({ method: "PATCH", url: "/v1/admin/local-models/model", payload: { id: ready, loadSettings: { mtp: true } } });
    expect(ahead.statusCode).toBe(200);
    expect(ahead.json<{ mtpSource: string }>().mtpSource).toBe("head-pending");
    await db.update(localModels).set({ mtpHead: null, loadSettings: {} }).where(eq(localModels.id, ready));

    await db.update(localModels).set({ meta: { nLayers: 28, nCtxTrain: 40960, mtp: { layers: 1 } } }).where(eq(localModels.id, ready));
    const on = await app.inject({ method: "PATCH", url: "/v1/admin/local-models/model", payload: { id: ready, loadSettings: { mtp: true, mtpDraftMax: 2 } } });
    expect(on.statusCode).toBe(200);
    expect(on.json<{ mtpSource: string; mtpHead: unknown }>()).toMatchObject({ mtpSource: "embedded", mtpHead: null });
    const estimate = async (loadSettings: Record<string, unknown>) =>
      (await app.inject({ method: "POST", url: "/v1/admin/local-models/estimate", payload: { id: ready, loadSettings } })).json<{ fit: { requiredBytes: number } }>().fit
        .requiredBytes;
    expect(await estimate({ ctxSize: 8192, mtp: true })).toBeGreaterThan(await estimate({ ctxSize: 8192 }));
    // A model that carries its own head is never sent to download another.
    const head = await app.inject({ method: "POST", url: "/v1/admin/local-models/model/mtp-head", payload: { id: ready, path: "MTP/mtp-x.gguf" } });
    expect(head.statusCode).toBe(409);
    // Removing a head the model does not have changes nothing it carries itself.
    const removed = await app.inject({ method: "DELETE", url: `/v1/admin/local-models/model/mtp-head?id=${encodeURIComponent(ready)}` });
    expect(removed.statusCode).toBe(200);
    expect(removed.json<{ loadSettings: unknown }>().loadSettings).toEqual({ mtp: true, mtpDraftMax: 2 });
    await app.inject({ method: "PATCH", url: "/v1/admin/local-models/model", payload: { id: ready, loadSettings: {} } });
    await db.update(localModels).set({ meta: { nLayers: 28, nCtxTrain: 40960 } }).where(eq(localModels.id, ready));
  });

  it("lists a repository's MTP heads from its file list alone — no model card, no fit labels", async () => {
    // The settings sheet reads only the heads; the details route behind the
    // Discover sheet asks HuggingFace four times, the model card included.
    const requests: string[] = [];
    const sha = "a".repeat(40);
    const hf: Server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      requests.push(url.pathname);
      res.writeHead(url.pathname.startsWith("/api/models/") ? 200 : 404, { "content-type": "application/json" });
      if (url.pathname === "/api/models/test/heads") res.end(JSON.stringify({ id: "test/heads", sha }));
      else if (url.pathname === `/api/models/test/heads/tree/${sha}`) {
        res.end(
          JSON.stringify([
            { type: "file", path: "Heads-Q4_K_M.gguf", size: 100, lfs: { oid: "1".repeat(64), size: 100 } },
            { type: "file", path: "MTP/mtp-Heads-Q8_0.gguf", size: 50, lfs: { oid: "2".repeat(64), size: 50 } },
          ]),
        );
      } else res.end("{}");
    });
    await new Promise<void>((r) => hf.listen(0, "127.0.0.1", r));
    const addr = hf.address();
    vi.stubEnv("HF_ENDPOINT", `http://127.0.0.1:${String(typeof addr === "object" && addr ? addr.port : 0)}`);
    try {
      const res = await app.inject({ method: "GET", url: "/v1/admin/local-models/hf/mtp-heads?repo=test/heads" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ revision: sha, mtpHeads: [{ path: "MTP/mtp-Heads-Q8_0.gguf", size: 50, sha256: "2".repeat(64), shared: false }] });
      expect(requests).toEqual(["/api/models/test/heads", `/api/models/test/heads/tree/${sha}`]);
      expect((await app.inject({ method: "GET", url: "/v1/admin/local-models/hf/mtp-heads?repo=../x" })).statusCode).toBe(400);
    } finally {
      vi.unstubAllEnvs();
      vi.stubEnv("LOXAIC_INSTANCE_ID", host);
      vi.stubEnv("LLAMA_MODE", "attach");
      vi.stubEnv("LLAMA_ROUTER_URL", "http://127.0.0.1:1");
      vi.stubEnv("LLAMA_DIR", dir);
      vi.stubEnv("MOCK_INFERENCE", "false");
      hf.closeAllConnections();
      await new Promise<void>((r) => hf.close(() => { r(); }));
    }
  });

  it("estimates unsaved settings", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/admin/local-models/estimate", payload: { id: ready, loadSettings: { ctxSize: 32768 } } });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ fit: { requiredBytes: number } }>().fit.requiredBytes).toBeGreaterThan(1000);
  });

  it("stores YaRN stages checked against the base settings, and prices each one", async () => {
    const stages = { enabled: true, whenFull: "extend", stages: [{ ctxSize: 81920 }, { ctxSize: 163840, cacheTypeK: "q8_0", cacheTypeV: "q8_0" }] };
    const est = await app.inject({ method: "POST", url: "/v1/admin/local-models/estimate", payload: { id: ready, loadSettings: { ctxSize: 8192 }, contextStages: stages } });
    expect(est.statusCode).toBe(200);
    const fits = est.json<{ fit: { requiredBytes: number }; stages: { requiredBytes: number }[] }>();
    expect(fits.stages).toHaveLength(2);
    expect(fits.stages[0].requiredBytes).toBeGreaterThan(fits.fit.requiredBytes);

    const saved = await app.inject({ method: "PATCH", url: "/v1/admin/local-models/model", payload: { id: ready, loadSettings: { ctxSize: 8192 }, contextStages: stages } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json<{ contextStages: { whoMayChange: string }; activeStage: number }>()).toMatchObject({
      contextStages: { whoMayChange: "everyone", whenFull: "extend" },
      activeStage: 0,
    });

    // Raising the standard context past stage 1 is refused, not left behind a
    // stage that is now smaller than standard.
    const raised = await app.inject({ method: "PATCH", url: "/v1/admin/local-models/model", payload: { id: ready, loadSettings: { ctxSize: 90000 } } });
    expect(raised.statusCode).toBe(400);
    expect(raised.json<{ error: string }>().error).toMatch(/larger than the standard context/);
    // YaRN and a manual frequency scale would multiply.
    const scaled = await app.inject({ method: "PATCH", url: "/v1/admin/local-models/model", payload: { id: ready, loadSettings: { ctxSize: 8192, ropeFreqScale: 0.5 } } });
    expect(scaled.statusCode).toBe(400);
    expect(scaled.json<{ error: string }>().error).toMatch(/RoPE frequency scale/);

    const cleared = await app.inject({ method: "PATCH", url: "/v1/admin/local-models/model", payload: { id: ready, contextStages: null } });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json<{ contextStages: unknown }>().contextStages).toBeNull();
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

  it("has no version to choose where it does not run llama.cpp itself", async () => {
    // Attached: the version is the sidecar's image, which the operator sets
    // in Compose. Every picker route says so rather than pretending.
    const calls = [
      app.inject({ method: "GET", url: "/v1/admin/local-models/runtime/versions" }),
      app.inject({ method: "POST", url: "/v1/admin/local-models/runtime/versions/download", payload: { tag: "b1" } }),
      app.inject({ method: "DELETE", url: "/v1/admin/local-models/runtime/versions?tag=b1" }),
      app.inject({ method: "POST", url: "/v1/admin/local-models/runtime/custom", payload: { name: "x", url: "https://example.com/x.tar.gz", backend: "vulkan" } }),
      app.inject({ method: "POST", url: "/v1/admin/local-models/runtime/custom/000000000000/download" }),
      app.inject({ method: "DELETE", url: "/v1/admin/local-models/runtime/custom/000000000000" }),
      app.inject({ method: "POST", url: "/v1/admin/local-models/runtime/select", payload: { kind: "bundled" } }),
      app.inject({ method: "POST", url: "/v1/admin/local-models/runtime/revert" }),
    ];
    for (const res of await Promise.all(calls)) {
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json<{ error: string }>().error).toMatch(/container's image/);
    }
    const view = (await app.inject({ method: "GET", url: "/v1/admin/local-models" })).json<{ runtime: { version: { kind: string; canRevert: boolean } } }>();
    expect(view.runtime.version).toMatchObject({ kind: "external", canRevert: false });

    // And they are admin-only like every other verb here.
    const saved = currentUser.id;
    currentUser.id = "plain-user";
    try {
      const res = await app.inject({ method: "GET", url: "/v1/admin/local-models/runtime/versions" });
      expect(res.statusCode).toBe(403);
      const add = await app.inject({ method: "POST", url: "/v1/admin/local-models/runtime/custom", payload: {} });
      expect(add.statusCode).toBe(403);
    } finally {
      currentUser.id = saved;
    }
  });
});
