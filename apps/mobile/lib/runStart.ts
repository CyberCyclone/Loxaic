/**
 * When a run began, on this device's clock, from what the server said in a
 * `stream.sync`: its own clock now (`serverNow`) and the run's start on that
 * clock (`startedAt`). The difference is how long the run has been going,
 * whatever this device's clock says — a phone a minute fast would otherwise
 * show a minute too much.
 *
 * Without both (an older server), the run is timed from now, as it always
 * was. A run discovered late — an automatic compaction started while the app
 * was in the background — used to be timed from the moment the app heard of
 * it: "Compacting… 84s" six minutes in.
 */
export function localRunStart(startedAt: number | undefined, serverNow: number | undefined, now = Date.now()): number {
  if (startedAt === undefined || serverNow === undefined) return now;
  return now - Math.max(0, serverNow - startedAt);
}
