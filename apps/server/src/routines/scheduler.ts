import cron from "node-cron";
import { v4 as uuid } from "uuid";
import { eq } from "@shannon/db";
import { db } from "@shannon/db";
import { routines, routineRuns, conversations, messages } from "@shannon/db/schema";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const jobs = new Map<string, any>();

export async function startRoutineScheduler() {
  const rows = await db.select().from(routines).where(eq(routines.enabled, true));
  for (const r of rows) scheduleRoutine(r.id, r.cron);
}

export function scheduleRoutine(routineId: string, cronExpr: string) {
  const existing = jobs.get(routineId);
  if (existing) existing.stop();

  const job = cron.schedule(cronExpr, async () => {
    await executeRoutine(routineId);
  });
  jobs.set(routineId, job);
}

export function unscheduleRoutine(routineId: string) {
  const job = jobs.get(routineId);
  if (job) { job.stop(); jobs.delete(routineId); }
}

async function executeRoutine(routineId: string) {
  const routine = await db.query.routines.findFirst({
    where: eq(routines.id, routineId),
  });
  if (!routine || !routine.enabled) return;

  const runId = uuid();
  const convId = uuid();

  // Create conversation + run record
  await db.insert(conversations).values({
    id: convId, ownerId: routine.ownerId,
    title: `Routine: ${routine.name}`, kind: "routine",
  });
  await db.insert(routineRuns).values({
    id: runId, routineId, conversationId: convId,
    status: "running", startedAt: new Date(),
  });

  try {
    // Simulate agent execution (in full impl, would call inference)
    await db.insert(messages).values({
      id: uuid(), conversationId: convId, parentId: null,
      authorType: "user", authorUserId: routine.ownerId,
      origin: "server", lamport: Date.now(),
      content: [{ kind: "text", text: routine.prompt }],
      status: "complete", createdAt: new Date(),
    });

    // Placeholder assistant response
    await db.insert(messages).values({
      id: uuid(), conversationId: convId, parentId: null,
      authorType: "assistant", origin: "server",
      model: "routine", lamport: Date.now() + 1,
      content: [{ kind: "text", text: `[Routine "${routine.name}" executed at ${new Date().toISOString()}]` }],
      status: "complete", createdAt: new Date(),
    });

    await db.update(routineRuns).set({
      status: "completed", finishedAt: new Date(),
    }).where(eq(routineRuns.id, runId));

    // ntfy push notification
    sendNtfyNotification(routine.ownerId, routine.name, "Routine completed").catch(() => {});
  } catch (err) {
    await db.update(routineRuns).set({
      status: "failed", finishedAt: new Date(),
    }).where(eq(routineRuns.id, runId));
  }

  // Update next run
  const now = new Date();
  await db.update(routines).set({
    lastRunAt: now,
    nextRunAt: now, // cron handles the actual next trigger
  }).where(eq(routines.id, routineId));
}

async function sendNtfyNotification(userId: string, title: string, message: string) {
  const ntfyUrl = process.env.NTFY_URL || "http://localhost:4003";
  try {
    await fetch(`${ntfyUrl}/shannon-${userId}`, {
      method: "POST",
      body: JSON.stringify({ topic: `shannon-${userId}`, title, message }),
    });
  } catch {
    // ntfy may not be running in dev
  }
}