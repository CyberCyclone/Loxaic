import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, readFile, readlink, rename, statfs, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, db, desc, eq, gt, inArray, isNotNull, isNull, sql } from "@loxaic/db";
import { conversations, messages, usageRecords } from "@loxaic/db/schema";
import type { ContentBlock } from "@loxaic/types";
import { prefillRate } from "../inference/prefill-rate.ts";
import { slotSaveDir } from "./paths.ts";
import { childOnPort } from "./residency.ts";
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
  SAVED_TTL_MS,
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

/** Free disk a save must leave behind. */
const DISK_MARGIN_BYTES = 2 * 1024 ** 3;
/** A save's size before one has been measured for the model: more than any
 * model on Pheonix needs per token (Qwen3.6-35B-A3B measured ~13 KiB). */
const DEFAULT_BYTES_PER_TOKEN = 64 * 1024;
const SAVE_TIMEOUT_MS = 120_000;
const WARM_TIMEOUT_MS = 5 * 60_000;
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
const bytesPerToken = new Map<string, number>();
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
  if (m.entries.length === 0) {
    await unlink(target).catch(() => undefined);
    return;
  }
  const tmp = `${target}.${String(process.pid)}.tmp`;
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
    .where(and(inArray(messages.conversationId, ids), eq(messages.authorType, "user")))
    .orderBy(messages.conversationId, desc(messages.lamport), desc(messages.createdAt));
  return new Map(
    rows.map((r) => [
      r.conversationId,
      ((r.content ?? []) as ContentBlock[]).flatMap((b) => (b.kind === "text" ? [b.text] : [])).join("\n"),
    ]),
  );
}

async function freeBytes(dir: string): Promise<number | null> {
  try {
    const s = await statfs(dir);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

/** Warm `conversationId` on `model`: send its history ending in its last reply,
 * so the slot holds exactly what its next turn extends (slot-cache.ts).
 * False when it could not be (no shape since this server started, or another
 * model's). */
async function warm(conversationId: string, model: string): Promise<boolean> {
  const { lastRequestShape } = await import("../streams/runs/request-shape.ts");
  if (lastRequestShape(conversationId)?.model !== model) return false;
  const { warmer } = await import("../streams/runs/stageRun.ts");
  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); }, WARM_TIMEOUT_MS);
  try {
    await warmer(conversationId, model)(controller.signal, () => undefined);
    return !controller.signal.aborted;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Save every conversation `model`'s slots hold, before an unload that keeps
 * its cache identity. `identity` is what the loaded process was started with.
 * Never throws: a failed save only means a re-read later. `deadline` bounds the
 * whole pass (a shutdown cannot wait for minutes).
 */
export async function saveModel(model: string, identity: string, deadline = Number.POSITIVE_INFINITY): Promise<void> {
  if (!slotCacheEnabled()) return;
  await withModel(model, async () => {
    try {
      await saveLocked(model, identity, deadline);
    } catch (err) {
      console.error(`[llama] could not save ${model}'s caches: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}

async function saveLocked(model: string, identity: string, deadline: number): Promise<void> {
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
  const order = [...matched.values()].sort(
    (a, b) => (uses.find((u) => u.conversationId === b)?.at ?? 0) - (uses.find((u) => u.conversationId === a)?.at ?? 0),
  );
  for (const conversationId of order) {
    if (Date.now() > deadline) break;
    if (!(await warm(conversationId, model))) continue;
    const after = await routerSlots(model);
    const slot = after
      ?.filter((s) => s.task != null && !s.busy)
      .sort((a, b) => (b.task ?? 0) - (a.task ?? 0))
      .at(0);
    if (!slot?.tokens) continue;
    const need = slot.tokens * (bytesPerToken.get(model) ?? DEFAULT_BYTES_PER_TOKEN) + DISK_MARGIN_BYTES;
    const free = await freeBytes(dir);
    if (free !== null && free < need) {
      console.warn(`[llama] not saving ${model}'s cache for ${conversationId}: ${String(Math.round(free / 1024 ** 3))} GB free`);
      break;
    }
    const file = `${modelKey(model)}-${conversationId}.bin`;
    try {
      const saved = await slotAction(model, slot.id, "save", file, Math.min(SAVE_TIMEOUT_MS, Math.max(deadline - Date.now(), 1_000)));
      await chmod(path.join(dir, file), 0o600);
      if (saved.tokens <= 0) {
        await removeFile(file);
        continue;
      }
      if (saved.bytes > 0) bytesPerToken.set(model, Math.ceil(saved.bytes / saved.tokens));
      entries.set(conversationId, {
        conversationId,
        file,
        tokens: saved.tokens,
        bytes: saved.bytes,
        saveMs: saved.ms,
        savedAt: Date.now(),
      });
      console.log(`[llama] saved ${model}'s cache for ${conversationId}: ${String(saved.tokens)} tokens, ${String(Math.round(saved.bytes / 1024 ** 2))} MiB in ${String(Math.round(saved.ms))} ms`);
    } catch (err) {
      await removeFile(file);
      console.warn(`[llama] could not save ${model}'s cache for ${conversationId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  await writeManifest({ version: 1, model, identity, entries: [...entries.values()] });
}

/** Save every loaded model before the router stops (a restart, a shutdown). */
export async function saveLoadedModels(deadline: number): Promise<void> {
  if (!slotCacheEnabled()) return;
  const statuses = await routerModelStatuses();
  for (const [id, s] of statuses) {
    if (s.value !== "loaded") continue;
    const identity = getCacheIdentity(id);
    if (identity) await saveModel(id, identity, deadline);
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
    // is useless, not just this one.
    for (const e of manifest.entries) await removeFile(e.file);
    await writeManifest({ ...manifest, entries: [] });
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
    const restore = slotAction(model, free.id, "restore", entry.file, RESTORE_TIMEOUT_MS).finally(() => { reading.finished = true; });
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
    saved: entry ? { tokens: entry.tokens } : null,
    lastReload: lastReloadOf(model),
    bootAt,
    prefillRate: prefillRate(model),
  });
}

// ── Housekeeping ────────────────────────────────────────────────────────────

/**
 * Delete what nobody will restore: files no manifest names, entries past the
 * TTL or for conversations that are gone, and every set whose identity no
 * longer matches its model. Runs at boot and after each reload.
 */
export async function sweepSlotCache(): Promise<void> {
  // Again every hour, so an entry's TTL holds on a server nobody reconfigures.
  sweeper ??= setInterval(() => { void sweepSlotCache().catch(() => undefined); }, SWEEP_EVERY_MS).unref();
  const dir = slotSaveDir();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  const manifests = names.filter((n) => n.endsWith(".json"));
  const keep = new Set<string>();
  for (const name of manifests) {
    const m = parseManifest(await readFile(path.join(dir, name), "utf8").catch(() => ""));
    if (!m || `${modelKey(m.model)}.json` !== name) {
      await unlink(path.join(dir, name)).catch(() => undefined);
      continue;
    }
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
  }
  for (const name of names) {
    if (name.endsWith(".bin") && !keep.has(name)) await unlink(path.join(dir, name)).catch(() => undefined);
  }
}

/** Test seam. */
export function __resetSlotStoreForTest(): void {
  if (sweeper) clearInterval(sweeper);
  sweeper = null;
  reloads.clear();
  warmedAt.clear();
  routerGone = null;
  bytesPerToken.clear();
  claimed.clear();
}
