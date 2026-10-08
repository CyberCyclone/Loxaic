import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { v4 as uuid } from "uuid";
import { and, asc, db, eq, inArray } from "@loxaic/db";
import { attachments, conversationShares, conversations, messages, usageRecords, user } from "@loxaic/db/schema";
import { CHECKIN_ANSWER_NUDGE, type ContentBlock } from "@loxaic/types";
import { getStreamBroker, initStreamBroker } from "../../streams/index.ts";
import { claimConversation, ConversationBusyError, getRunByConversation, unregisterRun } from "../../streams/registry.ts";
import { watchConversationEvents, type ConversationEvent } from "../../streams/watchers.ts";
import { startChatRun } from "../../streams/runs/chatRun.ts";
import { hasNoMessages } from "../../streams/runs/stageRun.ts";
import { historyFront, loadHistory } from "../../streams/runs/engine.ts";
import { NotFoundError } from "../../streams/authz.ts";
import { loadMessagePage } from "../history-page.ts";
import { previewRewind, rewindConversation, RewindError } from "../rewind.ts";

/**
 * Rewinding to a message removes it and everything after it (#166), and what
 * "removes" means follows the deleted-conversation retention setting. The
 * suffix is defined by `createdAt`, so a summary a run placed below the message
 * it was answering goes with that run.
 *
 * Integration against the dev Postgres, with the mock model for real runs.
 */
process.env.MOCK_INFERENCE = "true";
const MODEL = "llama-3.1-8b-instruct";

describe("rewinding a conversation", () => {
  const userId = `test-rewind-${uuid()}`;
  const otherId = `test-rewind-other-${uuid()}`;
  const convIds: string[] = [];
  const retention = process.env.DELETED_CHAT_RETENTION_ENABLED;

  beforeAll(async () => {
    await initStreamBroker();
    for (const id of [userId, otherId]) {
      await db.insert(user).values({
        id,
        name: "Test Rewind",
        email: `${id}@example.test`,
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }
  });

  afterEach(() => {
    if (retention === undefined) delete process.env.DELETED_CHAT_RETENTION_ENABLED;
    else process.env.DELETED_CHAT_RETENTION_ENABLED = retention;
  });

  afterAll(async () => {
    const children = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(inArray(conversations.parentConversationId, convIds.length ? convIds : [uuid()]));
    for (const id of [...convIds, ...children.map((c) => c.id)]) {
      await db.delete(messages).where(eq(messages.conversationId, id));
      await db.delete(usageRecords).where(eq(usageRecords.conversationId, id));
      await db.delete(conversationShares).where(eq(conversationShares.conversationId, id));
      await db.delete(conversations).where(eq(conversations.id, id));
    }
    await db.delete(usageRecords).where(inArray(usageRecords.userId, [userId, otherId]));
    await db.delete(attachments).where(inArray(attachments.ownerId, [userId, otherId]));
    await db.delete(user).where(inArray(user.id, [userId, otherId]));
  });

  const erase = () => { process.env.DELETED_CHAT_RETENTION_ENABLED = "false"; };
  const audit = () => { process.env.DELETED_CHAT_RETENTION_ENABLED = "true"; };

  async function waitFor(label: string, check: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  /** A real turn on the mock model, finished. */
  async function send(content: string, conversationId?: string) {
    const started = await startChatRun({ userId, content, model: MODEL, conversationId });
    if (!conversationId) convIds.push(started.conversationId);
    await waitFor("the run to end", () => getRunByConversation(started.conversationId) === undefined);
    return started;
  }

  async function rowsOf(convId: string, opts?: { all?: boolean }) {
    const rows = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, convId))
      .orderBy(asc(messages.lamport), asc(messages.createdAt));
    return opts?.all ? rows : rows.filter((r) => r.deletedAt === null);
  }

  async function newConv(ownerId = userId): Promise<string> {
    const [conv] = await db.insert(conversations).values({ ownerId, title: "rewind test" }).returning();
    convIds.push(conv.id);
    return conv.id;
  }

  const text = (t: string): ContentBlock[] => [{ kind: "text", text: t }];
  let clock = Date.now() - 60_000;
  /** A stored row, `clock` ms apart so `createdAt` orders them. */
  async function row(convId: string, authorType: "user" | "assistant" | "tool" | "summary", content: ContentBlock[], opts?: { lamport?: number; authorUserId?: string | null }) {
    clock += 10;
    const id = uuid();
    await db.insert(messages).values({
      id,
      conversationId: convId,
      authorType,
      authorUserId: opts?.authorUserId === undefined ? (authorType === "user" ? userId : null) : opts.authorUserId,
      origin: "server",
      lamport: opts?.lamport ?? clock,
      content,
      status: "complete",
      createdAt: new Date(clock),
    });
    return id;
  }

  it("removes the message and everything after it, and gives its text back", async () => {
    erase();
    const first = await send("hello one");
    await send("hello two", first.conversationId);
    const convId = first.conversationId;
    const before = await rowsOf(convId);
    const second = before.find((r) => r.authorType === "user" && JSON.stringify(r.content).includes("hello two"));
    expect(second).toBeDefined();
    const removed = before.filter((r) => r.createdAt >= second?.createdAt).map((r) => r.id);
    const usageBefore = await db.select().from(usageRecords).where(inArray(usageRecords.messageId, removed));
    expect(usageBefore.length).toBeGreaterThan(0);

    const result = await rewindConversation({ userId, conversationId: convId, messageId: second?.id });

    expect(result.text).toBe("hello two");
    expect(result.removedIds.sort()).toEqual(removed.sort());
    const after = await rowsOf(convId, { all: true });
    // Erased, not stamped: retention is off.
    expect(after.map((r) => r.id)).toEqual(before.filter((r) => !removed.includes(r.id)).map((r) => r.id));
    // The first turn is untouched, and the leaf is its last row.
    const conv = await db.query.conversations.findFirst({ where: eq(conversations.id, convId) });
    expect(conv?.activeLeafId).toBe(after.at(-1)?.id);
    // Usage kept for Stats, but no longer the conversation's.
    const usageAfter = await db.select().from(usageRecords).where(inArray(usageRecords.id, usageBefore.map((u) => u.id)));
    expect(usageAfter).toHaveLength(usageBefore.length);
    expect(usageAfter.every((u) => u.conversationId === null && u.messageId === null)).toBe(true);
    // The next prompt is the first turn alone.
    const history = await loadHistory(convId);
    expect(history.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("takes a summary written for the rewound message with it, though its lamport is lower", async () => {
    erase();
    const convId = await newConv();
    await row(convId, "user", text("first"));
    await row(convId, "assistant", text("first reply"));
    const target = await row(convId, "user", text("second"), { lamport: 5_000_000 });
    // Placed below the message its run was answering (compactRun's
    // cutoffBefore), written after it.
    const summary = await row(convId, "summary", text("summary of everything"), { lamport: 4_999_999 });
    await row(convId, "assistant", text("second reply"), { lamport: 5_000_001 });

    expect(await historyFront(convId)).toBe("4999999");
    await rewindConversation({ userId, conversationId: convId, messageId: target });

    const left = (await rowsOf(convId)).map((r) => (r.content as { text: string }[])[0].text);
    expect(left).toEqual(["first", "first reply"]);
    expect((await rowsOf(convId)).some((r) => r.id === summary)).toBe(false);
    // The front is back where the first turn left it.
    expect(await historyFront(convId)).toBe("0");
  });

  it("deletes the stream logs of the removed runs, compaction and stage runs included, and keeps the older ones", async () => {
    erase();
    const first = await send("one");
    const convId = first.conversationId;
    await send("two", convId);
    // A run with no rows of its own after the rewound message (a stage run).
    const broker = getStreamBroker();
    const stage = await broker.openProducer({ streamId: uuid(), conversationId: convId, userId, surface: "chat" });
    await stage.end("complete");
    const streamsBefore = await broker.driver.listConvStreams(convId);
    expect(streamsBefore).toHaveLength(3);

    const two = (await rowsOf(convId)).find((r) => JSON.stringify(r.content).includes('"two"'));
    const seen: ConversationEvent[] = [];
    const unwatch = watchConversationEvents(convId, (e) => seen.push(e));
    await rewindConversation({ userId, conversationId: convId, messageId: two?.id });
    unwatch();

    const streamsAfter = await broker.driver.listConvStreams(convId);
    expect(streamsAfter).toEqual([first.streamId]);
    expect(await broker.getMeta(streamsBefore[1])).toBeNull();
    // Every device watching is told, with the runs to forget.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ type: "conversation.rewound", conversation_id: convId, from_message_id: two?.id, reason: "rewind" });
    expect(seen[0].removed_stream_ids.sort()).toEqual(streamsBefore.slice(1).sort());
  });

  it("with audit retention, stamps the rows: gone for the model and the thread, kept for admins", async () => {
    audit();
    const convId = await newConv();
    const first = await row(convId, "user", text("only message"));
    const summary = await row(convId, "summary", text("a summary"));
    await row(convId, "assistant", text("reply"));

    await rewindConversation({ userId, conversationId: convId, messageId: first });

    const all = await rowsOf(convId, { all: true });
    expect(all).toHaveLength(3);
    expect(all.every((r) => r.deletedAt !== null)).toBe(true);
    expect(await hasNoMessages(convId)).toBe(true);
    // The stamped summary is not a cutoff, and nothing is replayed.
    expect(await historyFront(convId)).toBe("0");
    expect((await loadHistory(convId)).messages).toEqual([]);
    expect((await loadMessagePage(convId, { limit: 50 })).rows).toEqual([]);
    const adminPage = await loadMessagePage(convId, { limit: 50, includeRemoved: true });
    expect(adminPage.rows.map((r) => r.id)).toContain(summary);
    // A stamped row cannot be rewound to again.
    await expect(rewindConversation({ userId, conversationId: convId, messageId: first })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("removes the sub-agents a removed message spawned, by the same setting", async () => {
    for (const mode of ["erase", "audit"] as const) {
      if (mode === "erase") erase(); else audit();
      const convId = await newConv();
      await row(convId, "user", text("keep"));
      const target = await row(convId, "user", text("spawn"));
      const spawner = await row(convId, "assistant", [{ kind: "tool_call", call_id: "c1", tool: "subagent", args: {} }]);
      const [child] = await db
        .insert(conversations)
        .values({ ownerId: userId, kind: "subagent", parentConversationId: convId, parentMessageId: spawner, parentCallId: "c1" })
        .returning();
      await db.insert(messages).values({
        id: uuid(), conversationId: child.id, authorType: "user", origin: "server", lamport: 1, content: text("task"), status: "complete",
      });

      await rewindConversation({ userId, conversationId: convId, messageId: target });

      const after = await db.query.conversations.findFirst({ where: eq(conversations.id, child.id) });
      if (mode === "erase") {
        expect(after).toBeUndefined();
        expect(await db.select().from(messages).where(eq(messages.conversationId, child.id))).toEqual([]);
      } else {
        expect(after?.deletedAt).not.toBeNull();
      }
    }
  });

  it("forgets a project-instructions version only a removed message told the model about", async () => {
    erase();
    const convId = await newConv();
    const base = { path: "AGENTS.md", text: "v1", tokens: 1 };
    await db
      .update(conversations)
      .set({ instructions: { status: "found", ...base, latest: { path: "AGENTS.md", text: "v2", tokens: 1 } } })
      .where(eq(conversations.id, convId));
    await row(convId, "user", text("before"));
    const target = await row(convId, "user", [
      { kind: "instructions_update", path: "AGENTS.md", text: "changed", summary: "1 section changed" },
      { kind: "text", text: "after the change" },
    ]);

    const result = await rewindConversation({ userId, conversationId: convId, messageId: target });

    // The notice is never part of the text that goes back.
    expect(result.text).toBe("after the change");
    const conv = await db.query.conversations.findFirst({ where: eq(conversations.id, convId) });
    expect(conv?.instructions).toEqual({ status: "found", ...base });
  });

  it("gives attachments back only to the person who sent them, with their grace restarted", async () => {
    erase();
    const convId = await newConv();
    const old = new Date(Date.now() - 23 * 3_600_000);
    const [att] = await db
      .insert(attachments)
      .values({ ownerId: userId, mime: "image/png", sizeBytes: 1, filename: "a.png", createdAt: old })
      .returning();
    const content: ContentBlock[] = [{ kind: "attachment", ref: att.id, mime: "image/png", name: "a.png" }, { kind: "text", text: "look" }];
    await db.insert(conversationShares).values({ conversationId: convId, userId: otherId, role: "editor", createdBy: userId });

    const mineTarget = await row(convId, "user", content);
    const mine = await rewindConversation({ userId, conversationId: convId, messageId: mineTarget });
    expect(mine.attachments).toEqual([{ ref: att.id, mime: "image/png", name: "a.png" }]);
    expect(mine.attachmentsWithheld).toBe(false);
    const refreshed = await db.query.attachments.findFirst({ where: eq(attachments.id, att.id) });
    expect(refreshed?.createdAt.getTime()).toBeGreaterThan(old.getTime() + 3_600_000);

    const theirsTarget = await row(convId, "user", content);
    const theirs = await rewindConversation({ userId: otherId, conversationId: convId, messageId: theirsTarget });
    expect(theirs.text).toBe("look");
    expect(theirs.attachments).toEqual([]);
    expect(theirs.attachmentsWithheld).toBe(true);
  });

  it("refuses what is not a message someone typed, a viewer, and a sub-agent's conversation", async () => {
    erase();
    const convId = await newConv();
    await row(convId, "user", text("real"));
    const reply = await row(convId, "assistant", text("reply"));
    // An answered check-in's nudge carries the person's id, so only its text
    // says nobody typed it.
    const nudge = await row(convId, "user", text(CHECKIN_ANSWER_NUDGE), { authorUserId: userId });
    await expect(rewindConversation({ userId, conversationId: convId, messageId: reply })).rejects.toBeInstanceOf(RewindError);
    await expect(rewindConversation({ userId, conversationId: convId, messageId: nudge })).rejects.toBeInstanceOf(RewindError);
    await expect(rewindConversation({ userId, conversationId: convId, messageId: uuid() })).rejects.toBeInstanceOf(NotFoundError);

    await db.insert(conversationShares).values({ conversationId: convId, userId: otherId, role: "viewer", createdBy: userId });
    const real = (await rowsOf(convId))[0].id;
    await expect(rewindConversation({ userId: otherId, conversationId: convId, messageId: real })).rejects.toBeInstanceOf(NotFoundError);

    const [child] = await db
      .insert(conversations)
      .values({ ownerId: userId, kind: "subagent", parentConversationId: convId, parentMessageId: reply, parentCallId: "c" })
      .returning();
    const childMsg = await row(child.id, "user", text("task"));
    await expect(rewindConversation({ userId, conversationId: child.id, messageId: childMsg })).rejects.toBeInstanceOf(NotFoundError);
    expect(await rowsOf(convId)).toHaveLength(3);
  });

  it("is refused while a run holds the conversation, and holds it against a send while it works", async () => {
    erase();
    const convId = await newConv();
    const target = await row(convId, "user", text("hello"));
    const busy = { streamId: uuid(), conversationId: convId, userId, abort: new AbortController(), approvals: new Map() };
    claimConversation(busy);
    try {
      await expect(rewindConversation({ userId, conversationId: convId, messageId: target })).rejects.toBeInstanceOf(ConversationBusyError);
      // And a send is refused the same way before it writes anything.
      await expect(startChatRun({ userId, content: "sneaking in", model: MODEL, conversationId: convId })).rejects.toBeInstanceOf(
        ConversationBusyError,
      );
      expect(await rowsOf(convId)).toHaveLength(1);
    } finally {
      unregisterRun(busy.streamId);
    }
    // Released afterwards, whatever happened.
    await rewindConversation({ userId, conversationId: convId, messageId: target });
    expect(getRunByConversation(convId)).toBeUndefined();
  });

  it("previews what would go: the typed messages, other people's, and whether admins keep them", async () => {
    audit();
    const convId = await newConv();
    await db.insert(conversationShares).values({ conversationId: convId, userId: otherId, role: "editor", createdBy: userId });
    await row(convId, "user", text("kept"));
    const target = await row(convId, "user", text("mine"));
    await row(convId, "assistant", text("reply"));
    await row(convId, "user", text("theirs"), { authorUserId: otherId });
    await row(convId, "user", text(CHECKIN_ANSWER_NUDGE), { authorUserId: otherId });

    expect(await previewRewind({ userId, conversationId: convId, messageId: target })).toEqual({ turns: 2, others: 1, retained: true });
    // Nothing was touched.
    expect(await rowsOf(convId)).toHaveLength(5);
    expect(
      await db.select().from(messages).where(and(eq(messages.conversationId, convId), eq(messages.authorType, "user"))),
    ).toHaveLength(4);
  });
});
