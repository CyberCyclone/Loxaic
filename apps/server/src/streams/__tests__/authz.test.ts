import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { v4 as uuid } from "uuid";
import { db, eq, inArray } from "@shannon/db";
import { conversationShares, conversations, user } from "@shannon/db/schema";
import { initStreamBroker } from "../index.ts";
import { assertConversationAccess, assertParentInConversation, NotFoundError } from "../authz.ts";

/**
 * Integration test against the real dev Postgres (same DATABASE_URL the
 * server itself uses) plus a fresh in-memory stream broker — exercises the
 * one chokepoint every WS command authorizes through: owner / non-owner /
 * nonexistent. Cleans up everything it inserts.
 */
describe("assertConversationAccess", () => {
  const userA = `test-authz-a-${uuid()}`;
  const userB = `test-authz-b-${uuid()}`;
  const adminId = `test-authz-admin-${uuid()}`;
  let ownedConvId: string;

  beforeAll(async () => {
    await initStreamBroker();
    await db.insert(user).values([
      { id: userA, name: "Test A", email: `${userA}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
      { id: userB, name: "Test B", email: `${userB}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
      { id: adminId, name: "Test Admin", email: `${adminId}@example.test`, emailVerified: true, role: "admin", createdAt: new Date(), updatedAt: new Date() },
    ]);
    const [conv] = await db.insert(conversations).values({ ownerId: userA, title: "authz test" }).returning();
    ownedConvId = conv.id;
  });

  afterAll(async () => {
    await db.delete(conversationShares).where(eq(conversationShares.conversationId, ownedConvId));
    await db.delete(conversations).where(eq(conversations.id, ownedConvId));
    await db.delete(user).where(inArray(user.id, [userA, userB, adminId]));
  });

  it("grants the owner access to their own conversation", async () => {
    const grant = await assertConversationAccess(userA, ownedConvId);
    expect(grant).toEqual({ conversationId: ownedConvId, role: "owner", viaAdmin: false });
  });

  it("throws NotFoundError for a non-owner, not a permissions-specific error", async () => {
    await expect(assertConversationAccess(userB, ownedConvId)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("throws NotFoundError for a conversation id that doesn't exist anywhere", async () => {
    await expect(assertConversationAccess(userA, uuid())).rejects.toBeInstanceOf(NotFoundError);
  });

  describe("shared access", () => {
    async function share(role: "viewer" | "editor") {
      await db
        .insert(conversationShares)
        .values({ conversationId: ownedConvId, userId: userB, role, createdBy: userA })
        .onConflictDoUpdate({
          target: [conversationShares.conversationId, conversationShares.userId],
          set: { role },
        });
    }

    afterEach(async () => {
      await db
        .delete(conversationShares)
        .where(eq(conversationShares.conversationId, ownedConvId));
    });

    it("grants a shared viewer read access", async () => {
      await share("viewer");
      const grant = await assertConversationAccess(userB, ownedConvId);
      expect(grant).toEqual({ conversationId: ownedConvId, role: "viewer", viaAdmin: false });
    });

    it("refuses a viewer an editor action, indistinguishably from not sharing at all", async () => {
      // The whole point of the role: a viewer can watch this conversation
      // stream but must not be able to send into it.
      await share("viewer");
      await expect(
        assertConversationAccess(userB, ownedConvId, "editor"),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("grants an editor the actions a viewer is refused", async () => {
      await share("editor");
      const grant = await assertConversationAccess(userB, ownedConvId, "editor");
      expect(grant.role).toBe("editor");
    });

    it("never grants owner through a share, however the row is written", async () => {
      // Ownership is not a role you can be given — it lives on
      // conversations.ownerId. An editor asking for owner is refused.
      await share("editor");
      await expect(
        assertConversationAccess(userB, ownedConvId, "owner"),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("revoking takes effect on the next check", async () => {
      await share("editor");
      expect((await assertConversationAccess(userB, ownedConvId, "editor")).role).toBe("editor");
      await db
        .delete(conversationShares)
        .where(eq(conversationShares.conversationId, ownedConvId));
      await expect(assertConversationAccess(userB, ownedConvId)).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe("deleted conversations", () => {
    it("revokes every share, and the owner's own access, on soft delete", async () => {
      // Share rows outlive the delete, so without this a guest holding the id
      // could still read, stream, and (as an editor) send into a thread the
      // owner deleted to take it back.
      await db
        .insert(conversationShares)
        .values({ conversationId: ownedConvId, userId: userB, role: "editor", createdBy: userA });
      await db.update(conversations).set({ deletedAt: new Date() }).where(eq(conversations.id, ownedConvId));
      try {
        await expect(assertConversationAccess(userB, ownedConvId)).rejects.toBeInstanceOf(NotFoundError);
        await expect(assertConversationAccess(userA, ownedConvId)).rejects.toBeInstanceOf(NotFoundError);
        await expect(assertConversationAccess(adminId, ownedConvId)).rejects.toBeInstanceOf(NotFoundError);
      } finally {
        await db.update(conversations).set({ deletedAt: null }).where(eq(conversations.id, ownedConvId));
        await db.delete(conversationShares).where(eq(conversationShares.conversationId, ownedConvId));
      }
    });
  });

  describe("admin access", () => {
    it("lets an admin see any conversation, as a viewer", async () => {
      const grant = await assertConversationAccess(adminId, ownedConvId);
      expect(grant.role).toBe("viewer");
      expect(grant.viaAdmin).toBe(true);
    });

    it("does NOT let an admin act — seeing is not participating", async () => {
      // An admin who wants to send can share the conversation to themselves,
      // which leaves a row recording that they did.
      await expect(
        assertConversationAccess(adminId, ownedConvId, "editor"),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("prefers a real share over the admin fallback", async () => {
      // Otherwise an admin who was genuinely granted editor would be demoted
      // to viewer by their own admin status.
      await db.insert(conversationShares).values({
        conversationId: ownedConvId,
        userId: adminId,
        role: "editor",
        createdBy: userA,
      });
      const grant = await assertConversationAccess(adminId, ownedConvId, "editor");
      expect(grant.role).toBe("editor");
      expect(grant.viaAdmin).toBe(false);
      await db
        .delete(conversationShares)
        .where(eq(conversationShares.conversationId, ownedConvId));
    });
  });

  it("nonexistent and non-owner produce the identical error message (no existence oracle)", async () => {
    const [msgNonexistent, msgNonOwner] = await Promise.all([
      assertConversationAccess(userA, uuid()).catch((e: unknown) => (e instanceof Error ? e.message : String(e))),
      assertConversationAccess(userB, ownedConvId).catch((e: unknown) => (e instanceof Error ? e.message : String(e))),
    ]);
    expect(msgNonexistent).toBe(msgNonOwner);
  });
});

describe("assertParentInConversation", () => {
  it("throws NotFoundError when the parent message id doesn't exist", async () => {
    await expect(assertParentInConversation(uuid(), uuid())).rejects.toBeInstanceOf(NotFoundError);
  });
});
