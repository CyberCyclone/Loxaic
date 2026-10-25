import type { FastifyInstance } from "fastify";
import type { PromptCacheView } from "@loxaic/types";
import { authenticate } from "../auth/middleware";
import { getLocalModelRow, isServable } from "../llama/catalog.ts";
import { conversationCacheView } from "../llama/slot-store.ts";
import { NotFoundError, assertConversationAccess } from "../streams/authz.ts";

/**
 * `GET /v1/conversations/:id/prompt-cache?model=`: what this conversation's
 * next turn on `model` will find of its KV cache (llama/slot-cache.ts) — for
 * the banner above the composer that says a reload took it, and how long the
 * re-read will be. Anyone who can read the conversation may ask.
 */
export function promptCacheRoutes(app: FastifyInstance) {
  app.get("/v1/conversations/:id/prompt-cache", async (request, reply) => {
    const userId = await authenticate(request, reply);
    const { id } = request.params as { id: string };
    const { model } = request.query as { model?: string };
    if (typeof model !== "string" || !model) return reply.code(400).send({ error: "model is required" });
    try {
      await assertConversationAccess(userId, id, "viewer");
    } catch (err) {
      if (err instanceof NotFoundError) return reply.code(404).send({ error: "Conversation not found" });
      throw err;
    }
    const row = await getLocalModelRow(model);
    const view: PromptCacheView = await conversationCacheView(id, model, Boolean(row && isServable(row)));
    return view;
  });
}
