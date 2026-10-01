import type { FastifyInstance, FastifyReply } from "fastify";
import { authenticate } from "../auth/middleware";
import { invalidateBackendModels } from "../inference/models.ts";
import { getLocalModelRow, isServable, type LocalModelRow } from "../llama/catalog.ts";
import { StageRequestError, checkStageRequest, conversationTokens, stageInfo } from "../llama/context-stage-policy.ts";
import { applyStageChange, formatTokens, pendingStage, pendingSwitch, stageWindows, withdrawStageChange } from "../llama/context-stage-switch.ts";
import { rowStages } from "../llama/context-stages.ts";
import { AUTO_COMPACT_THRESHOLD } from "../streams/runs/auto-compact.ts";
import { NotFoundError, assertConversationAccess, isAdmin } from "../streams/authz.ts";
import { getStreamBroker } from "../streams/index.ts";
import { waitForRunEnd } from "../streams/registry.ts";
import { startStageRun } from "../streams/runs/stageRun.ts";

/**
 * `/v1/models/context-stage`: a host model's YaRN context stages, for anyone
 * who may use the model — the modals, the context popup and Context settings.
 *
 * Not admin-only, deliberately: the person whose conversation is filling up is
 * the one who decides to extend it, and an admin who wants that decision for
 * themselves sets the model's `whoMayChange` to admins. Every change is logged
 * with who made it (llama/context-stage-switch.ts).
 *
 * A change made from a conversation is a stage run in it, so it shows on every
 * device and holds the conversation's lock; one made with no conversation (the
 * popup with nothing open) runs detached and reports only through the model
 * list's `context_stage.pending`.
 */

function fail(reply: FastifyReply, err: unknown) {
  if (err instanceof StageRequestError) return reply.code(err.status).send({ error: err.message, code: err.code });
  if (err instanceof NotFoundError) return reply.code(404).send({ error: "Conversation not found" });
  throw err;
}

/** The model, when it is one anybody may use and it has stages. */
async function stagedModel(ref: unknown): Promise<LocalModelRow | null> {
  if (typeof ref !== "string" || !ref) return null;
  const row = await getLocalModelRow(ref);
  return row && isServable(row) ? row : null;
}

function surfaceOf(kind: string | undefined): "chat" | "agent" {
  return kind === "agent" ? "agent" : "chat";
}

export function contextStageRoutes(app: FastifyInstance) {
  app.get("/v1/models/context-stage", async (request, reply) => {
    const userId = await authenticate(request, reply);
    const q = request.query as { model?: string; conversation_id?: string };
    const row = await stagedModel(q.model);
    if (!row || !rowStages(row)) return reply.code(404).send({ error: "This model has no context stages" });
    try {
      if (q.conversation_id) await assertConversationAccess(userId, q.conversation_id, "viewer");
      return await stageInfo({ row, isAdmin: await isAdmin(userId), conversationId: q.conversation_id ?? null });
    } catch (err) {
      return fail(reply, err);
    }
  });

  /**
   * Ask for a stage. `compact_first` compacts the conversation, then switches
   * only if the summary fits the smaller stage. Answers once the switch has
   * *started*: it may be waiting behind another conversation's reply.
   */
  app.post("/v1/models/context-stage", async (request, reply) => {
    const userId = await authenticate(request, reply);
    const body = (request.body ?? {}) as { model?: unknown; stage?: unknown; conversation_id?: unknown; compact_first?: unknown };
    const row = await stagedModel(body.model);
    if (!row) return reply.code(404).send({ error: "This model has no context stages" });
    const conversationId = typeof body.conversation_id === "string" && body.conversation_id ? body.conversation_id : null;
    const compactFirst = body.compact_first === true;
    try {
      if (typeof body.stage !== "number") throw new StageRequestError("not_staged", "stage is required", 400);
      if (compactFirst && !conversationId) throw new StageRequestError("not_staged", "compact_first needs a conversation", 400);
      // Changing the stage from a conversation is acting on it.
      const grant = conversationId ? await assertConversationAccess(userId, conversationId, "editor") : null;
      const { target } = await checkStageRequest({
        row,
        target: body.stage,
        isAdmin: await isAdmin(userId),
        conversationId,
        compactFirst,
        userId,
      });
      const surface = surfaceOf(grant?.kind);

      if (conversationId && compactFirst) {
        const { startCompactRun } = await import("../streams/runs/compactRun.ts");
        const compaction = await startCompactRun({ userId, conversationId, model: row.id, surface });
        // Switch only once the summary has landed and only if it fits: a
        // compaction that saved too little leaves the model where it was, and
        // says so on the stage card.
        const off = getStreamBroker().onEnd(compaction.streamId, (info) => {
          off();
          if (info.status !== "complete") return;
          void (async () => {
            // The stream's end is announced from inside the compaction run,
            // *before* its `finally` lets go of the conversation. Starting the
            // stage run now would be refused as "already in progress", so wait
            // for the conversation to be free rather than for something else
            // to take long enough. (This once worked only because the read
            // below happened to yield for a few milliseconds.)
            await waitForRunEnd(conversationId, 30_000);
            const tokens = await conversationTokens(conversationId);
            const w = stageWindows(row)[target];
            const fits = tokens === null || w === null || tokens < w * (AUTO_COMPACT_THRESHOLD || 0.85);
            await startStageRun({
              userId,
              conversationId,
              model: row.id,
              target,
              reason: "compact-first",
              auto: false,
              surface,
              ...(fits
                ? {}
                : { refuse: `Still about ${formatTokens(tokens)} tokens after compacting — too large for ${formatTokens(w)}, so the context stays where it is.` }),
            });
          })().catch((e: unknown) => { console.warn(`stage switch after compaction skipped: ${(e as Error).message}`); });
        });
        return { started: "compaction", stream_id: compaction.streamId };
      }

      if (conversationId) {
        const run = await startStageRun({ userId, conversationId, model: row.id, target, reason: "chosen", auto: false, surface });
        return { started: "stage", stream_id: run.streamId, pending: pendingStage(row.id) };
      }

      // Nothing open: detached, reported through the model list.
      const abort = new AbortController();
      void applyStageChange({ modelId: row.id, target, reason: "chosen", auto: false, byUserId: userId, signal: abort.signal })
        .then(() => { invalidateBackendModels(); })
        .catch((e: unknown) => { console.warn(`stage switch for ${row.id} failed: ${(e as Error).message}`); });
      return { started: "detached", pending: target };
    } catch (err) {
      if (err instanceof Error && err.message.includes("already in progress")) {
        return reply.code(409).send({ error: "Wait for the reply in this conversation to finish first.", code: "busy" });
      }
      return fail(reply, err);
    }
  });

  /** Withdraw a switch that has not applied yet (Cancel switch). */
  app.delete("/v1/models/context-stage", async (request, reply) => {
    const userId = await authenticate(request, reply);
    const q = request.query as { model?: string };
    const row = await stagedModel(q.model);
    const config = row ? rowStages(row) : null;
    if (!row || !config) return reply.code(404).send({ error: "This model has no context stages" });
    if (config.whoMayChange === "admins" && !(await isAdmin(userId))) {
      return reply.code(403).send({ error: "An admin controls this model's context.", code: "not_allowed" });
    }
    // A switch is its starter's to cancel (and an admin's). One an automatic
    // extension started belongs to the conversation that filled up, so whoever
    // can edit that conversation may cancel it. Anyone else could otherwise
    // withdraw a switch they cannot see, again and again.
    const waiting = pendingSwitch(row.id);
    if (waiting && waiting.byUserId !== userId && !(await isAdmin(userId))) {
      const mayCancel = waiting.conversationId
        ? await assertConversationAccess(userId, waiting.conversationId, "editor").then(() => true, () => false)
        : false;
      if (!mayCancel) {
        return reply.code(403).send({ error: "That switch was started by someone else.", code: "not_allowed" });
      }
    }
    return { withdrawn: withdrawStageChange(row.id) };
  });
}
