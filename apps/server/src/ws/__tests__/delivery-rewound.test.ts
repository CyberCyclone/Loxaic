import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { v4 as uuid } from "uuid";
import { db, eq } from "@loxaic/db";
import { conversations, messages, user } from "@loxaic/db/schema";
import type { ContentBlock, ServerMessage } from "@loxaic/types";

/**
 * A rewind reaches every device watching the conversation, and a device that
 * resubscribes afterwards is not handed the removed runs back in a snapshot —
 * the stream log held every delta of them, and replaying it would put the
 * removed messages back on screen.
 */
const access = vi.hoisted(() => ({ revoked: false }));
vi.mock("../../streams/authz.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../streams/authz.ts")>();
  return {
    ...actual,
    // Only the watch's own re-check is stood in for; the rewind authorizes
    // through `resolveAccess`, which this leaves real.
    assertConversationAccess: (userId: string, convId: string, minimum?: "viewer" | "editor" | "owner") =>
      access.revoked && minimum === undefined
        ? Promise.reject(new actual.NotFoundError())
        : actual.assertConversationAccess(userId, convId, minimum),
  };
});

const { createDelivery } = await import("../delivery.ts");
const { initStreamBroker, getStreamBroker } = await import("../../streams/index.ts");
const { rewindConversation } = await import("../../conversations/rewind.ts");

describe("a rewound conversation on other devices", () => {
  const userId = `test-delivery-rewound-${uuid()}`;
  let convId: string;

  beforeAll(async () => {
    process.env.DELETED_CHAT_RETENTION_ENABLED = "false";
    await initStreamBroker();
    await db.insert(user).values({
      id: userId, name: "Rewound", email: `${userId}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date(),
    });
    const [conv] = await db.insert(conversations).values({ ownerId: userId, title: "rewound", kind: "chat" }).returning();
    convId = conv.id;
  });

  afterAll(async () => {
    delete process.env.DELETED_CHAT_RETENTION_ENABLED;
    await db.delete(messages).where(eq(messages.conversationId, convId));
    await db.delete(conversations).where(eq(conversations.id, convId));
    await db.delete(user).where(eq(user.id, userId));
  });

  /** A finished run that wrote one user message, stored and in the log. */
  async function storedTurn(text: string): Promise<{ streamId: string; messageId: string }> {
    const messageId = uuid();
    await db.insert(messages).values({
      id: messageId, conversationId: convId, authorType: "user", authorUserId: userId, origin: "server",
      lamport: Date.now(), content: [{ kind: "text", text }] as ContentBlock[], status: "complete", createdAt: new Date(),
    });
    const streamId = uuid();
    const producer = await getStreamBroker().openProducer({ streamId, conversationId: convId, userId, surface: "chat" });
    producer.emit({ kind: "message.start", message_id: messageId, author_type: "user", parent_id: null, text });
    producer.emit({ kind: "message.end", message_id: messageId, status: "complete" });
    await producer.end("complete");
    await new Promise((r) => setTimeout(r, 5));
    return { streamId, messageId };
  }

  const syncs = (sent: ServerMessage[]) =>
    sent.filter((m): m is Extract<ServerMessage, { type: "stream.sync" }> => m.type === "stream.sync").map((m) => m.stream_id);

  it("tells a watching device, and a resubscribe afterwards snapshots only what is left", async () => {
    const kept = await storedTurn("kept");
    const removed = await storedTurn("removed");
    const sent: ServerMessage[] = [];
    const delivery = createDelivery(userId, (m) => sent.push(m), () => 0);
    await delivery.handleSubscribe(convId, {});
    expect(syncs(sent).sort()).toEqual([kept.streamId, removed.streamId].sort());

    await rewindConversation({ userId, conversationId: convId, messageId: removed.messageId });

    await vi.waitFor(() => {
      expect(sent.find((m) => m.type === "conversation.rewound")).toMatchObject({
        type: "conversation.rewound",
        conversation_id: convId,
        removed_ids: [removed.messageId],
        removed_stream_ids: [removed.streamId],
      });
    });

    // A fresh socket — a reconnect — is given the surviving run only.
    const after: ServerMessage[] = [];
    const reconnect = createDelivery(userId, (m) => after.push(m), () => 0);
    await reconnect.handleSubscribe(convId, {});
    expect(syncs(after)).toEqual([kept.streamId]);
    delivery.close();
    reconnect.close();
  });

  it("is not passed on to a device whose access was revoked", async () => {
    const target = await storedTurn("again");
    const sent: ServerMessage[] = [];
    const delivery = createDelivery(userId, (m) => sent.push(m), () => 0);
    await delivery.handleSubscribe(convId, {});
    access.revoked = true;
    try {
      await rewindConversation({ userId, conversationId: convId, messageId: target.messageId });
      await new Promise((r) => setTimeout(r, 50));
      expect(sent.some((m) => m.type === "conversation.rewound")).toBe(false);
    } finally {
      access.revoked = false;
      delivery.close();
    }
  });
});
