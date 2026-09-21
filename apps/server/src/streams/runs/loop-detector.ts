/**
 * Notices a tool loop going nowhere, so the run can ask the user rather than
 * grinding through its whole step window repeating itself.
 *
 * The unit is an **iteration**, not a call. A model routinely emits several
 * calls in one message, and "read a, read b" twice running is an ordinary
 * re-read after an edit did not apply — keying on the flattened call stream
 * would read that as the cycle `A B A B` and speak up after two iterations.
 * Hashing each iteration's calls together instead means a batch has to repeat
 * three times before it counts, while the common single-call case is
 * unchanged.
 *
 * Keys are derived from tool names and *arguments*, never results: `grep` and
 * `glob` both truncate at 500 lines and ripgrep's file order is not stable, so
 * identical work can produce different output and a result-keyed detector
 * would miss real loops on a large repo. Arguments are exactly what the model
 * chose, which is the thing that is or isn't changing.
 *
 * Pure (one type import) so the rules can be asserted directly; the engine
 * owns the hashing and the `{tool, args}` the event carries.
 */
import type { LoopSensitivity } from "@loxaic/types";

/** The repetition that tripped the detector. `unit` is the repeating sequence
 * of iteration keys, oldest first — the engine maps them back to calls. */
export interface LoopHit {
  /** 1 for "the same iteration over and over", 2-3 for a cycle. */
  unitLength: number;
  repeats: number;
  unit: string[];
}

/** Cycle lengths worth looking for. Longer than 3 stops being distinguishable
 * from a model working through a list, and each extra length needs twice its
 * own length in history before it can ever match. */
const CYCLE_LENGTHS = [2, 3] as const;

/**
 * How many repeats count as a loop.
 *
 * `sameKeyRepeats` — the same single iteration, this many times running. Two
 * is a retry, routine and often correct (a flaky command, a file that had not
 * been written yet); three is a pattern.
 * `cycleRepeats` — a 2- or 3-step cycle, this many times back to back.
 * `enabled: false` never reports a hit: the step window still applies, so a
 * run that really is stuck is still asked, just later.
 */
export interface LoopDetectorOptions {
  sameKeyRepeats?: number;
  cycleRepeats?: number;
  enabled?: boolean;
}

/** Each sensitivity the settings screen offers, as detector options. `normal`
 * is exactly the detector's defaults — the behaviour before this was a
 * setting — so an unset preference changes nothing. */
export function loopDetectorOptions(sensitivity: LoopSensitivity): LoopDetectorOptions {
  switch (sensitivity) {
    case "off":
      return { enabled: false };
    case "relaxed":
      return { sameKeyRepeats: 5, cycleRepeats: 3 };
    case "normal":
      return {};
  }
}

export class LoopDetector {
  private keys: string[] = [];
  private readonly sameKeyRepeats: number;
  private readonly cycleRepeats: number;
  private readonly enabled: boolean;

  constructor(options: LoopDetectorOptions = {}) {
    this.sameKeyRepeats = options.sameKeyRepeats ?? 3;
    this.cycleRepeats = options.cycleRepeats ?? 2;
    this.enabled = options.enabled ?? true;
  }

  /**
   * Records one finished iteration and reports the repetition it completes, if
   * any. Returns null while things are still moving.
   */
  push(iterationKey: string): LoopHit | null {
    // Still recorded when disabled, so the history is honest if the detector
    // is ever consulted another way — but nothing is ever reported.
    this.keys.push(iterationKey);
    if (!this.enabled) return null;
    const k = this.keys;
    const same = this.sameKeyRepeats;

    // The same iteration, `same` times running.
    if (k.length >= same) {
      const tail = k.slice(-same);
      if (tail.every((x) => x === tail[0])) {
        return { unitLength: 1, repeats: same, unit: [tail[0]] };
      }
    }

    // A short cycle, `cycleRepeats` times back to back: A B A B, or A B C A B C.
    for (const len of CYCLE_LENGTHS) {
      const span = len * this.cycleRepeats;
      if (k.length < span) continue;
      const tail = k.slice(-span);
      const first = tail.slice(0, len);
      if (tail.every((x, i) => x === first[i % len])) {
        return { unitLength: len, repeats: this.cycleRepeats, unit: first };
      }
    }

    return null;
  }

  /**
   * Forgets everything seen so far.
   *
   * Called when the user says keep going: the detector re-arms rather than
   * switching off, so a run that really is stuck asks again after a fresh set
   * of repeats instead of burning the rest of the window unattended. The
   * history has to be cleared, not just the last hit — otherwise the very next
   * iteration completes the same pattern again and the user is asked twice in
   * a row for one answer they already gave.
   */
  reset(): void {
    this.keys = [];
  }
}
