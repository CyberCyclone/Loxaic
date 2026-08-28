import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { v4 as uuid } from "uuid";
import { db, eq } from "@shannon/db";
import { conversations, user } from "@shannon/db/schema";
import { getStreamBroker, initStreamBroker } from "../index.ts";
import { assertConversationAccess, assertParentInConversation, NotFoundError } from "../authz.ts";

/**
 * Integration test against the real dev Postgres (same DATABASE_URL the
 * server itself uses) plus a fresh in-memory stream broker — exercises the
 * one chokepoint every WS command authorizes through: owner / non-owner /
 * nonexistent, for both a real (Postgres) conversation and an ephemeral
 * (incognito) one. Cleans up everything it inserts.
 */
describe("assertConversationAccess", () => {
  const userA = `test-authz-a-${uuid()}`;
  const userB = `test-authz-b-${uuid()}`;
  let ownedConvId: string;

  beforeAll(async () => {
    await initStreamBroker();
    await db.insert(user).values([
      { id: userA, name: "Test A", email: `${userA}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
      { id: userB, name: "Test B", email: `${userB}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
    ]);
    const [conv] = await db.insert(conversations).values({ ownerId: userA, title: "authz test" }).returning();
    ownedConvId = conv.id;
  });

  afterAll(async () => {
    await db.delete(conversations).where(eq(conversations.id, ownedConvId));
    await db.delete(user).where(eq(user.id, userA));
    await db.delete(user).where(eq(user.id, userB));
  });

  it("grants the owner access to their own conversation", async () => {
    const grant = await assertConversationAccess(userA, ownedConvId);
    expect(grant).toEqual({ conversationId: ownedConvId, incognito: false });
  });

  it("throws NotFoundError for a non-owner, not a permissions-specific error", async () => {
    await expect(assertConversationAccess(userB, ownedConvId)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("throws NotFoundError for a conversation id that doesn't exist anywhere", async () => {
    await expect(assertConversationAccess(userA, uuid())).rejects.toBeInstanceOf(NotFoundError);
  });

  it("nonexistent and non-owner produce the identical error message (no existence oracle)", async () => {
    const [msgNonexistent, msgNonOwner] = await Promise.all([
      assertConversationAccess(userA, uuid()).catch((e: unknown) => (e instanceof Error ? e.message : String(e))),
      assertConversationAccess(userB, ownedConvId).catch((e: unknown) => (e instanceof Error ? e.message : String(e))),
    ]);
    expect(msgNonexistent).toBe(msgNonOwner);
  });

  describe("ephemeral (incognito) conversations", () => {
    let econvId: string;

    beforeAll(async () => {
      const broker = getStreamBroker();
      econvId = uuid();
      await broker.driver.putEphemeralConv({ id: econvId, ownerId: userA, title: "incognito test", kind: "chat", createdAt: Date.now() });
    });

    it("grants the owner access via the ephemeral registry, with incognito: true", async () => {
      const grant = await assertConversationAccess(userA, econvId);
      expect(grant).toEqual({ conversationId: econvId, incognito: true });
    });

    it("throws NotFoundError for a non-owner of an ephemeral conversation", async () => {
      await expect(assertConversationAccess(userB, econvId)).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});

describe("assertParentInConversation", () => {
  it("throws NotFoundError when the parent message id doesn't exist", async () => {
    await expect(assertParentInConversation(uuid(), uuid())).rejects.toBeInstanceOf(NotFoundError);
  });
});
