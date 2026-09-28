import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { v4 as uuid } from "uuid";
import { db, eq } from "@loxaic/db";
import { conversations, user } from "@loxaic/db/schema";
import type { ServerMessage } from "@loxaic/types";

/**
 * A run the server starts by itself — an automatic compaction after a turn, a
 * routine — reaches a watching device through the conversation watch, not a
 * send. It is announced before anything is stored, and the subscribe that
 * answered the announcement sent a snapshot only when there was something to
 * catch up on. So the device applied the run's events to the thread but never
 * counted the run as going: no Stop button, a composer that looked free, and a
 * compaction card that switched to the typing indicator minutes in, whenever a
 * later resync finally said so. Seen on the beta.
 */
vi.mock("../../streams/authz.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../streams/authz.ts")>();
  return { ...actual, assertConversationAccess: () => Promise.resolve() };
});

const { createDelivery } = await import("../delivery.ts");
const { initStreamBroker, getStreamBroker } = await import("../../streams/index.ts");
const { announceNewRun } = await import("../../streams/watchers.ts");

describe("a run the server started", () => {
  const userId = `test-delivery-new-run-${uuid()}`;
  let convId: string;

  beforeAll(async () => {
    await initStreamBroker();
    await db.insert(user).values({
      id: userId, name: "New run", email: `${userId}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date(),
    });
    const [conv] = await db.insert(conversations).values({ ownerId: userId, title: "new run", kind: "chat" }).returning();
    convId = conv.id;
  });

  afterAll(async () => {
    await db.delete(conversations).where(eq(conversations.id, convId));
    await db.delete(user).where(eq(user.id, userId));
  });

  it("reaches a watching device as a snapshot at once, with when it started", async () => {
    const sent: ServerMessage[] = [];
    const delivery = createDelivery(userId, (m) => sent.push(m), () => 0);
    await delivery.handleSubscribe(convId, {});

    const streamId = uuid();
    const producer = await getStreamBroker().openProducer({ streamId, conversationId: convId, userId, surface: "chat" });
    const meta = await getStreamBroker().getMeta(streamId);
    // Announced with nothing stored yet — the case that sent no snapshot.
    announceNewRun(convId, streamId);

    await vi.waitFor(() => {
      const sync = sent.find((m): m is Extract<ServerMessage, { type: "stream.sync" }> => m.type === "stream.sync" && m.stream_id === streamId);
      expect(sync).toMatchObject({ status: "active", started_at: meta?.createdAt });
      expect(typeof sync?.server_now).toBe("number");
    });

    await producer.end("complete");
    delivery.close();
  });

  it("reaches the socket that sent the previous turn, with no subscribe of its own", async () => {
    // A new conversation: the device has its id only from `turn.started`, and
    // has never subscribed. The automatic compaction after that turn is the
    // next run, and nothing else would tell this socket about it.
    const sent: ServerMessage[] = [];
    const delivery = createDelivery(userId, (m) => sent.push(m), () => 0);
    const turnId = uuid();
    const turn = await getStreamBroker().openProducer({ streamId: turnId, conversationId: convId, userId, surface: "chat" });
    await delivery.autoSubscribe(turnId, convId);
    await turn.end("complete");

    const compactionId = uuid();
    const compaction = await getStreamBroker().openProducer({ streamId: compactionId, conversationId: convId, userId, surface: "chat" });
    announceNewRun(convId, compactionId);

    await vi.waitFor(() => {
      expect(sent.some((m) => m.type === "stream.sync" && m.stream_id === compactionId && m.status === "active")).toBe(true);
    });

    await compaction.end("complete");
    delivery.close();
  });
});
