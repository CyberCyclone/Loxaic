import type { FastifyInstance } from "fastify";
import { db, eq } from "@loxaic/db";
import { userPrefs } from "@loxaic/db/schema";
import { isToolName } from "@loxaic/agent";
import {
  DEFAULT_CHECKIN_AUTO_CONTINUES,
  DEFAULT_LOOP_SENSITIVITY,
  LOOP_SENSITIVITIES,
  MAX_CHECKIN_AUTO_CONTINUES,
  MAX_WAIT_TIMEOUT_MS,
  MIN_WAIT_TIMEOUT_MS,
  isLoopSensitivity,
  type LoopSensitivity,
} from "@loxaic/types";
import { authenticate } from "../auth/middleware";
import { normalizeRecentModels } from "../inference/recent-models.ts";
import {
  clampMaxIterations,
  DEFAULT_MAX_ITERATIONS,
  MAX_MAX_ITERATIONS,
  MIN_MAX_ITERATIONS,
} from "../streams/runs/engine.ts";
import { clampAutoContinues, clampWaitTimeoutMs, serverDefaultTimeoutMs } from "../streams/runs/timeouts.ts";

/** What the API exposes. Builtin tools only for the allowlist; MCP tools have
 * their own per-server toolPolicies allowlist (PATCH /v1/mcp/servers/:id). */
function toApi(row: {
  toolAllowlist: unknown;
  autoCompact?: boolean;
  maxIterations?: number;
  recentModels?: unknown;
  checkinTimeoutMs?: number | null;
  approvalTimeoutMs?: number | null;
  adaptiveTimeout?: boolean;
  checkinAutoContinues?: number;
  loopSensitivity?: string;
}) {
  const allowlist = Array.isArray(row.toolAllowlist) ? row.toolAllowlist.filter(isToolName) : [];
  // Default true, matching the column: a user who has never had a prefs row
  // must read the same as one whose row says nothing, or the setting would
  // appear off until the first time they touched anything else.
  return {
    toolAllowlist: allowlist,
    autoCompact: row.autoCompact ?? true,
    // Clamped with the *same* function the engine enforces with, not a
    // parallel one. `?? DEFAULT` covers a missing value but not an
    // out-of-range one, and the "plain data" argument cuts both ways: if the
    // column can't be trusted to be in range for the loop, it can't be
    // trusted for the response either — otherwise the settings screen shows
    // one number while the agent enforces another.
    maxIterations: clampMaxIterations(row.maxIterations ?? DEFAULT_MAX_ITERATIONS),
    // Read-only: written by the run starters when a model is actually sent
    // with, and deliberately absent from the PATCH below. A client that could
    // write it could put a model at the top of everyone's picker without
    // anyone having run it — and more practically, two clients with stale
    // copies would fight over the order.
    recentModels: normalizeRecentModels(row.recentModels),
    // Null is a real value here — "use the server's default" — not a missing
    // one, and is sent as null rather than omitted: a client reads an absent
    // key as "this server has no such setting" and hides the row.
    checkinTimeoutMs: clampWaitTimeoutMs(row.checkinTimeoutMs),
    approvalTimeoutMs: clampWaitTimeoutMs(row.approvalTimeoutMs),
    adaptiveTimeout: row.adaptiveTimeout ?? true,
    checkinAutoContinues: clampAutoContinues(row.checkinAutoContinues) ?? DEFAULT_CHECKIN_AUTO_CONTINUES,
    loopSensitivity: isLoopSensitivity(row.loopSensitivity) ? row.loopSensitivity : DEFAULT_LOOP_SENSITIVITY,
    // What "server default" currently means, so the settings screen can label
    // that choice with a real number. Read-only and live: it is the operator's
    // APPROVAL_TIMEOUT_MS if set, and moves with it.
    serverDefaults: {
      checkinTimeoutMs: serverDefaultTimeoutMs(),
      approvalTimeoutMs: serverDefaultTimeoutMs(),
    },
  };
}

/**
 * A wait window from a request body: a whole number of ms in range, or null
 * to go back to the server default. Returns the value, or an error string.
 */
function parseWaitTimeout(name: string, value: unknown): number | null | { error: string } {
  if (value === null) return null;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < MIN_WAIT_TIMEOUT_MS ||
    value > MAX_WAIT_TIMEOUT_MS
  ) {
    return {
      error:
        `${name} must be a whole number of milliseconds between ${String(MIN_WAIT_TIMEOUT_MS)} and ` +
        `${String(MAX_WAIT_TIMEOUT_MS)}, or null for the server default`,
    };
  }
  return value;
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
    const body = (request.body ?? {}) as {
      toolAllowlist?: unknown;
      autoCompact?: unknown;
      maxIterations?: unknown;
      recentModels?: unknown;
      checkinTimeoutMs?: unknown;
      approvalTimeoutMs?: unknown;
      adaptiveTimeout?: unknown;
      checkinAutoContinues?: unknown;
      loopSensitivity?: unknown;
      serverDefaults?: unknown;
    };

    // Named rather than ignored: silently dropping it would leave a client
    // believing it had reordered the list.
    if (body.recentModels !== undefined) {
      reply.code(400);
      return { error: "recentModels is recorded by the server when a model is used, and cannot be set" };
    }
    if (body.serverDefaults !== undefined) {
      reply.code(400);
      return { error: "serverDefaults describes the operator's configuration and cannot be set" };
    }

    const patch: {
      toolAllowlist?: string[];
      autoCompact?: boolean;
      maxIterations?: number;
      checkinTimeoutMs?: number | null;
      approvalTimeoutMs?: number | null;
      adaptiveTimeout?: boolean;
      checkinAutoContinues?: number;
      loopSensitivity?: LoopSensitivity;
    } = {};
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
    if (body.maxIterations !== undefined) {
      const n = body.maxIterations;
      // Bounded here as well as clamped on read. Rejecting rather than
      // silently clamping tells a client its value was not what it asked for;
      // the read-side clamp is the belt for values that never came through
      // this route at all.
      if (
        typeof n !== "number" ||
        !Number.isInteger(n) ||
        n < MIN_MAX_ITERATIONS ||
        n > MAX_MAX_ITERATIONS
      ) {
        reply.code(400);
        return {
          error: `maxIterations must be a whole number between ${String(MIN_MAX_ITERATIONS)} and ${String(MAX_MAX_ITERATIONS)}`,
        };
      }
      patch.maxIterations = n;
    }
    // Both waits: rejected out of range rather than clamped, same as
    // maxIterations. The 5-second floor is not a product choice — it is what
    // lets an end-to-end test wait a window out.
    for (const key of ["checkinTimeoutMs", "approvalTimeoutMs"] as const) {
      if (body[key] === undefined) continue;
      const parsed = parseWaitTimeout(key, body[key]);
      if (parsed !== null && typeof parsed === "object") {
        reply.code(400);
        return parsed;
      }
      patch[key] = parsed;
    }
    if (body.adaptiveTimeout !== undefined) {
      if (typeof body.adaptiveTimeout !== "boolean") {
        reply.code(400);
        return { error: "adaptiveTimeout must be a boolean" };
      }
      patch.adaptiveTimeout = body.adaptiveTimeout;
    }
    if (body.checkinAutoContinues !== undefined) {
      const n = body.checkinAutoContinues;
      // Capped low on purpose: each one is another full step window of work
      // with nobody watching, and the cap is what bounds an abandoned run.
      if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > MAX_CHECKIN_AUTO_CONTINUES) {
        reply.code(400);
        return {
          error: `checkinAutoContinues must be a whole number between 0 and ${String(MAX_CHECKIN_AUTO_CONTINUES)}`,
        };
      }
      patch.checkinAutoContinues = n;
    }
    if (body.loopSensitivity !== undefined) {
      if (!isLoopSensitivity(body.loopSensitivity)) {
        reply.code(400);
        return { error: `loopSensitivity must be one of ${LOOP_SENSITIVITIES.join(", ")}` };
      }
      patch.loopSensitivity = body.loopSensitivity;
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
