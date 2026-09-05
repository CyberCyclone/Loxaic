import type { FastifyInstance } from "fastify";
import { eq, and, sql, gte, lte, lt, inArray } from "@loxaic/db";
import { db } from "@loxaic/db";
import { usageRecords, conversations } from "@loxaic/db/schema";
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
  return { since: new Date(Date.now() - window.ms), ms: window.ms, unit: window.unit };
}

/** The four headline aggregates, shared by the current-window query, the previous-window comparison, and the sparkline buckets. */
const USAGE_AGGREGATE = {
  totalInputTokens: sql<number>`COALESCE(SUM(${usageRecords.inputTokens}), 0)::float8`,
  totalCachedTokens: sql<number>`COALESCE(SUM(${usageRecords.cachedTokens}), 0)::float8`,
  totalOutputTokens: sql<number>`COALESCE(SUM(${usageRecords.outputTokens}), 0)::float8`,
  count: sql<number>`COUNT(*)::int`,
  avgTtftMs: sql<number>`AVG(${usageRecords.ttftMs})::float8`,
  avgPromptTps: sql<number>`AVG(${usageRecords.promptTps})::float8`,
  avgPredictedTps: sql<number>`AVG(${usageRecords.predictedTps})::float8`,
  avgTotalMs: sql<number>`AVG(${usageRecords.totalMs})::float8`,
};

interface UsageAggRow {
  totalInputTokens: number;
  totalCachedTokens: number;
  totalOutputTokens: number;
  count: number;
  avgTtftMs: number | null;
  avgPromptTps: number | null;
  avgPredictedTps: number | null;
  avgTotalMs: number | null;
}

function shapeUsage(r: UsageAggRow) {
  const hitRate = r.totalInputTokens > 0 ? (r.totalCachedTokens / r.totalInputTokens) * 100 : 0;
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
}

const SPARK_BUCKETS = 10;

export function statsRoutes(app: FastifyInstance) {
  app.get("/v1/stats/usage", async (request, reply) => {
    const userId = await authenticate(request, reply);
    const { conversation_id, model, from, to, range } = request.query as {
      conversation_id?: string;
      model?: string;
      from?: string;
      to?: string;
      range?: string;
    };

    const baseFilters = [eq(usageRecords.userId, userId)];
    if (conversation_id) baseFilters.push(eq(usageRecords.conversationId, conversation_id));
    if (model) baseFilters.push(eq(usageRecords.model, model));

    // An explicit from/to is a custom window with no natural "previous
    // period" — only derive comparison + sparkline off the named ranges,
    // which have a well-defined width to mirror backwards.
    const window = !from && !to ? rangeToWindow(range) : null;
    const since = from ? new Date(from) : window?.since;
    const until = to ? new Date(to) : undefined;

    const currentFilters = [...baseFilters];
    if (since) currentFilters.push(gte(usageRecords.createdAt, since));
    if (until) currentFilters.push(lte(usageRecords.createdAt, until));

    const [currentRows, previousRows, sparkRows] = await Promise.all([
      db.select(USAGE_AGGREGATE).from(usageRecords).where(and(...currentFilters)),
      window
        ? db
            .select(USAGE_AGGREGATE)
            .from(usageRecords)
            .where(
              and(
                ...baseFilters,
                gte(usageRecords.createdAt, new Date(window.since.getTime() - window.ms)),
                lt(usageRecords.createdAt, window.since),
              ),
            )
        : Promise.resolve(null),
      window
        ? (() => {
            const bucketSeconds = Math.max(1, Math.round(window.ms / 1000 / SPARK_BUCKETS));
            // Every dynamic value here must be sql.raw, not a bound param:
            // this expression is reused verbatim in select/groupBy/orderBy
            // below, and Postgres only recognizes a GROUP BY expression as
            // matching its SELECT counterpart when the literal SQL text is
            // identical — a bound parameter gets a fresh, differently
            // numbered placeholder in each clause, which breaks that match
            // (same constraint /v1/stats/series works around above). None of
            // these values are user input, so raw-interpolating them is safe.
            const bucketExpr = sql`LEAST(${sql.raw(String(SPARK_BUCKETS - 1))}, FLOOR(EXTRACT(EPOCH FROM (${usageRecords.createdAt} - ${sql.raw(`'${window.since.toISOString()}'`)}::timestamptz)) / ${sql.raw(String(bucketSeconds))}))::int`;
            return db
              .select({
                bucket: sql<number>`${bucketExpr}`,
                tokens: sql<number>`COALESCE(SUM(${usageRecords.inputTokens} + ${usageRecords.outputTokens}), 0)::float8`,
                inputTokens: sql<number>`COALESCE(SUM(${usageRecords.inputTokens}), 0)::float8`,
                cachedTokens: sql<number>`COALESCE(SUM(${usageRecords.cachedTokens}), 0)::float8`,
                avgTtftMs: sql<number>`AVG(${usageRecords.ttftMs})::float8`,
                avgPredictedTps: sql<number>`AVG(${usageRecords.predictedTps})::float8`,
              })
              .from(usageRecords)
              .where(and(...currentFilters))
              .groupBy(bucketExpr)
              .orderBy(bucketExpr);
          })()
        : Promise.resolve(null),
    ]);

    const current = shapeUsage(currentRows[0]);
    const previous = previousRows ? shapeUsage(previousRows[0]) : null;

    let spark: {
      totalTokens: number[];
      cacheHitRate: number[];
      avgTtftMs: (number | null)[];
      avgPredictedTps: (number | null)[];
    } | null = null;
    if (sparkRows) {
      const byBucket = new Map(sparkRows.map((r) => [r.bucket, r]));
      spark = { totalTokens: [], cacheHitRate: [], avgTtftMs: [], avgPredictedTps: [] };
      for (let i = 0; i < SPARK_BUCKETS; i++) {
        const b = byBucket.get(i);
        spark.totalTokens.push(b?.tokens ?? 0);
        spark.cacheHitRate.push(b && b.inputTokens > 0 ? (b.cachedTokens / b.inputTokens) * 100 : 0);
        spark.avgTtftMs.push(b?.avgTtftMs ?? null);
        spark.avgPredictedTps.push(b?.avgPredictedTps ?? null);
      }
    }

    return { ...current, previous, spark };
  });

  // Token usage bucketed over time, split by model — powers the usage chart.
  // Also returns a second, model-agnostic bucketing of cache hit rate for
  // the Cache Hit Rate chart — same bucket boundaries, different aggregate.
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

    const [rows, cacheRows] = await Promise.all([
      db
        .select({
          bucket: sql<string>`${bucketExpr}`,
          model: usageRecords.model,
          inputTokens: sql<number>`COALESCE(SUM(${usageRecords.inputTokens}), 0)::float8`,
          outputTokens: sql<number>`COALESCE(SUM(${usageRecords.outputTokens}), 0)::float8`,
        })
        .from(usageRecords)
        .where(and(eq(usageRecords.userId, userId), gte(usageRecords.createdAt, since)))
        .groupBy(bucketExpr, usageRecords.model)
        .orderBy(bucketExpr),
      db
        .select({
          bucket: sql<string>`${bucketExpr}`,
          inputTokens: sql<number>`COALESCE(SUM(${usageRecords.inputTokens}), 0)::float8`,
          cachedTokens: sql<number>`COALESCE(SUM(${usageRecords.cachedTokens}), 0)::float8`,
        })
        .from(usageRecords)
        .where(and(eq(usageRecords.userId, userId), gte(usageRecords.createdAt, since)))
        .groupBy(bucketExpr)
        .orderBy(bucketExpr),
    ]);

    const buckets = new Map<string, Record<string, number>>();
    for (const row of rows) {
      const values = buckets.get(row.bucket) ?? {};
      values[row.model] = (values[row.model] ?? 0) + row.inputTokens + row.outputTokens;
      buckets.set(row.bucket, values);
    }

    return {
      range: range ?? "week",
      points: Array.from(buckets.entries()).map(([bucket, values]) => ({ bucket, values })),
      cachePoints: cacheRows.map((r) => ({
        bucket: r.bucket,
        cacheHitRate: r.inputTokens > 0 ? Math.round((r.cachedTokens / r.inputTokens) * 10000) / 100 : 0,
      })),
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
        avgTtftMs: sql<number>`AVG(${usageRecords.ttftMs})::float8`,
        lastUsedAt: sql<string>`MAX(${usageRecords.createdAt})`,
      })
      .from(usageRecords)
      .where(and(eq(usageRecords.userId, userId), gte(usageRecords.createdAt, since)))
      .groupBy(usageRecords.conversationId)
      .orderBy(sql`MAX(${usageRecords.createdAt}) DESC`)
      .limit(take);

    const convIds = rows.map((r) => r.conversationId).filter((id): id is string => !!id);
    const convRows = convIds.length
      ? await db
          .select({ id: conversations.id, title: conversations.title, kind: conversations.kind })
          .from(conversations)
          .where(inArray(conversations.id, convIds))
      : [];
    const convMap = new Map(convRows.map((c) => [c.id, c]));

    return rows.map((r) => {
      const conv = r.conversationId ? convMap.get(r.conversationId) : undefined;
      return {
        conversationId: r.conversationId,
        title: conv?.title ?? "Untitled",
        kind: conv?.kind ?? "chat",
        model: r.model,
        tokens: r.inputTokens + r.outputTokens,
        cachePct: r.inputTokens > 0 ? Math.round((r.cachedTokens / r.inputTokens) * 10000) / 100 : 0,
        avgTtftMs: r.avgTtftMs,
        lastUsedAt: r.lastUsedAt,
      };
    });
  });
}