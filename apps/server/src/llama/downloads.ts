import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat, statfs, truncate } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import {
  deleteLocalModelRow,
  getLocalModelRow,
  insertLocalModelRow,
  listLocalModelRows,
  rowFiles,
  rowMeta,
  rowMmproj,
  rowMtpHead,
  updateLocalModelRow,
  type LocalModelMeta,
  type LocalModelRow,
  type ModelFile,
  type MtpHead,
} from "./catalog.ts";
import { estimateFit, type FitEstimate } from "./fit.ts";
import { readGgufFacts } from "./gguf.ts";
import { thinkingFromTemplate } from "../inference/thinking.ts";
import { downloadErrorMessage, hfHeaders, isRepoId, repoFiles, resolveUrl, type MtpHeadFile, type QuantFile } from "./hf.ts";
import { llamaDir, modelFilePath, repoDir } from "./paths.ts";
import { availableMemory, refreshMemory } from "./memory.ts";

/**
 * Downloading GGUFs from HuggingFace.
 *
 * An in-process queue, two at a time. Each file streams to `<file>.part`,
 * resumes with a `Range` request after a pause or a restart, is checked
 * against the sha256 HuggingFace records for it (its LFS object id), and only
 * then renamed into place — so a file with its final name is always a whole,
 * verified one.
 *
 * Progress lives in memory and is flushed to the row every few seconds; the
 * admin screen polls. A download that was running when the server stopped
 * comes back `paused`, resumable from its `.part` file.
 */

const CONCURRENCY = 2;
const FLUSH_MS = 3000;
/** A transfer that sends nothing for this long is treated as dead. Idle time,
 * not a wall-clock deadline: a multi-gigabyte download is legitimately long,
 * but one that has gone quiet holds a queue slot for nothing.
 * `LLAMA_DOWNLOAD_STALL_MS` exists so a test can observe it without waiting a
 * minute; read at call time. */
function stallMs(): number {
  const n = Number(process.env.LLAMA_DOWNLOAD_STALL_MS);
  return Number.isInteger(n) && n > 0 ? n : 60_000;
}
/** Left free on the disk after a download, so a full disk is refused up front
 * rather than discovered mid-file. */
const DISK_MARGIN_BYTES = 2 * 1024 ** 3;

export class DownloadError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "DownloadError";
    this.status = status;
  }
}

interface Active {
  controller: AbortController;
  /** What aborting means: pause keeps the `.part`, cancel removes everything. */
  intent: "pause" | "cancel" | "shutdown" | null;
  done: Promise<void>;
}

const active = new Map<string, Active>();
/** Live byte counts, ahead of the row by up to FLUSH_MS. */
const liveBytes = new Map<string, number>();
/** Files being written right now, by final path. Two quants of one vision
 * repo share a projector, and with two downloads running at once both rows
 * would otherwise open the same `.part` and interleave into it. */
const inflightTargets = new Map<string, Promise<void>>();
let log: (m: string) => void = () => undefined;
let started = false;

export function liveBytesDone(row: LocalModelRow): number {
  return liveBytes.get(row.id) ?? row.bytesDone;
}

// ── Queueing ────────────────────────────────────────────────────────────────

export interface QueueInput {
  repo?: unknown;
  quant?: unknown;
  /** Path of a vision projector to download with it, or null/absent for none. */
  mmproj?: unknown;
  /** Path of a multi-token-prediction head to download after it, or
   * null/absent for none. */
  mtpHead?: unknown;
  /** Required to queue a model estimated not to fit. */
  force?: unknown;
}

function displayNameFor(repo: string, quant: string): string {
  const name = repo.split("/")[1].replace(/[-_.]gguf$/i, "");
  return `${name} · ${quant}`;
}

/**
 * The fit label for `weightBytes` against the memory as last measured
 * (memory.ts — callers `await refreshMemory()` first when they want it now).
 * `forId` names the model being measured when it is a downloaded one, so its
 * own footprint counts as available when it is the model already loaded.
 */
export function fitFor(
  weightBytes: number,
  meta: LocalModelMeta,
  settings: Record<string, unknown> = {},
  forId?: string,
  mtp: { layers: number; headBytes: number } | null = null,
): FitEstimate {
  const mem = availableMemory(forId);
  return {
    ...estimateFit({
      weightBytes,
      nLayers: meta.nLayers ?? null,
      shape: meta.shape ?? null,
      settings: settings as never,
      memoryBytes: mem.bytes,
      cpu: mem.cpu,
      mtp,
    }),
    breakdown: mem.breakdown,
  };
}

export async function freeDiskBytes(): Promise<number | null> {
  try {
    await mkdir(llamaDir(), { recursive: true });
    const s = await statfs(llamaDir());
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

export async function queueDownload(input: QueueInput, userId: string): Promise<LocalModelRow> {
  if (!isRepoId(input.repo)) throw new DownloadError("That is not a HuggingFace repository name");
  if (typeof input.quant !== "string" || !input.quant) throw new DownloadError("Pick a quant to download");
  const repo = input.repo;
  const files = await repoFiles(repo);
  const option = files.quants.find((q) => q.quant === input.quant);
  if (!option) throw new DownloadError(`"${input.quant}" is not a quant of ${repo}`);
  let mmproj: QuantFile | null = null;
  if (input.mmproj !== undefined && input.mmproj !== null) {
    mmproj = files.mmproj.find((m) => m.path === input.mmproj) ?? null;
    if (!mmproj) throw new DownloadError("That vision projector is not in this repository");
  }
  const head = input.mtpHead !== undefined && input.mtpHead !== null ? pickMtpHead(files.mtpHeads, input.mtpHead) : null;
  const id = `${repo}:${option.quant}`;
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+:[A-Za-z0-9._-]+$/.test(id)) {
    throw new DownloadError("This model's name cannot be used as a model id");
  }

  const existing = await getLocalModelRow(id);
  if (existing && existing.status !== "failed") {
    throw new DownloadError(`${existing.displayName} is already ${existing.status === "ready" ? "downloaded" : "in the download list"}`, 409);
  }

  const sizeBytes = option.sizeBytes + (mmproj?.size ?? 0);
  await refreshMemory();
  const fit = fitFor(sizeBytes, {});
  if (fit.label === "wont-fit" && input.force !== true) {
    throw new DownloadError(
      "This model is estimated not to fit in this machine's memory. Download it anyway only if you mean to change its settings to make it fit.",
      422,
    );
  }
  await checkDiskFor(sizeBytes + (head?.size ?? 0));

  const row = {
    id,
    repo,
    revision: files.revision,
    quant: option.quant,
    files: option.files satisfies ModelFile[],
    mmproj: mmproj satisfies ModelFile | null,
    mtpHead: head ? queuedHead(head, files.revision) : null,
    sizeBytes,
    status: "queued" as const,
    bytesDone: 0,
    error: null,
    enabled: false,
    loadSettings: {},
    meta: {},
    displayName: displayNameFor(repo, option.quant),
    publisher: repo.split("/")[0],
    createdBy: userId,
  };
  const saved = existing ? await updateLocalModelRow(id, { ...row, createdBy: existing.createdBy }) : await insertLocalModelRow(row);
  if (!saved) throw new DownloadError("The download could not be recorded", 500);
  pump();
  return saved;
}

/** Refuse a download the disk cannot take, counting what is already queued:
 * the remaining bytes of models still downloading and of heads not yet done. */
async function checkDiskFor(bytes: number): Promise<void> {
  const free = await freeDiskBytes();
  if (free === null) return;
  const rows = await listLocalModelRows();
  const already =
    rows
      .filter((r) => r.status === "queued" || r.status === "downloading" || r.status === "paused")
      .reduce((n, r) => n + r.sizeBytes - r.bytesDone, 0) +
    rows.reduce((n, r) => {
      const h = rowMtpHead(r);
      return h && (h.status === "queued" || h.status === "downloading") ? n + h.size - (liveBytes.get(headKey(r.id)) ?? h.bytesDone) : n;
    }, 0);
  if (free - already - bytes < DISK_MARGIN_BYTES) {
    throw new DownloadError(
      `Not enough disk space: this needs ${gib(bytes)}, and ${gib(Math.max(0, free - already))} is free after the downloads already queued.`,
      507,
    );
  }
}

/** A head picked from a repo's list, refusing one the runtime cannot load. */
function pickMtpHead(heads: MtpHeadFile[], input: unknown): MtpHeadFile {
  const head = heads.find((h) => h.path === input);
  if (!head) throw new DownloadError("That MTP head is not in this repository");
  if (head.shared) throw new DownloadError(SHARED_HEAD_REFUSAL);
  return head;
}

const SHARED_HEAD_REFUSAL =
  "That head borrows the main model's tensors (a \"shared\" head), which this llama.cpp build cannot load. Choose one without \"shared\" in its name.";

function queuedHead(file: QuantFile, revision: string): MtpHead {
  return { path: file.path, size: file.size, sha256: file.sha256, revision, status: "queued", bytesDone: 0, error: null, layers: null };
}

/** The `active`/`liveBytes` key of a model's head job — beside its own. */
function headKey(id: string): string {
  return `${id}#mtp`;
}

export function liveHeadBytesDone(row: LocalModelRow): number | null {
  const head = rowMtpHead(row);
  if (!head) return null;
  return head.status === "ready" ? head.size : (liveBytes.get(headKey(row.id)) ?? head.bytesDone);
}

let headSettled: () => void = () => undefined;
/** Called when a head finishes (or fails): the preset changes once a head is
 * ready, since MTP may already be on, waiting for it. Registered by the admin
 * routes, which own "anything that changes how models are served". */
export function onMtpHeadSettled(fn: () => void): void {
  headSettled = fn;
}

/**
 * Queue a head for a model already in the list — usually an installed one,
 * which is the point: Flash-Next's head is a 4 GB sidecar, and nobody should
 * download 50 GB of model again to get it. Resolved at the repo's *current*
 * revision, since the model may predate the repo's MTP folder; the head keeps
 * its own revision and directory.
 */
export async function queueMtpHead(id: string, headPath: unknown): Promise<LocalModelRow> {
  const row = await getLocalModelRow(id);
  if (!row) throw new DownloadError("No such model", 404);
  if (rowMeta(row).mtp) throw new DownloadError("This model carries its own MTP head; it needs no other", 409);
  const existing = rowMtpHead(row);
  if (existing && existing.status !== "failed") {
    throw new DownloadError("This model already has an MTP head. Remove it first to choose another.", 409);
  }
  const files = await repoFiles(row.repo);
  const head = pickMtpHead(files.mtpHeads, headPath);
  await checkDiskFor(head.size);
  if (existing) await removeHeadFile(row, existing);
  const saved = await updateLocalModelRow(id, { mtpHead: queuedHead(head, files.revision) });
  if (!saved) throw new DownloadError("No such model", 404);
  pump();
  return saved;
}

/** Remove a model's head — stopping its download if one is running — and
 * turn MTP off when nothing is left to draft with. */
export async function removeMtpHead(id: string): Promise<LocalModelRow | null> {
  const a = active.get(headKey(id));
  if (a) {
    a.intent = "cancel";
    a.controller.abort();
    await a.done;
  }
  const row = await getLocalModelRow(id);
  if (!row) return null;
  const head = rowMtpHead(row);
  if (head) await removeHeadFile(row, head);
  liveBytes.delete(headKey(id));
  const settings = { ...(row.loadSettings as Record<string, unknown>) };
  if (!rowMeta(row).mtp) {
    delete settings.mtp;
    delete settings.mtpDraftMax;
  }
  return updateLocalModelRow(id, { mtpHead: null, loadSettings: settings });
}

/** Delete a head's file and its `.part`, unless another row uses the same
 * file (two quants of one repo sharing a head). */
async function removeHeadFile(row: LocalModelRow, head: MtpHead): Promise<void> {
  const others = (await listLocalModelRows()).filter((r) => r.id !== row.id && r.repo === row.repo);
  const shared = others.some((r) => {
    const h = rowMtpHead(r);
    return h !== null && h.path === head.path && h.revision === head.revision;
  });
  if (shared) return;
  const full = modelFilePath(row.repo, head.revision, head.path);
  await rm(full, { force: true });
  await rm(`${full}.part`, { force: true });
}

function gib(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

// ── Control ─────────────────────────────────────────────────────────────────

export async function pauseDownload(id: string): Promise<LocalModelRow | null> {
  const a = active.get(id);
  if (a) {
    a.intent = "pause";
    a.controller.abort();
    await a.done;
  }
  const row = await getLocalModelRow(id);
  if (!row || row.status === "ready" || row.status === "failed") return row;
  return updateLocalModelRow(id, { status: "paused", bytesDone: liveBytes.get(id) ?? row.bytesDone });
}

export async function resumeDownload(id: string): Promise<LocalModelRow | null> {
  const row = await getLocalModelRow(id);
  if (!row) return null;
  if (row.status !== "paused" && row.status !== "failed") return row;
  const updated = await updateLocalModelRow(id, { status: "queued", error: null });
  pump();
  return updated;
}

/** Stop a download and remove it entirely — row, partial files and any file
 * already completed for it. */
export async function cancelDownload(id: string): Promise<boolean> {
  const a = active.get(id);
  if (a) {
    a.intent = "cancel";
    a.controller.abort();
    await a.done;
  }
  const row = await getLocalModelRow(id);
  if (!row) return false;
  if (row.status === "ready") throw new DownloadError("This model has finished downloading — delete it instead", 409);
  await removeFiles(row);
  liveBytes.delete(id);
  return deleteLocalModelRow(id);
}

/** Remove a model's files. Other rows sharing the repo directory keep theirs. */
export async function removeFiles(row: LocalModelRow): Promise<void> {
  const headJob = active.get(headKey(row.id));
  if (headJob) {
    headJob.intent = "cancel";
    headJob.controller.abort();
    await headJob.done;
  }
  const head = rowMtpHead(row);
  if (head) await removeHeadFile(row, head);
  liveBytes.delete(headKey(row.id));
  const others = (await listLocalModelRows()).filter((r) => r.id !== row.id && r.repo === row.repo);
  const shared = new Set(
    others.filter((r) => r.revision === row.revision).flatMap((r) => [...rowFiles(r).map((f) => f.path), rowMmproj(r)?.path].filter(Boolean)),
  );
  for (const f of [...rowFiles(row), rowMmproj(row)].filter((x): x is ModelFile => x !== null)) {
    if (shared.has(f.path)) continue;
    const full = modelFilePath(row.repo, row.revision, f.path);
    await rm(full, { force: true });
    await rm(`${full}.part`, { force: true });
  }
  if (others.length === 0) await rm(repoDir(row.repo), { recursive: true, force: true });
}

// ── The worker ──────────────────────────────────────────────────────────────

function pump(): void {
  if (!started) return;
  void (async () => {
    if (active.size >= CONCURRENCY) return;
    const rows = await listLocalModelRows().catch(() => [] as LocalModelRow[]);
    for (const row of rows) {
      if (active.size >= CONCURRENCY) break;
      if (row.status === "queued" && !active.has(row.id)) {
        start(row);
        continue;
      }
      // A head waits for its model: it is only of use to a model that loads.
      if (row.status === "ready" && rowMtpHead(row)?.status === "queued" && !active.has(headKey(row.id))) startHead(row);
    }
  })();
}

function start(row: LocalModelRow): void {
  const controller = new AbortController();
  const entry: Active = { controller, intent: null, done: Promise.resolve() };
  active.set(row.id, entry);
  entry.done = run(row, entry)
    .catch(async (err: unknown) => {
      if (entry.intent === "cancel") return;
      if (entry.intent === "pause" || entry.intent === "shutdown") {
        await updateLocalModelRow(row.id, { status: "paused", bytesDone: liveBytes.get(row.id) ?? row.bytesDone }).catch(() => undefined);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      log(`Download of ${row.id} failed: ${message}`);
      await updateLocalModelRow(row.id, { status: "failed", error: message, bytesDone: liveBytes.get(row.id) ?? row.bytesDone }).catch(
        () => undefined,
      );
    })
    .finally(() => {
      active.delete(row.id);
      pump();
    });
}

function startHead(row: LocalModelRow): void {
  const key = headKey(row.id);
  const controller = new AbortController();
  const entry: Active = { controller, intent: null, done: Promise.resolve() };
  active.set(key, entry);
  entry.done = runHead(row, entry)
    .catch(async (err: unknown) => {
      if (entry.intent === "cancel") return;
      const head = rowMtpHead((await getLocalModelRow(row.id)) ?? row);
      if (!head) return;
      // Shutting down leaves it queued: the next boot picks it up and resumes
      // from its `.part`.
      const status = entry.intent === "shutdown" || entry.intent === "pause" ? "queued" : "failed";
      const message = err instanceof Error ? err.message : String(err);
      if (status === "failed") log(`Download of ${row.id}'s MTP head failed: ${message}`);
      await updateLocalModelRow(row.id, {
        mtpHead: { ...head, status, error: status === "failed" ? message : null, bytesDone: liveBytes.get(key) ?? head.bytesDone },
      }).catch(() => undefined);
      if (status === "failed") headSettled();
    })
    .finally(() => {
      active.delete(key);
      pump();
    });
}

/**
 * Download a model's separate MTP head, then read its header and refuse one
 * llama.cpp would refuse at load time — a refused head would otherwise sit in
 * the preset and fail every load of a model that worked before:
 * - no head in it at all (no `nextn_predict_layers`, or no nextn tensors);
 * - a head for another architecture (b11342 rejects the pairing);
 * - a `shared` head, which borrows tensors b11342 has no way to lend.
 * The model row stays `ready` throughout, and serving, on its own.
 */
async function runHead(row: LocalModelRow, entry: Active): Promise<void> {
  const key = headKey(row.id);
  const head = rowMtpHead(row);
  if (!head) return;
  if (!head.sha256) throw new Error(`HuggingFace published no checksum for ${path.basename(head.path)}, so it cannot be verified.`);
  await updateLocalModelRow(row.id, { mtpHead: { ...head, status: "downloading", error: null } });
  const target = modelFilePath(row.repo, head.revision, head.path);
  liveBytes.set(key, 0);
  const other = inflightTargets.get(target);
  if (other) await other.catch(() => undefined);
  const present = await stat(target).catch(() => null);
  if (present?.size !== head.size) {
    if (present) await rm(target, { force: true });
    await mkdir(path.dirname(target), { recursive: true });
    let lastFlush = Date.now();
    const job = downloadFile(row.repo, head.revision, head, target, entry.controller.signal, (bytes) => {
      liveBytes.set(key, bytes);
      if (Date.now() - lastFlush > FLUSH_MS) {
        lastFlush = Date.now();
        void (async () => {
          const now = rowMtpHead((await getLocalModelRow(row.id)) ?? row);
          if (now?.status === "downloading") await updateLocalModelRow(row.id, { mtpHead: { ...now, bytesDone: bytes } });
        })().catch(() => undefined);
      }
    });
    inflightTargets.set(target, job);
    try {
      await job;
    } finally {
      inflightTargets.delete(target);
    }
  }

  const facts = await readGgufFacts(target).catch(() => null);
  const modelArch = rowMeta(row).architecture ?? null;
  const refusal = !facts
    ? "The head's header could not be read."
    : !facts.mtp
      ? `${path.basename(head.path)} carries no MTP head.`
      : facts.mtp.sharedTarget
        ? SHARED_HEAD_REFUSAL
        : modelArch && facts.architecture !== modelArch
          ? `${path.basename(head.path)} is a head for ${facts.architecture ?? "another model"}, not ${modelArch}.`
          : null;
  const current = rowMtpHead((await getLocalModelRow(row.id)) ?? row) ?? head;
  if (refusal) {
    await removeHeadFile(row, head);
    await updateLocalModelRow(row.id, { mtpHead: { ...current, status: "failed", error: refusal, bytesDone: 0 } });
    liveBytes.delete(key);
    log(`Refused ${row.id}'s MTP head: ${refusal}`);
    headSettled();
    return;
  }
  await updateLocalModelRow(row.id, {
    mtpHead: { ...current, status: "ready", error: null, bytesDone: head.size, layers: facts?.mtp?.layers ?? null },
  });
  liveBytes.delete(key);
  log(`Downloaded ${row.id}'s MTP head`);
  headSettled();
}

async function run(row: LocalModelRow, entry: Active): Promise<void> {
  await updateLocalModelRow(row.id, { status: "downloading", error: null });
  const all = [...rowFiles(row), rowMmproj(row)].filter((x): x is ModelFile => x !== null);
  let doneBefore = 0;
  let lastFlush = Date.now();
  liveBytes.set(row.id, 0);

  for (const file of all) {
    if (!file.sha256) throw new Error(`HuggingFace published no checksum for ${path.basename(file.path)}, so it cannot be verified.`);
    const target = modelFilePath(row.repo, row.revision, file.path);
    // Another row may be writing this very file (a shared vision projector):
    // wait for it rather than writing the same `.part` twice.
    const other = inflightTargets.get(target);
    if (other) await other.catch(() => undefined);
    const present = await stat(target).catch(() => null);
    if (present?.size === file.size) {
      // Renamed into place only after its checksum matched, at this very
      // revision (the path carries it), so its presence is proof.
      doneBefore += file.size;
      liveBytes.set(row.id, doneBefore);
      continue;
    }
    if (present) await rm(target, { force: true });
    await mkdir(path.dirname(target), { recursive: true });
    const job = downloadFile(row.repo, row.revision, file, target, entry.controller.signal, (fileBytes) => {
      liveBytes.set(row.id, doneBefore + fileBytes);
      if (Date.now() - lastFlush > FLUSH_MS) {
        lastFlush = Date.now();
        void updateLocalModelRow(row.id, { bytesDone: doneBefore + fileBytes }).catch(() => undefined);
      }
    });
    inflightTargets.set(target, job);
    try {
      await job;
    } finally {
      inflightTargets.delete(target);
    }
    doneBefore += file.size;
  }

  const meta = (await describeFile(row)) ?? {};
  await updateLocalModelRow(row.id, { status: "ready", bytesDone: row.sizeBytes, meta, error: null });
  liveBytes.delete(row.id);
  log(`Downloaded ${row.id}`);
}

async function hashExisting(file: string, hash: ReturnType<typeof createHash>): Promise<void> {
  await pipeline(createReadStream(file), new Transform({
    transform(chunk: Buffer, _enc, cb) {
      hash.update(chunk);
      cb();
    },
  }));
}

async function downloadFile(
  repo: string,
  revision: string,
  file: ModelFile,
  target: string,
  signal: AbortSignal,
  onBytes: (fileBytes: number) => void,
): Promise<void> {
  const part = `${target}.part`;
  let offset = (await stat(part).catch(() => null))?.size ?? 0;
  if (offset > file.size) {
    await truncate(part, 0);
    offset = 0;
  }
  // The user's cancel, plus a stall timer re-armed by every chunk: a transfer
  // that goes quiet is aborted rather than holding a queue slot for ever.
  const STALL_MS = stallMs();
  const stall = new AbortController();
  let stallTimer = setTimeout(() => { stall.abort(new Error("stalled")); }, STALL_MS);
  const touch = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => { stall.abort(new Error("stalled")); }, STALL_MS);
  };
  const combined = AbortSignal.any([signal, stall.signal]);
  let res: Response;
  try {
    res = await fetch(resolveUrl(repo, revision, file.path), {
      signal: combined,
      headers: { ...hfHeaders(), ...(offset > 0 ? { Range: `bytes=${String(offset)}-` } : {}) },
    });
  } catch (err) {
    clearTimeout(stallTimer);
    if (stall.signal.aborted) throw new Error(`${path.basename(file.path)} sent nothing for ${String(STALL_MS / 1000)} s. Resume to try again.`);
    throw err;
  }
  if (!res.ok || !res.body) throw new Error(downloadErrorMessage(res.status, repo));
  // A server that ignores Range answers 200 with the whole file: start over
  // rather than appending the beginning to the middle.
  if (offset > 0 && res.status !== 206) {
    await truncate(part, 0);
    offset = 0;
  }
  const hash = createHash("sha256");
  if (offset > 0) await hashExisting(part, hash);
  let written = offset;
  onBytes(written);
  const body = Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>);
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      touch();
      written += chunk.length;
      // A response that keeps sending past the declared size is stopped here,
      // before it writes past the disk margin reserved for that size — not
      // after the pipeline has finished.
      if (written > file.size) {
        cb(new Error(`${path.basename(file.path)} is larger than HuggingFace said it was; discarded.`));
        return;
      }
      hash.update(chunk);
      onBytes(written);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(body, counter, createWriteStream(part, { flags: offset > 0 ? "a" : "w" }), { signal: combined });
  } catch (err) {
    if (stall.signal.aborted) throw new Error(`${path.basename(file.path)} sent nothing for ${String(STALL_MS / 1000)} s. Resume to try again.`);
    if (written > file.size) await rm(part, { force: true });
    throw err;
  } finally {
    clearTimeout(stallTimer);
  }
  if (written !== file.size) {
    throw new Error(`${path.basename(file.path)} ended after ${String(written)} of ${String(file.size)} bytes. Resume to continue.`);
  }
  // Never conditional: a file without a checksum was refused before this
  // point, so every file that reaches its final name was verified.
  const actual = hash.digest("hex");
  if (actual !== file.sha256) {
    await rm(part, { force: true });
    throw new Error(`${path.basename(file.path)} did not match HuggingFace's checksum and was discarded. Retry to download it again.`);
  }
  await rename(part, target);
}

/** The facts a downloaded file's header gives, or null when it could not be
 * read — the model still loads; the settings sheet just lacks exact ranges and
 * the fit estimate falls back to its rough figure. */
async function describeFile(row: LocalModelRow): Promise<LocalModelMeta | null> {
  try {
    const first = rowFiles(row)[0];
    const facts = await readGgufFacts(modelFilePath(row.repo, row.revision, first.path));
    return {
      architecture: facts.architecture,
      nLayers: facts.nLayers,
      nCtxTrain: facts.nCtxTrain,
      expertCount: facts.expertCount,
      shape: facts.shape,
      thinking: thinkingFromTemplate(facts.chatTemplate),
      // A shared head inside a model's own file would be nonsense; a head is
      // only counted when the file can draft on its own.
      mtp: facts.mtp && !facts.mtp.sharedTarget ? { layers: facts.mtp.layers } : null,
    };
  } catch (err) {
    log(`Could not read ${row.id}'s GGUF header: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Give rows downloaded before a header fact was read that fact: the attention
 * layout (`shape`) and the thinking control (`thinking`, from the chat
 * template). Without the first their fit — and every YaRN stage's — is the
 * rough per-layer figure, several times too high for a hybrid model; without
 * the second the model is offered no thinking level and sent none, so its
 * template's own default (Qwen3.8's is its highest) applies. The files are on
 * this disk, so this is cheap; it runs once per row (a file that describes
 * nothing, or cannot be read, stores null, not absence).
 */
export async function backfillHeaderFacts(rows: LocalModelRow[]): Promise<number> {
  let filled = 0;
  for (const row of rows) {
    const meta = rowMeta(row);
    if (row.status !== "ready" || (meta.shape !== undefined && meta.thinking !== undefined && meta.mtp !== undefined)) continue;
    const facts = await describeFile(row);
    if (!facts) {
      // A header that cannot be read is an answer too. Storing nothing, as this
      // once did, re-parsed an unreadable (or hostile) file on every boot for
      // ever, on the event loop, before the API was serving.
      await updateLocalModelRow(row.id, {
        meta: { ...meta, shape: meta.shape ?? null, thinking: meta.thinking ?? null, mtp: meta.mtp ?? null },
      }).catch(() => undefined);
      continue;
    }
    await updateLocalModelRow(row.id, { meta: { ...meta, ...facts } }).catch(() => undefined);
    filled++;
  }
  return filled;
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

/** Boot: anything that was mid-download when the server stopped is paused,
 * then the queue starts. */
export function startDownloadQueue(logger: (m: string) => void): void {
  log = logger;
  started = true;
  void (async () => {
    const rows = await listLocalModelRows().catch(() => [] as LocalModelRow[]);
    for (const r of rows) {
      if (r.status === "downloading") await updateLocalModelRow(r.id, { status: "paused" }).catch(() => undefined);
      // A head has no pause: one cut off by a stop is simply queued again and
      // resumes from its `.part`.
      const head = rowMtpHead(r);
      if (head?.status === "downloading") await updateLocalModelRow(r.id, { mtpHead: { ...head, status: "queued" } }).catch(() => undefined);
    }
    pump();
    const filled = await backfillHeaderFacts(rows).catch(() => 0);
    if (filled > 0) log(`Read the header of ${String(filled)} downloaded model(s)`);
  })();
}

export async function stopDownloads(): Promise<void> {
  started = false;
  const waits: Promise<void>[] = [];
  for (const a of active.values()) {
    a.intent = "shutdown";
    a.controller.abort();
    waits.push(a.done);
  }
  await Promise.all(waits);
}

/** Test seam. */
export function __isDownloadQueueStarted(): boolean {
  return started;
}
