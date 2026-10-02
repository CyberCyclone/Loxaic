import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import { v4 as uuid } from "uuid";
import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import WebSocket from "ws";
import { and, db, eq, inArray } from "@loxaic/db";
import { conversations, messages, usageRecords, user } from "@loxaic/db/schema";
import type { ContentBlock, ServerMessage } from "@loxaic/types";

/**
 * The thinking level from the composer's `+` menu, from the socket to the
 * request body. The selector used to be display-only: no field carried it, so
 * every request went out with none and the model's template chose — on
 * Qwen3.8, its highest effort. The mock answers "thinking level" prompts by
 * naming the fields it was sent, so this reads what the backend really got.
 */
process.env.MOCK_INFERENCE = "true";

const userId = `test-thinking-${uuid()}`;

vi.mock("../../auth/middleware", () => ({
  resolveSessionFromToken: (token: string) => Promise.resolve(token === "mine" ? { user: { id: userId } } : null),
}));

const { chatWsHandler } = await import("../chat.ts");
const { agentWsHandler } = await import("../agent.ts");
const { initStreamBroker } = await import("../../streams/index.ts");

/** Graded levels in the mock (like Qwen3.8); the other mock model is on/off. */
const GRADED = "llama-3.1-8b-instruct";
const TOGGLE = "qwen2.5-14b-instruct";

let app: FastifyInstance;
let port: number;

beforeAll(async () => {
  await initStreamBroker();
  app = Fastify();
  await app.register(websocket);
  chatWsHandler(app);
  agentWsHandler(app);
  await app.listen({ port: 0, host: "127.0.0.1" });
  port = (app.server.address() as AddressInfo).port;
  await db.insert(user).values({
    id: userId, name: "Thinking", email: `${userId}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date(),
  });
});

afterAll(async () => {
  await app.close();
  const mine = await db.select({ id: conversations.id }).from(conversations).where(eq(conversations.ownerId, userId));
  const ids = mine.map((c) => c.id);
  if (ids.length > 0) {
    await db.delete(messages).where(inArray(messages.conversationId, ids));
    await db.delete(conversations).where(inArray(conversations.id, ids));
  }
  await db.delete(usageRecords).where(eq(usageRecords.userId, userId));
  await db.delete(user).where(eq(user.id, userId));
});

/** Sends one message and returns the reply's text once the run is done. */
async function reply(surface: "chat" | "agent", send: Record<string, unknown>): Promise<string> {
  const ws = new WebSocket(`ws://127.0.0.1:${String(port)}/ws/${surface}?token=mine`);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => { resolve(); });
    ws.once("error", reject);
  });
  const started = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error("no turn.started")); }, 10_000);
    ws.on("message", (raw: Buffer) => {
      const msg = JSON.parse(raw.toString()) as ServerMessage;
      if (msg.type === "turn.started") {
        clearTimeout(timer);
        resolve(msg.conversation_id);
      }
      if (msg.type === "error") {
        clearTimeout(timer);
        reject(new Error(msg.error));
      }
    });
  });
  ws.send(JSON.stringify({ type: `${surface}.send`, content: "what thinking level is this", ...send }));
  const convId = await started;
  try {
    for (let i = 0; i < 200; i++) {
      const rows = await db
        .select({ content: messages.content, status: messages.status })
        .from(messages)
        .where(and(eq(messages.conversationId, convId), eq(messages.authorType, "assistant")));
      const done = rows.find((r) => r.status === "complete");
      if (done) {
        return (done.content as ContentBlock[]).map((b) => (b.kind === "text" ? b.text : "")).join("");
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("the reply never completed");
  } finally {
    ws.close();
  }
}

describe("thinking_level on a send", () => {
  it("reaches the request as llama.cpp's reasoning_effort, on Chat and on Agent", async () => {
    expect(await reply("chat", { model: GRADED, thinking_level: "High" })).toContain("Thinking level: reasoning_effort=high.");
    expect(await reply("agent", { model: GRADED, mode: "manual", thinking_level: "Low" })).toContain(
      "Thinking level: reasoning_effort=low.",
    );
  });

  it("turns thinking off with None", async () => {
    expect(await reply("chat", { model: GRADED, thinking_level: "None" })).toContain("Thinking level: reasoning_effort=none, enable_thinking=false.");
  });

  it("switches an on/off model on for any level but None", async () => {
    expect(await reply("chat", { model: TOGGLE, thinking_level: "Low" })).toContain("Thinking level: enable_thinking=true.");
  });

  it("uses the default for a send with no level, or one that is not a level", async () => {
    // An older client: Medium, never the template's own (highest) default.
    expect(await reply("chat", { model: GRADED })).toContain("Thinking level: reasoning_effort=medium.");
    // Not forwarded: it would become a request field on the backend.
    expect(await reply("chat", { model: GRADED, thinking_level: "xhigh" })).toContain("Thinking level: reasoning_effort=medium.");
  });
});
