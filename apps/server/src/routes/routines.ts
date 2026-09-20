import type { FastifyInstance } from "fastify";
import cron from "node-cron";
import { eq, and, desc, isNull, count } from "@loxaic/db";
import { db } from "@loxaic/db";
import { routines, routineRuns, conversations } from "@loxaic/db/schema";
import { authenticate } from "../auth/middleware";
import { deleteConversation } from "../conversations/delete.ts";
import { ModelRefError, assertModelUsable } from "../inference/providers.ts";
import { getRunByConversation } from "../streams/registry.ts";
import { scheduleRoutine, unscheduleRoutine, executeRoutine } from "../routines/scheduler";

async function findOwnedRoutine(id: string, userId: string) {
  return db.query.routines.findFirst({
    where: and(eq(routines.id, id), eq(routines.ownerId, userId)),
  });
}

/**
 * Validate a routine's cron expression and model before the row is written.
 *
 * Both used to fail later and worse: an invalid cron inserted the row and then
 * threw out of `cron.schedule`, leaving a routine that existed and was never
 * scheduled, and an unusable model was only discovered by the run itself, at
 * 6am, with nobody watching. Returns the message to answer with, or null.
 */
async function rejectionFor(input: { cron?: string; model?: string | null }): Promise<string | null> {
  if (input.cron !== undefined && !cron.validate(input.cron)) {
    return `"${input.cron}" is not a valid cron expression.`;
  }
  if (input.model !== undefined && input.model !== null) {
    try {
      await assertModelUsable(input.model);
    } catch (err) {
      if (err instanceof ModelRefError) return err.message;
      throw err;
    }
  }
  return null;
}

export function routineRoutes(app: FastifyInstance) {
  app.get("/v1/routines", async (request, reply) => {
    const userId = await authenticate(request, reply);
    return db
      .select()
      .from(routines)
      .where(eq(routines.ownerId, userId))
      .orderBy(desc(routines.createdAt));
  });

  app.post("/v1/routines", async (request, reply) => {
    const userId = await authenticate(request, reply);
    const { name, cron: cronExpr, prompt, model } = request.body as {
      name: string;
      cron: string;
      prompt: string;
      // Absent only from an older client. That routine fails every run, with
      // the reason in the run's own chat, until someone picks a model.
      model?: string | null;
    };
    const rejection = await rejectionFor({ cron: cronExpr, model });
    if (rejection) {
      reply.code(400);
      return { error: rejection };
    }
    const [r] = await db
      .insert(routines)
      .values({ ownerId: userId, name, cron: cronExpr, prompt, model: model ?? null })
      .returning();
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

    const { name, cron: cronExpr, prompt, enabled, model } = request.body as {
      name?: string;
      cron?: string;
      prompt?: string;
      enabled?: boolean;
      model?: string | null;
    };
    // A model can be changed but never removed: a routine that once had one
    // and now does not would start failing its runs for a reason nobody chose.
    if (model === null) {
      reply.code(400);
      return { error: "A routine needs a model. Choose a different one instead of removing it." };
    }
    const rejection = await rejectionFor({ cron: cronExpr, model });
    if (rejection) {
      reply.code(400);
      return { error: rejection };
    }

    const patch: Partial<typeof routines.$inferInsert> = {};
    if (name !== undefined) patch.name = name;
    if (cronExpr !== undefined) patch.cron = cronExpr;
    if (prompt !== undefined) patch.prompt = prompt;
    if (enabled !== undefined) patch.enabled = enabled;
    if (model !== undefined) patch.model = model;

    const [updated] = await db
      .update(routines)
      .set(patch)
      .where(and(eq(routines.id, request.params.id), eq(routines.ownerId, userId)))
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

    // Returns once the run has started — the row comes back `running`, and the
    // client opens its conversation and watches the stream from there.
    const runId = await executeRoutine(existing.id);
    const run = runId
      ? await db.query.routineRuns.findFirst({ where: eq(routineRuns.id, runId) })
      : null;
    if (!run) {
      // `executeRoutine` returns nothing when it could not write the run at
      // all — the routine deleted underneath it, or the insert failing. This
      // used to answer `200 {ok: true}`, which the client is typed to read as
      // a run: it opened `conversationId: undefined` and blanked a screen full
      // of history, with nothing saying the run had never started.
      reply.code(409);
      return { error: "The run could not be started. Try again." };
    }
    return run;
  });

  /**
   * Delete a routine, its runs, and the chats those runs produced.
   *
   * The order matters. Conversations go first, one at a time through
   * `deleteConversation`, which is the only thing that knows what deleting a
   * conversation means on this deployment — erase, or retain for an audit. A
   * throw there leaves the routine intact, so the whole delete is retryable
   * rather than half-done. Only then do the rows go, and a second pass catches
   * a run that started while the first pass was walking.
   *
   * Never `purgeConversation`: a routine's chats can be continued by hand, and
   * deleting the routine must not become a way around a deployment's retention
   * policy.
   */
  app.delete<{ Params: { id: string } }>("/v1/routines/:id", async (request, reply) => {
    const userId = await authenticate(request, reply);
    const existing = await findOwnedRoutine(request.params.id, userId);
    if (!existing) {
      // Unlike every other verb here, this used to answer {ok:true} for a
      // routine that was not yours — and for one that did not exist, which is
      // what a second delete looks like.
      reply.code(404);
      return { error: "Not found" };
    }

    const first = await db
      .select({ conversationId: routineRuns.conversationId })
      .from(routineRuns)
      .where(eq(routineRuns.routineId, existing.id));
    const erased = new Set<string>();
    for (const row of first) {
      await deleteConversation(row.conversationId, request.log);
      erased.add(row.conversationId);
    }

    // The routine goes with its rows: `routine_runs.routine_id` cascades, so
    // the delete below removes both, and RETURNING is how a run that raced the
    // pass above is still accounted for.
    const straggler = await db.transaction(async (tx) => {
      const rows = await tx
        .delete(routineRuns)
        .where(eq(routineRuns.routineId, existing.id))
        .returning({ conversationId: routineRuns.conversationId });
      await tx.delete(routines).where(eq(routines.id, existing.id));
      return rows;
    });

    // Only now, with the row gone. Unscheduling first looked tidier and left a
    // hole: a throw in the pass above answers 500 with the routine intact —
    // which is the point, the delete is retryable — but nothing re-adds a job
    // outside POST, PATCH and boot, so the routine came back in the list
    // looking enabled and silently never fired again until a restart. A tick
    // that lands in the gap is harmless either way: before the transaction its
    // run row is caught by RETURNING above, and after it `executeRoutine`
    // finds no routine and returns.
    unscheduleRoutine(existing.id);

    for (const row of straggler) {
      if (erased.has(row.conversationId)) continue;
      await deleteConversation(row.conversationId, request.log);
    }

    return { ok: true };
  });

  /**
   * This routine's chats, newest run first — the list behind the routine
   * chat's own history panel.
   *
   * Shaped like a row of `GET /v1/conversations` so the client's existing
   * thread list renders it unchanged, plus the run that produced it. The join
   * is what excludes a chat the user deleted from inside the routine: a
   * retained conversation is gone from every ordinary path, and a routine's
   * history is one.
   */
  app.get<{ Params: { id: string } }>("/v1/routines/:id/conversations", async (request, reply) => {
    const userId = await authenticate(request, reply);
    const existing = await findOwnedRoutine(request.params.id, userId);
    if (!existing) {
      reply.code(404);
      return { error: "Not found" };
    }

    const rows = await db
      .select({
        conversation: conversations,
        run: {
          id: routineRuns.id,
          status: routineRuns.status,
          startedAt: routineRuns.startedAt,
          finishedAt: routineRuns.finishedAt,
        },
      })
      .from(routineRuns)
      .innerJoin(conversations, eq(conversations.id, routineRuns.conversationId))
      .where(
        and(
          eq(routineRuns.routineId, existing.id),
          eq(conversations.ownerId, userId),
          isNull(conversations.deletedAt),
        ),
      )
      .orderBy(desc(routineRuns.startedAt))
      .limit(50);

    return rows.map(({ conversation, run }) => ({
      ...conversation,
      role: "owner" as const,
      active_run: getRunByConversation(conversation.id) !== undefined,
      run,
    }));
  });

  /**
   * How many chats deleting this routine takes with it.
   *
   * Its own route because the listing above is a page: capped at 50, which is
   * right for a history panel and wrong for the sentence in the delete dialog.
   * An hourly routine a week old has ~168 chats, the dialog said "Its 50 chats
   * go with it", and the delete — which walks every run row — then removed all
   * of them. Same join as the listing, so it counts what the user can see.
   */
  app.get<{ Params: { id: string } }>("/v1/routines/:id/conversations/count", async (request, reply) => {
    const userId = await authenticate(request, reply);
    const existing = await findOwnedRoutine(request.params.id, userId);
    if (!existing) {
      reply.code(404);
      return { error: "Not found" };
    }
    const [row] = await db
      .select({ n: count() })
      .from(routineRuns)
      .innerJoin(conversations, eq(conversations.id, routineRuns.conversationId))
      .where(
        and(
          eq(routineRuns.routineId, existing.id),
          eq(conversations.ownerId, userId),
          isNull(conversations.deletedAt),
        ),
      );
    return { count: row.n };
  });

  app.get<{ Params: { id: string } }>("/v1/routines/:id/runs", async (request, reply) => {
    const userId = await authenticate(request, reply);
    const existing = await findOwnedRoutine(request.params.id, userId);
    if (!existing) {
      reply.code(404);
      return { error: "Not found" };
    }
    // Same join as the listing above: a run whose chat was deleted is not one
    // the user can open, so it is not one to list.
    const rows = await db
      .select({ run: routineRuns })
      .from(routineRuns)
      .innerJoin(conversations, eq(conversations.id, routineRuns.conversationId))
      .where(and(eq(routineRuns.routineId, existing.id), isNull(conversations.deletedAt)))
      .orderBy(desc(routineRuns.startedAt))
      .limit(20);
    return rows.map((r) => r.run);
  });
}
