import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { v4 as uuid } from "uuid";
import { db, eq } from "@loxaic/db";
import { conversations, user } from "@loxaic/db/schema";
import type { ServerMessage } from "@loxaic/types";

/**
 * A finished run must not hand a catching-up client a question it cannot
 * answer.
 *
 * `foldSnapshot` is pure over the record log and cannot see that a stream has
 * ended — `producer.end` writes no record, it only finalizes the meta. So a
 * run stopped while parked at a step check-in leaves `steps.checkin` in the
 * log with nothing after it: the abort emits no `steps.decision`, because
 * nobody decided. The fold therefore keeps reporting the question forever.
 *
 * Found in the browser, not by a unit test: stopping a parked chat run cleared
 * the banner, and the next resync put it straight back — on a run that had
 * already ended, offering "Keep going" and "Answer now" on a stream nothing
 * was listening to. Approvals escape the same trap only by accident, because
 * their abort path records a `tool.result` that the fold clears on.
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

  it("carries a pending check-in while the run is still parked, and not after it ends", async () => {
    const broker = getStreamBroker();
    const streamId = uuid();
    const producer = await broker.openProducer({ streamId, conversationId: convId, userId, surface: "agent" });
    producer.emit({ kind: "iteration", n: 100, max: 100 });
    producer.emit({ kind: "steps.checkin", n: 100, max: 100, reason: "budget" });

    // Parked: the question is real and a reconnecting client needs it.
    const live = await syncFor(streamId);
    expect(live?.status).toBe("active");
    expect(live?.snapshot.pending_checkin).toMatchObject({ n: 100, reason: "budget" });

    // Stopped while parked — the shape an abort leaves behind.
    await producer.end("cancelled");

    // The raw fold still says "parked", because nothing in the log ever said
    // otherwise. That is the trap this guards.
    expect(broker.foldSnapshot(await broker.readFrom(streamId, 0)).pending_checkin).toBeDefined();

    const ended = await syncFor(streamId);
    expect(ended?.status).toBe("cancelled");
    expect(ended?.snapshot.pending_checkin).toBeUndefined();
    // The transcript itself is untouched — only the question is dropped.
    expect(ended?.snapshot.iteration).toEqual({ n: 100, max: 100 });
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
});
