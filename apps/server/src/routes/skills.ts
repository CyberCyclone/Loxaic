import type { FastifyInstance } from "fastify";
import { authenticate } from "../auth/middleware";
import { NotFoundError } from "../streams/authz.ts";
import { paletteSkills } from "../skills/catalog.ts";
import { catalogForRequest } from "../skills/resolve.ts";
import { getSkillUsage } from "../skills/usage.ts";

/**
 * Skills (#283) — see AGENTS.md, "Skills".
 *
 * `GET /v1/skills` is what the composer's "/" palette lists: every skill the
 * caller can run in the named conversation (its owner's, as a send resolves
 * them), or their own when none is named, most-used first by the caller's own
 * counts. The order is the server's so every client lists the same thing.
 */
export function skillRoutes(app: FastifyInstance) {
  app.get("/v1/skills", async (request, reply) => {
    const userId = await authenticate(request, reply);
    const { conversation_id: conversationId } = request.query as { conversation_id?: string };
    try {
      const [catalog, usage] = await Promise.all([
        catalogForRequest(userId, conversationId),
        getSkillUsage(userId),
      ]);
      return { skills: paletteSkills(catalog, usage) };
    } catch (err) {
      if (err instanceof NotFoundError) {
        reply.code(404);
        return { error: "Not found" };
      }
      throw err;
    }
  });
}
