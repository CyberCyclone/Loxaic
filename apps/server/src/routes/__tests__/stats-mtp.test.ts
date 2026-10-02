import Fastify from "fastify";
import { v4 as uuid } from "uuid";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db, eq } from "@loxaic/db";
import { usageRecords, user } from "@loxaic/db/schema";

/**
 * `/v1/stats/models`' MTP acceptance: the share of drafted tokens the model
 * accepted, over the requests that drafted anything — and null, never 0%,
 * for a model nothing was speculated on.
 */
const userId = `test-stats-mtp-${uuid()}`;

vi.mock("../../auth/middleware", () => ({
  authenticate: () => Promise.resolve(userId),
}));

const { statsRoutes } = await import("../stats.ts");
const app = Fastify();
statsRoutes(app);

const row = (model: string, draft: [number, number] | null) => ({
  id: uuid(),
  userId,
  model,
  origin: "server" as const,
  inputTokens: 100,
  outputTokens: 50,
  draftTokens: draft ? draft[0] : null,
  draftAcceptedTokens: draft ? draft[1] : null,
});

beforeAll(async () => {
  await app.ready();
  await db.insert(user).values({ id: userId, name: userId, email: `${userId}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
  await db.insert(usageRecords).values([
    row("mtp-model", [300, 200]),
    row("mtp-model", [191, 125]),
    // A request on the same model that drafted nothing does not dilute it.
    row("mtp-model", null),
    row("plain-model", null),
  ]);
});

afterAll(async () => {
  await db.delete(usageRecords).where(eq(usageRecords.userId, userId));
  await db.delete(user).where(eq(user.id, userId));
  await app.close();
});

describe("stats: MTP acceptance", () => {
  it("is accepted over drafted for a speculating model, and null for one that never drafted", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/stats/models?range=week" });
    expect(res.statusCode).toBe(200);
    const models = res.json<{ model: string; mtpAcceptPct: number | null; mtpDraftTokens: number | null }[]>();
    // 325 of 491, floored to a tenth: 66.1%.
    expect(models.find((m) => m.model === "mtp-model")).toMatchObject({ mtpAcceptPct: 66.1, mtpDraftTokens: 491 });
    expect(models.find((m) => m.model === "plain-model")).toMatchObject({ mtpAcceptPct: null, mtpDraftTokens: null });
  });
});
