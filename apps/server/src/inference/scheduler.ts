/**
 * One run at a time per backend, unless that backend can genuinely do more.
 *
 * ## Why this exists
 *
 * llama.cpp and LM Studio cache the KV state of a prompt **prefix**, and a
 * turn is only cheap when the previous request's prompt is a literal prefix of
 * it. With one slot there is one cached prefix, so two conversations taking
 * turns evict each other's: measured on a 14.5k-token thread, 312 ms when the
 * prefix held versus 14,551 ms when it did not. Nothing in the server stopped
 * that — `streams/registry.ts` enforces one run per *conversation*, and two
 * conversations were free to interleave every request.
 *
 * The unit of scheduling is therefore the **run** — one user turn including
 * all of its tool iterations — not the individual model call. Rotating between
 * runs per call would preserve fairness and destroy the cache on every single
 * iteration, which is the failure this exists to prevent.
 *
 * ## Why per provider
 *
 * The thing being protected is one backend's cache and one backend's capacity,
 * and there is now more than one backend. A queue shared across them would make
 * a chat on OpenRouter wait behind a local run's tool work — for a provider
 * with no prefix cache to protect and sixteen requests of headroom — while the
 * local backend it was queued for sat idle. So each provider gets its own
 * queue, its own limit and its own probe, and "added" never means "cloud": a
 * second llama.cpp host has exactly the single-prefix problem the first one
 * has.
 *
 * ## Why not just let the backend sort it out
 *
 * Because it can, but only when it has the slots. llama.cpp with `--parallel N`
 * really does keep N prefixes and picks a slot by longest common prefix; there,
 * N concurrent runs are strictly better than a queue. LM Studio reports nothing
 * about slots and behaves as one. So concurrency follows the backend's own
 * answer rather than a number we invent — see resolveMaxConcurrent.
 *
 * ## Fairness
 *
 * Plain FIFO, with one exception: a run that gave up its slot to wait for a
 * human (a tool approval) re-enters at the **front**. It has already been
 * admitted once and its prefix is the one the backend most likely still holds,
 * so sending it to the back would both punish the user for approving and throw
 * away the cache the queue exists to protect.
 *
 * ## The cost
 *
 * A run holds its slot across its tool executions as well as its model calls
 * — a sandboxed `bash` included — and gives it up only while waiting for a
 * human. With one slot, one long auto-mode run holds everyone else for the
 * length of its tool work while the backend sits idle. That is accepted
 * rather than fixed by yielding around tool calls, because a run admitted in
 * that gap evicts the prefix and the yielding run then re-evaluates its whole
 * prompt on return. Per-user fairness and a cap on hold time are follow-ups.
 *
 * Process-local, like the run registry beside it. #78 owns making this work
 * across a cluster.
 */
import { DEFAULT_PROVIDER_ID } from "@loxaic/types";
import { getInferenceSettings } from "../settings.ts";
// Type-only, so it is erased: the value import stays dynamic below, because
// `providers.ts` → `models.ts` → this module is a real runtime cycle.
import type { ResolvedProvider } from "./providers.ts";

/** What a queued run is told about its place, so the UI can say so. */
export type QueuedListener = (position: number) => void;

export interface RunSlot {
  /** Give the slot back. Idempotent — the engine releases in a `finally` that
   * can run after an error path already released. */
  release(): void;
  /**
   * Hand the slot back for the duration of `work`, then take it again at the
   * front of the queue.
   *
   * For waits that are long and human rather than computational: a manual-mode
   * approval can sit unanswered for minutes, and holding an inference slot
   * through it would stall every other conversation on the deployment for
   * exactly as long as the user takes to click.
   *
   * Rejects if the run is aborted while it is out of the queue, so a stopped
   * run does not resume into a slot nobody wants any more.
   */
  yieldWhile<T>(work: () => Promise<T>): Promise<T>;
}

interface Waiter {
  /** Front-of-queue re-entry after an approval — see the module comment. */
  priority: boolean;
  notify: QueuedListener;
  admit: () => void;
  /** Resolves the acquire call with "aborted" rather than rejecting. */
  cancel: () => void;
  signal: AbortSignal;
  onAbort: () => void;
}

/** One backend's queue. Never deleted while it holds a run or a waiter — the
 * map is small (one entry per configured provider) and dropping a live one
 * would lose the accounting that decides who runs next. */
interface Queue {
  running: number;
  waiting: Waiter[];
  probed: { value: number | null; at: number } | null;
}

const queues = new Map<string, Queue>();

function queueFor(providerId: string): Queue {
  let q = queues.get(providerId);
  if (!q) {
    q = { running: 0, waiting: [], probed: null };
    queues.set(providerId, q);
  }
  return q;
}

/**
 * Take an inference slot on a provider, waiting in line if that backend is
 * busy.
 *
 * Returns null when the run was aborted before it reached the front — the
 * caller ends the stream as cancelled. Deliberately not a rejection: the two
 * run starters call `runToolLoop` fire-and-forget, so a throw here would land
 * as an unhandled rejection instead of a cancelled turn.
 */
export async function acquireRunSlot(opts: {
  signal: AbortSignal;
  /** Called on enqueue, and again whenever the run moves up the queue, so a
   * waiting client sees "#3 → #2 → #1" rather than one number that goes stale. */
  onQueued: QueuedListener;
  /** Which backend's queue to join. Defaults to the built-in one, so every
   * caller that predates providers keeps its previous behaviour exactly. */
  providerId?: string;
}): Promise<RunSlot | null> {
  const providerId = opts.providerId ?? DEFAULT_PROVIDER_ID;
  const admitted = await enter(providerId, opts.signal, opts.onQueued, false);
  if (!admitted) return null;
  return makeSlot(providerId, opts.signal, opts.onQueued);
}

function makeSlot(providerId: string, signal: AbortSignal, onQueued: QueuedListener): RunSlot {
  let held = true;
  const give = () => {
    if (!held) return;
    held = false;
    queueFor(providerId).running--;
    pump(providerId);
  };
  return {
    release: give,
    async yieldWhile<T>(work: () => Promise<T>): Promise<T> {
      give();
      let result: T;
      try {
        result = await work();
      } catch (err) {
        // Re-take the slot even when `work` failed, so the caller's `finally`
        // releases exactly one — then let the original error through, which is
        // always the more informative of the two. Deliberately not a `finally`
        // with a throw in it: that would swallow this error entirely.
        held = await enter(providerId, signal, onQueued, true);
        throw err;
      }
      held = await enter(providerId, signal, onQueued, true);
      if (!held) throw new RunSlotAbortedError();
      return result;
    },
  };
}

/** Thrown out of `yieldWhile` when the run was stopped while it waited. */
export class RunSlotAbortedError extends Error {
  constructor() {
    super("run was stopped while it waited for an inference slot");
    this.name = "RunSlotAbortedError";
  }
}

/** Joins the queue (or takes a free slot immediately). Resolves true when
 * admitted, false when aborted first. */
async function enter(
  providerId: string,
  signal: AbortSignal,
  onQueued: QueuedListener,
  priority: boolean,
): Promise<boolean> {
  // Read through a call, not as `signal.aborted` directly: the type checker
  // narrows the property to false after the first check and cannot see that
  // the await below gives it every chance to change.
  const stopped = () => signal.aborted;
  if (stopped()) return false;
  const max = await resolveMaxConcurrent(providerId);
  // Both re-checks exist because of that await. resolveMaxConcurrent can hit
  // the network on a cold cache, which is easily long enough for the run to be
  // stopped, or for slots to free or fill.
  if (stopped()) return false;
  const q = queueFor(providerId);
  if (q.running < max && q.waiting.length === 0) {
    q.running++;
    return true;
  }

  return new Promise<boolean>((resolve) => {
    const waiter: Waiter = {
      priority,
      notify: onQueued,
      admit: () => {
        signal.removeEventListener("abort", waiter.onAbort);
        q.running++;
        resolve(true);
      },
      cancel: () => {
        signal.removeEventListener("abort", waiter.onAbort);
        resolve(false);
      },
      signal,
      onAbort: () => {
        const i = q.waiting.indexOf(waiter);
        if (i >= 0) q.waiting.splice(i, 1);
        waiter.cancel();
        // Someone leaving the middle of the line moves everyone behind them up.
        notifyPositions(q);
      },
    };
    if (priority) q.waiting.unshift(waiter);
    else q.waiting.push(waiter);
    signal.addEventListener("abort", waiter.onAbort, { once: true });
    // An abort that fired during the await above has already run its
    // listeners, so registering one now would never hear it and the waiter
    // would sit in the queue forever — holding a place nobody is behind and
    // blocking nothing, but never resolving, so the run never ends. Checked
    // after registering rather than before, so an abort landing between the
    // two is caught by the listener instead.
    if (stopped()) {
      waiter.onAbort();
      return;
    }
    notifyPositions(q);
  });
}

/** Admits as many waiters as there is room for, on one provider's queue. */
function pump(providerId: string): void {
  void (async () => {
    const max = await resolveMaxConcurrent(providerId);
    const q = queueFor(providerId);
    while (q.waiting.length > 0 && q.running < max) {
      const next = q.waiting.shift();
      if (next) next.admit();
    }
    notifyPositions(q);
  })();
}

/**
 * Re-examines a queue against the *current* limit.
 *
 * `pump()` otherwise runs only when a slot is released, so an admin raising
 * the limit from 1 to 4 to unstick three waiting chats changed nothing until
 * the run holding the one slot finished — from the settings screen the
 * control looked dead for exactly as long as the slow run it was reached for.
 * Called by the settings and provider routes after a write lands. Also
 * invalidates the backend probe, so lowering back to "follow the backend"
 * re-asks it.
 *
 * With no argument it kicks every queue: a provider write can change any of
 * them, and a provider that was just deleted has a queue that must not keep
 * its old limit.
 */
export function kickScheduler(providerId?: string): void {
  if (providerId === undefined) {
    for (const [id, q] of queues) {
      q.probed = null;
      pump(id);
    }
    // A provider added since the last run has no queue yet; it will resolve
    // its limit fresh when its first run arrives, so there is nothing to kick.
    return;
  }
  queueFor(providerId).probed = null;
  pump(providerId);
}

/** Tells every waiter where it now stands. 1-based: "#1" is next to run.
 *
 * One number, not a position plus a separate "runs ahead" count. With more than
 * one slot those two differ, and two numbers that can disagree is worse than
 * the one a client actually renders. */
function notifyPositions(q: Queue): void {
  q.waiting.forEach((w, i) => {
    try {
      w.notify(i + 1);
    } catch {
      // A listener that throws (a closed producer, say) must not stop the
      // rest of the queue from being told where it stands.
    }
  });
}

// ── How many runs may hold a backend at once ────────────

/** Long enough that the probe costs nothing per run, short enough that
 * restarting llama.cpp with a different `--parallel` is picked up without
 * restarting this server. */
const PROBE_TTL_MS = 60_000;

/**
 * Precedence, for the built-in backend: environment pin > admin setting >
 * what the backend says > **1**. For an added provider the row's own
 * `maxConcurrentRuns` comes first instead, since the deployment-wide setting
 * describes the deployment's own backend, not someone else's API.
 *
 * The floor is 1 rather than "unlimited" on purpose. Getting this wrong in the
 * permissive direction restores exactly the interleaving this module exists to
 * prevent, and does it invisibly — the symptom is every turn being slow, not an
 * error. A backend that will not say how many slots it has is therefore
 * assumed to have one, which is the truth for LM Studio and for llama.cpp's
 * own default.
 */
export async function resolveMaxConcurrent(providerId: string = DEFAULT_PROVIDER_ID): Promise<number> {
  if (providerId === DEFAULT_PROVIDER_ID) {
    const { maxConcurrentRuns } = getInferenceSettings();
    if (maxConcurrentRuns !== null) return maxConcurrentRuns;
    return (await probeBackendSlots(providerId, undefined)) ?? 1;
  }

  const { getProviderById } = await import("./providers.ts");
  const provider = await getProviderById(providerId).catch(() => null);
  if (provider?.maxConcurrentRuns != null) return provider.maxConcurrentRuns;
  return (await probeBackendSlots(providerId, provider ?? undefined)) ?? 1;
}

async function probeBackendSlots(providerId: string, provider: ResolvedProvider | undefined): Promise<number | null> {
  const q = queueFor(providerId);
  if (q.probed && Date.now() - q.probed.at < PROBE_TTL_MS) return q.probed.value;
  const { probeTotalSlots } = await import("./models.ts");
  const value = await probeTotalSlots(provider ?? undefined);
  q.probed = { value, at: Date.now() };
  return value;
}

/** Test seam: forget the cached backend probes. */
export function resetSlotProbe(): void {
  for (const q of queues.values()) q.probed = null;
}

/** Test seam: the queues are process-global, so a suite that leaves waiters
 * behind would hang the next one. */
export function __resetSchedulerForTest(): void {
  for (const q of queues.values()) {
    for (const w of [...q.waiting]) w.cancel();
  }
  queues.clear();
}

/** Diagnostics: what a queue looks like right now. Defaults to the built-in
 * backend's, which is the one every existing caller means. */
export function schedulerState(providerId: string = DEFAULT_PROVIDER_ID): { running: number; waiting: number } {
  const q = queues.get(providerId);
  return { running: q?.running ?? 0, waiting: q?.waiting.length ?? 0 };
}
