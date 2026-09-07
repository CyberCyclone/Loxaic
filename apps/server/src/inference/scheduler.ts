/**
 * One run at a time, unless the backend can genuinely do more.
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
 * Process-local, like the run registry beside it. #78 owns making this work
 * across a cluster.
 */
import { getInferenceSettings } from "../settings.ts";

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

let running = 0;
const waiting: Waiter[] = [];

/**
 * Take an inference slot, waiting in line if the backend is busy.
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
}): Promise<RunSlot | null> {
  const admitted = await enter(opts.signal, opts.onQueued, false);
  if (!admitted) return null;
  return makeSlot(opts.signal, opts.onQueued);
}

function makeSlot(signal: AbortSignal, onQueued: QueuedListener): RunSlot {
  let held = true;
  const give = () => {
    if (!held) return;
    held = false;
    running--;
    pump();
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
        held = await enter(signal, onQueued, true);
        throw err;
      }
      held = await enter(signal, onQueued, true);
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
  signal: AbortSignal,
  onQueued: QueuedListener,
  priority: boolean,
): Promise<boolean> {
  // Read through a call, not as `signal.aborted` directly: the type checker
  // narrows the property to false after the first check and cannot see that
  // the await below gives it every chance to change.
  const stopped = () => signal.aborted;
  if (stopped()) return false;
  const max = await resolveMaxConcurrent();
  // Both re-checks exist because of that await. resolveMaxConcurrent can hit
  // the network on a cold cache, which is easily long enough for the run to be
  // stopped, or for slots to free or fill.
  if (stopped()) return false;
  if (running < max && waiting.length === 0) {
    running++;
    return true;
  }

  return new Promise<boolean>((resolve) => {
    const waiter: Waiter = {
      priority,
      notify: onQueued,
      admit: () => {
        signal.removeEventListener("abort", waiter.onAbort);
        running++;
        resolve(true);
      },
      cancel: () => {
        signal.removeEventListener("abort", waiter.onAbort);
        resolve(false);
      },
      signal,
      onAbort: () => {
        const i = waiting.indexOf(waiter);
        if (i >= 0) waiting.splice(i, 1);
        waiter.cancel();
        // Someone leaving the middle of the line moves everyone behind them up.
        notifyPositions();
      },
    };
    if (priority) waiting.unshift(waiter);
    else waiting.push(waiter);
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
    notifyPositions();
  });
}

/** Admits as many waiters as there is room for. */
function pump(): void {
  void (async () => {
    const max = await resolveMaxConcurrent();
    while (waiting.length > 0 && running < max) {
      const next = waiting.shift();
      if (next) next.admit();
    }
    notifyPositions();
  })();
}

/** Tells every waiter where it now stands. 1-based: "#1" is next to run.
 *
 * One number, not a position plus a separate "runs ahead" count. With more than
 * one slot those two differ, and two numbers that can disagree is worse than
 * the one a client actually renders. */
function notifyPositions(): void {
  waiting.forEach((w, i) => {
    try {
      w.notify(i + 1);
    } catch {
      // A listener that throws (a closed producer, say) must not stop the
      // rest of the queue from being told where it stands.
    }
  });
}

// ── How many runs may hold the backend at once ────────────

let probed: { value: number | null; at: number } | null = null;
/** Long enough that the probe costs nothing per run, short enough that
 * restarting llama.cpp with a different `--parallel` is picked up without
 * restarting this server. */
const PROBE_TTL_MS = 60_000;

/**
 * Precedence: environment pin > admin setting > what the backend says >
 * **1**.
 *
 * The floor is 1 rather than "unlimited" on purpose. Getting this wrong in the
 * permissive direction restores exactly the interleaving this module exists to
 * prevent, and does it invisibly — the symptom is every turn being slow, not an
 * error. A backend that will not say how many slots it has is therefore
 * assumed to have one, which is the truth for LM Studio and for llama.cpp's
 * own default.
 */
export async function resolveMaxConcurrent(): Promise<number> {
  const { maxConcurrentRuns } = getInferenceSettings();
  if (maxConcurrentRuns !== null) return maxConcurrentRuns;
  return (await probeBackendSlots()) ?? 1;
}

async function probeBackendSlots(): Promise<number | null> {
  if (probed && Date.now() - probed.at < PROBE_TTL_MS) return probed.value;
  const { probeTotalSlots } = await import("./models.ts");
  const value = await probeTotalSlots();
  probed = { value, at: Date.now() };
  return value;
}

/** Test seam: forget the cached backend probe. */
export function resetSlotProbe(): void {
  probed = null;
}

/** Test seam: the queue is process-global, so a suite that leaves waiters
 * behind would hang the next one. */
export function __resetSchedulerForTest(): void {
  for (const w of [...waiting]) w.cancel();
  waiting.length = 0;
  running = 0;
  probed = null;
}

/** Diagnostics: what the queue looks like right now. */
export function schedulerState(): { running: number; waiting: number } {
  return { running, waiting: waiting.length };
}
