/**
 * `GET /v1/executors` — the caller's own machines that are connected right
 * now, for the workspace chooser. Only theirs: which machines a user has,
 * and what folders they chose on them, is not something another user (or an
 * admin) has a reason to see.
 */
import type { FastifyInstance } from "fastify";
import { authenticate } from "../auth/middleware";
import { listExecutors } from "../executor/registry.ts";

export function executorRoutes(app: FastifyInstance) {
  app.get("/v1/executors", async (request, reply) => {
    const userId = await authenticate(request, reply);
    return listExecutors(userId).map((e) => ({
      id: e.executorId,
      name: e.name,
      platform: e.platform,
      capabilities: e.capabilities,
      roots: e.roots,
      connectedAt: new Date(e.connectedAt).toISOString(),
    }));
  });
}
