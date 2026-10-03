import type { FastifyInstance, FastifyReply } from "fastify";
import { DEFAULT_PROVIDER_ID } from "@loxaic/types";
import { requireAdmin } from "../auth/middleware";
import { invalidateBackendModels } from "../inference/models.ts";
import { kickScheduler } from "../inference/scheduler.ts";
import {
  deleteLocalModelRow,
  getLocalModelRow,
  listLocalModelRows,
  mtpFitInput,
  mtpSource,
  rowMeta,
  rowMmproj,
  rowMtpHead,
  updateLocalModelRow,
  type LocalModelRow,
} from "../llama/catalog.ts";
import {
  cancelDownload,
  DownloadError,
  fitFor,
  freeDiskBytes,
  liveBytesDone,
  liveHeadBytesDone,
  onMtpHeadSettled,
  pauseDownload,
  queueDownload,
  queueMtpHead,
  removeMtpHead,
  removeFiles,
  resumeDownload,
} from "../llama/downloads.ts";
import {
  activeStageIndex,
  effectiveSettings,
  normalizeContextStages,
  rowStages,
  settingsForStage,
} from "../llama/context-stages.ts";
import { bestFit, type FitLabel } from "../llama/fit.ts";
import { HfError, repoDetails, repoFiles, searchModels, type HfSort } from "../llama/hf.ts";
import { checkMtpSetting, LOAD_SETTINGS, LoadSettingsError, normalizeLoadSettings } from "../llama/load-settings.ts";
import { refreshMemory } from "../llama/memory.ts";
import { pinErrorFor } from "../llama/room.ts";
import {
  ensureHardwareDetected,
  ensureRuntime,
  modelBusy,
  refreshRuntimeState,
  routerModelStatuses,
  runtimeView,
  syncPreset,
  unloadModel,
} from "../llama/router.ts";
import { getLocalModelsSettings, LocalModelsSettingsError, updateLocalModelsSettings } from "../llama/settings.ts";

/**
 * The admin screen for local models: the llama.cpp runtime, HuggingFace
 * search, downloads, and which downloaded models every user may pick.
 *
 * Every route is `requireAdmin`: downloading is deployment-wide disk and
 * bandwidth, enabling a model offers it to every user, and the runtime's
 * backend decides whether the GPU is used at all.
 *
 * Model ids contain `/` and `:`, so per-model actions take the id in the body
 * (or the query, for DELETE) rather than the path.
 */

function modelView(row: LocalModelRow, loaded: Map<string, { value: string; failed: boolean }>) {
  const meta = rowMeta(row);
  const status = loaded.get(row.id);
  const settings = effectiveSettings(row);
  const head = rowMtpHead(row);
  return {
    id: row.id,
    repo: row.repo,
    publisher: row.publisher,
    displayName: row.displayName,
    quant: row.quant,
    sizeBytes: row.sizeBytes,
    bytesDone: row.status === "ready" ? row.sizeBytes : liveBytesDone(row),
    status: row.status,
    error: row.error,
    enabled: row.enabled,
    /** Kept loaded, never unloaded to make room (llama/room.ts). */
    pinned: row.pinned,
    /** Why a pinned model is not loaded, or null. */
    pinError: row.pinned ? pinErrorFor(row.id) : null,
    loadSettings: row.loadSettings,
    /** YaRN stages as stored (null until set up), and the stage the model
     * loads at now — 0 is standard. */
    contextStages: row.contextStages ?? null,
    activeStage: activeStageIndex(row),
    meta,
    hasVision: rowMmproj(row) !== null,
    /** Where an MTP head would come from (catalog.ts `mtpSource`). */
    mtpSource: mtpSource(row),
    /** A separate MTP head and its download, or null. */
    mtpHead: head
      ? {
          path: head.path,
          size: head.size,
          status: head.status,
          bytesDone: liveHeadBytesDone(row) ?? head.bytesDone,
          error: head.error,
          layers: head.layers,
        }
      : null,
    /** At the settings it loads with now, its active stage's included. */
    fit: fitFor(row.sizeBytes, meta, settings, row.id, mtpFitInput(row, settings)),
    /** The router's view: `loaded`, `loading`, `unloaded`, `sleeping`, or null
     * when it cannot be asked. */
    runtimeStatus: status?.value ?? null,
    loadFailed: status?.failed ?? false,
    createdAt: row.createdAt.toISOString(),
  };
}

async function fullView() {
  await ensureHardwareDetected();
  await refreshRuntimeState();
  await refreshMemory();
  const rows = await listLocalModelRows();
  const statuses = await routerModelStatuses();
  return {
    runtime: runtimeView(),
    settings: getLocalModelsSettings(),
    models: rows.map((r) => modelView(r, statuses)),
    freeDiskBytes: await freeDiskBytes(),
    settingSpecs: LOAD_SETTINGS,
  };
}

/** Anything that changes which models are served or how. */
async function afterModelWrite(): Promise<{ deferred: boolean }> {
  const result = await syncPreset().catch((e: unknown) => {
    console.error(`[llama] preset sync failed: ${e instanceof Error ? e.message : String(e)}`);
    return { deferred: false };
  });
  invalidateBackendModels(DEFAULT_PROVIDER_ID);
  kickScheduler(DEFAULT_PROVIDER_ID);
  return result;
}

function fail(reply: FastifyReply, err: unknown) {
  if (err instanceof DownloadError) return reply.code(err.status).send({ error: err.message });
  if (err instanceof LoadSettingsError) return reply.code(400).send({ error: err.message });
  if (err instanceof LocalModelsSettingsError) {
    return reply.code(err.code === "envOverride" ? 409 : 400).send({ error: err.message, envOverride: err.code === "envOverride" });
  }
  if (err instanceof HfError) {
    return reply.code(err.status === 400 ? 400 : err.status === 404 ? 404 : 502).send({ error: err.message });
  }
  throw err;
}

// A head finishing (or being refused) changes what the preset says for a model
// whose MTP setting was waiting on it.
onMtpHeadSettled(() => {
  void afterModelWrite();
});

function idFrom(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length < 300 ? value : null;
}

export function adminLocalModelRoutes(app: FastifyInstance) {
  /**
   * The whole screen in one answer, polled while anything is moving.
   *
   * Opening the screen is also what starts the runtime's first install — the
   * way LM Studio fetches its runtime on first launch. On a machine where no
   * GPU resolves, that ends in `needs-gpu` and nothing is downloaded: CPU is
   * only ever the admin's explicit choice.
   */
  app.get("/v1/admin/local-models", async (request, reply) => {
    await requireAdmin(request, reply);
    const view = runtimeView();
    if (view.mode === "managed" && view.state === "not-installed") void ensureRuntime();
    return fullView();
  });

  app.post("/v1/admin/local-models/runtime/restart", async (request, reply) => {
    await requireAdmin(request, reply);
    void ensureRuntime({ restart: true });
    // Give a quick start a moment to show up as starting rather than stale.
    await new Promise((r) => setTimeout(r, 100));
    return fullView();
  });

  app.patch("/v1/admin/local-models/settings", async (request, reply) => {
    await requireAdmin(request, reply);
    const body = (request.body ?? {}) as Record<string, unknown>;
    try {
      await updateLocalModelsSettings(body);
    } catch (err) {
      return fail(reply, err);
    }
    // Backend and devices are process arguments or preset globals: the runtime
    // restarts to take them. The loaded-model limit is Loxaic's own (room.ts)
    // and a token change needs nothing.
    if (body.backend !== undefined || body.devices !== undefined) {
      void ensureRuntime({ restart: true });
      await new Promise((r) => setTimeout(r, 100));
    }
    return fullView();
  });

  app.get("/v1/admin/local-models/hf/search", async (request, reply) => {
    await requireAdmin(request, reply);
    const q = request.query as Record<string, string | undefined>;
    const sort: HfSort = q.sort === "likes" || q.sort === "trending" || q.sort === "recent" ? q.sort : "downloads";
    try {
      await ensureHardwareDetected();
      await refreshMemory();
      const results = await searchModels({ q: q.q, author: q.author, sort, vision: q.vision === "1" || q.vision === "true" });
      const rows = await listLocalModelRows();
      return {
        results: results.map((r) => ({
          ...r,
          // A search result has no file list, so the label is for a typical
          // 4-bit quant of a model this size (~0.6 bytes a parameter) — the
          // quant most people pick, and the one the details sheet leads with.
          fit: (r.params ? fitFor(r.params * 0.6, {}).label : "unknown") satisfies FitLabel,
          downloaded: rows.filter((m) => m.repo === r.repo).map((m) => m.quant),
        })),
      };
    } catch (err) {
      return fail(reply, err);
    }
  });

  // A repository's MTP heads and nothing else, for the settings sheet: two
  // HuggingFace requests (the revision and its file list) where the details
  // route above makes four, the model card among them, and prices every quant.
  app.get("/v1/admin/local-models/hf/mtp-heads", async (request, reply) => {
    await requireAdmin(request, reply);
    const { repo } = request.query as { repo?: string };
    try {
      const files = await repoFiles(repo ?? "");
      return { revision: files.revision, mtpHeads: files.mtpHeads };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get("/v1/admin/local-models/hf/details", async (request, reply) => {
    await requireAdmin(request, reply);
    const { repo } = request.query as { repo?: string };
    try {
      await ensureHardwareDetected();
      await refreshMemory();
      const details = await repoDetails(repo ?? "");
      const rows = await listLocalModelRows();
      const meta = { nLayers: null };
      const mmprojSize = details.files.mmproj[0]?.size ?? 0;
      const quants = details.files.quants.map((q) => {
        const row = rows.find((m) => m.id === `${details.summary.repo}:${q.quant}`);
        // A quant already downloaded is measured as the model it is, so one
        // that is loaded (or pinned) counts its own memory as its own — the
        // same answer its installed row gives.
        const fit = fitFor(q.sizeBytes + (details.summary.vision ? mmprojSize : 0), meta, {}, row?.id);
        return { ...q, fit, downloadStatus: row?.status ?? null };
      });
      return {
        ...details,
        files: { ...details.files, quants },
        bestFit: bestFit(quants.map((q) => q.fit.label)),
      };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post("/v1/admin/local-models/downloads", async (request, reply) => {
    const userId = await requireAdmin(request, reply);
    try {
      await ensureHardwareDetected();
      const row = await queueDownload(request.body ?? {}, userId);
      // A first download is the other thing that starts the runtime install.
      const view = runtimeView();
      if (view.mode === "managed" && view.state === "not-installed") void ensureRuntime();
      return await reply.code(201).send(modelView(row, new Map()));
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post("/v1/admin/local-models/pause", async (request, reply) => {
    await requireAdmin(request, reply);
    const id = idFrom((request.body as { id?: unknown } | undefined)?.id);
    if (!id) return reply.code(400).send({ error: "id is required" });
    const row = await pauseDownload(id);
    if (!row) return reply.code(404).send({ error: "Model not found" });
    return modelView(row, new Map());
  });

  app.post("/v1/admin/local-models/resume", async (request, reply) => {
    await requireAdmin(request, reply);
    const id = idFrom((request.body as { id?: unknown } | undefined)?.id);
    if (!id) return reply.code(400).send({ error: "id is required" });
    const row = await resumeDownload(id);
    if (!row) return reply.code(404).send({ error: "Model not found" });
    return modelView(row, new Map());
  });

  app.post("/v1/admin/local-models/cancel", async (request, reply) => {
    await requireAdmin(request, reply);
    const id = idFrom((request.body as { id?: unknown } | undefined)?.id);
    if (!id) return reply.code(400).send({ error: "id is required" });
    try {
      const existed = await cancelDownload(id);
      if (!existed) return await reply.code(404).send({ error: "Model not found" });
      return { ok: true };
    } catch (err) {
      return fail(reply, err);
    }
  });

  /**
   * Change a downloaded model: enable it for everyone, pin it (keep it loaded),
   * rename it, or change its load settings. Settings are replaced whole (the sheet sends them all);
   * `null` for a key is llama.cpp's default. `appliesOnNextLoad` says the
   * model is in use right now and will pick the change up once it is idle.
   */
  app.patch("/v1/admin/local-models/model", async (request, reply) => {
    await requireAdmin(request, reply);
    const body = (request.body ?? {}) as Record<string, unknown>;
    const id = idFrom(body.id);
    if (!id) return reply.code(400).send({ error: "id is required" });
    const row = await getLocalModelRow(id);
    if (!row) return reply.code(404).send({ error: "Model not found" });
    const patch: Parameters<typeof updateLocalModelRow>[1] = {};
    try {
      if (body.enabled !== undefined) {
        if (typeof body.enabled !== "boolean") throw new DownloadError("enabled must be true or false");
        if (body.enabled && row.status !== "ready") throw new DownloadError("A model can be enabled once it has finished downloading", 409);
        patch.enabled = body.enabled;
        // A pin keeps a model loaded for everyone to use; one nobody may use
        // would only hold the GPU. Disabling unpins.
        if (!body.enabled) patch.pinned = false;
      }
      if (body.pinned !== undefined) {
        if (typeof body.pinned !== "boolean") throw new DownloadError("pinned must be true or false");
        const enabled = patch.enabled ?? row.enabled;
        if (body.pinned && (row.status !== "ready" || !enabled)) {
          throw new DownloadError("Only a model that is enabled for everyone can be pinned", 409);
        }
        patch.pinned = body.pinned;
      }
      if (body.displayName !== undefined) {
        const name = typeof body.displayName === "string" ? body.displayName.replace(/\p{Cc}/gu, "").trim() : "";
        if (!name || name.length > 80) throw new DownloadError("A display name is 1 to 80 characters");
        patch.displayName = name;
      }
      if (body.loadSettings !== undefined) {
        const settings = normalizeLoadSettings(body.loadSettings, rowMeta(row));
        checkMtpSetting(settings, mtpSource(row));
        patch.loadSettings = settings;
      }
      if (body.contextStages !== undefined || body.loadSettings !== undefined) {
        // Stages are checked against the base settings they extend, whichever
        // of the two changed: raising the standard context past stage 1 must
        // be refused, not leave a stage that is smaller than standard.
        const base = (patch.loadSettings ?? row.loadSettings ?? {}) as Record<string, never>;
        const stages = normalizeContextStages(body.contextStages !== undefined ? body.contextStages : row.contextStages, rowMeta(row), base);
        if (body.contextStages !== undefined) patch.contextStages = stages;
        const count = stages?.enabled ? stages.stages.length : 0;
        if (row.activeStage > count) patch.activeStage = count;
      }
    } catch (err) {
      return fail(reply, err);
    }
    if (Object.keys(patch).length === 0) return reply.code(400).send({ error: "nothing to update" });
    const updated = await updateLocalModelRow(id, patch);
    if (!updated) return reply.code(404).send({ error: "Model not found" });
    const { deferred } = await afterModelWrite();
    const statuses = await routerModelStatuses();
    return { ...modelView(updated, statuses), appliesOnNextLoad: deferred };
  });

  /** Fit and memory for settings the admin has not saved yet — the settings
   * sheet's live estimate. */
  app.post("/v1/admin/local-models/estimate", async (request, reply) => {
    await requireAdmin(request, reply);
    const body = (request.body ?? {}) as Record<string, unknown>;
    const id = idFrom(body.id);
    if (!id) return reply.code(400).send({ error: "id is required" });
    const row = await getLocalModelRow(id);
    if (!row) return reply.code(404).send({ error: "Model not found" });
    try {
      const settings = normalizeLoadSettings(body.loadSettings ?? {}, rowMeta(row));
      const weights = row.sizeBytes - (settings.vision === false ? (rowMmproj(row)?.size ?? 0) : 0);
      // The draft stages, priced the way they would load: each one's context
      // and cache types on top of the draft base settings.
      const stagesDraft = body.contextStages !== undefined ? normalizeContextStages(body.contextStages, rowMeta(row), settings) : null;
      const draftRow = { ...row, loadSettings: settings, contextStages: stagesDraft ? { ...stagesDraft, enabled: true } : null };
      await refreshMemory();
      return {
        fit: fitFor(weights, rowMeta(row), settings, row.id, mtpFitInput(row, settings)),
        stages: (rowStages(draftRow)?.stages ?? []).map((_, i) => {
          const stage = settingsForStage(draftRow, i + 1);
          return fitFor(weights, rowMeta(row), stage, row.id, mtpFitInput(row, stage));
        }),
      };
    } catch (err) {
      return fail(reply, err);
    }
  });

  /**
   * Download a multi-token-prediction head for a model in the list — one from
   * its repository's `MTP/` folder. The model stays usable throughout; the head
   * is checked once it is on disk (it must carry a head, for this model's
   * architecture, that the runtime can load) and only then used.
   */
  app.post("/v1/admin/local-models/model/mtp-head", async (request, reply) => {
    await requireAdmin(request, reply);
    const body = (request.body ?? {}) as Record<string, unknown>;
    const id = idFrom(body.id);
    if (!id) return reply.code(400).send({ error: "id is required" });
    if (typeof body.path !== "string" || !body.path) return reply.code(400).send({ error: "path is required" });
    try {
      const row = await queueMtpHead(id, body.path);
      return await reply.code(201).send(modelView(row, await routerModelStatuses()));
    } catch (err) {
      return fail(reply, err);
    }
  });

  /** Remove a model's separate head (stopping its download), which turns MTP
   * off unless the model carries its own. */
  app.delete("/v1/admin/local-models/model/mtp-head", async (request, reply) => {
    await requireAdmin(request, reply);
    const id = idFrom((request.query as { id?: unknown }).id);
    if (!id) return reply.code(400).send({ error: "id is required" });
    const row = await removeMtpHead(id);
    if (!row) return reply.code(404).send({ error: "Model not found" });
    const { deferred } = await afterModelWrite();
    return { ...modelView(row, await routerModelStatuses()), appliesOnNextLoad: deferred };
  });

  app.delete("/v1/admin/local-models/model", async (request, reply) => {
    await requireAdmin(request, reply);
    const id = idFrom((request.query as { id?: unknown }).id);
    if (!id) return reply.code(400).send({ error: "id is required" });
    const row = await getLocalModelRow(id);
    if (!row) return reply.code(404).send({ error: "Model not found" });
    if (row.status !== "ready" && row.status !== "failed") {
      return reply.code(409).send({ error: "This model is still downloading — cancel it instead" });
    }
    if (await modelBusy(id)) {
      return reply
        .code(409)
        .send({ error: "This model is answering someone right now. Try again when it is idle, or disable it first." });
    }
    await unloadModel(id);
    await removeFiles(row);
    await deleteLocalModelRow(id);
    await afterModelWrite();
    return { ok: true };
  });
}
