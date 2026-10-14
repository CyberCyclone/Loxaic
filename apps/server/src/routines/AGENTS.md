# apps/server/src/routines

The routine scheduler (`scheduler.ts`): cron jobs that start an ordinary chat run unattended. The delete route lives in `routes/routines.ts`; its rules are here because they are about routines.

## Running a routine

- `executeRoutine` creates the conversation (`kind: "routine"`, `modelPref`) and the `routine_runs` row in one transaction, then calls `startChatRun`. It returns once the run has started; the row is still `running`.
- A routine run uses its owner's prefs and wait settings (approval window, check-in ladder); that is what keeps an unattended run bounded.
- Pass `recordUse: false` to `startChatRun`: a cron is nobody's choice of model, so it stays out of the picker's recents.
- The terminal status comes from `broker.onEnd` via `onSettled`, wired before the loop starts and firing once. `settleRun` is `UPDATE … WHERE status='running' RETURNING`; no row (routine deleted mid-run) means no ntfy.
- **A routine's chats use only `routines.model`.** A null or unresolvable model records the run `failed` with an error assistant row; never fall back to the built-in default or `recent_models[0]` (that spends a provider key on a model nobody picked).

## Deleting a routine

- Delete its conversations first, one at a time, through `deleteConversation`, never `purgeConversation` (retention must apply to chats people continued by hand). A throw leaves the routine intact and the delete retryable.
- Then one transaction deleting `routine_runs` `RETURNING` and the routine, then a second pass for a run that raced the first.
- Call `unscheduleRoutine` only after the routine row is gone; unscheduling first leaves a routine that looks enabled and never fires again. `isRoutineScheduled()` exists so tests can see the schedule.
- DELETE answers 404 for a routine that is not yours or does not exist.

## Scheduling and listing

- `nextRunAt` is node-cron's `getNextRun()`, written on schedule and each tick, nulled on unschedule; never re-derive it.
- Every routine-scoped listing inner-joins `conversations` on `deletedAt IS NULL`.
- The boot reconcile of stuck `running` rows is bounded by the module-load `BOOT_AT`, so a "Run now" during startup is not failed.
- The scheduler is single-process: cron fires on every instance, and the reconcile would fail another instance's live runs.
