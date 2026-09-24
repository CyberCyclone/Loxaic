import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { v4 as uuid } from "uuid";
import Fastify from "fastify";
import { db, eq, inArray } from "@loxaic/db";
import { conversations, messages, user } from "@loxaic/db/schema";
import { pageEnd } from "../../conversations/history-page.ts";

/**
 * A thread loads its newest messages, a page at a time, backwards (#213).
 *
 * Both history routes used to return the *oldest* rows — `ORDER BY created_at
 * LIMIT n` — so a long thread reloaded without the messages anyone came back
 * for. They also ordered by `created_at` alone, while the engine replays by
 * `(lamport, created_at)`, so two rows written in the same millisecond could
 * come back swapped. And a page must never start inside a turn: the client
 * joins a `tool_call` to its result by call id within one page, so a page
 * boundary between them would leave the call with no result on screen.
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

type Author = "user" | "assistant" | "tool";
interface Block { kind: string; text?: string; output?: string }
interface Page {
  messages: { id: string; authorType: Author; content: { kind: string; text?: string }[] }[];
  hasMore: boolean;
  before: string | null;
}

describe("pageEnd", () => {
  const keys = (...authors: Author[]) => authors.map((authorType) => ({ authorType }));

  it("takes everything when it fits", () => {
    expect(pageEnd(keys("tool", "assistant", "user"), 5)).toBe(3);
  });

  it("grows back to the start of the turn it cuts into", () => {
    // newest first: the limit of 2 lands on an assistant row, and the page
    // grows until its oldest row is the turn's user message.
    expect(pageEnd(keys("assistant", "tool", "assistant", "user", "assistant", "user"), 2)).toBe(4);
  });

  it("stops at the limit when that is already a turn start", () => {
    expect(pageEnd(keys("assistant", "user", "assistant", "user"), 2)).toBe(2);
  });

  it("cuts a turn longer than the ceiling, but never with a tool row as the oldest", () => {
    // ceiling 4, no user row within reach: the cut lands on a tool row, whose
    // call is one row older, so the page gives both up to the older page.
    const long = keys("assistant", "tool", "assistant", "tool", "assistant", "tool", "user");
    const end = pageEnd(long, 2, 4);
    expect(end).toBe(3);
    expect(long[end - 1].authorType).toBe("assistant");
  });
});

describe("GET /v1/conversations/:id/messages", () => {
  const owner = `test-history-owner-${uuid()}`;
  const stranger = `test-history-stranger-${uuid()}`;
  const admin = `admin-test-history-${uuid()}`;
  const app = Fastify();
  let convId = "";
  /** Every row, in the order the engine replays them. */
  const inserted: { id: string; text: string }[] = [];

  function as(userId: string) {
    currentUser.id = userId;
  }

  beforeAll(async () => {
    conversationRoutes(app);
    adminConversationRoutes(app);
    await app.ready();
    await db.insert(user).values(
      [owner, stranger, admin].map((id) => ({
        id,
        name: "Person",
        email: `${id}@example.test`,
        emailVerified: true,
        ...(id.startsWith("admin") ? { role: "admin" } : {}),
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
    );
    const [conv] = await db.insert(conversations).values({ ownerId: owner, title: "history test", kind: "agent" }).returning();
    convId = conv.id;

    // 90 turns of user → assistant (a tool call) → tool → assistant, and every
    // fourth turn a second call/result pair: 406 rows, in turns of 4 and 6, so a
    // 200-row cut lands inside a turn and the page has to grow back to its
    // start. Every row of a turn shares one created_at, so only lamport — not
    // created_at, the old sort key — says which came first.
    const rows: (typeof messages.$inferInsert)[] = [];
    let lamport = 1_000;
    for (let turn = 0; turn < 90; turn++) {
      const at = new Date(Date.UTC(2026, 0, 1, 0, 0, turn));
      const add = (authorType: Author, text: string) => {
        const id = uuid();
        inserted.push({ id, text });
        rows.push({
          id,
          conversationId: convId,
          authorType,
          lamport: lamport++,
          content:
            authorType === "tool"
              ? [{ kind: "tool_result", call_id: `c${String(turn)}`, output: text }]
              : authorType === "assistant" && text.endsWith("call")
                ? [{ kind: "tool_call", call_id: `c${String(turn)}`, tool: "grep", args: {} }, { kind: "text", text }]
                : [{ kind: "text", text }],
          status: "complete",
          createdAt: at,
        });
      };
      add("user", `turn ${String(turn)} ask`);
      add("assistant", `turn ${String(turn)} call`);
      add("tool", `turn ${String(turn)} result`);
      if (turn % 4 === 0) {
        add("assistant", `turn ${String(turn)} second call`);
        add("tool", `turn ${String(turn)} second result`);
      }
      add("assistant", `turn ${String(turn)} answer`);
    }
    // Shuffled, so neither insertion order nor heap order can pass for the
    // sort the route is meant to apply.
    for (let i = rows.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rows[i], rows[j]] = [rows[j], rows[i]];
    }
    await db.insert(messages).values(rows);
  });

  afterAll(async () => {
    await db.delete(messages).where(eq(messages.conversationId, convId));
    await db.delete(conversations).where(eq(conversations.id, convId));
    await db.delete(user).where(inArray(user.id, [owner, stranger, admin]));
  });

  const textOf = (m: Page["messages"][number]) => m.content.find((b) => b.kind === "text")?.text ?? m.content[0]?.text;

  async function page(url: string): Promise<Page> {
    const res = await app.inject({ method: "GET", url });
    expect(res.statusCode).toBe(200);
    const body = res.json<Omit<Page, "messages"> & { messages: (Omit<Page["messages"][number], "content"> & { content: Block[] })[] }>();
    // tool rows carry their text as `output`; fold it in for the comparisons.
    return {
      ...body,
      messages: body.messages.map((m) => ({
        ...m,
        content: m.content.map((b) => ({ kind: b.kind, text: b.output ?? b.text })),
      })),
    };
  }

  it("opens on the newest messages, in replay order", async () => {
    as(owner);
    const first = await page(`/v1/conversations/${convId}/messages`);
    // The 200th-newest row is inside a turn, so the page grows past 200 to
    // that turn's user message — and holds the newest rows, all of them.
    const n = first.messages.length;
    expect(n).toBeGreaterThan(200);
    expect(first.messages.map(textOf)).toEqual(inserted.slice(-n).map((r) => r.text));
    expect(first.messages[0].authorType).toBe("user");
    expect(textOf(first.messages[0])).toMatch(/ ask$/);
    expect(first.hasMore).toBe(true);
    expect(first.before).toBe(first.messages[0].id);
  });

  it("walks back through every row exactly once, never starting a page inside a turn", async () => {
    as(owner);
    const seen: string[] = [];
    let url = `/v1/conversations/${convId}/messages`;
    for (let guard = 0; guard < 10; guard++) {
      const p = await page(url);
      expect(p.messages[0].authorType).toBe("user");
      seen.unshift(...p.messages.map((m) => m.id));
      if (!p.hasMore) {
        expect(p.before).toBeNull();
        break;
      }
      url = `/v1/conversations/${convId}/messages?before=${String(p.before)}`;
    }
    expect(seen).toEqual(inserted.map((r) => r.id));
  });

  it("refuses a cursor that is not a message of this conversation", async () => {
    as(owner);
    for (const before of ["not-a-uuid", uuid()]) {
      const res = await app.inject({ method: "GET", url: `/v1/conversations/${convId}/messages?before=${before}` });
      expect(res.statusCode).toBe(400);
    }
  });

  it("refuses a real message id from another conversation, the same way", async () => {
    // A row the caller can see, in a conversation they own: only the scoping
    // of the cursor lookup to *this* conversation stands between it and a
    // page cut against someone else's thread. Same 400 as an unknown id, so a
    // cursor's validity is not something to probe.
    const [other] = await db.insert(conversations).values({ ownerId: owner, title: "other", kind: "agent" }).returning();
    const foreign = uuid();
    await db.insert(messages).values({
      id: foreign,
      conversationId: other.id,
      authorType: "user",
      lamport: 1,
      content: [{ kind: "text", text: "elsewhere" }],
      status: "complete",
      createdAt: new Date(),
    });
    try {
      as(owner);
      const res = await app.inject({ method: "GET", url: `/v1/conversations/${convId}/messages?before=${foreign}` });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: "Unknown cursor" });
      as(admin);
      const adminRes = await app.inject({ method: "GET", url: `/v1/admin/conversations/${convId}/messages?before=${foreign}` });
      expect(adminRes.statusCode).toBe(400);
    } finally {
      await db.delete(messages).where(eq(messages.conversationId, other.id));
      await db.delete(conversations).where(eq(conversations.id, other.id));
    }
  });

  it("still 404s for someone who cannot see the conversation", async () => {
    as(stranger);
    const res = await app.inject({ method: "GET", url: `/v1/conversations/${convId}/messages` });
    expect(res.statusCode).toBe(404);
  });

  it("gives the admin transcript the same newest-first pages", async () => {
    as(admin);
    const first = await page(`/v1/admin/conversations/${convId}/messages`);
    // 500 is past the whole thread: everything, in replay order.
    expect(first.messages.map(textOf)).toEqual(inserted.map((r) => r.text));
    expect(first.hasMore).toBe(false);
    expect(first.before).toBeNull();
  });
});
