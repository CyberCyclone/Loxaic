import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readdir, readFile, readlink, rename, stat, statfs, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, db, desc, eq, gt, inArray, isNotNull, isNull, sql } from "@loxaic/db";
import { conversations, messages, usageRecords } from "@loxaic/db/schema";
import type { ContentBlock } from "@loxaic/types";
import { prefillRate } from "../inference/prefill-rate.ts";
import { slotSaveDir } from "./paths.ts";
import { listServableModels, rowMeta } from "./catalog.ts";
import { activeStageIndex, settingsForStage } from "./context-stages.ts";
import { childOnPort } from "./residency.ts";
import { DEFAULT_UBATCH, shapeCost } from "./shape.ts";
import {
  childPortFor,
  getCacheIdentity,
  routerModelStatuses,
  routerPid,
  routerSlots,
  slotAction,
  slotCacheEnabled,
} from "./router.ts";
import {
  estimatedBytes,
  fdinfoPos,
  liveEntries,
  matchSlots,
  usesNear,
  parseManifest,
  promptCacheState,
  DISK_MARGIN_BYTES,
  estimatedSaveBytes,
  SAVED_TTL_MS,
  type DiskSkip,
  type Manifest,
  type PromptCacheView,
  type ReloadEvent,
  type ReloadReason,
  type SavedEntry,
} from "./slot-cache.ts";

/**
 * Saved KV caches on disk, and the router calls that make and use them. The
 * decisions are slot-cache.ts; read it first.
 *
 * Before a reload that keeps a model's cache identity, each conversation a slot
 * holds is warmed (its history ending in its last reply) and that slot saved.
 * Nothing is restored when the model loads: a conversation's saved slot goes
 * back in at its own next turn, under a pill that says so — most saved
 * conversations are never continued, and a restore needs a free slot.
 *
 * Layout: `slots/<model key>.json` (the manifest) beside
 * `slots/<model key>-<conversation id>.bin` (llama.cpp's files; it takes a bare
 * name under `slot-save-path`). The directory is 0700 and every file 0600:
 * llama.cpp creates its files with the umask, so they are tightened after.
 */

const SAVE_TIMEOUT_MS = 120_000;
const WARM_TIMEOUT_MS = 5 * 60_000;
/** Below this much time left before a pass's deadline, no further save starts. */
const MIN_STEP_MS = 2_000;
/** A file no manifest names is a save still being written for this long. */
const ORPHAN_GRACE_MS = 60 * 60_000;
/** A restore reads at disk speed; this bounds a stuck one. */
const RESTORE_TIMEOUT_MS = 5 * 60_000;
const PROGRESS_EVERY_MS = 500;
/** As long as a context-stage switch waits for its load. */
const LOAD_TIMEOUT_MS = 15 * 60_000;
const SWEEP_EVERY_MS = 60 * 60_000;
let sweeper: NodeJS.Timeout | null = null;

const bootAt = Date.now();
const reloads = new Map<string, ReloadEvent>();
/** Every model's child went with the router (a crash, a restart). */
let routerGone: ReloadEvent | null = null;
/** Saves skipped for want of disk, by model then conversation: what the
 * composer's banner says instead of "reloaded". Bounded per model. */
const diskSkips = new Map<string, Map<string, DiskSkip>>();
const MAX_SKIPS_PER_MODEL = 200;
/** The newest skip per model, for the admin's Host models card; cleared by
 * that model's next save that worked. */
const lastDiskSkip = new Map<string, DiskSkip>();

function recordDiskSkip(model: string, conversationIds: string[], skip: DiskSkip): void {
  let byConv = diskSkips.get(model);
  if (!byConv) {
    byConv = new Map();
    diskSkips.set(model, byConv);
  }
  for (const id of conversationIds) {
    byConv.delete(id);
    if (byConv.size >= MAX_SKIPS_PER_MODEL) {
      const oldest = byConv.keys().next();
      if (!oldest.done) byConv.delete(oldest.value);
    }
    byConv.set(id, skip);
  }
  lastDiskSkip.set(model, skip);
}

/** The newest save skipped for want of disk, across models, while it stands. */
export function slotCacheDiskWarning(): { at: number; model: string; needBytes: number; freeBytes: number; dir: string } | null {
  let newest: { model: string; skip: DiskSkip } | null = null;
  for (const [model, skip] of lastDiskSkip) if (!newest || skip.at > newest.skip.at) newest = { model, skip };
  return newest ? { at: newest.skip.at, model: newest.model, needBytes: newest.skip.needBytes, freeBytes: newest.skip.freeBytes, dir: slotSaveDir() } : null;
}
/** When each conversation was last re-read into a model with no turn of its
 * own (a context-stage switch's warm-up), by `model|conversation`. */
const warmedAt = new Map<string, number>();
const MAX_WARMED = 500;

/** A warm-up read `conversationId` into `model`: its cache is there now, as
 * after a turn. */
export function recordWarmed(model: string, conversationId: string): void {
  const key = `${model}|${conversationId}`;
  warmedAt.delete(key);
  if (warmedAt.size >= MAX_WARMED) {
    const oldest = warmedAt.keys().next();
    if (!oldest.done) warmedAt.delete(oldest.value);
  }
  warmedAt.set(key, Date.now());
}

/** A model's key in file names: its id may hold "/" and ":". */
function modelKey(model: string): string {
  return createHash("sha256").update(model).digest("hex").slice(0, 16);
}

function manifestPath(model: string): string {
  return path.join(slotSaveDir(), `${modelKey(model)}.json`);
}

/** The slot directory, created 0700 whatever the umask. */
export async function ensureSlotDir(): Promise<string> {
  const dir = slotSaveDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  return dir;
}

async function readManifest(model: string): Promise<Manifest | null> {
  try {
    const m = parseManifest(await readFile(manifestPath(model), "utf8"));
    return m?.model === model ? m : null;
  } catch {
    return null;
  }
}

async function writeManifest(m: Manifest): Promise<void> {
  const target = manifestPath(m.model);
  // An empty one is kept only for its measured size, which the next save uses.
  if (m.entries.length === 0 && !m.bytesPerToken) {
    await unlink(target).catch(() => undefined);
    return;
  }
  // Per write, not per process: two writers sharing a name would splice.
  const tmp = `${target}.${String(process.pid)}-${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(m), { mode: 0o600 });
  await rename(tmp, target);
}

async function removeFile(file: string): Promise<void> {
  await unlink(path.join(slotSaveDir(), file)).catch(() => undefined);
}

/** Serialises everything that reads or writes one model's set. */
const chains = new Map<string, Promise<unknown>>();
function withModel<T>(model: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(model) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => undefined);
  chains.set(model, tail);
  void tail.then(() => {
    if (chains.get(model) === tail) chains.delete(model);
  });
  return next;
}

// ── Reloads ─────────────────────────────────────────────────────────────────

/** A model's child was (or is about to be) unloaded: every conversation's
 * cache in it is gone unless it was saved. */
export function recordReload(model: string, reason: ReloadReason): void {
  reloads.set(model, { at: Date.now(), reason });
}

/** The router itself went: every model's child with it. */
export function recordRouterGone(reason: ReloadReason): void {
  routerGone = { at: Date.now(), reason };
}

function lastReloadOf(model: string): ReloadEvent | null {
  const own = reloads.get(model) ?? null;
  if (!routerGone) return own;
  return !own || routerGone.at > own.at ? routerGone : own;
}

/** Whether `model`'s process has gone since `at`: a saved entry is only worth
 * restoring then. One saved for an unload that was refused, or a reload that
 * was put off, still has its live cache in the slot it came from. A save from
 * before this server started always qualifies. */
function reloadedSince(model: string, at: number): boolean {
  return at < bootAt || (lastReloadOf(model)?.at ?? 0) >= at;
}

// ── Saving ──────────────────────────────────────────────────────────────────

interface Use {
  conversationId: string;
  tokens: number;
  at: number;
}

/** Each conversation's newest turn on `model` within the saved TTL. */
async function recentUses(model: string): Promise<Use[]> {
  const rows = await db
    .selectDistinctOn([usageRecords.conversationId], {
      conversationId: usageRecords.conversationId,
      tokens: sql<number>`(${usageRecords.inputTokens} + ${usageRecords.outputTokens})::float8`,
      at: usageRecords.createdAt,
    })
    .from(usageRecords)
    .innerJoin(conversations, and(eq(conversations.id, usageRecords.conversationId), isNull(conversations.deletedAt)))
    .where(
      and(
        eq(usageRecords.model, model),
        gt(usageRecords.createdAt, new Date(Date.now() - SAVED_TTL_MS)),
        isNotNull(usageRecords.conversationId),
        isNull(usageRecords.purpose),
      ),
    )
    .orderBy(usageRecords.conversationId, desc(usageRecords.createdAt));
  return rows.flatMap((r) => (r.conversationId ? [{ conversationId: r.conversationId, tokens: r.tokens, at: r.at.getTime() }] : []));
}

/** Each conversation's newest user message as text. */
async function lastUserTexts(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .selectDistinctOn([messages.conversationId], { conversationId: messages.conversationId, content: messages.content })
    .from(messages)
    // A message a rewind removed is not what the slot's prompt ends with.
    .where(and(inArray(messages.conversationId, ids), eq(messages.authorType, "user"), isNull(messages.deletedAt)))
    .orderBy(messages.conversationId, desc(messages.lamport), desc(messages.createdAt));
  return new Map(
    rows.map((r) => [
      r.conversationId,
      ((r.content ?? []) as ContentBlock[]).flatMap((b) => (b.kind === "text" ? [b.text] : [])).join("\n"),
    ]),
  );
}

/** What a save of `tokens` of `model` is expected to take (slot-cache.ts):
 * the manifest's measured figure, else the model's cache shape at its current
 * stage's cache types. */
async function expectedBytes(model: string, tokens: number, measuredPerToken: number | undefined): Promise<number> {
  if (measuredPerToken) return estimatedSaveBytes(tokens, { measuredPerToken });
  const row = (await listServableModels()).find((r) => r.id === model);
  const shape = row ? rowMeta(row).shape : null;
  if (!row || !shape) return estimatedSaveBytes(tokens, {});
  const settings = settingsForStage(row, activeStageIndex(row));
  const cost = shapeCost(shape, {
    ctx: tokens,
    slots: 1,
    ubatch: typeof settings.ubatchSize === "number" ? settings.ubatchSize : DEFAULT_UBATCH,
    cacheTypeK: String(settings.cacheTypeK ?? "f16"),
    cacheTypeV: String(settings.cacheTypeV ?? "f16"),
    flashAttention: settings.flashAttention !== "off",
  });
  return estimatedSaveBytes(tokens, { shape: cost });
}

async function freeBytes(dir: string): Promise<number | null> {
  // Tests only: a file holding the free bytes to report, read at call time.
  const fake = process.env.LOXAIC_SLOT_FREE_FILE;
  if (fake) {
    const text = await readFile(fake, "utf8").catch(() => null);
    if (text !== null && Number.isFinite(Number(text.trim()))) return Number(text.trim());
  }
  try {
    const s = await statfs(dir);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

/**
 * Warm `conversationId` in slot `slotId` of `model`: send its history ending in
 * its last reply, so the slot holds exactly what its next turn extends
 * (slot-cache.ts). Resolves to the prompt's size, or null when it could not
 * be warmed (no shape since this server started, another model's, out of
 * time, stopped). Throws only what the request itself throws.
 */
async function warm(conversationId: string, model: string, slotId: number, timeoutMs: number, signal?: AbortSignal): Promise<number | null> {
  const { lastRequestShape } = await import("../streams/runs/request-shape.ts");
  if (lastRequestShape(conversationId)?.model !== model) return null;
  const { warmer } = await import("../streams/runs/stageRun.ts");
  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); }, timeoutMs);
  const both = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
  try {
    const tokens = await warmer(conversationId, model, { slotId })(both, () => undefined);
    return both.aborted ? null : tokens;
  } finally {
    clearTimeout(timer);
  }
}

export interface SaveOptions {
  /** When the whole pass must be over (epoch ms): each warm-up and save is
   * cut to what is left. */
  deadline?: number;
  /** The caller's: a Stop ends the pass where it is. */
  signal?: AbortSignal;
}

/**
 * Save every conversation `model`'s slots hold, before an unload that keeps
 * its cache identity. `identity` is what the loaded process was started with.
 * Never throws: a failed save only means a re-read later. `deadline` bounds the
 * whole pass (a shutdown cannot wait for minutes).
 */
export async function saveModel(model: string, identity: string, opts: SaveOptions = {}): Promise<void> {
  if (!slotCacheEnabled()) return;
  const deadline = opts.deadline ?? Number.POSITIVE_INFINITY;
  await withModel(model, async () => {
    try {
      await saveLocked(model, identity, deadline, opts.signal);
    } catch (err) {
      console.error(`[llama] could not save ${model}'s caches: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}

async function saveLocked(model: string, identity: string, deadline: number, signal?: AbortSignal): Promise<void> {
  const slots = await routerSlots(model);
  if (!slots) return;
  const uses = await recentUses(model);
  // Two conversations whose turns cost the same are told apart by their last
  // user message, read only for those.
  const tied = new Set(slots.flatMap((s) => { const near = usesNear(s, uses); return near.length > 1 ? near.map((u) => u.conversationId) : []; }));
  const matched = matchSlots(slots, uses, await lastUserTexts([...tied]));
  if (matched.size === 0) return;
  const dir = await ensureSlotDir();
  const previous = await readManifest(model);
  const kept = previous?.identity === identity ? previous.entries : [];
  if (previous && previous.identity !== identity) for (const e of previous.entries) await removeFile(e.file);
  const entries = new Map(kept.map((e) => [e.conversationId, e]));
  let perToken = previous?.identity === identity ? previous.bytesPerToken : undefined;
  let savedAny = false;
  const atOf = (id: string) => uses.find((u) => u.conversationId === id)?.at ?? 0;
  // Newest first: if time runs out, the conversation most likely continued
  // next is the one that was kept.
  const order = [...matched].sort(([, a], [, b]) => atOf(b) - atOf(a));
  const left = () => deadline - Date.now();
  try {
    for (const [i, [slotId, conversationId]] of order.entries()) {
      if (signal?.aborted || left() < MIN_STEP_MS) break;
      try {
        const kept = await saveOne(model, slotId, conversationId, dir, perToken, left, signal);
        if (kept === "no-disk") {
          // This one and every one after it: the disk will not have grown.
          const skip = diskSkipsNow.at(-1);
          if (skip) recordDiskSkip(model, order.slice(i).map(([, c]) => c), skip);
          break;
        }
        if (kept) {
          entries.set(conversationId, kept);
          if (kept.bytes > 0) perToken = Math.ceil(kept.bytes / kept.tokens);
          savedAny = true;
        }
      } catch (err) {
        // One conversation's failure (a warm-up the backend refused) costs that
        // conversation alone; the others are still saved and recorded.
        console.warn(`[llama] could not save ${model}'s cache for ${conversationId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } finally {
    diskSkipsNow.length = 0;
    if (savedAny) lastDiskSkip.delete(model);
    // Always written: files saved before a failure must be in it, or the
    // sweep deletes them as orphans.
    await writeManifest({ version: 1, model, identity, entries: [...entries.values()], ...(perToken ? { bytesPerToken: perToken } : {}) });
  }
}

/** The disk check's last refusal within the pass under way (the lock is held). */
const diskSkipsNow: DiskSkip[] = [];

/**
 * Warm and save one conversation's slot. Resolves to its entry, null when
 * nothing was kept, or "no-disk" when the disk is too full for it.
 */
async function saveOne(
  model: string,
  slotId: number,
  conversationId: string,
  dir: string,
  perToken: number | undefined,
  left: () => number,
  signal?: AbortSignal,
): Promise<SavedEntry | "no-disk" | null> {
  const warmed = await warm(conversationId, model, slotId, Math.min(WARM_TIMEOUT_MS, left()), signal);
  if (warmed === null || signal?.aborted || left() < MIN_STEP_MS) return null;
  // The slot must hold exactly the warm-up: idle, at its size. Another
  // conversation's request that took it in the meantime is never saved as
  // this one's.
  const slot = (await routerSlots(model))?.find((s) => s.id === slotId);
  if (!slot || slot.busy || !slot.tokens || Math.abs(slot.tokens - warmed) > 1) return null;
  const expectedTokens = slot.tokens;
  const expected = await expectedBytes(model, expectedTokens, perToken);
  const free = await freeBytes(dir);
  if (free !== null && free < expected + DISK_MARGIN_BYTES) {
    diskSkipsNow.push({ at: Date.now(), needBytes: expected, freeBytes: free });
    console.warn(
      `[llama] not saving ${model}'s caches: one needs about ${String(Math.round(expected / 1024 ** 2))} MiB ` +
        `and ${String(Math.round(free / 1024 ** 2))} MiB is free, less the ${String(Math.round(DISK_MARGIN_BYTES / 1024 ** 3))} GB kept spare`,
    );
    return "no-disk";
  }
  const file = `${modelKey(model)}-${conversationId}.bin`;
  try {
    const saved = await slotAction(model, slotId, "save", file, Math.min(SAVE_TIMEOUT_MS, Math.max(left(), 1_000)), signal);
    await chmod(path.join(dir, file), 0o600);
    // What was written must be what was warmed: a request that took the slot
    // between the check above and the save is someone else's conversation.
    if (saved.tokens <= 0 || saved.tokens !== expectedTokens) {
      await removeFile(file);
      return null;
    }
    console.log(
      `[llama] saved ${model}'s cache for ${conversationId}: ${String(saved.tokens)} tokens, ` +
        `${String(Math.round(saved.bytes / 1024 ** 2))} MiB in ${String(Math.round(saved.ms))} ms`,
    );
    return { conversationId, file, tokens: saved.tokens, bytes: saved.bytes, saveMs: saved.ms, savedAt: Date.now() };
  } catch (err) {
    await removeFile(file);
    // llama.cpp says only "Unable to save slot"; a disk that is now short of
    // what the file needed is the likely why, and is said as that.
    const after = await freeBytes(dir);
    if (after !== null && after < expected) {
      diskSkipsNow.push({ at: Date.now(), needBytes: expected, freeBytes: after });
      console.warn(`[llama] ran out of disk saving ${model}'s cache for ${conversationId}`);
      return "no-disk";
    }
    throw err;
  }
}

/** Save every loaded model before the router stops (a restart, a shutdown). */
export async function saveLoadedModels(deadline: number): Promise<void> {
  if (!slotCacheEnabled()) return;
  const statuses = await routerModelStatuses();
  for (const [id, s] of statuses) {
    if (s.value !== "loaded") continue;
    const identity = getCacheIdentity(id);
    if (identity) await saveModel(id, identity, { deadline });
  }
}

// ── Restoring ───────────────────────────────────────────────────────────────

export interface CacheProgress {
  step: "restoring" | "restored" | "failed";
  tokens: number;
  bytesTotal: number;
  bytesDone: number;
  /** The figure is elapsed time against the save's, not what was read. */
  estimated: boolean;
}

/** Slots this server restored into and no request has used yet. */
const claimed = new Map<string, Set<number>>();

/** How far the child serving `model` has read `file`, from `/proc` (Linux),
 * or null where that cannot be told. */
async function readPosition(model: string, file: string): Promise<number | null> {
  if (process.platform !== "linux") return null;
  const parent = routerPid();
  const port = childPortFor(model);
  if (!parent || !port) return null;
  const pid = await childOnPort(parent, port);
  if (!pid) return null;
  const target = path.join(slotSaveDir(), file);
  try {
    for (const fd of await readdir(`/proc/${String(pid)}/fd`)) {
      const link = await readlink(`/proc/${String(pid)}/fd/${fd}`).catch(() => "");
      if (link === target) return fdinfoPos(await readFile(`/proc/${String(pid)}/fdinfo/${fd}`, "utf8"));
    }
  } catch {
    // gone, or not ours to read
  }
  return null;
}

async function dropEntry(model: string, conversationId: string): Promise<void> {
  const m = await readManifest(model);
  if (!m) return;
  const entry = m.entries.find((e) => e.conversationId === conversationId);
  if (entry) await removeFile(entry.file);
  await writeManifest({ ...m, entries: m.entries.filter((e) => e.conversationId !== conversationId) });
}

/**
 * Put `conversationId`'s saved cache back into a free slot of `model`, just
 * before its turn's request. Yields progress for the pill; yields nothing when
 * there is nothing saved. The entry is used once, whatever happens: a failed
 * restore costs the re-read there would have been anyway.
 */
export async function* restoreConversation(
  model: string,
  conversationId: string,
  signal?: AbortSignal,
): AsyncGenerator<CacheProgress> {
  if (!slotCacheEnabled()) return;
  const manifest = await readManifest(model);
  const entry = manifest?.entries.find((e) => e.conversationId === conversationId);
  if (!manifest || !entry) return;
  if (manifest.identity !== getCacheIdentity(model)) {
    // Loaded with something the cache was not computed under: every entry
    // is useless, not just this one. Read again under the lock: a save may
    // have written since.
    await withModel(model, async () => {
      const current = await readManifest(model);
      if (!current || current.identity === getCacheIdentity(model)) return;
      for (const e of current.entries) await removeFile(e.file);
      await writeManifest({ ...current, entries: [] });
    });
    return;
  }
  if (!reloadedSince(model, entry.savedAt)) {
    // Never unloaded after all: the live cache is still in its slot, and a
    // copy would only take room beside it.
    await withModel(model, () => dropEntry(model, conversationId));
    return;
  }
  const base = { tokens: entry.tokens, bytesTotal: entry.bytes };
  const queue: CacheProgress[] = [];
  let wake: (() => void) | null = null;
  const push = (p: CacheProgress) => {
    queue.push(p);
    wake?.();
  };
  const job = withModel(model, () => restoreLocked(model, entry, push, signal));
  // A property, not a local: the closure sets it, and the loop must see that.
  const state = { done: false };
  void job.finally(() => {
    state.done = true;
    wake?.();
  });
  yield { step: "restoring", ...base, bytesDone: 0, estimated: process.platform !== "linux" };
  while (!state.done || queue.length > 0) {
    if (queue.length === 0) {
      await new Promise<void>((r) => { wake = r; });
      wake = null;
      continue;
    }
    const next = queue.shift();
    if (next) yield next;
  }
}

async function restoreLocked(
  model: string,
  entry: SavedEntry,
  push: (p: CacheProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  const base = { tokens: entry.tokens, bytesTotal: entry.bytes };
  try {
    if (signal?.aborted) return;
    // An unloaded model (an admin's Unload, a restart) would otherwise be
    // loaded by the router for the request itself — after this, with no slot
    // to restore into. Loaded here instead, making room as a request would.
    if ((await routerModelStatuses()).get(model)?.value !== "loaded") {
      const { loadWithRoom } = await import("./room.ts");
      if (!(await loadWithRoom(model, signal ?? new AbortController().signal, LOAD_TIMEOUT_MS))) {
        push({ step: "failed", ...base, bytesDone: 0, estimated: false });
        return;
      }
    }
    const slots = await routerSlots(model);
    const taken = claimed.get(model) ?? new Set<number>();
    const free = slots?.find((s) => !s.busy && !s.tokens && !taken.has(s.id));
    if (!free) {
      push({ step: "failed", ...base, bytesDone: 0, estimated: false });
      return;
    }
    const started = Date.now();
    const reading = { finished: false };
    // Read through a call: the checker takes the property to stay as last
    // tested, and cannot see the restore settling during the await.
    const finished = () => reading.finished;
    // The turn's signal: a Stop frees this model's queue at once rather than
    // after the read (llama.cpp may still finish it into the slot).
    const restore = slotAction(model, free.id, "restore", entry.file, RESTORE_TIMEOUT_MS, signal).finally(() => { reading.finished = true; });
    while (!finished()) {
      await Promise.race([restore.catch(() => undefined), new Promise((r) => setTimeout(r, PROGRESS_EVERY_MS))]);
      if (finished()) break;
      const pos = await readPosition(model, entry.file);
      push(
        pos !== null
          ? { step: "restoring", ...base, bytesDone: Math.min(pos, entry.bytes), estimated: false }
          : { step: "restoring", ...base, bytesDone: estimatedBytes(entry.bytes, entry.saveMs, Date.now() - started), estimated: true },
      );
    }
    const result = await restore;
    taken.add(free.id);
    claimed.set(model, taken);
    // Claimed until the turn's request has had time to take it.
    setTimeout(() => { claimed.get(model)?.delete(free.id); }, 60_000).unref();
    push({ step: "restored", tokens: result.tokens, bytesTotal: entry.bytes, bytesDone: entry.bytes, estimated: false });
    console.log(`[llama] restored ${model}'s cache for ${entry.conversationId}: ${String(result.tokens)} tokens in ${String(Math.round(result.ms))} ms`);
  } catch (err) {
    console.warn(`[llama] could not restore ${model}'s cache for ${entry.conversationId}: ${err instanceof Error ? err.message : String(err)}`);
    push({ step: "failed", ...base, bytesDone: 0, estimated: false });
  } finally {
    await dropEntry(model, entry.conversationId);
  }
}

/** A model was reloaded: slots this server restored into are fresh again. */
export function forgetClaims(model: string): void {
  claimed.delete(model);
}

// ── What a conversation will find ───────────────────────────────────────────

/** For the composer's banner (`GET /v1/conversations/:id/prompt-cache`). */
export async function conversationCacheView(conversationId: string, model: string, hostModel: boolean): Promise<PromptCacheView> {
  const rows = await db
    .select({
      model: usageRecords.model,
      tokens: sql<number>`(${usageRecords.inputTokens} + ${usageRecords.outputTokens})::float8`,
      at: usageRecords.createdAt,
    })
    .from(usageRecords)
    .where(and(eq(usageRecords.conversationId, conversationId), isNull(usageRecords.purpose)))
    .orderBy(desc(usageRecords.createdAt))
    .limit(1);
  const last = rows.at(0);
  const warmed = warmedAt.get(`${model}|${conversationId}`) ?? 0;
  const manifest = slotCacheEnabled() ? await readManifest(model) : null;
  const entry = manifest?.identity === getCacheIdentity(model)
    ? manifest.entries.find((e) => e.conversationId === conversationId)
    : undefined;
  return promptCacheState({
    // A warm-up since the turn read it back in as the turn would have.
    lastTurn: last ? { model: last.model, tokens: last.tokens, at: Math.max(last.at.getTime(), last.model === model ? warmed : 0) } : null,
    model,
    hostModel,
    saved: entry && reloadedSince(model, entry.savedAt) ? { tokens: entry.tokens } : null,
    lastReload: lastReloadOf(model),
    diskSkip: diskSkips.get(model)?.get(conversationId) ?? null,
    bootAt,
    prefillRate: prefillRate(model),
  });
}

// ── Housekeeping ────────────────────────────────────────────────────────────

/**
 * Delete what nobody will restore: files no manifest names, entries past the
 * TTL or for conversations that are gone, and every set whose identity no
 * longer matches its model. Runs at boot, after each preset write and hourly.
 * Each manifest is rewritten under its model's lock, so a save under way is
 * never written over; an unnamed file is a save still being written until it
 * is an hour old.
 */
export async function sweepSlotCache(): Promise<void> {
  sweeper ??= setInterval(() => { void sweepSlotCache().catch(() => undefined); }, SWEEP_EVERY_MS).unref();
  const dir = slotSaveDir();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  const keep = new Set<string>();
  for (const name of names.filter((n) => n.endsWith(".json"))) {
    const found = parseManifest(await readFile(path.join(dir, name), "utf8").catch(() => ""));
    if (!found || `${modelKey(found.model)}.json` !== name) {
      await unlink(path.join(dir, name)).catch(() => undefined);
      continue;
    }
    await withModel(found.model, async () => {
      const m = await readManifest(found.model);
      if (!m) return;
      const ids = m.entries.map((e) => e.conversationId);
      const existing = ids.length
        ? new Set(
            (await db
              .select({ id: conversations.id })
              .from(conversations)
              .where(and(inArray(conversations.id, ids), isNull(conversations.deletedAt)))).map((r) => r.id),
          )
        : new Set<string>();
      const identity = getCacheIdentity(m.model);
      // No identity: the model is not in the preset (disabled, deleted, or the
      // runtime is not up yet) — kept for the TTL, judged when it can be.
      const valid = identity === null || identity === m.identity;
      const live = valid ? liveEntries(m.entries, Date.now(), (id) => existing.has(id)) : [];
      for (const e of m.entries) if (!live.includes(e)) await removeFile(e.file);
      await writeManifest({ ...m, entries: live });
      for (const e of live) keep.add(e.file);
    });
  }
  for (const name of names) {
    if (!name.endsWith(".bin") || keep.has(name)) continue;
    const at = await stat(path.join(dir, name)).then((st) => st.mtimeMs, () => null);
    if (at !== null && Date.now() - at > ORPHAN_GRACE_MS) await unlink(path.join(dir, name)).catch(() => undefined);
  }
}

/**
 * A conversation was deleted or erased: its saved caches go now, not at the
 * next sweep. They hold its whole prompt as tokens, which read back as text.
 */
export async function forgetConversationCaches(conversationIds: readonly string[]): Promise<void> {
  if (conversationIds.length === 0) return;
  const ids = new Set(conversationIds);
  let names: string[];
  try {
    names = await readdir(slotSaveDir());
  } catch {
    return;
  }
  for (const name of names.filter((n) => n.endsWith(".json"))) {
    const found = parseManifest(await readFile(path.join(slotSaveDir(), name), "utf8").catch(() => ""));
    if (!found?.entries.some((e) => ids.has(e.conversationId))) continue;
    await withModel(found.model, async () => {
      const m = await readManifest(found.model);
      if (!m) return;
      for (const e of m.entries) if (ids.has(e.conversationId)) await removeFile(e.file);
      await writeManifest({ ...m, entries: m.entries.filter((e) => !ids.has(e.conversationId)) });
    });
  }
  // A save in progress names its file after the conversation; the sweep's
  // grace would otherwise keep it an hour.
  for (const name of names) {
    if (name.endsWith(".bin") && [...ids].some((id) => name.endsWith(`-${id}.bin`))) {
      await unlink(path.join(slotSaveDir(), name)).catch(() => undefined);
    }
  }
}

/** Test seam. */
export function __resetSlotStoreForTest(): void {
  if (sweeper) clearInterval(sweeper);
  sweeper = null;
  reloads.clear();
  warmedAt.clear();
  routerGone = null;
  diskSkips.clear();
  lastDiskSkip.clear();
  claimed.clear();
}
