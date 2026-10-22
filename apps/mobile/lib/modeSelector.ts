import type { PermissionMode } from '@loxaic/api-client';

/**
 * What the agent's mode selector shows (#311). The selector is the mode the
 * next message is sent in, and the one a run going on screen is switched to.
 * It used to start at Manual on every load, whatever the run was doing, so a
 * thread picked as Auto came back Manual after a reload and its next message
 * went out in Manual with nobody noticing.
 */

/** What the selector follows on the thread on screen. */
export interface SelectorSource {
  /** The thread on screen, or null for a new one not yet sent. */
  convId: string | null;
  /** Its live run's mode as the server says it is, or null with none going. */
  runMode: PermissionMode | null;
  /** The thread's last mode, as the server stored it, or null if never. */
  storedMode: PermissionMode | null;
}

/**
 * The selector after what it follows changed from `prev` to `next`.
 *
 * Opening a thread shows its last mode, else its live run's (a thread from
 * before the mode was stored), else keeps the pick (a new thread). The last
 * mode first: it is the run's own unless Planning was picked for the next
 * message while the run went on, and that pick must survive leaving and
 * coming back. On the same thread the selector moves only when the run's mode
 * itself changes — the run starting, a switch from another device, or the
 * mode first heard on a load or reconnect — and never on a resync that says
 * the same, so that same pick stays put while the run finishes.
 */
export function followSelector(selector: PermissionMode, prev: SelectorSource | null, next: SelectorSource): PermissionMode {
  if (next.convId === null) return selector;
  if (prev?.convId !== next.convId) return next.storedMode ?? next.runMode ?? selector;
  if (next.runMode !== null && next.runMode !== prev.runMode) return next.runMode;
  // A thread opened before its row was read: the mode arrives late.
  if (next.runMode === null && prev.storedMode === null && next.storedMode !== null) return next.storedMode;
  return selector;
}

export const MODE_LABELS: Record<PermissionMode, string> = { planning: 'Planning', manual: 'Manual', auto: 'Auto' };

/**
 * What to say when a pick does not reach the run going: Planning, in or out,
 * applies from the next message, since its prompt and tools are fixed for the
 * run (the server's `liveModeAfter`). Null when the run switches, or none is
 * going.
 */
export function modeChangeNotice(runMode: PermissionMode | null, picked: PermissionMode): string | null {
  if (runMode === null || runMode === picked) return null;
  if (runMode !== 'planning' && picked !== 'planning') return null;
  return `${MODE_LABELS[picked]} starts with your next message. This run stays in ${MODE_LABELS[runMode]}.`;
}
