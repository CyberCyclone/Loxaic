import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { v4 as uuid } from "uuid";
import { db, eq, inArray } from "@loxaic/db";
import { conversations, conversationShares, user } from "@loxaic/db/schema";

/**
 * Whose catalog a request is answered from. A person's own skills are theirs:
 * someone who can only see a thread — a viewer, or any admin, who resolves to
 * one — gets their own list, never the owner's. Only someone who can send
 * into the thread gets the owner's, which is what a send there would use.
 */
const asked: string[] = [];
vi.mock("../catalog.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../catalog.ts")>();
  return {
    ...real,
    resolveSkillCatalog: (input: { ownerId: string; conversationId?: string | null }) => {
      asked.push(input.ownerId);
      return real.resolveSkillCatalog(input);
    },
  };
});

const { catalogForRequest } = await import("../resolve.ts");
const { NotFoundError } = await import("../../streams/authz.ts");

const tag = uuid();
const owner = `test-resolve-owner-${tag}`;
const viewer = `test-resolve-viewer-${tag}`;
const editor = `test-resolve-editor-${tag}`;
const admin = `test-resolve-admin-${tag}`;
const stranger = `test-resolve-stranger-${tag}`;
const people = [owner, viewer, editor, admin, stranger];
let convId = "";

beforeAll(async () => {
  for (const id of people) {
    await db.insert(user).values({
      id, name: id, email: `${id}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date(),
      ...(id === admin ? { role: "admin" } : {}),
    });
  }
  const [conv] = await db.insert(conversations).values({ ownerId: owner, title: "shared" }).returning();
  convId = conv.id;
  await db.insert(conversationShares).values([
    { conversationId: convId, userId: viewer, role: "viewer", createdBy: owner },
    { conversationId: convId, userId: editor, role: "editor", createdBy: owner },
  ]);
});

beforeEach(() => {
  asked.length = 0;
});

afterAll(async () => {
  await db.delete(conversations).where(eq(conversations.id, convId));
  await db.delete(user).where(inArray(user.id, people));
});

describe("catalogForRequest", () => {
  it("answers the owner and an editor from the owner's catalog", async () => {
    await catalogForRequest(owner, convId);
    await catalogForRequest(editor, convId);
    expect(asked).toEqual([owner, owner]);
  });

  it("answers a viewer and an admin from their own, never the owner's", async () => {
    await catalogForRequest(viewer, convId);
    await catalogForRequest(admin, convId);
    expect(asked).toEqual([viewer, admin]);
  });

  it("refuses someone who cannot see the thread at all", async () => {
    await expect(catalogForRequest(stranger, convId)).rejects.toBeInstanceOf(NotFoundError);
    expect(asked).toEqual([]);
  });
});
