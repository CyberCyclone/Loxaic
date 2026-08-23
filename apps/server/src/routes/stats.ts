import type { FastifyInstance } from "fastify";
import { eq, and, sql, gte, lte, inArray } from "@shannon/db";
import { db } from "@shannon/db";
import { usageRecords, conversations } from "@shannon/db/schema";
import { authenticate } from "../auth/middleware";

const RANGE_WINDOWS: Record<string, { ms: number; unit: string }> = {
  session: { ms: 60 * 60 * 1000, unit: "minute" },
  today: { ms: 24 * 60 * 60 * 1000, unit: "hour" },
  week: { ms: 7 * 24 * 60 * 60 * 1000, unit: "day" },
  month: { ms: 30 * 24 * 60 * 60 * 1000, unit: "day" },
  year: { ms: 365 * 24 * 60 * 60 * 1000, unit: "month" },
};

function rangeToWindow(range?: string) {
  const window = RANGE_WINDOWS[range ?? "week"] ?? RANGE_WINDOWS.week;
  return { since: new Date(Date.now() - window.ms), unit: window.unit };
}

export async function statsRoutes(app: FastifyInstance) {
  app.get("/v1/stats/usage", async (request, reply) => {
    const userId = await authenticate(request, reply);
    const { conversation_id, model, from, to } = request.query as {
      conversation_id?: string;
      model?: string;
      from?: string;
      to?: string;
    };

    const filters = [eq(usageRecords.userId, userId)];
    if (conversation_id) filters.push(eq(usageRecords.conversationId, conversation_id));
    if (model) filters.push(eq(usageRecords.model, model));
    if (from) filters.push(gte(usageRecords.createdAt, new Date(from)));
    if (to) filters.push(lte(usageRecords.createdAt, new Date(to)));

    const rows = await db
      .select({
        totalInputTokens: sql<number>`COALESCE(SUM(${usageRecords.inputTokens}), 0)::float8`,
        totalCachedTokens: sql<number>`COALESCE(SUM(${usageRecords.cachedTokens}), 0)::float8`,
        totalOutputTokens: sql<number>`COALESCE(SUM(${usageRecords.outputTokens}), 0)::float8`,
        count: sql<number>`COUNT(*)::int`,
        avgTtftMs: sql<number>`AVG(${usageRecords.ttftMs})::float8`,
        avgPromptTps: sql<number>`AVG(${usageRecords.promptTps})::float8`,
        avgPredictedTps: sql<number>`AVG(${usageRecords.predictedTps})::float8`,
        avgTotalMs: sql<number>`AVG(${usageRecords.totalMs})::float8`,
      })
      .from(usageRecords)
      .where(and(...filters));

    const r = rows[0];
    const hitRate = r.totalInputTokens > 0
      ? (r.totalCachedTokens / r.totalInputTokens) * 100
      : 0;

    return {
      inputTokens: r.totalInputTokens,
      cachedTokens: r.totalCachedTokens,
      outputTokens: r.totalOutputTokens,
      totalTokens: r.totalInputTokens + r.totalOutputTokens,
      cacheHitRate: Math.round(hitRate * 100) / 100,
      requestCount: r.count,
      avgTtftMs: r.avgTtftMs,
      avgPromptTps: r.avgPromptTps,
      avgPredictedTps: r.avgPredictedTps,
      avgTotalMs: r.avgTotalMs,
    };
  });

  // Token usage bucketed over time, split by model — powers the usage chart.
  app.get("/v1/stats/series", async (request, reply) => {
    const userId = await authenticate(request, reply);
    const { range } = request.query as { range?: string };
    const { since, unit } = rangeToWindow(range);
    // `unit` only ever comes from RANGE_WINDOWS (a fixed allowlist), so a raw
    // literal is safe here — and required: reusing a bound-parameter version
    // of this expression across select/groupBy/orderBy gives each occurrence
    // a different placeholder, which Postgres then treats as non-matching
    // expressions and rejects the GROUP BY.
    const bucketExpr = sql`date_trunc(${sql.raw(`'${unit}'`)}, ${usageRecords.createdAt})`;

    const rows = await db
      .select({
        bucket: sql<string>`${bucketExpr}`,
        model: usageRecords.model,
        inputTokens: sql<number>`COALESCE(SUM(${usageRecords.inputTokens}), 0)::float8`,
        outputTokens: sql<number>`COALESCE(SUM(${usageRecords.outputTokens}), 0)::float8`,
      })
      .from(usageRecords)
      .where(and(eq(usageRecords.userId, userId), gte(usageRecords.createdAt, since)))
      .groupBy(bucketExpr, usageRecords.model)
      .orderBy(bucketExpr);

    const buckets = new Map<string, Record<string, number>>();
    for (const row of rows) {
      const values = buckets.get(row.bucket) ?? {};
      values[row.model] = (values[row.model] ?? 0) + row.inputTokens + row.outputTokens;
      buckets.set(row.bucket, values);
    }

    return {
      range: range ?? "week",
      points: Array.from(buckets.entries()).map(([bucket, values]) => ({ bucket, values })),
    };
  });

  // Per-model breakdown (tokens, cache hit rate, throughput, TTFT percentiles).
  app.get("/v1/stats/models", async (request, reply) => {
    const userId = await authenticate(request, reply);
    const { range } = request.query as { range?: string };
    const { since } = rangeToWindow(range);

    const rows = await db
      .select({
        model: usageRecords.model,
        conversations: sql<number>`COUNT(DISTINCT ${usageRecords.conversationId})::int`,
        inputTokens: sql<number>`COALESCE(SUM(${usageRecords.inputTokens}), 0)::float8`,
        cachedTokens: sql<number>`COALESCE(SUM(${usageRecords.cachedTokens}), 0)::float8`,
        outputTokens: sql<number>`COALESCE(SUM(${usageRecords.outputTokens}), 0)::float8`,
        ppSpeed: sql<number>`AVG(${usageRecords.promptTps})::float8`,
        tgSpeed: sql<number>`AVG(${usageRecords.predictedTps})::float8`,
        ttftP50: sql<number>`percentile_cont(0.5) WITHIN GROUP (ORDER BY ${usageRecords.ttftMs})`,
        ttftP95: sql<number>`percentile_cont(0.95) WITHIN GROUP (ORDER BY ${usageRecords.ttftMs})`,
        ttftP99: sql<number>`percentile_cont(0.99) WITHIN GROUP (ORDER BY ${usageRecords.ttftMs})`,
      })
      .from(usageRecords)
      .where(and(eq(usageRecords.userId, userId), gte(usageRecords.createdAt, since)))
      .groupBy(usageRecords.model);

    return rows.map((r) => ({
      model: r.model,
      conversations: r.conversations,
      tokens: r.inputTokens + r.outputTokens,
      cachePct: r.inputTokens > 0 ? Math.round((r.cachedTokens / r.inputTokens) * 10000) / 100 : 0,
      ppSpeed: r.ppSpeed,
      tgSpeed: r.tgSpeed,
      ttftP50: r.ttftP50,
      ttftP95: r.ttftP95,
      ttftP99: r.ttftP99,
    }));
  });

  // Recent conversations ranked by activity within the range, with real titles joined in.
  app.get("/v1/stats/conversations", async (request, reply) => {
    const userId = await authenticate(request, reply);
    const { range, limit } = request.query as { range?: string; limit?: string };
    const { since } = rangeToWindow(range);
    const take = Math.min(Math.max(Number(limit) || 20, 1), 100);

    const rows = await db
      .select({
        conversationId: usageRecords.conversationId,
        model: sql<string>`(array_agg(${usageRecords.model} ORDER BY ${usageRecords.createdAt} DESC))[1]`,
        inputTokens: sql<number>`COALESCE(SUM(${usageRecords.inputTokens}), 0)::float8`,
        cachedTokens: sql<number>`COALESCE(SUM(${usageRecords.cachedTokens}), 0)::float8`,
        outputTokens: sql<number>`COALESCE(SUM(${usageRecords.outputTokens}), 0)::float8`,
        lastUsedAt: sql<string>`MAX(${usageRecords.createdAt})`,
      })
      .from(usageRecords)
      .where(and(eq(usageRecords.userId, userId), gte(usageRecords.createdAt, since)))
      .groupBy(usageRecords.conversationId)
      .orderBy(sql`MAX(${usageRecords.createdAt}) DESC`)
      .limit(take);

    const convIds = rows.map((r) => r.conversationId).filter((id): id is string => !!id);
    const titleRows = convIds.length
      ? await db.select({ id: conversations.id, title: conversations.title }).from(conversations).where(inArray(conversations.id, convIds))
      : [];
    const titleMap = new Map(titleRows.map((t) => [t.id, t.title]));

    return rows.map((r) => ({
      conversationId: r.conversationId,
      title: (r.conversationId && titleMap.get(r.conversationId)) || "Untitled",
      model: r.model,
      tokens: r.inputTokens + r.outputTokens,
      cachePct: r.inputTokens > 0 ? Math.round((r.cachedTokens / r.inputTokens) * 10000) / 100 : 0,
      lastUsedAt: r.lastUsedAt,
    }));
  });
}