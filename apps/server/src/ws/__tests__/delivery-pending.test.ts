import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { v4 as uuid } from "uuid";
import { db, eq } from "@loxaic/db";
import { conversations, user } from "@loxaic/db/schema";
import type { ServerMessage } from "@loxaic/types";

/**
 * A finished run must not hand a catching-up client a question it cannot
 * answer, or a review it is no longer running.
 *
 * `foldSnapshot` is pure over the record log and cannot see that a stream has
 * ended — `producer.end` writes no record, it only finalizes the meta. So a
 * run that ends with something outstanding leaves it in the log with nothing
 * after it, and the fold keeps reporting it forever: a progress review still
 * running beside a run that finished is dropped without an end event, and an
 * approval survives its own abort only by accident, because that path records
 * a `tool.result` the fold clears on. Only delivery sees both the snapshot and
 * the status, so it is where these are stripped.
 */
vi.mock("../../streams/authz.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../streams/authz.ts")>();
  return { ...actual, assertConversationAccess: () => Promise.resolve() };
});

const { createDelivery } = await import("../delivery.ts");
const { initStreamBroker, getStreamBroker } = await import("../../streams/index.ts");

describe("a finished stream's snapshot", () => {
  const userId = `test-delivery-${uuid()}`;
  let convId: string;

  beforeAll(async () => {
    await initStreamBroker();
    await db.insert(user).values({
      id: userId,
      name: "Test Delivery",
      email: `${userId}@example.test`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const [conv] = await db
      .insert(conversations)
      .values({ ownerId: userId, title: "delivery test", kind: "agent" })
      .returning();
    convId = conv.id;
  });

  afterAll(async () => {
    await db.delete(conversations).where(eq(conversations.id, convId));
    await db.delete(user).where(eq(user.id, userId));
  });

  /** Subscribes a fresh delivery and returns the `stream.sync` it sends. */
  async function syncFor(streamId: string) {
    const sent: ServerMessage[] = [];
    const delivery = createDelivery(userId, (m) => sent.push(m), () => 0);
    await delivery.handleSubscribe(convId);
    delivery.close();
    return sent.find(
      (m): m is Extract<ServerMessage, { type: "stream.sync" }> =>
        m.type === "stream.sync" && m.stream_id === streamId,
    );
  }

  it("says a review is under way while the run is, and not after it ends", async () => {
    const broker = getStreamBroker();
    const streamId = uuid();
    const producer = await broker.openProducer({ streamId, conversationId: convId, userId, surface: "agent" });
    producer.emit({ kind: "iteration", n: 20 });
    producer.emit({ kind: "run.review.start", mode: "alongside" });

    const live = await syncFor(streamId);
    expect(live?.status).toBe("active");
    expect(live?.snapshot.reviewing).toEqual({ mode: "alongside" });

    // A run that ends with a review beside it leaves no `run.review.end`
    // (progress-review.ts drops the review silently).
    await producer.end("complete");
    expect(broker.foldSnapshot(await broker.readFrom(streamId, 0)).reviewing).toBeDefined();

    const ended = await syncFor(streamId);
    expect(ended?.status).toBe("complete");
    expect(ended?.snapshot.reviewing).toBeUndefined();
    // The transcript itself is untouched.
    expect(ended?.snapshot.iteration).toEqual({ n: 20 });
  });

  it("drops a pending approval from a finished stream for the same reason", async () => {
    // Approvals survive their own abort path by accident today (a recorded
    // `tool.result` clears the fold). Asserted anyway, because that is an
    // accident of one code path rather than a property of the snapshot.
    const broker = getStreamBroker();
    const streamId = uuid();
    const producer = await broker.openProducer({ streamId, conversationId: convId, userId, surface: "agent" });
    producer.emit({ kind: "approval.request", call_id: "c1", tool: "bash", args: { command: "ls" } });
    await producer.end("cancelled");

    const ended = await syncFor(streamId);
    expect(ended?.snapshot.pending_approval).toBeUndefined();
  });

  it("ends a sub-agent a finished run's log still calls running, and keeps a queue position through a child's events", async () => {
    // A run waits for its children before it ends, so one still marked running
    // in a finished run's log is one whose end was never written (a crash).
    // Shown as running it would offer a Stop, and an approval, that reach
    // nothing — the same trap as the two cases above.
    const broker = getStreamBroker();
    const streamId = uuid();
    const producer = await broker.openProducer({ streamId, conversationId: convId, userId, surface: "agent" });
    const child = {
      message_id: uuid(),
      call_id: "call_0",
      conversation_id: uuid(),
      stream_id: uuid(),
      description: "Left running",
      model: "m",
      started_at: Date.now(),
    };
    producer.emit({ kind: "subagent.started", ...child });
    producer.emit({
      kind: "subagent.progress",
      conversation_id: child.conversation_id,
      state: "awaiting_approval",
      pending_approval: { stream_id: child.stream_id, call_id: "c9", tool: "bash", args: {} },
    });
    // The parent re-queues, and a late report from its child must not clear
    // the place it holds: the child's events are not about this run.
    producer.emit({ kind: "run.queued", position: 2 });
    producer.emit({ kind: "subagent.progress", conversation_id: child.conversation_id, tokens_out: 5 });

    const live = await syncFor(streamId);
    expect(live?.snapshot.queued).toEqual({ position: 2 });
    expect(live?.snapshot.subagents?.[0]).toMatchObject({ status: "running", state: "awaiting_approval", tokens_out: 5 });
    expect(live?.snapshot.subagents?.[0].pending_approval).toBeDefined();

    await producer.end("error");
    const ended = await syncFor(streamId);
    expect(ended?.snapshot.subagents).toHaveLength(1);
    expect(ended?.snapshot.subagents?.[0]).toMatchObject({ status: "error", description: "Left running" });
    expect(ended?.snapshot.subagents?.[0].pending_approval).toBeUndefined();
    expect(ended?.snapshot.subagents?.[0].state).toBeUndefined();
  });
});
