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
  rowMmproj,
  updateLocalModelRow,
  type LocalModelMeta,
  type LocalModelRow,
  type ModelFile,
} from "./catalog.ts";
import { estimateFit, type FitEstimate } from "./fit.ts";
import { readGgufFacts } from "./gguf.ts";
import { downloadErrorMessage, hfHeaders, isRepoId, repoFiles, resolveUrl, type QuantFile } from "./hf.ts";
import { llamaDir, modelFilePath, repoDir } from "./paths.ts";
import { offloadMemory } from "./router.ts";

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
  /** Required to queue a model estimated not to fit. */
  force?: unknown;
}

function displayNameFor(repo: string, quant: string): string {
  const name = repo.split("/")[1].replace(/[-_.]gguf$/i, "");
  return `${name} · ${quant}`;
}

export function fitFor(weightBytes: number, meta: LocalModelMeta, settings: Record<string, unknown> = {}): FitEstimate {
  const mem = offloadMemory();
  return estimateFit({
    weightBytes,
    nLayers: meta.nLayers ?? null,
    settings: settings as never,
    memoryBytes: mem.bytes,
    cpu: mem.cpu,
  });
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
  const id = `${repo}:${option.quant}`;
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+:[A-Za-z0-9._-]+$/.test(id)) {
    throw new DownloadError("This model's name cannot be used as a model id");
  }

  const existing = await getLocalModelRow(id);
  if (existing && existing.status !== "failed") {
    throw new DownloadError(`${existing.displayName} is already ${existing.status === "ready" ? "downloaded" : "in the download list"}`, 409);
  }

  const sizeBytes = option.sizeBytes + (mmproj?.size ?? 0);
  const fit = fitFor(sizeBytes, {});
  if (fit.label === "wont-fit" && input.force !== true) {
    throw new DownloadError(
      "This model is estimated not to fit in this machine's memory. Download it anyway only if you mean to change its settings to make it fit.",
      422,
    );
  }
  const free = await freeDiskBytes();
  const already = (await listLocalModelRows())
    .filter((r) => r.status === "queued" || r.status === "downloading" || r.status === "paused")
    .reduce((n, r) => n + r.sizeBytes - r.bytesDone, 0);
  if (free !== null && free - already - sizeBytes < DISK_MARGIN_BYTES) {
    throw new DownloadError(
      `Not enough disk space: this needs ${gib(sizeBytes)}, and ${gib(Math.max(0, free - already))} is free after the downloads already queued.`,
      507,
    );
  }

  const row = {
    id,
    repo,
    revision: files.revision,
    quant: option.quant,
    files: option.files satisfies ModelFile[],
    mmproj: mmproj satisfies ModelFile | null,
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
      if (row.status !== "queued" || active.has(row.id)) continue;
      start(row);
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
    const job = downloadFile(row, file, target, entry.controller.signal, (fileBytes) => {
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

  let meta: LocalModelMeta = {};
  try {
    const first = rowFiles(row)[0];
    const facts = await readGgufFacts(modelFilePath(row.repo, row.revision, first.path));
    meta = {
      architecture: facts.architecture,
      nLayers: facts.nLayers,
      nCtxTrain: facts.nCtxTrain,
      expertCount: facts.expertCount,
    };
  } catch (err) {
    // The model still loads; the settings sheet just lacks exact ranges.
    log(`Could not read ${row.id}'s GGUF header: ${err instanceof Error ? err.message : String(err)}`);
  }
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
  row: LocalModelRow,
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
    res = await fetch(resolveUrl(row.repo, row.revision, file.path), {
      signal: combined,
      headers: { ...hfHeaders(), ...(offset > 0 ? { Range: `bytes=${String(offset)}-` } : {}) },
    });
  } catch (err) {
    clearTimeout(stallTimer);
    if (stall.signal.aborted) throw new Error(`${path.basename(file.path)} sent nothing for ${String(STALL_MS / 1000)} s. Resume to try again.`);
    throw err;
  }
  if (!res.ok || !res.body) throw new Error(downloadErrorMessage(res.status, row.repo));
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
    }
    pump();
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
