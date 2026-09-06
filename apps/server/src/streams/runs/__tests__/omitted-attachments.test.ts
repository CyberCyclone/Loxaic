import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { v4 as uuid } from "uuid";
import { db, eq } from "@loxaic/db";
import { conversations, messages, user } from "@loxaic/db/schema";
import { MAX_EXTRACTED_BYTES, type ContentBlock } from "@loxaic/types";
import { attachmentTextPath } from "../../../files/storage.ts";
import { loadHistory } from "../engine.ts";

/** Whether the prompt actually substituted the budget marker for this file —
 * read off the text parts rather than a stringified blob, so a mismatch
 * reports a boolean instead of a megabyte of document text. */
function promptMarksAsOmitted(msgs: { content: unknown }[], name: string): boolean {
  const needle = `[attached file ${JSON.stringify(name)} omitted`;
  return msgs.some(
    (m) =>
      Array.isArray(m.content) &&
      (m.content as { type: string; text?: string }[]).some(
        (part) => part.type === "text" && (part.text ?? "").includes(needle),
      ),
  );
}

/**
 * What the user is told when an attachment doesn't fit the prompt's budget.
 *
 * The model has always been told — `attachmentContentParts` substitutes a
 * marker naming the file — but nothing reached the client, so the thumbnail sat
 * in the transcript looking exactly like one the model could see. Someone whose
 * image was dropped got a confused answer and no way to connect the two.
 *
 * The load-bearing property is that the reported set and the prompt agree.
 * Reporting a file as dropped while quietly sending it, or the reverse, would
 * be worse than saying nothing — so both are asserted against the same call,
 * not against each other's expectations.
 */
describe("omitted attachments are reported alongside the prompt that dropped them", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "loxaic-omitted-test-"));
  const previousUploadsDir = process.env.UPLOADS_DIR;
  const userId = `test-omitted-${uuid()}`;
  const convIds: string[] = [];

  beforeAll(async () => {
    process.env.UPLOADS_DIR = dir;
    await db.insert(user).values({
      id: userId,
      name: "Test Omitted",
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
    await db.delete(user).where(eq(user.id, userId));
    if (previousUploadsDir === undefined) delete process.env.UPLOADS_DIR;
    else process.env.UPLOADS_DIR = previousUploadsDir;
    rmSync(dir, { recursive: true, force: true });
  });

  /** A document whose extracted text sits exactly at the per-document cap. */
  function writeDocument(name: string): { ref: string; name: string } {
    const ref = uuid();
    writeFileSync(attachmentTextPath(ref), "x".repeat(MAX_EXTRACTED_BYTES), "utf8");
    return { ref, name };
  }

  /** One user turn per document, oldest first — the shape prompt assembly sees. */
  async function conversationOf(docs: { ref: string; name: string }[]): Promise<string> {
    const [conv] = await db
      .insert(conversations)
      .values({ ownerId: userId, title: "omitted test" })
      .returning();
    convIds.push(conv.id);
    await db.insert(messages).values(
      docs.map((doc, i) => ({
        id: uuid(),
        conversationId: conv.id,
        authorType: "user" as const,
        origin: "server" as const,
        lamport: 1000 + i,
        content: [
          { kind: "attachment", ref: doc.ref, mime: "application/pdf", name: doc.name },
          { kind: "text", text: `about ${doc.name}` },
        ] as ContentBlock[],
        status: "complete" as const,
        createdAt: new Date(1_700_000_000_000 + i),
      })),
    );
    return conv.id;
  }

  it("reports nothing when everything fits", async () => {
    const convId = await conversationOf([writeDocument("a.pdf"), writeDocument("b.pdf")]);
    const history = await loadHistory(convId);
    expect(history.omittedAttachments).toEqual([]);
  });

  it("names what it dropped, and drops exactly what it named", async () => {
    // The budget holds three documents at the cap; a fourth cannot fit.
    const docs = ["a.pdf", "b.pdf", "c.pdf", "d.pdf"].map(writeDocument);
    const convId = await conversationOf(docs);
    const history = await loadHistory(convId);

    expect(history.omittedAttachments).toHaveLength(1);
    const dropped = history.omittedAttachments[0];
    expect(dropped.name).toBeDefined();

    // The claim and the prompt have to agree. Every named file must carry the
    // budget marker in the messages actually being sent, and no file that was
    // *not* named may carry it — the second half is what stops this reporting
    // drops that never happened.
    //
    // Compared as booleans rather than by searching the assembled prompt:
    // these messages hold a megabyte of document text, and a failed
    // `toContain` against that prints all of it.
    const verdicts = docs.map((doc) => ({
      file: doc.name,
      reported: history.omittedAttachments.some((a) => a.ref === doc.ref),
      inPrompt: promptMarksAsOmitted(history.messages, doc.name),
    }));
    expect(verdicts).toEqual(verdicts.map((v) => ({ ...v, inPrompt: v.reported })));
    expect(verdicts.filter((v) => v.reported).map((v) => v.file)).toEqual([dropped.name]);
  });

  it("does not call a file that isn't on disk 'over budget'", async () => {
    // An unreadable attachment is a different thing from an unaffordable one,
    // and only the second is a budget problem. Reporting the first here would
    // tell someone their image is over a budget — about a file that is not on
    // disk — and then advise an action that cannot possibly help. Reachable
    // whenever bytes outlive their row: a pruned UPLOADS_DIR, a DB restored
    // against a newer volume, a partially-failed upload.
    const missing = { ref: uuid(), mime: "image/png", name: "gone.png" };
    const convId = await conversationOf([writeDocument("a.pdf")]);
    await db.insert(messages).values({
      id: uuid(),
      conversationId: convId,
      authorType: "user",
      origin: "server",
      lamport: 2000,
      content: [
        { kind: "attachment", ref: missing.ref, mime: missing.mime, name: missing.name },
        { kind: "text", text: "and this one" },
      ] as ContentBlock[],
      status: "complete",
      createdAt: new Date(),
    });

    const history = await loadHistory(convId);
    expect(history.omittedAttachments.map((a) => a.ref)).not.toContain(missing.ref);
    // And the prompt says the true thing rather than the budget thing.
    expect(promptMarksAsOmitted(history.messages, missing.name)).toBe(false);
    const text = JSON.stringify(history.messages);
    expect(text).toContain("[image unavailable]");
  });

  it("reports a repeated ref once, however many turns carried it", async () => {
    // One file dropped is one thing to tell the user; three copies of the same
    // sentence is not more informative.
    const shared = writeDocument("shared.pdf");
    const docs = [shared, writeDocument("b.pdf"), writeDocument("c.pdf"), shared, shared];
    const convId = await conversationOf(docs);
    const history = await loadHistory(convId);
    const refs = history.omittedAttachments.map((a) => a.ref);
    expect(new Set(refs).size).toBe(refs.length);
  });
});
