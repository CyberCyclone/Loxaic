import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { v4 as uuid } from "uuid";
import { db, eq, inArray } from "@loxaic/db";
import { conversations, user } from "@loxaic/db/schema";
import type { ServerMessage, StreamEventKind } from "@loxaic/types";

/**
 * What delivery does for get_location: a socket that can share a location
 * counts for a run only while it follows that run's stream (so a request is
 * never left waiting on a device that cannot see it), and a location result
 * goes out in full only to the person whose device answered; anyone else
 * following the thread (a share member) reads only that it was shared, live
 * and in a catch-up snapshot alike.
 */
vi.mock("../../streams/authz.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../streams/authz.ts")>();
  return { ...actual, assertConversationAccess: () => Promise.resolve() };
});

const { createDelivery } = await import("../delivery.ts");
const { initStreamBroker, getStreamBroker } = await import("../../streams/index.ts");
const { hasLocationFollower } = await import("../../streams/device-presence.ts");

const sender = `test-delivery-loc-${uuid()}`;
const member = `test-delivery-loc-member-${uuid()}`;
let convId = "";

const RESULT: StreamEventKind = {
  kind: "tool.result",
  message_id: "m1",
  call_id: "c1",
  tool: "get_location",
  output: "Approximate location: Brisbane, Queensland, Australia (city-level).",
  ok: true,
  device: { request: "location", outcome: "shared", place: "Brisbane, Queensland, Australia", user_id: sender },
};

beforeAll(async () => {
  await initStreamBroker();
  await db.insert(user).values(
    [sender, member].map((id) => ({ id, name: "Person", email: `${id}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() })),
  );
  const [conv] = await db.insert(conversations).values({ ownerId: sender, title: "delivery location" }).returning();
  convId = conv.id;
});

afterAll(async () => {
  await db.delete(conversations).where(eq(conversations.id, convId));
  await db.delete(user).where(inArray(user.id, [sender, member]));
});

function socketOf(userId: string, canShareLocation: boolean) {
  const sent: ServerMessage[] = [];
  const delivery = createDelivery(userId, (m) => sent.push(m), () => 0, canShareLocation);
  return { sent, delivery };
}

describe("a location-capable socket", () => {
  it("counts for a run while it follows it, and not once it closes", async () => {
    const streamId = uuid();
    const producer = await getStreamBroker().openProducer({ streamId, conversationId: convId, userId: sender, surface: "chat" });
    const oldApp = socketOf(sender, false);
    await oldApp.delivery.handleSubscribe(convId);
    expect(hasLocationFollower(sender, streamId)).toBe(false);

    const phone = socketOf(sender, true);
    await phone.delivery.handleSubscribe(convId);
    expect(hasLocationFollower(sender, streamId)).toBe(true);
    phone.delivery.close();
    expect(hasLocationFollower(sender, streamId)).toBe(false);

    // The run ending ends the following too.
    const again = socketOf(sender, true);
    await again.delivery.handleSubscribe(convId);
    await producer.end("complete");
    await new Promise((r) => setTimeout(r, 50));
    expect(hasLocationFollower(sender, streamId)).toBe(false);
    oldApp.delivery.close();
    again.delivery.close();
  });
});

describe("a location result", () => {
  const outputsIn = (sent: ServerMessage[]) => JSON.stringify(sent);

  it("goes out in full to its sender, and as only \"shared\" to anyone else, live and caught up", async () => {
    const streamId = uuid();
    const producer = await getStreamBroker().openProducer({ streamId, conversationId: convId, userId: sender, surface: "chat" });
    const mine = socketOf(sender, true);
    const theirs = socketOf(member, true);
    await mine.delivery.handleSubscribe(convId);
    await theirs.delivery.handleSubscribe(convId);
    producer.emit(RESULT);
    await new Promise((r) => setTimeout(r, 50));
    expect(outputsIn(mine.sent)).toContain("Brisbane");
    expect(outputsIn(theirs.sent)).toContain("Shared their location.");
    expect(outputsIn(theirs.sent)).not.toContain("Brisbane");

    // A member who opens the thread later is caught up the same way.
    const late = socketOf(member, false);
    await late.delivery.handleSubscribe(convId);
    expect(late.sent.some((m) => m.type === "stream.sync")).toBe(true);
    expect(outputsIn(late.sent)).not.toContain("Brisbane");

    await producer.end("complete");
    for (const s of [mine, theirs, late]) s.delivery.close();
  });
});
