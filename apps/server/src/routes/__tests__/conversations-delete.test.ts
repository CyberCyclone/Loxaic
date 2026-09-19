import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { v4 as uuid } from "uuid";
import Fastify from "fastify";
import { and, db, eq, inArray, isNull } from "@loxaic/db";
import { conversationShares, conversations, messages, usageRecords, user } from "@loxaic/db/schema";

/**
 * What "Delete chat" actually does, at the route.
 *
 * On the `shares.test.ts` harness — real Fastify `inject`, only authentication
 * stubbed, four personas as real rows — because the questions are the same
 * shape: who may do this, and does everybody else get the identical answer.
 *
 * Retention is pinned per case through the environment rather than through
 * `updateConversationSettings`, for two reasons. The settings row is global and
 * these suites share one Postgres, so writing it would change what a
 * concurrently-running suite's deletes do; and `resetServerSettingsCache()` is
 * process-global, which AGENTS.md already records as having broken four
 * unrelated container tests. Env pins are read at call time and are per-case.
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
const { registerRun, unregisterRun } = await import("../../streams/registry.ts");
const { sweepRetainedConversations } = await import("../../conversations/reaper.ts");

const owner = `test-del-owner-${uuid()}`;
const editor = `test-del-editor-${uuid()}`;
const stranger = `test-del-stranger-${uuid()}`;
const admin = `admin-test-del-${uuid()}`;
const everyone = [owner, editor, stranger, admin];

const app = Fastify();

function as(userId: string) {
  currentUser.id = userId;
}

/** Retention off — the default, where deleting erases. */
function retentionOff() {
  process.env.DELETED_CHAT_RETENTION_ENABLED = "0";
  delete process.env.DELETED_CHAT_RETENTION_DAYS;
}

/** Retention on, with a window in days. */
function retentionOn(days = 30) {
  process.env.DELETED_CHAT_RETENTION_ENABLED = "1";
  process.env.DELETED_CHAT_RETENTION_DAYS = String(days);
}

async function makeConversation(opts?: { title?: string; deletedAt?: Date; hold?: boolean }) {
  const [conv] = await db
    .insert(conversations)
    .values({
      ownerId: owner,
      title: opts?.title ?? "delete route test",
      ...(opts?.deletedAt ? { deletedAt: opts.deletedAt } : {}),
      ...(opts?.hold ? { deletedHold: true } : {}),
    })
    .returning();
  return conv.id;
}

async function addMessage(convId: string, text = "hello") {
  const id = uuid();
  await db.insert(messages).values({
    id,
    conversationId: convId,
    parentId: null,
    authorType: "user",
    authorUserId: owner,
    origin: "server",
    lamport: Date.now(),
    content: [{ kind: "text", text }],
    status: "complete",
    createdAt: new Date(),
  });
  return id;
}

async function addUsage(convId: string, messageId: string) {
  const id = uuid();
  await db.insert(usageRecords).values({
    id,
    userId: owner,
    conversationId: convId,
    messageId,
    model: "test-model",
    inputTokens: 100,
    outputTokens: 20,
  });
  return id;
}

async function countMessages(convId: string) {
  return (await db.select({ id: messages.id }).from(messages).where(eq(messages.conversationId, convId))).length;
}

async function conversationRow(convId: string) {
  return db.query.conversations.findFirst({ where: eq(conversations.id, convId) });
}

/** Deletion's cleanup is deliberately detached from the response, so a test
 * asserting on what it did has to let the microtasks it queued run. */
async function settle() {
  await new Promise((r) => setTimeout(r, 50));
}

beforeAll(async () => {
  conversationRoutes(app);
  adminConversationRoutes(app);
  await app.ready();

  await db.insert(user).values(
    everyone.map((id) => ({
      id,
      name: id.startsWith("admin") ? "Admin" : "Person",
      email: `${id}@example.test`,
      emailVerified: true,
      ...(id.startsWith("admin") ? { role: "admin" } : {}),
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
  );
});

beforeEach(() => {
  retentionOff();
});

afterEach(async () => {
  retentionOff();
  // Scoped to this suite's own owner — an unscoped delete here would wipe
  // every other suite's rows out from under them (AGENTS.md records exactly
  // that bug in git.test.ts).
  const own = await db.select({ id: conversations.id }).from(conversations).where(eq(conversations.ownerId, owner));
  const ids = own.map((c) => c.id);
  if (ids.length) {
    await db.delete(messages).where(inArray(messages.conversationId, ids));
    await db.delete(usageRecords).where(inArray(usageRecords.conversationId, ids));
    await db.delete(conversations).where(inArray(conversations.id, ids));
  }
  await db.delete(usageRecords).where(eq(usageRecords.userId, owner));
});

afterAll(async () => {
  delete process.env.DELETED_CHAT_RETENTION_ENABLED;
  delete process.env.DELETED_CHAT_RETENTION_DAYS;
  await db.delete(user).where(inArray(user.id, everyone));
  await app.close();
});

describe("DELETE /v1/conversations/:id — retention off", () => {
  it("erases the conversation, its messages and its shares", async () => {
    const convId = await makeConversation();
    await addMessage(convId);
    await addMessage(convId, "second");
    await db.insert(conversationShares).values({
      conversationId: convId,
      userId: editor,
      role: "editor",
      createdBy: owner,
    });

    as(owner);
    const res = await app.inject({ method: "DELETE", url: `/v1/conversations/${convId}` });
    expect(res.statusCode).toBe(200);

    expect(await conversationRow(convId)).toBeUndefined();
    expect(await countMessages(convId)).toBe(0);
    const shares = await db
      .select({ userId: conversationShares.userId })
      .from(conversationShares)
      .where(eq(conversationShares.conversationId, convId));
    expect(shares).toHaveLength(0);
  });

  it("keeps the usage rows but detaches them from the conversation", async () => {
    const convId = await makeConversation();
    const msgId = await addMessage(convId);
    const usageId = await addUsage(convId, msgId);

    as(owner);
    await app.inject({ method: "DELETE", url: `/v1/conversations/${convId}` });

    const row = await db.query.usageRecords.findFirst({ where: eq(usageRecords.id, usageId) });
    // The tokens were spent; deleting the conversation is not a claim they
    // weren't. What must not survive is anything pointing back at it.
    expect(row).toBeDefined();
    expect(row?.inputTokens).toBe(100);
    expect(row?.conversationId).toBeNull();
    expect(row?.messageId).toBeNull();
  });

  it("is idempotent — deleting twice is not an error", async () => {
    const convId = await makeConversation();
    as(owner);
    const first = await app.inject({ method: "DELETE", url: `/v1/conversations/${convId}` });
    const second = await app.inject({ method: "DELETE", url: `/v1/conversations/${convId}` });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.body).toBe(first.body);
  });
});

describe("DELETE /v1/conversations/:id — who may", () => {
  it("answers identically for an editor, a stranger, an admin and an id that never existed", async () => {
    const convId = await makeConversation();
    await db.insert(conversationShares).values({
      conversationId: convId,
      userId: editor,
      role: "editor",
      createdBy: owner,
    });

    const answers: string[] = [];
    for (const who of [editor, stranger, admin]) {
      as(who);
      const res = await app.inject({ method: "DELETE", url: `/v1/conversations/${convId}` });
      expect(res.statusCode).toBe(200);
      answers.push(res.body);
      // …and the conversation is still there. A silent "ok" that did nothing
      // is the whole design; a silent "ok" that deleted would be the bug.
      expect(await conversationRow(convId)).toBeDefined();
    }
    as(stranger);
    const missing = await app.inject({ method: "DELETE", url: `/v1/conversations/${uuid()}` });
    answers.push(missing.body);
    expect(new Set(answers).size).toBe(1);
  });
});

describe("DELETE /v1/conversations/:id — an active run", () => {
  it("aborts the run, and erases what the run writes as it unwinds", async () => {
    const convId = await makeConversation();
    await addMessage(convId);
    const streamId = uuid();
    const abort = new AbortController();
    registerRun({ streamId, conversationId: convId, userId: owner, abort, approvals: new Map() });

    as(owner);
    await app.inject({ method: "DELETE", url: `/v1/conversations/${convId}` });

    // The user's delete does not wait on the run: the row is already gone.
    expect(abort.signal.aborted).toBe(true);
    expect(await conversationRow(convId)).toBeUndefined();

    // A run unwinding after the transaction committed still writes — its
    // cancelled assistant row, a stopped tool result. Nothing else would ever
    // collect those: their conversation no longer exists.
    await addMessage(convId, "written while unwinding");
    expect(await countMessages(convId)).toBe(1);

    unregisterRun(streamId);
    await settle();
    expect(await countMessages(convId)).toBe(0);
  });
});

describe("DELETE /v1/conversations/:id — retention on", () => {
  it("keeps the row and its messages, and hides it from the owner's list", async () => {
    retentionOn();
    const convId = await makeConversation({ title: "kept for audit" });
    await addMessage(convId);

    as(owner);
    await app.inject({ method: "DELETE", url: `/v1/conversations/${convId}` });

    const row = await conversationRow(convId);
    expect(row?.deletedAt).toBeInstanceOf(Date);
    expect(await countMessages(convId)).toBe(1);

    const list = await app.inject({ method: "GET", url: "/v1/conversations" });
    const ids = list.json<{ id: string }[]>().map((c) => c.id);
    expect(ids).not.toContain(convId);
  });

  it("still refuses the conversation to its owner and to a share-holder", async () => {
    retentionOn();
    const convId = await makeConversation();
    await db.insert(conversationShares).values({
      conversationId: convId,
      userId: editor,
      role: "editor",
      createdBy: owner,
    });

    as(owner);
    await app.inject({ method: "DELETE", url: `/v1/conversations/${convId}` });

    for (const who of [owner, editor]) {
      as(who);
      const res = await app.inject({ method: "GET", url: `/v1/conversations/${convId}` });
      expect(res.statusCode).toBe(404);
      const msgs = await app.inject({ method: "GET", url: `/v1/conversations/${convId}/messages` });
      expect(msgs.statusCode).toBe(404);
    }
  });
});

describe("the admin audit routes", () => {
  it("refuses a non-admin", async () => {
    retentionOn();
    const convId = await makeConversation({ deletedAt: new Date() });
    for (const who of [owner, editor, stranger]) {
      as(who);
      const res = await app.inject({ method: "GET", url: `/v1/admin/conversations/${convId}/messages` });
      expect(res.statusCode).toBe(403);
    }
  });

  it("lists a retained conversation with its purge date, and reads its transcript", async () => {
    retentionOn(30);
    const deletedAt = new Date();
    const convId = await makeConversation({ title: "audit me", deletedAt });
    await addMessage(convId, "the thing that was said");

    as(admin);
    const list = await app.inject({ method: "GET", url: "/v1/admin/conversations" });
    const row = list
      .json<{ id: string; deletedAt: string | null; purgeAt: string | null }[]>()
      .find((r) => r.id === convId);
    expect(row?.deletedAt).not.toBeNull();
    expect(new Date(row?.purgeAt ?? 0).getTime()).toBeCloseTo(deletedAt.getTime() + 30 * 86_400_000, -4);

    const msgs = await app.inject({ method: "GET", url: `/v1/admin/conversations/${convId}/messages` });
    expect(msgs.statusCode).toBe(200);
    expect(JSON.stringify(msgs.json())).toContain("the thing that was said");
  });

  it("restores a retained conversation to its owner, shares and all", async () => {
    retentionOn();
    const convId = await makeConversation({ deletedAt: new Date() });
    await db.insert(conversationShares).values({
      conversationId: convId,
      userId: editor,
      role: "editor",
      createdBy: owner,
    });

    as(admin);
    expect((await app.inject({ method: "POST", url: `/v1/admin/conversations/${convId}/restore` })).statusCode).toBe(200);

    as(owner);
    const res = await app.inject({ method: "GET", url: `/v1/conversations/${convId}` });
    expect(res.statusCode).toBe(200);
    as(editor);
    expect((await app.inject({ method: "GET", url: `/v1/conversations/${convId}` })).statusCode).toBe(200);
  });

  it("erases one on demand, and holds one past its window", async () => {
    retentionOn(30);
    const longAgo = new Date(Date.now() - 90 * 86_400_000);
    const purgeMe = await makeConversation({ deletedAt: new Date() });
    const holdMe = await makeConversation({ deletedAt: longAgo });

    as(admin);
    expect((await app.inject({ method: "POST", url: `/v1/admin/conversations/${purgeMe}/purge` })).statusCode).toBe(200);
    expect(await conversationRow(purgeMe)).toBeUndefined();

    const held = await app.inject({
      method: "PATCH",
      url: `/v1/admin/conversations/${holdMe}/hold`,
      payload: { hold: true },
    });
    expect(held.statusCode).toBe(200);
    expect((await conversationRow(holdMe))?.deletedHold).toBe(true);

    // Past its window by two months, and the sweep still leaves it alone.
    await sweepRetainedConversations(owner);
    expect(await conversationRow(holdMe)).toBeDefined();

    // Released, it goes on the next sweep.
    await app.inject({ method: "PATCH", url: `/v1/admin/conversations/${holdMe}/hold`, payload: { hold: false } });
    await sweepRetainedConversations(owner);
    expect(await conversationRow(holdMe)).toBeUndefined();
  });

  it("404s on a conversation that is not deleted — restoring a live one is not a thing", async () => {
    const convId = await makeConversation();
    as(admin);
    for (const [method, url] of [
      ["POST", `/v1/admin/conversations/${convId}/restore`],
      ["POST", `/v1/admin/conversations/${convId}/purge`],
    ] as const) {
      expect((await app.inject({ method, url })).statusCode).toBe(404);
    }
    const hold = await app.inject({
      method: "PATCH",
      url: `/v1/admin/conversations/${convId}/hold`,
      payload: { hold: true },
    });
    expect(hold.statusCode).toBe(404);
    // …and it is still perfectly usable.
    expect(await conversationRow(convId)).toBeDefined();
  });
});

describe("the retention sweep", () => {
  it("erases what is past the window and leaves what is not", async () => {
    retentionOn(30);
    const stale = await makeConversation({ deletedAt: new Date(Date.now() - 31 * 86_400_000) });
    const fresh = await makeConversation({ deletedAt: new Date(Date.now() - 1 * 86_400_000) });
    const live = await makeConversation();
    await addMessage(stale);

    const purged = await sweepRetainedConversations(owner);
    expect(purged).toBe(1);
    expect(await conversationRow(stale)).toBeUndefined();
    expect(await countMessages(stale)).toBe(0);
    expect(await conversationRow(fresh)).toBeDefined();
    expect(await conversationRow(live)).toBeDefined();
  });

  it("with retention off, erases everything retained — that is what switching it off means", async () => {
    retentionOff();
    const yesterday = await makeConversation({ deletedAt: new Date(Date.now() - 86_400_000) });
    const held = await makeConversation({ deletedAt: new Date(Date.now() - 86_400_000), hold: true });
    const live = await makeConversation();

    await sweepRetainedConversations(owner);
    expect(await conversationRow(yesterday)).toBeUndefined();
    // A hold is an admin saying "not this one". A policy change is not an
    // answer to that.
    expect(await conversationRow(held)).toBeDefined();
    expect(await conversationRow(live)).toBeDefined();
  });

  it("stands down entirely when the retention policy could not be read", async () => {
    const settings = await import("../../settings.ts");
    // No env pin: a pinned DELETED_CHAT_RETENTION_ENABLED is the operator
    // stating the policy without the database, and outranks the failed read —
    // which is the case the sibling test below covers.
    delete process.env.DELETED_CHAT_RETENTION_ENABLED;
    delete process.env.DELETED_CHAT_RETENTION_DAYS;
    const stale = await makeConversation({ deletedAt: new Date(Date.now() - 400 * 86_400_000) });
    settings.__setConversationLoadFailedForTest(true);
    try {
      // Both branches of this sweep delete, so guessing "off" on an unreadable
      // policy is the one guess that cannot be taken back.
      expect(await sweepRetainedConversations(owner)).toBe(0);
      expect(await conversationRow(stale)).toBeDefined();
      // And a delete in that state keeps rather than erases.
      const convId = await makeConversation();
      await addMessage(convId);
      as(owner);
      await app.inject({ method: "DELETE", url: `/v1/conversations/${convId}` });
      expect((await conversationRow(convId))?.deletedAt).toBeInstanceOf(Date);
      expect(await countMessages(convId)).toBe(1);
    } finally {
      settings.__setConversationLoadFailedForTest(false);
    }
  });

  it("but an env pin outranks the failed read — the operator said it without the database", async () => {
    const settings = await import("../../settings.ts");
    retentionOff();
    const stale = await makeConversation({ deletedAt: new Date(Date.now() - 400 * 86_400_000) });
    settings.__setConversationLoadFailedForTest(true);
    try {
      expect(await sweepRetainedConversations(owner)).toBe(1);
      expect(await conversationRow(stale)).toBeUndefined();
    } finally {
      settings.__setConversationLoadFailedForTest(false);
    }
  });
});

describe("messages of a live conversation", () => {
  it("are unaffected by any of this — the ordinary read still works", async () => {
    const convId = await makeConversation();
    await addMessage(convId, "still here");
    as(owner);
    const res = await app.inject({ method: "GET", url: `/v1/conversations/${convId}/messages` });
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(res.json())).toContain("still here");
    const live = await db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.conversationId, convId), isNull(messages.deletedAt)));
    expect(live).toHaveLength(1);
  });
});
