/**
 * How long to wait after a sheet or modal starts closing before presenting
 * another: long enough for its exit animation (200ms) to finish. iOS will not
 * present a second overlay while the first is still being dismissed, so one
 * overlay opened from another waits this long (apps/mobile/components/AGENTS.md:
 * never stack modals).
 */
export const SHEET_EXIT_MS = 300;
