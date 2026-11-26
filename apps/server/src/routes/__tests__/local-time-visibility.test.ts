import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { v4 as uuid } from "uuid";
import Fastify from "fastify";
import { db, eq, inArray } from "@loxaic/db";
import { conversationShares, conversations, messages, user } from "@loxaic/db/schema";

/**
 * A message's `local_time` block names its sender's zone, so the message
 * routes serve it only to that sender: another member of a shared thread, and
 * an admin reading a transcript, get the row without it
 * (`withoutOthersLocalTime` in streams/runs/local-time.ts).
 */
const currentUser = { id: "" };

vi.mock("../../auth/middleware", () => ({
  authenticate: () => Promise.resolve(currentUser.id),
  requireAdmin: (_req: unknown, reply: { code: (n: number) => { send: (b: unknown) => void } }) => {
    if (!currentUser.id.startsWith("admin")) {
      reply.code(403).send({ error: "Admin access required" });
      throw new Error("Forbidden");
    }
    return Promise.resolve(currentUser.id);
  },
}));

const { conversationRoutes } = await import("../conversations.ts");
const { adminConversationRoutes } = await import("../shares.ts");

interface Row {
  authorUserId: string | null;
  content: { kind: string; text?: string; tz?: string }[];
}

const owner = `test-ltv-owner-${uuid()}`;
const guest = `test-ltv-guest-${uuid()}`;
const admin = `admin-test-ltv-${uuid()}`;
const app = Fastify();
let convId = "";

function sentBy(userId: string, text: string, tz: string, lamport: number): typeof messages.$inferInsert {
  return {
    id: uuid(),
    conversationId: convId,
    authorType: "user",
    authorUserId: userId,
    lamport,
    content: [
      { kind: "text", text },
      { kind: "local_time", at: "2026-11-26T09:00+10:00", tz, source: "device", text: `<local-time>${tz}</local-time>` },
    ],
    status: "complete",
  };
}

beforeAll(async () => {
  conversationRoutes(app);
  adminConversationRoutes(app);
  await app.ready();
  await db.insert(user).values(
    [owner, guest, admin].map((id) => ({
      id,
      name: "Person",
      email: `${id}@example.test`,
      emailVerified: true,
      ...(id.startsWith("admin") ? { role: "admin" } : {}),
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
  );
  const [conv] = await db.insert(conversations).values({ ownerId: owner, title: "local time visibility" }).returning();
  convId = conv.id;
  await db.insert(conversationShares).values({ conversationId: convId, userId: guest, role: "editor", createdBy: owner });
  await db.insert(messages).values([sentBy(owner, "from the owner", "Australia/Brisbane", 1), sentBy(guest, "from the guest", "Europe/Oslo", 2)]);
});

afterAll(async () => {
  await db.delete(messages).where(eq(messages.conversationId, convId));
  await db.delete(conversations).where(eq(conversations.id, convId));
  await db.delete(user).where(inArray(user.id, [owner, guest, admin]));
  await app.close();
});

/** The zones each author's row shows this reader. */
async function zonesSeen(reader: string, url: string): Promise<Record<string, (string | undefined)[]>> {
  currentUser.id = reader;
  const res = await app.inject({ method: "GET", url });
  expect(res.statusCode).toBe(200);
  const rows = res.json<{ messages: Row[] }>().messages;
  const out: Record<string, (string | undefined)[]> = {};
  for (const row of rows) {
    // The text is always there: only the time block is withheld.
    expect(row.content.some((b) => b.kind === "text")).toBe(true);
    out[row.authorUserId ?? ""] = row.content.filter((b) => b.kind === "local_time").map((b) => b.tz);
  }
  return out;
}

describe("a message's time zone", () => {
  it("is served to its sender only, in a shared thread", async () => {
    const url = `/v1/conversations/${convId}/messages`;
    expect(await zonesSeen(owner, url)).toEqual({ [owner]: ["Australia/Brisbane"], [guest]: [] });
    expect(await zonesSeen(guest, url)).toEqual({ [owner]: [], [guest]: ["Europe/Oslo"] });
  });

  it("is left out of an admin's transcript", async () => {
    expect(await zonesSeen(admin, `/v1/admin/conversations/${convId}/messages`)).toEqual({ [owner]: [], [guest]: [] });
  });
});
