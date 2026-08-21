import type { FastifyInstance } from "fastify";
import { eq, and, sql, gte, lte } from "@shannon/db";
import { db } from "@shannon/db";
import { usageRecords } from "@shannon/db/schema";
import { authenticate } from "../auth/middleware";

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
        totalInputTokens: sql<number>`COALESCE(SUM(${usageRecords.inputTokens}), 0)`,
        totalCachedTokens: sql<number>`COALESCE(SUM(${usageRecords.cachedTokens}), 0)`,
        totalOutputTokens: sql<number>`COALESCE(SUM(${usageRecords.outputTokens}), 0)`,
        count: sql<number>`COUNT(*)::int`,
        avgTtftMs: sql<number>`AVG(${usageRecords.ttftMs})`,
        avgPromptTps: sql<number>`AVG(${usageRecords.promptTps})`,
        avgPredictedTps: sql<number>`AVG(${usageRecords.predictedTps})`,
        avgTotalMs: sql<number>`AVG(${usageRecords.totalMs})`,
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
}