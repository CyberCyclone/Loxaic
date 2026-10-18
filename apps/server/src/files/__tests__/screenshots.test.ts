import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { v4 as uuid } from "uuid";
import { db, eq, inArray, sql } from "@loxaic/db";
import { attachments, conversationShares, conversations, messages, user } from "@loxaic/db/schema";
import type { ContentBlock } from "@loxaic/types";
import { GeneratedImageError, storeGeneratedImage } from "../generated.ts";
import { attachmentPath } from "../storage.ts";
import { sweepOrphanAttachments } from "../reaper.ts";
import {
  replayedScreenshotRefs,
  screenshotMessage,
  screenshotTurnsOf,
  SCREENSHOT_REPLAY_LIMIT,
  storeScreenshot,
} from "../../streams/runs/screenshots.ts";
import { modelSupportsImages } from "../../inference/providers.ts";

/**
 * web_fetch screenshots (#281) as attachments: stored for the conversation's
 * owner, kept by the reaper while a tool result names them, readable by
 * whoever can read the conversation and nobody else, and replayed to the
 * model in the same bytes every turn.
 */
const currentUser = { id: "" };
vi.mock("../../auth/middleware", () => ({
  authenticate: () => Promise.resolve(currentUser.id),
  authenticateHeaderOrQuery: () => Promise.resolve(currentUser.id),
}));

/** A 1×1 PNG: real bytes, so the store's sniff and read-back accept it. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

const owner = `test-shot-owner-${uuid()}`;
const viewer = `test-shot-viewer-${uuid()}`;
const stranger = `test-shot-stranger-${uuid()}`;
const convId = uuid();
const dir = mkdtempSync(path.join(tmpdir(), "loxaic-screenshots-test-"));
const prevUploads = process.env.UPLOADS_DIR;

beforeAll(async () => {
  process.env.UPLOADS_DIR = dir;
  const now = new Date();
  await db.insert(user).values(
    [owner, viewer, stranger].map((id) => ({ id, name: id, email: `${id}@example.test`, emailVerified: true, createdAt: now, updatedAt: now })),
  );
  await db.insert(conversations).values({ id: convId, ownerId: owner, title: "screenshots", kind: "chat" });
  await db.insert(conversationShares).values({ conversationId: convId, userId: viewer, role: "viewer", createdBy: owner });
});

afterAll(async () => {
  await db.delete(messages).where(eq(messages.conversationId, convId));
  await db.delete(conversations).where(eq(conversations.id, convId));
  await db.delete(attachments).where(inArray(attachments.ownerId, [owner, viewer, stranger]));
  await db.delete(user).where(inArray(user.id, [owner, viewer, stranger]));
  if (prevUploads === undefined) delete process.env.UPLOADS_DIR;
  else process.env.UPLOADS_DIR = prevUploads;
  delete process.env.ATTACHMENT_USER_QUOTA_BYTES;
  rmSync(dir, { recursive: true, force: true });
});

async function toolRow(blocks: ContentBlock[]): Promise<void> {
  await db.insert(messages).values({ id: uuid(), conversationId: convId, authorType: "tool", lamport: 1, status: "complete", content: blocks });
}

describe("storing a screenshot", () => {
  it("stores it for the conversation's owner under a safe name", async () => {
    const stored = await storeScreenshot(convId, "call/../1", { bytes: PNG, mime: "image/png" });
    expect("images" in stored).toBe(true);
    if (!("images" in stored)) return;
    const [image] = stored.images;
    const row = await db.query.attachments.findFirst({ where: eq(attachments.id, image.ref) });
    expect(row?.ownerId).toBe(owner);
    expect(row?.filename).toBe("screenshot-call1.png");
    expect(readFileSync(attachmentPath(image.ref)).equals(PNG)).toBe(true);
  });

  it("refuses bytes that are not the image they claim to be", async () => {
    await expect(storeGeneratedImage({ bytes: Buffer.from("<svg/>"), mime: "image/png", ownerId: owner, name: "x.png" })).rejects.toThrow(GeneratedImageError);
  });

  it("sanitizes the name it is given", async () => {
    const stored = await storeGeneratedImage({ bytes: PNG, mime: "image/png", ownerId: owner, name: "a\u0000b/../c\r\n.png" });
    for (const bad of ["\u0000", "\r", "\n", "/"]) expect(stored.filename.includes(bad)).toBe(false);
  });

  it("keeps nothing, on disk or in the table, when the owner is over quota", async () => {
    const used = await db.execute<{ total: string }>(sql`SELECT COALESCE(SUM(size_bytes), 0)::text AS total FROM attachments WHERE owner_id = ${owner}`);
    process.env.ATTACHMENT_USER_QUOTA_BYTES = String(Number(used[0].total) + PNG.length - 1);
    const before = await db.select().from(attachments).where(eq(attachments.ownerId, owner));
    const stored = await storeScreenshot(convId, "call-q", { bytes: PNG, mime: "image/png" });
    expect(stored).toEqual({ note: expect.stringContaining("quota") as unknown });
    const after = await db.select().from(attachments).where(eq(attachments.ownerId, owner));
    expect(after).toHaveLength(before.length);
    delete process.env.ATTACHMENT_USER_QUOTA_BYTES;
  });
});

describe("a screenshot named by a tool result", () => {
  let kept: string;
  let orphan: string;

  beforeAll(async () => {
    kept = (await storeGeneratedImage({ bytes: PNG, mime: "image/png", ownerId: owner, name: "kept.png" })).ref;
    orphan = (await storeGeneratedImage({ bytes: PNG, mime: "image/png", ownerId: owner, name: "orphan.png" })).ref;
    await db.update(attachments).set({ createdAt: sql`now() - make_interval(hours => 72)` }).where(inArray(attachments.id, [kept, orphan]));
    await toolRow([
      { kind: "tool_result", call_id: "c1", output: "shot", ok: true, images: [{ ref: kept, mime: "image/png" }], images_sent_to_model: true },
    ]);
  });

  it("survives the reaper, while one nothing names is collected", async () => {
    await sweepOrphanAttachments([owner]);
    expect(existsSync(attachmentPath(kept))).toBe(true);
    expect(existsSync(attachmentPath(orphan))).toBe(false);
  });

  it("is readable by the owner and a viewer the conversation is shared with, and nobody else", async () => {
    const { fileRoutes } = await import("../../routes/files.ts");
    const app = Fastify();
    fileRoutes(app);
    await app.ready();
    try {
      const get = async (who: string) => {
        currentUser.id = who;
        return (await app.inject({ method: "GET", url: `/v1/files/${kept}` })).statusCode;
      };
      expect(await get(owner)).toBe(200);
      expect(await get(viewer)).toBe(200);
      expect(await get(stranger)).toBe(404);
    } finally {
      await app.close();
    }
  });
});

describe("replaying screenshots to the model", () => {
  const ref = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

  it("names only results the model was shown, and only calls still in the prompt", () => {
    const blocks: ContentBlock[] = [
      { kind: "tool_result", call_id: "shown", output: "", images: [{ ref: ref(1), mime: "image/png" }], images_sent_to_model: true },
      { kind: "tool_result", call_id: "not-shown", output: "", images: [{ ref: ref(2), mime: "image/png" }] },
      { kind: "tool_result", call_id: "dropped", output: "", images: [{ ref: ref(3), mime: "image/png" }], images_sent_to_model: true },
    ];
    expect(screenshotTurnsOf(blocks, new Set(["shown", "not-shown"]))).toEqual([{ callId: "shown", images: [{ ref: ref(1), mime: "image/png" }] }]);
  });

  it("resends only the newest few as images", () => {
    const turns = Array.from({ length: SCREENSHOT_REPLAY_LIMIT + 2 }, (_, i) => ({ callId: `c${String(i)}`, images: [{ ref: ref(i), mime: "image/png" }] }));
    const kept = replayedScreenshotRefs(turns);
    expect([...kept]).toEqual(turns.slice(-SCREENSHOT_REPLAY_LIMIT).map((t) => t.images[0].ref));
  });

  it("builds the same message live and on replay, from the stored bytes", async () => {
    const stored = await storeGeneratedImage({ bytes: PNG, mime: "image/png", ownerId: owner, name: "replay.png" });
    const turns = [{ callId: "c9", images: [{ ref: stored.ref, mime: "image/png" }] }];
    const live = await screenshotMessage(turns);
    const replay = await screenshotMessage(turns, (r) => r === stored.ref);
    expect(JSON.stringify(replay)).toBe(JSON.stringify(live));
    expect(live).toEqual({
      role: "user",
      content: [
        { type: "text", text: "Screenshot from web_fetch (call c9):" },
        { type: "image_url", image_url: { url: `data:image/png;base64,${PNG.toString("base64")}` } },
      ],
    });
    const older = await screenshotMessage(turns, () => false);
    expect(older.content).toEqual([
      { type: "text", text: "Screenshot from web_fetch (call c9):" },
      { type: "text", text: "[earlier screenshot, not resent]" },
    ]);
  });
});

describe("modelSupportsImages", () => {
  it("never assumes a configured provider's model can see images", async () => {
    const prev = process.env.MOCK_INFERENCE;
    delete process.env.MOCK_INFERENCE;
    try {
      expect(await modelSupportsImages("someprovider::gpt-whatever")).toBe(false);
    } finally {
      if (prev !== undefined) process.env.MOCK_INFERENCE = prev;
    }
  });
});
