import type { FastifyInstance } from "fastify";
import { eq } from "@shannon/db";
import { db } from "@shannon/db";
import { syncOps } from "@shannon/db/schema";
import { authenticate } from "../auth/middleware";
import type { SyncPushRequest, SyncPushResponse } from "@shannon/sync";

export function syncRoutes(app: FastifyInstance) {
  // Push operations from device to server
  app.post("/sync/push", async (request, reply) => {
    const userId = await authenticate(request, reply);
    const { device_id, ops } = request.body as SyncPushRequest;

    const accepted: SyncPushResponse["accepted"] = [];
    const rejected: SyncPushResponse["rejected"] = [];

    for (const op of ops) {
      try {
        const [row] = await db
          .insert(syncOps)
          .values({
            userId,
            deviceId: device_id,
            opType: op.op_type,
            entityId: op.entity_id,
            payload: op.payload,
            lamport: op.lamport,
          })
          .returning({ seq: syncOps.seq });
        accepted.push({ client_op_id: op.client_op_id, seq: row.seq });
      } catch (err) {
        rejected.push({
          client_op_id: op.client_op_id,
          reason: (err as Error).message,
        });
      }
    }

    return { accepted, rejected };
  });

  // Pull operations since a cursor
  app.get("/sync/pull", async (request, reply) => {
    const userId = await authenticate(request, reply);
    const { since, limit } = request.query as { since: string; limit?: string };
    const sinceSeq = parseInt(since, 10) || 0;
    const pullLimit = limit ? parseInt(limit, 10) : 100;

    const rows = await db.query.syncOps.findMany({
      where: eq(syncOps.userId, userId),
      orderBy: (ops, { asc }) => [asc(ops.seq)],
      limit: pullLimit,
    });

    const filtered = rows.filter((r) => r.seq > sinceSeq);
    const cursor = filtered.length > 0 ? filtered[filtered.length - 1].seq : sinceSeq;

    return {
      ops: filtered.map((r) => ({
        seq: r.seq,
        op_type: r.opType,
        entity_id: r.entityId,
        payload: r.payload,
        lamport: r.lamport,
        device_id: r.deviceId,
        created_at: r.createdAt.toISOString(),
      })),
      cursor,
    };
  });
}