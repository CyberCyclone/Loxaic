import type { FastifyInstance } from "fastify";
import { db, eq } from "@loxaic/db";
import { userPrefs } from "@loxaic/db/schema";
import { isToolName } from "@loxaic/agent";
import { authenticate } from "../auth/middleware";

/** What the API exposes. Builtin tools only for the allowlist; MCP tools have
 * their own per-server toolPolicies allowlist (PATCH /v1/mcp/servers/:id). */
function toApi(row: { toolAllowlist: unknown; autoCompact?: boolean }) {
  const allowlist = Array.isArray(row.toolAllowlist) ? row.toolAllowlist.filter(isToolName) : [];
  // Default true, matching the column: a user who has never had a prefs row
  // must read the same as one whose row says nothing, or the setting would
  // appear off until the first time they touched anything else.
  return { toolAllowlist: allowlist, autoCompact: row.autoCompact ?? true };
}

export function prefsRoutes(app: FastifyInstance) {
  app.get("/v1/prefs", async (request, reply) => {
    const userId = await authenticate(request, reply);
    const row = await db.query.userPrefs.findFirst({ where: eq(userPrefs.userId, userId) });
    return toApi(row ?? { toolAllowlist: [] });
  });

  /**
   * Partial by design. It used to require `toolAllowlist` on every call, so
   * adding a second field would have meant every writer of one had to send the
   * other — and a client that read stale prefs first would silently revert it.
   * Absent keys are left alone; a present key must still be well-formed.
   */
  app.patch("/v1/prefs", async (request, reply) => {
    const userId = await authenticate(request, reply);
    const body = (request.body ?? {}) as { toolAllowlist?: unknown; autoCompact?: unknown };

    const patch: { toolAllowlist?: string[]; autoCompact?: boolean } = {};
    if (body.toolAllowlist !== undefined) {
      if (!Array.isArray(body.toolAllowlist) || !body.toolAllowlist.every(isToolName)) {
        reply.code(400);
        return { error: "toolAllowlist must be an array of builtin tool names" };
      }
      patch.toolAllowlist = body.toolAllowlist;
    }
    if (body.autoCompact !== undefined) {
      if (typeof body.autoCompact !== "boolean") {
        reply.code(400);
        return { error: "autoCompact must be a boolean" };
      }
      patch.autoCompact = body.autoCompact;
    }
    if (Object.keys(patch).length === 0) {
      reply.code(400);
      return { error: "Nothing to update" };
    }

    const [row] = await db
      .insert(userPrefs)
      .values({ userId, ...patch, updatedAt: new Date() })
      .onConflictDoUpdate({ target: userPrefs.userId, set: { ...patch, updatedAt: new Date() } })
      .returning();
    return toApi(row);
  });
}
