import type { FastifyInstance } from "fastify";
import { eq, and, desc } from "@shannon/db";
import { db } from "@shannon/db";
import { routines, routineRuns } from "@shannon/db/schema";
import { authenticate } from "../auth/middleware";
import { scheduleRoutine, unscheduleRoutine } from "../routines/scheduler";

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

  app.delete<{ Params: { id: string } }>("/v1/routines/:id", async (request, reply) => {
    const userId = await authenticate(request, reply);
    unscheduleRoutine(request.params.id);
    await db.update(routines).set({ enabled: false }).where(and(eq(routines.id, request.params.id), eq(routines.ownerId, userId)));
    return { ok: true };
  });

  app.get("/v1/routines/:id/runs", async (request, reply) => {
    const userId = await authenticate(request, reply);
    return db.select().from(routineRuns).where(eq(routineRuns.routineId, (request.params as { id: string }).id)).orderBy(desc(routineRuns.startedAt)).limit(20);
  });
}