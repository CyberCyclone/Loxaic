import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { v4 as uuid } from "uuid";
import { db, eq } from "@loxaic/db";
import { conversations, messages, user } from "@loxaic/db/schema";
import type { ContentBlock } from "@loxaic/types";
import { toolResultMessageForPrompt } from "../engine.ts";
import { jsonbSafe } from "../jsonb-safe.ts";

describe("jsonbSafe", () => {
  it("replaces NUL and lone surrogates, and leaves a real pair alone", () => {
    expect(jsonbSafe("a\u0000b")).toBe("a�b");
    expect(jsonbSafe("cut \ud83d")).toBe("cut �");
    expect(jsonbSafe("\ude00 cut")).toBe("� cut");
    expect(jsonbSafe("ok 😀")).toBe("ok 😀");
  });

  it("walks arrays, objects and keys, and leaves other values as they are", () => {
    expect(jsonbSafe({ "k\u0000": ["a\u0000", { n: 1, b: true, z: null }] })).toEqual({
      "k�": ["a�", { n: 1, b: true, z: null }],
    });
  });

  it("is what the prompt sends too, or the replay of a stored result would differ from the request", () => {
    expect(toolResultMessageForPrompt("c", "t", "a\u0000b").content).toBe("a\ufffdb");
  });

  it("is idempotent, so the prompt and the row can each apply it and still match", () => {
    const once = jsonbSafe("x\u0000\ud83d");
    expect(jsonbSafe(once)).toBe(once);
  });
});

describe("a row Postgres would refuse", () => {
  const userId = `test-jsonb-safe-${uuid()}`;
  let convId: string;

  beforeAll(async () => {
    await db.insert(user).values({
      id: userId,
      name: "Test Jsonb Safe",
      email: `${userId}@example.test`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const [conv] = await db.insert(conversations).values({ ownerId: userId, title: "jsonb", kind: "agent" }).returning();
    convId = conv.id;
  });

  afterAll(async () => {
    await db.delete(messages).where(eq(messages.conversationId, convId));
    await db.delete(conversations).where(eq(conversations.id, convId));
    await db.delete(user).where(eq(user.id, userId));
  });

  const row = (content: ContentBlock[]) => ({
    id: uuid(),
    conversationId: convId,
    authorType: "tool" as const,
    origin: "server" as const,
    lamport: Date.now(),
    content,
    status: "complete" as const,
    createdAt: new Date(),
  });
  const block = (output: string): ContentBlock[] => [{ kind: "tool_result", call_id: "c", output, ok: true }];

  it.each([["NUL", "bytes\u0000here"], ["a lone surrogate", "cut \ud83d"]])("stores %s once it has been through", async (_name, output) => {
    // The real refusal, so this file stops proving anything if it ever stops being one.
    await expect(db.insert(messages).values(row(block(output)))).rejects.toThrow();

    const safe = row(jsonbSafe(block(output)));
    await db.insert(messages).values(safe);
    const [stored] = await db.select().from(messages).where(eq(messages.id, safe.id));
    expect((stored.content as ContentBlock[])[0]).toMatchObject({ output: jsonbSafe(output) });
  });
});
