import type { FastifyInstance } from "fastify";
import { db, eq } from "@loxaic/db";
import { userPrefs } from "@loxaic/db/schema";
import { isAllowlistableTool } from "@loxaic/agent";
import {
  MAX_PROGRESS_CHECK_MS,
  MAX_PROGRESS_CHECK_STEPS,
  MAX_PROGRESS_REVIEW_PROMPT_CHARS,
  MAX_WAIT_TIMEOUT_MS,
  MIN_PROGRESS_CHECK_MS,
  MIN_PROGRESS_CHECK_STEPS,
  MIN_WAIT_TIMEOUT_MS,
  DEFAULT_SUBAGENT_MODEL_MODE,
  SUBAGENT_MODEL_MODES,
  isSubAgentModelMode,
  type SubAgentModelMode,
} from "@loxaic/types";
import { assertModelResolvable } from "../inference/providers.ts";
import { authenticate } from "../auth/middleware";
import { normalizeRecentModels } from "../inference/recent-models.ts";
import { clampWaitTimeoutMs, serverDefaultTimeoutMs } from "../streams/runs/timeouts.ts";
import {
  clampProgressCheckMs,
  clampProgressCheckSteps,
  DEFAULT_REVIEW_PROMPT,
  serverDefaultProgressCheckMs,
  serverDefaultProgressCheckSteps,
  usableReviewPrompt,
} from "../streams/runs/progress-review.ts";
import {
  addCommandRules,
  CommandRuleError,
  deleteCommandRule,
  isRuleAction,
  loadCommandRules,
} from "../permissions/store.ts";

/** What the API exposes. Builtin tools only for the allowlist; MCP tools have
 * their own per-server toolPolicies allowlist (PATCH /v1/mcp/servers/:id). */
function toApi(row: {
  toolAllowlist: unknown;
  recentModels?: unknown;
  approvalTimeoutMs?: number | null;
  adaptiveTimeout?: boolean;
  progressReview?: boolean;
  progressCheckMs?: number | null;
  progressCheckSteps?: number | null;
  progressReviewPrompt?: string | null;
  subagentModelMode?: string;
  subagentModel?: string | null;
  bashGrantRetiredAt?: Date | null;
}) {
  // Not `bash`: its grants are command rules (GET /v1/prefs/command-rules).
  const allowlist = Array.isArray(row.toolAllowlist) ? row.toolAllowlist.filter(isAllowlistableTool) : [];
  return {
    toolAllowlist: allowlist,
    // An old "allow always" for every bash command was retired for command
    // rules (migration 0043); the permissions screen says so until dismissed.
    bashGrantRetired: row.bashGrantRetiredAt != null,
    // Read-only: written by the run starters when a model is actually sent
    // with, and deliberately absent from the PATCH below. A client that could
    // write it could put a model at the top of everyone's picker without
    // anyone having run it — and more practically, two clients with stale
    // copies would fight over the order.
    recentModels: normalizeRecentModels(row.recentModels),
    // Null is a real value here — "use the server's default" — not a missing
    // one, and is sent as null rather than omitted: a client reads an absent
    // key as "this server has no such setting" and hides the row.
    approvalTimeoutMs: clampWaitTimeoutMs(row.approvalTimeoutMs),
    adaptiveTimeout: row.adaptiveTimeout ?? true,
    // Clamped with the *same* functions the engine reads with, not parallel
    // ones: a column that can't be trusted to be in range for a run can't be
    // trusted for the response either — otherwise the settings screen shows
    // one value while runs use another. A stored prompt the engine would not
    // use reads as null (the built-in one) for the same reason.
    progressReview: row.progressReview ?? true,
    progressCheckMs: clampProgressCheckMs(row.progressCheckMs),
    progressCheckSteps: clampProgressCheckSteps(row.progressCheckSteps),
    progressReviewPrompt: usableReviewPrompt(row.progressReviewPrompt),
    // Which model a sub-agent runs on (streams/runs/subagent-policy.ts). The
    // model is sent even when the mode is not `fixed`: it is what the screen
    // offers back if the person returns to that choice, and null — not an
    // absent key — when none was ever picked.
    subagentModelMode: isSubAgentModelMode(row.subagentModelMode) ? row.subagentModelMode : DEFAULT_SUBAGENT_MODEL_MODE,
    subagentModel: row.subagentModel ?? null,
    // What "server default" currently means, so the settings screen can label
    // that choice with a real value — and show the built-in reviewer
    // instructions to start editing from. Read-only and live: the operator's
    // env where it has one, and moves with it.
    serverDefaults: {
      approvalTimeoutMs: serverDefaultTimeoutMs(),
      progressCheckMs: serverDefaultProgressCheckMs(),
      progressCheckSteps: serverDefaultProgressCheckSteps(),
      progressReviewPrompt: DEFAULT_REVIEW_PROMPT,
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
      recentModels?: unknown;
      approvalTimeoutMs?: unknown;
      adaptiveTimeout?: unknown;
      progressReview?: unknown;
      progressCheckMs?: unknown;
      progressCheckSteps?: unknown;
      progressReviewPrompt?: unknown;
      serverDefaults?: unknown;
      subagentModelMode?: unknown;
      subagentModel?: unknown;
      bashGrantNoticeSeen?: unknown;
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
    // Gone, and said so: a client from before would otherwise believe it had
    // turned compaction off. A full conversation is always compacted or its
    // context extended now — the alternative was a request the backend cut off.
    if (body.autoCompact !== undefined) {
      reply.code(400);
      return { error: "autoCompact is no longer a setting: a full conversation is always compacted or its context extended" };
    }
    // The same for the step check-in's settings, which the progress review
    // replaced: a client from before would believe it had set a limit.
    const retired = ["maxIterations", "checkinTimeoutMs", "checkinAutoContinues", "loopSensitivity"].filter(
      (key) => (request.body as Record<string, unknown> | null)?.[key] !== undefined,
    );
    if (retired.length > 0) {
      reply.code(400);
      return { error: `${retired.join(", ")} ${retired.length === 1 ? "is" : "are"} no longer a setting: runs are bounded by the progress review` };
    }

    const patch: {
      toolAllowlist?: string[];
      approvalTimeoutMs?: number | null;
      adaptiveTimeout?: boolean;
      progressReview?: boolean;
      progressCheckMs?: number | null;
      progressCheckSteps?: number | null;
      progressReviewPrompt?: string | null;
      subagentModelMode?: SubAgentModelMode;
      subagentModel?: string | null;
      bashGrantRetiredAt?: null;
    } = {};
    if (body.toolAllowlist !== undefined) {
      if (!Array.isArray(body.toolAllowlist)) {
        reply.code(400);
        return { error: "toolAllowlist must be an array of builtin tool names" };
      }
      // `bash` is dropped rather than refused: an older client's "Allow
      // always" sends the whole list with it added, and failing that write
      // would lose the rest. Its grants are command rules now, recorded by
      // the server from the approval itself.
      const list: unknown[] = body.toolAllowlist.filter((name) => name !== "bash");
      if (!list.every(isAllowlistableTool)) {
        reply.code(400);
        return { error: "toolAllowlist must be an array of builtin tool names" };
      }
      patch.toolAllowlist = list;
    }
    if (body.bashGrantNoticeSeen !== undefined) {
      if (body.bashGrantNoticeSeen !== true) {
        reply.code(400);
        return { error: "bashGrantNoticeSeen can only be true" };
      }
      patch.bashGrantRetiredAt = null;
    }
    // Rejected out of range rather than clamped: telling a client its value
    // was not what it asked for beats storing something else. The read-side
    // clamp is the belt for values that never came through this route. The
    // 5-second floor is not a product choice — it is what lets an end-to-end
    // test wait a window out.
    if (body.approvalTimeoutMs !== undefined) {
      const parsed = parseWaitTimeout("approvalTimeoutMs", body.approvalTimeoutMs);
      if (parsed !== null && typeof parsed === "object") {
        reply.code(400);
        return parsed;
      }
      patch.approvalTimeoutMs = parsed;
    }
    if (body.adaptiveTimeout !== undefined) {
      if (typeof body.adaptiveTimeout !== "boolean") {
        reply.code(400);
        return { error: "adaptiveTimeout must be a boolean" };
      }
      patch.adaptiveTimeout = body.adaptiveTimeout;
    }
    if (body.progressReview !== undefined) {
      if (typeof body.progressReview !== "boolean") {
        reply.code(400);
        return { error: "progressReview must be a boolean" };
      }
      patch.progressReview = body.progressReview;
    }
    if (body.progressCheckMs !== undefined) {
      const n = body.progressCheckMs;
      if (n !== null && (typeof n !== "number" || !Number.isInteger(n) || n < MIN_PROGRESS_CHECK_MS || n > MAX_PROGRESS_CHECK_MS)) {
        reply.code(400);
        return {
          error:
            `progressCheckMs must be a whole number of milliseconds between ${String(MIN_PROGRESS_CHECK_MS)} and ` +
            `${String(MAX_PROGRESS_CHECK_MS)}, or null for the server default`,
        };
      }
      patch.progressCheckMs = n;
    }
    if (body.progressCheckSteps !== undefined) {
      const n = body.progressCheckSteps;
      if (n !== null && (typeof n !== "number" || !Number.isInteger(n) || n < MIN_PROGRESS_CHECK_STEPS || n > MAX_PROGRESS_CHECK_STEPS)) {
        reply.code(400);
        return {
          error: `progressCheckSteps must be a whole number between ${String(MIN_PROGRESS_CHECK_STEPS)} and ${String(MAX_PROGRESS_CHECK_STEPS)}, or null for the server default`,
        };
      }
      patch.progressCheckSteps = n;
    }
    if (body.progressReviewPrompt !== undefined) {
      const text = body.progressReviewPrompt;
      // Blank is refused rather than read as "the default": null says that,
      // and a cleared editor saved by accident should not quietly reset.
      if (text !== null && (typeof text !== "string" || !text.trim() || text.length > MAX_PROGRESS_REVIEW_PROMPT_CHARS)) {
        reply.code(400);
        return {
          error: `progressReviewPrompt must be text of 1 to ${String(MAX_PROGRESS_REVIEW_PROMPT_CHARS)} characters, or null for the built-in instructions`,
        };
      }
      patch.progressReviewPrompt = text;
    }
    if (body.subagentModel !== undefined) {
      if (body.subagentModel !== null) {
        // The check a routine's model gets when it is saved: whether this
        // server can serve it at all. What happens to be loaded right now is
        // beside the point for a saved choice.
        if (typeof body.subagentModel !== "string" || !body.subagentModel || body.subagentModel === "default") {
          reply.code(400);
          return { error: "subagentModel must be a model reference, or null" };
        }
        try {
          await assertModelResolvable(body.subagentModel);
        } catch (err) {
          reply.code(400);
          return { error: (err as Error).message };
        }
      }
      patch.subagentModel = body.subagentModel;
    }
    if (body.subagentModelMode !== undefined) {
      if (!isSubAgentModelMode(body.subagentModelMode)) {
        reply.code(400);
        return { error: `subagentModelMode must be one of ${SUBAGENT_MODEL_MODES.join(", ")}` };
      }
      patch.subagentModelMode = body.subagentModelMode;
    }
    // "A fixed model" with no model is not a setting, it is a sub-agent that
    // silently runs on something else. Judged on what the row will hold after
    // this patch — the model may be arriving with it, or already be there.
    if (patch.subagentModelMode === "fixed" || patch.subagentModel === null) {
      const current = await db.query.userPrefs.findFirst({
        where: eq(userPrefs.userId, userId),
        columns: { subagentModelMode: true, subagentModel: true },
      });
      const mode = patch.subagentModelMode ?? current?.subagentModelMode;
      const model = patch.subagentModel !== undefined ? patch.subagentModel : (current?.subagentModel ?? null);
      if (mode === "fixed" && !model) {
        reply.code(400);
        return { error: "Choose the model sub-agents should use (subagentModel) to use a fixed one" };
      }
      // The stored model is judged the same way as one arriving with the
      // patch: whether this server can still serve it. Its provider may have
      // been deleted since it was saved, and "fixed" on a model that resolves
      // nowhere is a setting that reports success and then fails every
      // sub-agent call, with nothing pointing back here.
      if (mode === "fixed" && model && patch.subagentModel === undefined) {
        try {
          await assertModelResolvable(model);
        } catch (err) {
          reply.code(400);
          return { error: (err as Error).message };
        }
      }
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

  // ── Command rules (permissions/bash/rules.ts) ──────────────
  // One row per rule, so each write is one statement: adding a rule never
  // overwrites one another device added meanwhile.

  app.get("/v1/prefs/command-rules", async (request, reply) => {
    const userId = await authenticate(request, reply);
    return { rules: (await loadCommandRules(userId)).map(ruleToApi) };
  });

  app.post("/v1/prefs/command-rules", async (request, reply) => {
    const userId = await authenticate(request, reply);
    const body = (request.body ?? {}) as { pattern?: unknown; action?: unknown };
    if (typeof body.pattern !== "string" || !isRuleAction(body.action)) {
      reply.code(400);
      return { error: "pattern must be a string and action one of allow, ask, deny" };
    }
    try {
      await addCommandRules(userId, [body.pattern], body.action, "settings");
    } catch (err) {
      if (!(err instanceof CommandRuleError)) throw err;
      reply.code(400);
      return { error: err.message };
    }
    return { rules: (await loadCommandRules(userId)).map(ruleToApi) };
  });

  app.delete<{ Params: { id: string } }>("/v1/prefs/command-rules/:id", async (request, reply) => {
    const userId = await authenticate(request, reply);
    const ok = /^[0-9a-f-]{36}$/i.test(request.params.id) && (await deleteCommandRule(userId, request.params.id));
    if (!ok) {
      reply.code(404);
      return { error: "Not found" };
    }
    return { rules: (await loadCommandRules(userId)).map(ruleToApi) };
  });
}

function ruleToApi(rule: Awaited<ReturnType<typeof loadCommandRules>>[number]) {
  return {
    id: rule.id,
    pattern: rule.pattern,
    action: rule.action,
    source: rule.source,
    createdAt: rule.createdAt.toISOString(),
  };
}
