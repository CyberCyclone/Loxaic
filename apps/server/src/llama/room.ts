import { listServableModels, type LocalModelRow } from "./catalog.ts";
import { labelFor } from "./fit.ts";
import { availableMemory, footprintBytes, loadedFootprints, refreshMemory, type LoadedFootprint } from "./memory.ts";
import { loadModel, routerEndpoint, routerModelStatuses, unloadModel, waitForModelStatus } from "./router.ts";
import { getLocalModelsSettings } from "./settings.ts";

/**
 * Which models stay loaded: pinning, and making room.
 *
 * llama.cpp's router can unload by count (`--models-max`), least recently used,
 * and has no notion of a model that must stay — so it is started with
 * `--models-max 0` and never unloads anything itself. Loxaic decides here:
 *
 * - A **pinned** model is always loaded: loaded when it is pinned and again
 *   after every runtime restart or preset reload (`loadPinnedModels`), and
 *   never unloaded to make room.
 * - Before a request for a model that is not loaded, our **unpinned** loaded
 *   models are unloaded, least recently used first, until the new one fits
 *   (`ensureRoom`). A model with a request in flight is never unloaded.
 * - When it still would not fit and pinned models are what is in the way, the
 *   request is refused with `NoRoomError`, which the client shows as a modal
 *   asking for an admin to unpin one. Refused only then: a model that would
 *   not fit an empty GPU either is the admin's download decision, and
 *   llama.cpp's own `--fit` (on by default) may still load it with some
 *   layers on the CPU.
 *
 * Unloading is decided one model at a time on a *re-measured* figure, never on
 * the sum of our estimates: estimates are good enough to label a download and
 * too rough to decide how many of someone's models to throw away.
 */

export interface RoomCandidate {
  id: string;
  displayName: string;
  pinned: boolean;
  /** A request is in flight, or it is still loading: never unloaded. */
  busy: boolean;
  lastUsedAt: number;
  estBytes: number;
}

export type RoomPlan =
  | { kind: "proceed" }
  /** Unload these, in order (least recently used first). */
  | { kind: "evict"; ids: string[] }
  | { kind: "refuse"; blockers: { id: string; displayName: string }[] };

/**
 * What to do before loading a model needing `requiredBytes`. Pure: every input
 * is a measurement taken by the caller.
 *
 * `freeBytes` null means memory is unknown (the CPU, or a runtime that cannot
 * list its devices) — then only the count cap applies. Unloads until the model
 * would comfortably fit (`will-fit`), or until nothing unpinned is left; then
 * refuses only when it still would not fit (`wont-fit`, or the count cap) and
 * a pinned model is loaded.
 */
export function planRoom(input: {
  requiredBytes: number;
  freeBytes: number | null;
  loaded: RoomCandidate[];
  countCap: number;
}): RoomPlan {
  const { requiredBytes, freeBytes, loaded, countCap } = input;
  let available = freeBytes;
  let count = loaded.length;
  const overCap = () => countCap > 0 && count >= countCap;
  const needsRoom = () => overCap() || (available !== null && labelFor(requiredBytes, available) !== "will-fit");
  const evictable = loaded.filter((m) => !m.pinned && !m.busy).sort((a, b) => a.lastUsedAt - b.lastUsedAt);
  const ids: string[] = [];
  while (needsRoom() && evictable.length > 0) {
    const m = evictable.shift();
    if (!m) break;
    ids.push(m.id);
    if (available !== null) available += m.estBytes;
    count -= 1;
  }
  const stillBlocked = overCap() || (available !== null && labelFor(requiredBytes, available) === "wont-fit");
  if (stillBlocked) {
    const pinned = loaded.filter((m) => m.pinned);
    if (pinned.length > 0) return { kind: "refuse", blockers: pinned.map((m) => ({ id: m.id, displayName: m.displayName })) };
  }
  return ids.length > 0 ? { kind: "evict", ids } : { kind: "proceed" };
}

/** A model cannot be loaded because pinned models hold the room it needs. */
export class NoRoomError extends Error {
  readonly code = "local_model_no_room" as const;
  constructor(
    readonly modelName: string,
    readonly blockers: { id: string; displayName: string }[],
  ) {
    super(noRoomMessage(modelName, blockers.map((b) => b.displayName)));
    this.name = "NoRoomError";
  }
}

export function noRoomMessage(modelName: string, pinned: string[]): string {
  const list =
    pinned.length <= 1
      ? `"${pinned[0] ?? "another model"}" is`
      : `${pinned.slice(0, -1).map((n) => `"${n}"`).join(", ")} and "${pinned[pinned.length - 1]}" are`;
  const which = pinned.length > 1 ? "one of them" : "it";
  return (
    `"${modelName}" can't be loaded right now: there isn't enough GPU memory on this host while ${list} pinned. ` +
    `Pick a model that is already loaded, or ask an admin to unpin ${which} under Settings > Host models.`
  );
}

// ── Use tracking ────────────────────────────────────────────────────────────

const inFlight = new Map<string, number>();
const lastUsed = new Map<string, number>();

/**
 * Mark a request to `id` as in flight until the returned function is called:
 * a model answering someone is never unloaded to make room. Also records the
 * use, for least-recently-used order.
 */
export function trackRequest(id: string): () => void {
  inFlight.set(id, (inFlight.get(id) ?? 0) + 1);
  lastUsed.set(id, Date.now());
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const n = (inFlight.get(id) ?? 1) - 1;
    if (n <= 0) inFlight.delete(id);
    else inFlight.set(id, n);
    lastUsed.set(id, Date.now());
    // A pinned model that could not be loaded may have been waiting for this
    // one to go idle.
    if (pinErrors.size > 0) void loadPinnedModels();
  };
}

function candidates(loaded: LoadedFootprint[]): RoomCandidate[] {
  return loaded.map((m) => ({
    id: m.id,
    displayName: m.displayName,
    pinned: m.pinned,
    busy: (inFlight.get(m.id) ?? 0) > 0 || m.status === "loading",
    lastUsedAt: lastUsed.get(m.id) ?? 0,
    estBytes: m.estBytes,
  }));
}

/** Free memory for the plan, or null when unknown — the CPU, where models use
 * system RAM and a count cap is the only measure that applies. */
function planFreeBytes(): number | null {
  const mem = availableMemory();
  return mem.cpu ? null : (mem.breakdown?.freeBytes ?? null);
}

// ── Making room ─────────────────────────────────────────────────────────────

/** Serialises everything that loads or unloads: two sends deciding at once
 * would each see the same free memory and both load into it. */
let chain: Promise<unknown> = Promise.resolve();
function withRoomLock<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  // A request stopped while it waited must not go on to unload someone's
  // model for an answer nobody wants: the queued work checks first.
  const guarded = () => {
    if (signal?.aborted) return Promise.reject(abortError());
    return fn();
  };
  const next = chain.then(guarded, guarded);
  chain = next.catch(() => undefined);
  return signal ? abortable(next, signal) : next;
}

function abortError(): Error {
  return new DOMException("The operation was aborted.", "AbortError");
}

/** `p`, or an AbortError as soon as `signal` fires — the wait for the lock
 * can be minutes behind a pinned model loading, and Stop must not be. */
function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => { reject(abortError()); };
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

const UNLOAD_WAIT_MS = 30_000;
const MAX_EVICTIONS = 16;

async function servableRow(id: string): Promise<LocalModelRow | null> {
  return (await listServableModels()).find((r) => r.id === id) ?? null;
}

async function isLoaded(id: string): Promise<boolean> {
  const s = (await routerModelStatuses()).get(id)?.value;
  return s === "loaded" || s === "loading";
}

async function ensureRoomLocked(row: LocalModelRow, signal?: AbortSignal): Promise<void> {
  const required = footprintBytes(row);
  for (let i = 0; i <= MAX_EVICTIONS; i++) {
    if (signal?.aborted) throw abortError();
    if (await isLoaded(row.id)) return;
    // Always measured now: a load is about to happen, and a listing costs a
    // fraction of one. Estimates and a cached figure both miss what another
    // program did a moment ago.
    await refreshMemory({ force: true });
    const plan = planRoom({
      requiredBytes: required,
      freeBytes: planFreeBytes(),
      loaded: candidates(loadedFootprints()).filter((m) => m.id !== row.id),
      countCap: getLocalModelsSettings().modelsMax,
    });
    if (plan.kind === "proceed") return;
    if (plan.kind === "refuse") throw new NoRoomError(row.displayName, plan.blockers);
    // One at a time: the next decision is made on memory measured after it.
    const victim = plan.ids[0];
    console.log(`[llama] unloading ${victim} to make room for ${row.id}`);
    await unloadModel(victim);
    await waitForModelStatus(victim, "unloaded", UNLOAD_WAIT_MS);
  }
}

/**
 * Before a request to `id`: unload unpinned models until it fits, or throw
 * `NoRoomError` when pinned models are in the way. Does nothing for a model
 * that is already loaded, one that is not ours, or with no router. `signal`
 * is the run's: a Stop while this waits ends it with an AbortError.
 */
export async function ensureRoom(id: string, signal?: AbortSignal): Promise<void> {
  if (!routerEndpoint()) return;
  const row = await servableRow(id);
  if (!row || (await isLoaded(id))) return;
  await withRoomLock(() => ensureRoomLocked(row, signal), signal);
}

/**
 * The send-time check: would `id` be refused? Unloads nothing (the run may
 * wait in the queue behind another model's run, which must not lose its model
 * meanwhile) — it only answers the one question whose answer is a modal
 * rather than a failed turn.
 */
export async function checkRoom(id: string): Promise<void> {
  if (!routerEndpoint()) return;
  const row = await servableRow(id);
  if (!row || (await isLoaded(id))) return;
  await refreshMemory({ force: true });
  const plan = planRoom({
    requiredBytes: footprintBytes(row),
    freeBytes: planFreeBytes(),
    // Busy models are not a reason to refuse — they will be idle by the time
    // this run is admitted, so they count as unloadable here.
    loaded: candidates(loadedFootprints())
      .filter((m) => m.id !== id)
      .map((m) => ({ ...m, busy: false })),
    countCap: getLocalModelsSettings().modelsMax,
  });
  if (plan.kind === "refuse") throw new NoRoomError(row.displayName, plan.blockers);
}

// ── Pinned models ───────────────────────────────────────────────────────────

/** Why a pinned model is not loaded, by id. Cleared when it loads or is
 * unpinned. */
const pinErrors = new Map<string, string>();

export function pinErrorFor(id: string): string | null {
  return pinErrors.get(id) ?? null;
}

const PIN_LOAD_WAIT_MS = 10 * 60_000;
let pinning: Promise<void> | null = null;
let pinAgain = false;

/**
 * Load every pinned model that is not loaded. Shared between concurrent
 * callers; a call while one is running runs once more after it, since the
 * caller may have just pinned something the running pass never read.
 */
export function loadPinnedModels(): Promise<void> {
  if (pinning) {
    pinAgain = true;
    return pinning;
  }
  // Read through a call: after `pinAgain = false` the type checker takes it to
  // be false for good, and cannot see a caller setting it during the await.
  const again = () => pinAgain;
  pinning = (async () => {
    do {
      pinAgain = false;
      await loadPinnedOnce();
    } while (again());
  })().finally(() => { pinning = null; });
  return pinning;
}

async function loadPinnedOnce(): Promise<void> {
  if (!routerEndpoint()) return;
  const rows = await listServableModels();
  const pinnedIds = new Set(rows.filter((r) => r.pinned).map((r) => r.id));
  for (const id of [...pinErrors.keys()]) if (!pinnedIds.has(id)) pinErrors.delete(id);
  for (const row of rows) {
    if (!row.pinned || (await isLoaded(row.id))) continue;
    await withRoomLock(async () => {
      try {
        await ensureRoomLocked(row);
        if (await isLoaded(row.id)) return;
        console.log(`[llama] loading pinned model ${row.id}`);
        await loadModel(row.id);
        const status = await waitForModelStatus(row.id, "loaded", PIN_LOAD_WAIT_MS);
        if (status?.value === "loaded") pinErrors.delete(row.id);
        else pinErrors.set(row.id, "Pinned, but llama.cpp could not load it with its current settings.");
      } catch (err) {
        pinErrors.set(
          row.id,
          err instanceof NoRoomError
            ? `Pinned, but not loaded: there isn't enough GPU memory while ${err.blockers.map((b) => `"${b.displayName}"`).join(", ")} ${err.blockers.length > 1 ? "are" : "is"} pinned too.`
            : `Pinned, but not loaded: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
  }
}

/** Test seam: forget use tracking and pin errors. */
export function __resetRoomForTest(): void {
  inFlight.clear();
  lastUsed.clear();
  pinErrors.clear();
}
