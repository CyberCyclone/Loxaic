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
 * Pure and dependency-free so the rules can be asserted directly; the engine
 * owns the hashing and the `{tool, args}` the event carries.
 */

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

/** How many times the same single iteration must repeat. Two is a retry —
 * routine and often correct (a flaky command, a file that had not been written
 * yet). Three is a pattern. */
const SAME_KEY_REPEATS = 3;

export class LoopDetector {
  private keys: string[] = [];

  /**
   * Records one finished iteration and reports the repetition it completes, if
   * any. Returns null while things are still moving.
   */
  push(iterationKey: string): LoopHit | null {
    this.keys.push(iterationKey);
    const k = this.keys;

    // The same iteration, three times running.
    if (k.length >= SAME_KEY_REPEATS) {
      const tail = k.slice(-SAME_KEY_REPEATS);
      if (tail.every((x) => x === tail[0])) {
        return { unitLength: 1, repeats: SAME_KEY_REPEATS, unit: [tail[0]] };
      }
    }

    // A short cycle, twice back to back: A B A B, or A B C A B C.
    for (const len of CYCLE_LENGTHS) {
      if (k.length < len * 2) continue;
      const tail = k.slice(-len * 2);
      const first = tail.slice(0, len);
      if (first.every((x, i) => x === tail[i + len])) {
        return { unitLength: len, repeats: 2, unit: first };
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
