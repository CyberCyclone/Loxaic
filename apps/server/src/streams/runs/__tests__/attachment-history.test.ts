import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { v4 as uuid } from "uuid";
import { db, eq } from "@loxaic/db";
import { attachments, conversations, messages, user } from "@loxaic/db/schema";
import type { ContentBlock } from "@loxaic/types";
import { attachmentPath } from "../../../files/storage.ts";
import { initStreamBroker } from "../../index.ts";
import { loadHistory } from "../engine.ts";

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
  const dir = mkdtempSync(path.join(tmpdir(), "loxaic-uploads-test-"));
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
});
