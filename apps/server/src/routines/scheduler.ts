import cron from "node-cron";
import type { ScheduledTask } from "node-cron";
import { v4 as uuid } from "uuid";
import { and, eq, lt } from "@loxaic/db";
import { db } from "@loxaic/db";
import { routines, routineRuns, conversations, messages, user } from "@loxaic/db/schema";
import type { ContentBlock } from "@loxaic/types";
import { ModelRefError, assertModelUsable } from "../inference/providers.ts";
import { startChatRun } from "../streams/runs/chatRun.ts";
import type { RunSettled } from "../streams/runs/chatRun.ts";

const jobs = new Map<string, ScheduledTask>();

/**
 * When this process started. The boot reconcile below only touches run rows
 * older than this, so a "Run now" that lands while the scheduler is still
 * starting is never marked failed by it.
 */
const BOOT_AT = new Date();

export async function startRoutineScheduler() {
  // A run is tracked in memory — its terminal status is written when the
  // stream log finalizes. A process that died mid-run leaves a row nothing
  // will ever move, so reconcile those before scheduling anything, or they sit
  // in the routine's history as permanently "running".
  await db
    .update(routineRuns)
    .set({ status: "failed", finishedAt: new Date() })
    .where(and(eq(routineRuns.status, "running"), lt(routineRuns.startedAt, BOOT_AT)))
    .catch((err: unknown) => {
      console.error("routine run reconcile failed:", err);
    });

  const rows = await db.select().from(routines).where(eq(routines.enabled, true));
  for (const r of rows) scheduleRoutine(r.id, r.cron);
}

export function scheduleRoutine(routineId: string, cronExpr: string) {
  const existing = jobs.get(routineId);
  if (existing) void existing.stop();

  // A row can hold an expression node-cron rejects — every routine written
  // before the route validated one. Skipping it leaves the rest of the boot
  // loop intact; letting cron.schedule throw would abandon every routine after
  // it in the list.
  if (!cron.validate(cronExpr)) {
    console.error(`routine ${routineId} has an invalid cron expression (${cronExpr}); not scheduled`);
    jobs.delete(routineId);
    return;
  }

  const job = cron.schedule(cronExpr, async () => {
    // node-cron has nobody to hand a rejection to, and an unhandled one from a
    // scheduled tick would take the process down.
    try {
      await executeRoutine(routineId);
    } catch (err) {
      console.error(`routine ${routineId} failed to start:`, err);
    }
  });
  jobs.set(routineId, job);
  void recordNextRun(routineId);
}

/**
 * Write when this routine fires next, as node-cron itself computes it.
 *
 * The column is on the wire and the stub used to fill it with `now`, which was
 * a lie; dropping that write left it permanently null, which is no better for
 * a client that renders it. Asked of the live job rather than re-derived from
 * the expression, so it cannot disagree with what will actually fire. Best
 * effort: a failed write costs a label, never a run.
 */
async function recordNextRun(routineId: string) {
  const next = jobs.get(routineId)?.getNextRun() ?? null;
  await db
    .update(routines)
    .set({ nextRunAt: next })
    .where(eq(routines.id, routineId))
    .catch(() => undefined);
}

export function unscheduleRoutine(routineId: string) {
  const job = jobs.get(routineId);
  if (job) { void job.stop(); jobs.delete(routineId); }
  // A disabled routine has no next run, and saying it still does is the same
  // lie in the other direction. A no-op for a routine that was just deleted.
  void recordNextRun(routineId);
}

/** Whether a cron job is live for this routine in this process. The schedule
 * is otherwise invisible from outside, which is how a routine that was enabled
 * in the database and scheduled nowhere went unnoticed. */
export function isRoutineScheduled(routineId: string): boolean {
  return jobs.has(routineId);
}

/** Stop every scheduled job so the process can exit cleanly. */
export function stopRoutineScheduler() {
  for (const job of jobs.values()) void job.stop();
  jobs.clear();
}

/**
 * Start one run of a routine: a real conversation, a real model call, through
 * the same machinery a typed chat message uses — the queue, the tool loop, the
 * stream log, usage records.
 *
 * Returns as soon as the run has *started*, with its `routine_runs` row still
 * `running`. The terminal status is written later, by `onSettled`, from the
 * stream log's own finalize — so "completed" means the turn really finished,
 * not that it was dispatched.
 */
export async function executeRoutine(routineId: string): Promise<string | undefined> {
  const routine = await db.query.routines.findFirst({
    where: eq(routines.id, routineId),
  });
  if (!routine) return;

  // A banned owner's cron would otherwise keep spending on their behalf: the
  // ban middleware only guards requests, and nobody makes one for a scheduled
  // run.
  const owner = await db.query.user.findFirst({
    where: eq(user.id, routine.ownerId),
    columns: { banned: true, banExpires: true },
  });
  if (owner?.banned && (!owner.banExpires || owner.banExpires > new Date())) {
    console.warn(`routine ${routineId} skipped: owner is banned`);
    return;
  }

  // The routine's model, exactly as stored. Nothing substitutes for it — see
  // `routines.model`. A routine that has none, or whose provider has since
  // been deleted, fails the run and says which, rather than running on
  // whatever the backend happens to have loaded.
  const resolved = await resolveRoutineModel(routine.model);

  const runId = uuid();
  const convId = uuid();
  const startedAt = new Date();

  try {
    await db.transaction(async (tx) => {
      await tx.insert(conversations).values({
        id: convId,
        ownerId: routine.ownerId,
        title: `Routine: ${routine.name}`,
        kind: "routine",
        // So the client opening this chat shows, and continues on, the model
        // the run actually used.
        ...(routine.model ? { modelPref: { model: routine.model } } : {}),
      });
      await tx.insert(routineRuns).values({
        id: runId, routineId, conversationId: convId,
        status: "running", startedAt,
      });
    });
  } catch (err) {
    // The routine was deleted between the read above and here: the run row's
    // foreign key has nothing to point at. Nothing to record and nobody to
    // tell.
    console.warn(`routine ${routineId} run not started:`, err);
    return;
  }

  await db.update(routines).set({ lastRunAt: startedAt }).where(eq(routines.id, routineId));
  // A tick has just been consumed, so the job's next fire time has moved.
  void recordNextRun(routineId);

  if (!resolved.ok) {
    await recordFailedStart(routine, convId, runId, resolved.reason);
    return runId;
  }

  try {
    await startChatRun({
      userId: routine.ownerId,
      content: routine.prompt,
      model: resolved.model,
      conversationId: convId,
      // A cron firing is nobody's choice of model — see `recordUse`.
      recordUse: false,
      onSettled: (info) => {
        void settleRun(runId, routine.ownerId, routine.name, info);
      },
    });
  } catch (err) {
    // A refusal between here and the first token: the conversation exists and
    // is empty, so say why in it rather than leaving a blank chat.
    await recordFailedStart(routine, convId, runId, (err as Error).message);
  }

  return runId;
}

/**
 * The model this run will use, or why there isn't one.
 *
 * Both failures — never chosen, and no longer resolvable — reach the user as a
 * sentence in the run's own chat. Neither is ever answered with a substitute
 * model: a routine that quietly ran on something else would bill an admin's
 * provider key for a choice nobody made, and say nothing about it.
 */
async function resolveRoutineModel(
  model: string | null,
): Promise<{ ok: true; model: string } | { ok: false; reason: string }> {
  if (!model) {
    return {
      ok: false,
      reason: "This routine has no model. Edit the routine and choose one, then run it again.",
    };
  }
  try {
    await assertModelUsable(model);
    return { ok: true, model };
  } catch (err) {
    if (err instanceof ModelRefError) {
      return { ok: false, reason: `This routine's model (${model}) cannot be used. ${err.message}` };
    }
    throw err;
  }
}

/**
 * Write a run that never reached the model as a finished, failed one: the
 * prompt the user would have sent, and an assistant row carrying the reason.
 *
 * The error goes on the message in the same shape a failed turn persists
 * (engine.ts), so the client renders it with no new case — the alternative
 * being a routine whose history fills with empty chats.
 */
async function recordFailedStart(
  routine: typeof routines.$inferSelect,
  convId: string,
  runId: string,
  reason: string,
) {
  const now = Date.now();
  await db
    .insert(messages)
    .values([
      {
        id: uuid(), conversationId: convId, parentId: null,
        authorType: "user", authorUserId: routine.ownerId,
        origin: "server", lamport: now,
        content: [{ kind: "text", text: routine.prompt }] as ContentBlock[],
        status: "complete", createdAt: new Date(),
      },
      {
        id: uuid(), conversationId: convId, parentId: null,
        authorType: "assistant", origin: "server",
        lamport: now + 1,
        content: [] as ContentBlock[],
        status: "error", error: reason, createdAt: new Date(),
      },
    ])
    .catch((err: unknown) => {
      console.error(`routine ${routine.id} could not record its failure:`, err);
    });
  await settleRun(runId, routine.ownerId, routine.name, { status: "error", error: reason });
}

/**
 * Record how a run ended, and tell the owner.
 *
 * The update is conditional on the row still being `running`: a routine
 * deleted mid-run takes its rows with it (the conversation is erased and the
 * run row cascades), and a run whose status is already written must not be
 * rewritten by a late settle. Nothing came back means nothing to announce —
 * which is exactly what should happen for a run the user deleted.
 */
async function settleRun(runId: string, ownerId: string, name: string, info: RunSettled) {
  const status = info.status === "complete" ? "completed" : info.status === "cancelled" ? "cancelled" : "failed";
  try {
    const rows = await db
      .update(routineRuns)
      .set({ status, finishedAt: new Date() })
      .where(and(eq(routineRuns.id, runId), eq(routineRuns.status, "running")))
      .returning({ id: routineRuns.id });
    if (rows.length === 0) return;
    // A user who pressed stop knows the run stopped; only the two outcomes
    // they did not ask for are worth a push.
    if (status === "cancelled") return;
    await sendNtfyNotification(
      ownerId,
      name,
      status === "completed" ? "Routine completed" : `Routine failed: ${info.error ?? "unknown error"}`,
    ).catch(() => undefined);
  } catch (err) {
    console.error(`routine run ${runId} could not be finalized:`, err);
  }
}

async function sendNtfyNotification(userId: string, title: string, message: string) {
  const ntfyUrl = process.env.NTFY_URL ?? "http://localhost:4003";
  try {
    await fetch(`${ntfyUrl}/loxaic-${userId}`, {
      method: "POST",
      body: JSON.stringify({ topic: `loxaic-${userId}`, title, message }),
    });
  } catch {
    // ntfy may not be running in dev
  }
}
