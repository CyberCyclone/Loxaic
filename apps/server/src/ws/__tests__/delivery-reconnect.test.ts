import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { v4 as uuid } from "uuid";
import { db, eq } from "@loxaic/db";
import { conversations, user } from "@loxaic/db/schema";
import type { ServerMessage } from "@loxaic/types";

/**
 * A client that reconnects already caught up on a live run must still hear
 * the rest of it.
 *
 * A subscribe skipped every run whose last seq the client's cursor had
 * reached, active ones included. That is right for the old socket, which
 * already has a live tap, and wrong for a new one, which has none. A run
 * parked on an approval emits nothing while it waits, so a client that
 * reconnects at that moment is always exactly caught up. The fresh socket
 * therefore got no tap, the approval still reached the server (a command
 * needs no subscription), and every later event of the run went nowhere: the
 * tool's result, the next message, the next approval. On a phone this looked
 * like a frozen chat after coming back from the background (#231), and only
 * reloading fixed it, because a reload starts with no cursor.
 */
vi.mock("../../streams/authz.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../streams/authz.ts")>();
  return { ...actual, assertConversationAccess: () => Promise.resolve() };
});

const { createDelivery } = await import("../delivery.ts");
const { initStreamBroker, getStreamBroker } = await import("../../streams/index.ts");

type Sent = ServerMessage;

describe("resubscribing to a live run the client is caught up on", () => {
  const userId = `test-delivery-reconnect-${uuid()}`;
  let convId: string;

  beforeAll(async () => {
    await initStreamBroker();
    await db.insert(user).values({
      id: userId,
      name: "Test Delivery Reconnect",
      email: `${userId}@example.test`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const [conv] = await db
      .insert(conversations)
      .values({ ownerId: userId, title: "delivery reconnect test", kind: "chat" })
      .returning();
    convId = conv.id;
  });

  afterAll(async () => {
    await db.delete(conversations).where(eq(conversations.id, convId));
    await db.delete(user).where(eq(user.id, userId));
  });

  const eventsFor = (sent: Sent[], streamId: string) =>
    sent.filter((m): m is Extract<Sent, { type: "stream.event" }> => m.type === "stream.event" && m.stream_id === streamId);

  async function parkedRun() {
    const broker = getStreamBroker();
    const streamId = uuid();
    const producer = await broker.openProducer({ streamId, conversationId: convId, userId, surface: "chat" });
    producer.emit({ kind: "approval.request", call_id: "c1", tool: "bash", args: { command: "echo first" } });
    const meta = await broker.getMeta(streamId);
    if (!meta) throw new Error("no meta for the run");
    return { producer, streamId, lastSeq: meta.lastSeq };
  }

  it("gives a new socket the run's later events", async () => {
    const { producer, streamId, lastSeq } = await parkedRun();

    // A new socket, with the cursor the old one had reached.
    const sent: Sent[] = [];
    const delivery = createDelivery(userId, (m) => sent.push(m), () => 0);
    await delivery.handleSubscribe(convId, { [streamId]: lastSeq });

    // Nothing to catch up on, so no snapshot...
    expect(sent.some((m) => m.type === "stream.sync" && m.stream_id === streamId)).toBe(false);

    // ...but the run carries on after the approval, and this socket hears it.
    producer.emit({ kind: "tool.result", message_id: uuid(), call_id: "c1", tool: "bash", ok: true, output: "first" });
    await vi.waitFor(() => { expect(eventsFor(sent, streamId).map((m) => m.seq)).toEqual([lastSeq + 1]); });

    await producer.end("complete");
    await vi.waitFor(() => { expect(sent.some((m) => m.type === "stream.end" && m.stream_id === streamId)).toBe(true); });
    delivery.close();
  });

  it("does not deliver twice to a socket that already has the run", async () => {
    const { producer, streamId, lastSeq } = await parkedRun();

    const sent: Sent[] = [];
    const delivery = createDelivery(userId, (m) => sent.push(m), () => 0);
    await delivery.handleSubscribe(convId, { [streamId]: 0 });
    // Caught up now; the same socket subscribing again must not add a tap.
    await delivery.handleSubscribe(convId, { [streamId]: lastSeq });

    producer.emit({ kind: "tool.result", message_id: uuid(), call_id: "c1", tool: "bash", ok: true, output: "first" });
    await vi.waitFor(() => { expect(eventsFor(sent, streamId).length).toBeGreaterThan(0); });
    // Give a second tap, if there were one, the chance to deliver its copy.
    await new Promise((r) => setTimeout(r, 50));
    expect(eventsFor(sent, streamId).map((m) => m.seq)).toEqual([lastSeq + 1]);

    await producer.end("complete");
    delivery.close();
  });

  it("tells a caught-up socket that the run it was following has finished, once", async () => {
    // The run finishes while the client has every event: `producer.end`
    // writes no record, so its cursor still equals lastSeq, and the live
    // `stream.end` went out on the socket a resume then replaced.
    const { producer, streamId, lastSeq } = await parkedRun();
    await producer.end("complete");

    const sent: Sent[] = [];
    const delivery = createDelivery(userId, (m) => sent.push(m), () => 0);
    await delivery.handleSubscribe(convId, { [streamId]: lastSeq });
    const syncs = () =>
      sent.filter((m): m is Extract<Sent, { type: "stream.sync" }> => m.type === "stream.sync" && m.stream_id === streamId);
    expect(syncs().map((m) => m.status)).toEqual(["complete"]);

    // Once per socket: a later subscribe on it has nothing new to say.
    await delivery.handleSubscribe(convId, { [streamId]: lastSeq });
    expect(syncs()).toHaveLength(1);
    delivery.close();
  });

  it("attaches a caught-up socket without re-reading the run from the start", async () => {
    const { producer, streamId, lastSeq } = await parkedRun();
    const broker = getStreamBroker();
    const readFrom = vi.spyOn(broker, "readFrom");
    try {
      const delivery = createDelivery(userId, () => undefined, () => 0);
      await delivery.handleSubscribe(convId, { [streamId]: lastSeq });
      const reads = readFrom.mock.calls.filter(([id]) => id === streamId).map(([, after]) => after);
      expect(reads).toEqual([lastSeq]);
      delivery.close();
    } finally {
      readFrom.mockRestore();
      await producer.end("complete");
    }
  });
});
