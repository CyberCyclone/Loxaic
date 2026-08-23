import type { FastifyInstance } from "fastify";
import { eq, and, desc } from "@shannon/db";
import { db } from "@shannon/db";
import { routines, routineRuns } from "@shannon/db/schema";
import { authenticate } from "../auth/middleware";
import { scheduleRoutine, unscheduleRoutine, executeRoutine } from "../routines/scheduler";

async function findOwnedRoutine(id: string, userId: string) {
  return db.query.routines.findFirst({
    where: and(eq(routines.id, id), eq(routines.ownerId, userId)),
  });
}

export async function routineRoutes(app: FastifyInstance) {
  app.get("/v1/routines", async (request, reply) => {
    const userId = await authenticate(request, reply);
    return db.select().from(routines).where(eq(routines.ownerId, userId));
  });

  app.post("/v1/routines", async (request, reply) => {
    const userId = await authenticate(request, reply);
    const { name, cron, prompt } = request.body as { name: string; cron: string; prompt: string };
    const [r] = await db.insert(routines).values({ ownerId: userId, name, cron, prompt }).returning();
    scheduleRoutine(r.id, r.cron);
    return r;
  });

  app.patch<{ Params: { id: string } }>("/v1/routines/:id", async (request, reply) => {
    const userId = await authenticate(request, reply);
    const existing = await findOwnedRoutine(request.params.id, userId);
    if (!existing) {
      reply.code(404);
      return { error: "Not found" };
    }

    const { name, cron, prompt, enabled } = request.body as {
      name?: string;
      cron?: string;
      prompt?: string;
      enabled?: boolean;
    };
    const patch: Partial<typeof routines.$inferInsert> = {};
    if (name !== undefined) patch.name = name;
    if (cron !== undefined) patch.cron = cron;
    if (prompt !== undefined) patch.prompt = prompt;
    if (enabled !== undefined) patch.enabled = enabled;

    const [updated] = await db
      .update(routines)
      .set(patch)
      .where(eq(routines.id, request.params.id))
      .returning();

    if (updated.enabled) {
      scheduleRoutine(updated.id, updated.cron);
    } else {
      unscheduleRoutine(updated.id);
    }

    return updated;
  });

  app.post<{ Params: { id: string } }>("/v1/routines/:id/run", async (request, reply) => {
    const userId = await authenticate(request, reply);
    const existing = await findOwnedRoutine(request.params.id, userId);
    if (!existing) {
      reply.code(404);
      return { error: "Not found" };
    }

    const runId = await executeRoutine(existing.id);
    const run = runId
      ? await db.query.routineRuns.findFirst({ where: eq(routineRuns.id, runId) })
      : null;
    return run ?? { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/v1/routines/:id", async (request, reply) => {
    const userId = await authenticate(request, reply);
    unscheduleRoutine(request.params.id);
    await db.update(routines).set({ enabled: false }).where(and(eq(routines.id, request.params.id), eq(routines.ownerId, userId)));
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>("/v1/routines/:id/runs", async (request, reply) => {
    const userId = await authenticate(request, reply);
    const existing = await findOwnedRoutine(request.params.id, userId);
    if (!existing) {
      reply.code(404);
      return { error: "Not found" };
    }
    return db
      .select()
      .from(routineRuns)
      .where(eq(routineRuns.routineId, existing.id))
      .orderBy(desc(routineRuns.startedAt))
      .limit(20);
  });
}