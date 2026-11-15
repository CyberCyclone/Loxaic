import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { v4 as uuid } from "uuid";
import Fastify from "fastify";
import { db, eq, inArray } from "@loxaic/db";
import { conversationShares, conversations, messages, runReviews, user } from "@loxaic/db/schema";
import type { ContentBlock, RunReview, RunReviewDetail } from "@loxaic/types";
import type { CompletionResult } from "../../inference/provider.ts";
import type { ReviewRecord } from "../../streams/runs/progress-review.ts";

/**
 * A run's progress reviews as records: what a row is built from, who may read
 * them over REST (a sub-agent's included), and what a rewind and a delete do
 * with them. Only authentication is stubbed.
 */
const currentUser = { id: "" };
vi.mock("../../auth/middleware", () => ({
  authenticate: () => Promise.resolve(currentUser.id),
  requireAdmin: () => Promise.resolve(currentUser.id),
}));

const { conversationRoutes } = await import("../conversations.ts");
const { initStreamBroker } = await import("../../streams/index.ts");
const { removeAfterForRetry } = await import("../../conversations/rewind.ts");
const { purgeConversation } = await import("../../conversations/delete.ts");
const { loadHistory } = await import("../../streams/runs/engine.ts");
const { publicRunReview, publicRunReviewDetail, recordRunReview, runReviewValues } = await import("../../streams/runs/run-reviews.ts");

const MODEL = "llama-3.1-8b-instruct";

function record(over: Partial<ReviewRecord> = {}): ReviewRecord {
  return {
    id: uuid(),
    mode: "paused",
    trigger: "steps",
    step: 3,
    workedMs: 4_200,
    lamport: 100,
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_001_500,
    verdict: "stuck",
    reason: "It keeps reading the same file.",
    action: "steer",
    forced: false,
    digest: "## The task\nfind the bug",
    result: {
      usage: { prompt_tokens: 812, completion_tokens: 31, total_tokens: 843 },
      // llama.cpp reports fractional milliseconds; the columns are integers.
      timings: { prompt_ms: 1203.667, predicted_ms: 250.4 },
      totalMs: 1480,
    } as unknown as CompletionResult,
    ...over,
  };
}

describe("a review's row", () => {
  it("keeps what the card and the panel show, rounded for its integer columns", () => {
    const r = record({ workedMs: 4_200.6 });
    expect(runReviewValues({ conversationId: "c", runId: "s", model: MODEL, record: r })).toEqual({
      id: r.id,
      conversationId: "c",
      runId: "s",
      lamport: 100,
      step: 3,
      workedMs: 4_201,
      mode: "paused",
      trigger: "steps",
      verdict: "stuck",
      reason: "It keeps reading the same file.",
      action: "steer",
      forced: false,
      digest: "## The task\nfind the bug",
      model: MODEL,
      inputTokens: 812,
      outputTokens: 31,
      promptMs: 1204,
      generationMs: 250,
      totalMs: 1500,
      startedAt: new Date(1_700_000_000_000),
      endedAt: new Date(1_700_000_001_500),
    });
  });

  it("leaves unknown what the backend never said: a request that did not finish, timings it does not report", () => {
    const unfinished = runReviewValues({ conversationId: "c", runId: "s", model: MODEL, record: record({ result: null, verdict: null, reason: "", action: "none" }) });
    expect(unfinished).toMatchObject({ inputTokens: null, outputTokens: null, promptMs: null, generationMs: null, totalMs: 1500, model: MODEL, verdict: null });
    const noTimings = record();
    (noTimings.result as { timings: unknown }).timings = null;
    expect(runReviewValues({ conversationId: "c", runId: "s", model: MODEL, record: noTimings })).toMatchObject({ inputTokens: 812, promptMs: null, generationMs: null });
  });

  it("names no model for the ceiling, which asked none", () => {
    const limit = record({ mode: null, trigger: "limit", forced: true, verdict: null, action: "answer", digest: "", result: null, endedAt: 1_700_000_000_000 });
    expect(runReviewValues({ conversationId: "c", runId: "s", model: MODEL, record: limit })).toMatchObject({ model: null, mode: null, trigger: "limit", forced: true, totalMs: 0, digest: "" });
  });
});

describe("GET /v1/conversations/:id/reviews", () => {
  const owner = `test-reviews-owner-${uuid()}`;
  const viewer = `test-reviews-viewer-${uuid()}`;
  const stranger = `test-reviews-stranger-${uuid()}`;
  const everyone = [owner, viewer, stranger];
  const app = Fastify();
  const convIds: string[] = [];
  const log = { warn: () => undefined };

  const as = (id: string) => {
    currentUser.id = id;
  };

  beforeAll(async () => {
    await initStreamBroker();
    conversationRoutes(app);
    await app.ready();
    for (const id of everyone) {
      await db.insert(user).values({ id, name: "Reviews", email: `${id}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    }
  });

  afterAll(async () => {
    delete process.env.DELETED_CHAT_RETENTION_ENABLED;
    if (convIds.length) {
      await db.delete(runReviews).where(inArray(runReviews.conversationId, convIds));
      await db.delete(messages).where(inArray(messages.conversationId, convIds));
      await db.delete(conversationShares).where(inArray(conversationShares.conversationId, convIds));
      await db.delete(conversations).where(inArray(conversations.id, convIds));
    }
    await db.delete(user).where(inArray(user.id, everyone));
    await app.close();
  });

  let clock = Date.now() - 60_000;
  /** Two turns, each reviewed once after its reply: user, assistant, review,
   * user, assistant, review. Times and lamports ten apart. */
  async function thread(opts: { parentId?: string; parentMessageId?: string } = {}) {
    const [conv] = await db
      .insert(conversations)
      .values({
        ownerId: owner,
        title: "reviewed",
        kind: opts.parentId ? "subagent" : "agent",
        ...(opts.parentId ? { parentConversationId: opts.parentId, parentMessageId: opts.parentMessageId ?? uuid(), parentCallId: "call_0" } : {}),
      })
      .returning();
    convIds.push(conv.id);
    const runId = uuid();
    const ids: string[] = [];
    const reviewIds: string[] = [];
    for (const [authorType, text] of [["user", "one"], ["assistant", "reply one"], ["user", "two"], ["assistant", "reply two"]] as const) {
      clock += 10;
      const id = uuid();
      ids.push(id);
      await db.insert(messages).values({
        id, conversationId: conv.id, authorType, authorUserId: authorType === "user" ? owner : null, origin: "server",
        lamport: clock, content: [{ kind: "text", text }] as ContentBlock[], status: "complete", createdAt: new Date(clock),
      });
      if (authorType === "assistant") {
        const r = record({ lamport: clock, startedAt: clock + 1, endedAt: clock + 3, digest: `## The task\n${text} SECRET-DIGEST` });
        reviewIds.push(r.id);
        await recordRunReview({ conversationId: conv.id, runId, model: MODEL, record: r });
      }
    }
    return { convId: conv.id, runId, ids, reviewIds };
  }

  const list = async (convId: string) => app.inject({ method: "GET", url: `/v1/conversations/${convId}/reviews` });
  const listed = async (convId: string) => (await list(convId)).json<{ reviews: RunReview[] }>().reviews;
  const one = async (convId: string, id: string) => app.inject({ method: "GET", url: `/v1/conversations/${convId}/reviews/${id}` });

  it("lists a thread's reviews in thread order, without their digests", async () => {
    as(owner);
    const { convId, runId, ids, reviewIds } = await thread();
    // One written later that sits earlier in the thread: order is by place.
    const early = record({ lamport: 1, startedAt: clock + 500, endedAt: clock + 501, verdict: "progressing", reason: "", action: "none" });
    await recordRunReview({ conversationId: convId, runId, model: MODEL, record: early });

    const res = await list(convId);
    expect(res.statusCode).toBe(200);
    const reviews = res.json<{ reviews: RunReview[] }>().reviews;
    expect(reviews.map((r) => r.id)).toEqual([early.id, ...reviewIds]);
    expect(res.body).not.toContain("SECRET-DIGEST");
    expect(reviews.every((r) => !("digest" in r) && !("model" in r))).toBe(true);
    const rows = await db.select({ lamport: messages.lamport }).from(messages).where(eq(messages.id, ids[1]));
    expect(reviews[1]).toEqual({
      id: reviewIds[0],
      stream_id: runId,
      lamport: rows[0].lamport,
      step: 3,
      worked_ms: 4_200,
      mode: "paused",
      trigger: "steps",
      started_at: rows[0].lamport + 1,
      ended_at: rows[0].lamport + 3,
      verdict: "stuck",
      reason: "It keeps reading the same file.",
      action: "steer",
    });
    // A review that said nothing carries no reason, and the ceiling says so.
    expect(reviews[0]).not.toHaveProperty("reason");
    expect(reviews[0]).not.toHaveProperty("forced");
  });

  it("reads one in full, digest and cost included", async () => {
    as(owner);
    const { convId, reviewIds } = await thread();
    const res = await one(convId, reviewIds[1]);
    expect(res.statusCode).toBe(200);
    expect(res.json<RunReviewDetail>()).toMatchObject({
      id: reviewIds[1],
      verdict: "stuck",
      action: "steer",
      model: MODEL,
      input_tokens: 812,
      output_tokens: 31,
      prompt_ms: 1204,
      generation_ms: 250,
      total_ms: 2,
      digest: "## The task\nreply two SECRET-DIGEST",
    });
  });

  it("answers a viewer, and nobody without access, the same for a list and for one review", async () => {
    const { convId, reviewIds } = await thread();
    await db.insert(conversationShares).values({ conversationId: convId, userId: viewer, role: "viewer", createdBy: owner });
    as(viewer);
    expect((await listed(convId)).map((r) => r.id)).toEqual(reviewIds);
    expect((await one(convId, reviewIds[0])).statusCode).toBe(200);

    as(stranger);
    const refused = await list(convId);
    expect(refused.statusCode).toBe(404);
    const refusedOne = await one(convId, reviewIds[0]);
    expect(refusedOne.statusCode).toBe(404);
    expect(refusedOne.body).not.toContain("SECRET-DIGEST");
    // The same bytes as for a conversation that does not exist.
    expect(refused.body).toBe((await list(uuid())).body);
    expect(refusedOne.body).toBe((await one(uuid(), reviewIds[0])).body);
    expect((await list("not-a-uuid")).statusCode).toBe(404);
  });

  it("never reads a review through a conversation it is not in", async () => {
    as(owner);
    const a = await thread();
    const b = await thread();
    expect((await one(a.convId, b.reviewIds[0])).statusCode).toBe(404);
    expect((await one(a.convId, uuid())).statusCode).toBe(404);
    expect((await one(a.convId, "not-a-uuid")).statusCode).toBe(404);
    expect((await listed(a.convId)).map((r) => r.id)).toEqual(a.reviewIds);
  });

  it("reads a sub-agent's reviews under its own conversation, for whoever can read its parent", async () => {
    const parent = await thread();
    const child = await thread({ parentId: parent.convId, parentMessageId: parent.ids[1] });
    await db.insert(conversationShares).values({ conversationId: parent.convId, userId: viewer, role: "viewer", createdBy: owner });
    for (const id of [owner, viewer]) {
      as(id);
      expect((await listed(child.convId)).map((r) => r.id)).toEqual(child.reviewIds);
      expect((await one(child.convId, child.reviewIds[0])).statusCode).toBe(200);
    }
    // The parent's listing is its own reviews, never its children's.
    expect((await listed(parent.convId)).map((r) => r.id)).toEqual(parent.reviewIds);
    as(stranger);
    expect((await list(child.convId)).statusCode).toBe(404);
    expect((await one(child.convId, child.reviewIds[0])).statusCode).toBe(404);
  });

  it("is never part of the prompt: the history a run replays has nothing of a review in it", async () => {
    const { convId } = await thread();
    const history = await loadHistory(convId);
    expect(history.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(JSON.stringify(history.messages)).not.toContain("SECRET-DIGEST");
    expect(JSON.stringify(history.messages)).not.toContain("It keeps reading the same file.");
  });

  it("a rewind removes the reviews that followed the removed rows, and keeps the ones before", async () => {
    process.env.DELETED_CHAT_RETENTION_ENABLED = "false";
    as(owner);
    const { convId, ids, reviewIds } = await thread();
    const res = await app.inject({ method: "POST", url: `/v1/conversations/${convId}/rewind`, payload: { message_id: ids[2] } });
    expect(res.statusCode).toBe(200);
    expect((await listed(convId)).map((r) => r.id)).toEqual([reviewIds[0]]);
    // Erased, not hidden.
    expect(await db.select({ id: runReviews.id }).from(runReviews).where(eq(runReviews.conversationId, convId))).toEqual([{ id: reviewIds[0] }]);
  });

  it("a retry removes the reviews of the reply it replaces", async () => {
    process.env.DELETED_CHAT_RETENTION_ENABLED = "false";
    const { convId, ids, reviewIds } = await thread();
    const answered = await removeAfterForRetry(convId);
    expect(answered.id).toBe(ids[2]);
    as(owner);
    expect((await listed(convId)).map((r) => r.id)).toEqual([reviewIds[0]]);
  });

  it("with audit retention, a rewound review is stamped like its rows: gone from every read, kept in the table", async () => {
    process.env.DELETED_CHAT_RETENTION_ENABLED = "true";
    as(owner);
    const { convId, ids, reviewIds } = await thread();
    await app.inject({ method: "POST", url: `/v1/conversations/${convId}/rewind`, payload: { message_id: ids[2] } });
    expect((await listed(convId)).map((r) => r.id)).toEqual([reviewIds[0]]);
    expect((await one(convId, reviewIds[1])).statusCode).toBe(404);
    const kept = await db.select({ id: runReviews.id, deletedAt: runReviews.deletedAt }).from(runReviews).where(eq(runReviews.conversationId, convId));
    expect(kept.find((r) => r.id === reviewIds[1])?.deletedAt).toBeInstanceOf(Date);
    expect(kept.find((r) => r.id === reviewIds[0])?.deletedAt).toBeNull();
    process.env.DELETED_CHAT_RETENTION_ENABLED = "false";
  });

  it("a rewind erases the reviews of the sub-agents it removes", async () => {
    process.env.DELETED_CHAT_RETENTION_ENABLED = "false";
    as(owner);
    const parent = await thread();
    const removed = await thread({ parentId: parent.convId, parentMessageId: parent.ids[3] });
    const kept = await thread({ parentId: parent.convId, parentMessageId: parent.ids[1] });
    await app.inject({ method: "POST", url: `/v1/conversations/${parent.convId}/rewind`, payload: { message_id: parent.ids[2] } });
    expect(await db.select().from(runReviews).where(eq(runReviews.conversationId, removed.convId))).toEqual([]);
    expect((await listed(kept.convId)).map((r) => r.id)).toEqual(kept.reviewIds);
  });

  it("erasing a conversation erases its reviews and its sub-agents'", async () => {
    const parent = await thread();
    const child = await thread({ parentId: parent.convId, parentMessageId: parent.ids[1] });
    const other = await thread();
    await purgeConversation(parent.convId, log);
    expect(await db.select().from(runReviews).where(inArray(runReviews.conversationId, [parent.convId, child.convId]))).toEqual([]);
    as(owner);
    expect((await listed(other.convId)).map((r) => r.id)).toEqual(other.reviewIds);
  });

  it("shapes a stored row for the wire", async () => {
    const { convId, reviewIds } = await thread();
    const [row] = await db.select().from(runReviews).where(eq(runReviews.id, reviewIds[0]));
    const { digest: _digest, ...withoutDigest } = row;
    expect(publicRunReviewDetail(row)).toMatchObject({ ...publicRunReview(withoutDigest), digest: row.digest, model: MODEL });
    await db.update(runReviews).set({ forced: true, mode: null, trigger: "limit", reason: "" }).where(eq(runReviews.id, reviewIds[0]));
    as(owner);
    expect((await listed(convId))[0]).toMatchObject({ forced: true, mode: null, trigger: "limit" });
  });
});
