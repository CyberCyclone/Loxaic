import type { FastifyInstance } from "fastify";
import { db, eq } from "@shannon/db";
import { userPrefs } from "@shannon/db/schema";
import { isToolName } from "@shannon/agent";
import { authenticate } from "../auth/middleware";

/** What the API exposes. Builtin-only today; MCP tools have their own
 * per-server toolPolicies allowlist (PATCH /v1/mcp/servers/:id). */
function toApi(row: { toolAllowlist: unknown }) {
  const allowlist = Array.isArray(row.toolAllowlist) ? row.toolAllowlist.filter(isToolName) : [];
  return { toolAllowlist: allowlist };
}

export function prefsRoutes(app: FastifyInstance) {
  app.get("/v1/prefs", async (request, reply) => {
    const userId = await authenticate(request, reply);
    const row = await db.query.userPrefs.findFirst({ where: eq(userPrefs.userId, userId) });
    return toApi(row ?? { toolAllowlist: [] });
  });

  app.patch("/v1/prefs", async (request, reply) => {
    const userId = await authenticate(request, reply);
    const body = (request.body ?? {}) as { toolAllowlist?: unknown };
    if (!Array.isArray(body.toolAllowlist) || !body.toolAllowlist.every(isToolName)) {
      reply.code(400);
      return { error: "toolAllowlist must be an array of builtin tool names" };
    }

    const [row] = await db
      .insert(userPrefs)
      .values({ userId, toolAllowlist: body.toolAllowlist, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: userPrefs.userId,
        set: { toolAllowlist: body.toolAllowlist, updatedAt: new Date() },
      })
      .returning();
    return toApi(row);
  });
}
