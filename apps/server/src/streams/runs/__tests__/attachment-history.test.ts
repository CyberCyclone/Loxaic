import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { v4 as uuid } from "uuid";
import { db, eq } from "@shannon/db";
import { attachments, conversations, messages, user } from "@shannon/db/schema";
import type { ContentBlock } from "@shannon/types";
import { attachmentPath } from "../../../files/storage.ts";
import { getStreamBroker, initStreamBroker } from "../../index.ts";
import { loadEphemeralHistory, loadHistory } from "../engine.ts";

/**
 * Integration test against the real dev Postgres (same pattern as
 * compaction-history.test.ts) — exercises the one thing a pure-function test
 * on attachmentContentParts can't: that a stored `attachment` content block
 * actually turns into an `image_url` part when the history loader assembles
 * the prompt. Chat and agent share `loadHistory`, so one pass covers both.
 */
describe("attachment content in history loaders", () => {
  const userId = `test-attach-history-${uuid()}`;
  const convIds: string[] = [];
  const dir = mkdtempSync(path.join(tmpdir(), "shannon-uploads-test-"));
  const prevUploadsDir = process.env.UPLOADS_DIR;

  beforeAll(async () => {
    process.env.UPLOADS_DIR = dir;
    await initStreamBroker();
    await db.insert(user).values({
      id: userId,
      name: "Test Attach History",
      email: `${userId}@example.test`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  afterAll(async () => {
    for (const id of convIds) {
      await db.delete(messages).where(eq(messages.conversationId, id));
      await db.delete(conversations).where(eq(conversations.id, id));
    }
    await db.delete(attachments).where(eq(attachments.ownerId, userId));
    await db.delete(user).where(eq(user.id, userId));
    if (prevUploadsDir === undefined) delete process.env.UPLOADS_DIR;
    else process.env.UPLOADS_DIR = prevUploadsDir;
    rmSync(dir, { recursive: true, force: true });
  });

  async function newConv(): Promise<string> {
    const [conv] = await db.insert(conversations).values({ ownerId: userId, title: "attach test" }).returning();
    convIds.push(conv.id);
    return conv.id;
  }

  async function newAttachment(bytes: string): Promise<{ ref: string; mime: string }> {
    const ref = uuid();
    writeFileSync(attachmentPath(ref), Buffer.from(bytes));
    await db.insert(attachments).values({ id: ref, ownerId: userId, mime: "image/png", sizeBytes: bytes.length });
    return { ref, mime: "image/png" };
  }

  it("loadHistory turns an attachment block into an image_url part, images before text", async () => {
    const convId = await newConv();
    const att = await newAttachment("png bytes");
    await db.insert(messages).values({
      id: uuid(),
      conversationId: convId,
      authorType: "user",
      authorUserId: userId,
      origin: "server",
      lamport: Date.now(),
      content: [
        { kind: "attachment", ref: att.ref, mime: att.mime },
        { kind: "text", text: "what is this" },
      ] as ContentBlock[],
      status: "complete",
      createdAt: new Date(),
    });

    const history = await loadHistory(convId);
    expect(history.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:image/png;base64,${Buffer.from("png bytes").toString("base64")}` } },
          { type: "text", text: "what is this" },
        ],
      },
    ]);
  });

  it("loadHistory replays an image-only message (no text block at all)", async () => {
    const convId = await newConv();
    const att = await newAttachment("img only");
    await db.insert(messages).values({
      id: uuid(),
      conversationId: convId,
      authorType: "user",
      authorUserId: userId,
      origin: "server",
      lamport: Date.now(),
      content: [{ kind: "attachment", ref: att.ref, mime: att.mime }] as ContentBlock[],
      status: "complete",
      createdAt: new Date(),
    });

    const history = await loadHistory(convId);
    expect(history.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:image/png;base64,${Buffer.from("img only").toString("base64")}` } },
        ],
      },
    ]);
  });

  it("a text-only user message is unaffected — still a plain string", async () => {
    const convId = await newConv();
    await db.insert(messages).values({
      id: uuid(),
      conversationId: convId,
      authorType: "user",
      authorUserId: userId,
      origin: "server",
      lamport: Date.now(),
      content: [{ kind: "text", text: "just text" }] as ContentBlock[],
      status: "complete",
      createdAt: new Date(),
    });

    const history = await loadHistory(convId);
    expect(history.messages).toEqual([{ role: "user", content: "just text" }]);
  });

  it("loadEphemeralHistory (incognito) turns a message.start's attachments into an image_url part too", async () => {
    // Incognito writes nothing to Postgres — the attachment row (for the
    // bytes/mime) is the only DB row this case needs; the message itself
    // lives only in the stream log.
    const convId = uuid();
    const att = await newAttachment("incognito png");
    const broker = getStreamBroker();
    await broker.driver.putEphemeralConv({
      id: convId,
      ownerId: userId,
      title: "incognito attach test",
      kind: "chat",
      createdAt: Date.now(),
    });

    const streamId = uuid();
    const userMsgId = uuid();
    const producer = await broker.openProducer({
      streamId,
      conversationId: convId,
      userId,
      surface: "chat",
      incognito: true,
    });
    producer.emit({
      kind: "message.start",
      message_id: userMsgId,
      author_type: "user",
      parent_id: null,
      text: "what is this",
      attachments: [att],
    });
    producer.emit({ kind: "message.end", message_id: userMsgId, status: "complete" });
    await producer.end("complete");

    const history = await loadEphemeralHistory(convId);
    expect(history.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:image/png;base64,${Buffer.from("incognito png").toString("base64")}` } },
          { type: "text", text: "what is this" },
        ],
      },
    ]);
  });
});
