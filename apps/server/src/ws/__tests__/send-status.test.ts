import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import { v4 as uuid } from "uuid";
import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import WebSocket from "ws";
import { db, eq, inArray } from "@loxaic/db";
import { conversationShares, conversations, messages, usageRecords, user } from "@loxaic/db/schema";
import type { ServerMessage } from "@loxaic/types";

/**
 * A new conversation's id reaches the client only in `turn.started`, on the
 * socket that sent the message. Replace that socket before the answer lands and
 * the answer is lost: the run still finishes, but the client never learns which
 * conversation it is in, shows no reply, and later subscribed with its own
 * optimistic id — `invalid input syntax for type uuid: "c1790483463291"` on the
 * screen. `send.status` lets the replacement socket ask what became of the send.
 *
 * Over real sockets, closing the first one straight after the send, which is
 * the failure itself rather than a picture of it. Only the session lookup is
 * faked, the same seam the other socket tests use.
 */
process.env.MOCK_INFERENCE = "true";

const userId = `test-send-status-${uuid()}`;
const otherId = `test-send-status-other-${uuid()}`;
const sessions: Record<string, string> = { mine: userId, theirs: otherId };

vi.mock("../../auth/middleware", () => ({
  resolveSessionFromToken: (token: string) =>
    Promise.resolve(sessions[token] ? { user: { id: sessions[token] } } : null),
}));

const { chatWsHandler } = await import("../chat.ts");
const { agentWsHandler } = await import("../agent.ts");
const { initStreamBroker } = await import("../../streams/index.ts");

const MODEL = "llama-3.1-8b-instruct";

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
  await db.insert(user).values([
    { id: userId, name: "Send status", email: `${userId}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
    { id: otherId, name: "Someone else", email: `${otherId}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
  ]);
});

afterAll(async () => {
  await app.close();
  // Scoped to this file's own rows, once its runs are done writing them: a run
  // outlives the socket that started it, which is the point of the file.
  const owners = [userId, otherId];
  const mine = await db.select({ id: conversations.id }).from(conversations).where(inArray(conversations.ownerId, owners));
  const ids = mine.map((c) => c.id);
  for (let i = 0; i < 100 && ids.length > 0; i++) {
    const rows = await db.select({ status: messages.status }).from(messages).where(inArray(messages.conversationId, ids));
    if (!rows.some((r) => r.status === "streaming")) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  await db.delete(usageRecords).where(inArray(usageRecords.userId, owners));
  if (mine.length > 0) {
    await db.delete(conversationShares).where(inArray(conversationShares.conversationId, ids));
    await db.delete(messages).where(inArray(messages.conversationId, mine.map((c) => c.id)));
    await db.delete(conversations).where(inArray(conversations.ownerId, [userId, otherId]));
  }
  await db.delete(user).where(eq(user.id, userId));
  await db.delete(user).where(eq(user.id, otherId));
});

interface Client {
  ws: WebSocket;
  received: ServerMessage[];
  waitFor: <T extends ServerMessage>(pred: (m: ServerMessage) => m is T, timeoutMs?: number) => Promise<T>;
}

async function connect(surface: "chat" | "agent", token = "mine"): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${String(port)}/ws/${surface}?token=${token}`);
  const received: ServerMessage[] = [];
  const listeners = new Set<() => void>();
  ws.on("message", (raw: Buffer) => {
    received.push(JSON.parse(raw.toString()) as ServerMessage);
    for (const l of listeners) l();
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => { resolve(); });
    ws.once("error", reject);
  });
  const waitFor = <T extends ServerMessage>(pred: (m: ServerMessage) => m is T, timeoutMs = 10_000) =>
    new Promise<T>((resolve, reject) => {
      const check = () => {
        const hit = received.find(pred);
        if (!hit) return;
        listeners.delete(check);
        clearTimeout(timer);
        resolve(hit);
      };
      const timer = setTimeout(() => {
        listeners.delete(check);
        reject(new Error(`timed out; received ${JSON.stringify(received.map((m) => m.type))}`));
      }, timeoutMs);
      listeners.add(check);
      check();
    });
  return { ws, received, waitFor };
}

const isTurnStarted = (m: ServerMessage): m is Extract<ServerMessage, { type: "turn.started" }> => m.type === "turn.started";

/** Sends and closes at once, so the answer has nowhere to go. */
async function sendAndDrop(surface: "chat" | "agent", ref: string, content: string): Promise<void> {
  const first = await connect(surface);
  first.ws.send(JSON.stringify({ type: `${surface}.send`, content, model: MODEL, client_ref: ref }));
  first.ws.close();
  await new Promise<void>((resolve) => first.ws.once("close", () => { resolve(); }));
  expect(first.received.some((m) => m.type === "turn.started")).toBe(false);
}

describe("send.status", () => {
  it("gives a replacement socket the lost turn.started, and the run with it", async () => {
    const ref = `lm${String(Date.now())}`;
    await sendAndDrop("chat", ref, "hello after a dropped socket");

    const second = await connect("chat");
    second.ws.send(JSON.stringify({ type: "send.status", client_ref: ref }));
    const started = await second.waitFor(isTurnStarted);
    expect(started.client_ref).toBe(ref);

    // A real conversation, holding the message that was sent.
    const conv = await db.query.conversations.findFirst({ where: eq(conversations.id, started.conversation_id) });
    expect(conv?.ownerId).toBe(userId);

    // And the replacement is subscribed to the run, so the reply reaches it.
    // A run that finished before the ask arrives as a complete snapshot; one
    // still going ends live. Either is the reply reaching the new socket.
    const reply = await second.waitFor(
      (m): m is Extract<ServerMessage, { type: "stream.sync" | "stream.end" }> =>
        (m.type === "stream.sync" && m.stream_id === started.stream_id && m.status === "complete") ||
        (m.type === "stream.end" && m.stream_id === started.stream_id),
      15_000,
    );
    expect(reply.stream_id).toBe(started.stream_id);
    second.ws.close();
  });

  it("works on the agent socket too", async () => {
    const ref = `lm${String(Date.now())}a`;
    await sendAndDrop("agent", ref, "hello agent after a dropped socket");
    const second = await connect("agent");
    second.ws.send(JSON.stringify({ type: "send.status", client_ref: ref }));
    const started = await second.waitFor(isTurnStarted);
    expect(started.client_ref).toBe(ref);
    second.ws.close();
  });

  it("says unknown for a send it never heard of", async () => {
    const client = await connect("chat");
    client.ws.send(JSON.stringify({ type: "send.status", client_ref: "never-sent" }));
    const unknown = await client.waitFor(
      (m): m is Extract<ServerMessage, { type: "send.unknown" }> => m.type === "send.unknown",
    );
    expect(unknown.client_ref).toBe("never-sent");
    client.ws.close();
  });

  it("never answers with someone else's send, even under the same ref", async () => {
    const ref = `shared-${uuid().slice(0, 8)}`;
    await sendAndDrop("chat", ref, "mine, not theirs");
    const stranger = await connect("chat", "theirs");
    stranger.ws.send(JSON.stringify({ type: "send.status", client_ref: ref }));
    await stranger.waitFor((m): m is Extract<ServerMessage, { type: "send.unknown" }> => m.type === "send.unknown");
    expect(stranger.received.some((m) => m.type === "turn.started")).toBe(false);
    stranger.ws.close();
  });

  it("replays a refusal as the error it was, with the ref", async () => {
    const ref = `lm${String(Date.now())}r`;
    const first = await connect("chat");
    // Not a uuid: refused as not found, never as a Postgres error.
    first.ws.send(JSON.stringify({ type: "chat.send", content: "into nowhere", model: MODEL, conversation_id: "c1790483463291", client_ref: ref }));
    const live = await first.waitFor((m): m is Extract<ServerMessage, { type: "error" }> => m.type === "error");
    expect(live.error).toBe("not found");
    first.ws.close();

    const second = await connect("chat");
    second.ws.send(JSON.stringify({ type: "send.status", client_ref: ref }));
    const replayed = await second.waitFor((m): m is Extract<ServerMessage, { type: "error" }> => m.type === "error");
    expect(replayed).toEqual({ type: "error", error: "not found", client_ref: ref });
    second.ws.close();
  });

  it("re-authorizes before replaying: a revoked editor gets not found, and no stream", async () => {
    const [conv] = await db.insert(conversations).values({ ownerId: userId, title: "shared then revoked", kind: "chat" }).returning();
    await db.insert(conversationShares).values({ conversationId: conv.id, userId: otherId, role: "editor", createdBy: userId });
    const ref = `lm${String(Date.now())}v`;
    const first = await connect("chat", "theirs");
    first.ws.send(JSON.stringify({ type: "chat.send", content: "as an editor", model: MODEL, conversation_id: conv.id, client_ref: ref }));
    await first.waitFor(isTurnStarted);
    first.ws.close();

    await db.delete(conversationShares).where(eq(conversationShares.conversationId, conv.id));
    const second = await connect("chat", "theirs");
    second.ws.send(JSON.stringify({ type: "send.status", client_ref: ref }));
    const refused = await second.waitFor((m): m is Extract<ServerMessage, { type: "error" }> => m.type === "error");
    expect(refused).toEqual({ type: "error", error: "not found", client_ref: ref });
    await new Promise((r) => setTimeout(r, 300));
    expect(second.received.some((m) => m.type === "turn.started" || m.type === "stream.sync" || m.type === "stream.event")).toBe(false);
    second.ws.close();
  });

  it("answers for the other surface's send type instead of hanging", async () => {
    const ref = `lm${String(Date.now())}x`;
    const client = await connect("chat");
    // Not handled on the chat socket, so never started — and never remembered.
    client.ws.send(JSON.stringify({ type: "agent.send", content: "wrong socket", model: MODEL, client_ref: ref }));
    client.ws.send(JSON.stringify({ type: "send.status", client_ref: ref }));
    const unknown = await client.waitFor(
      (m): m is Extract<ServerMessage, { type: "send.unknown" }> => m.type === "send.unknown",
      3_000,
    );
    expect(unknown.client_ref).toBe(ref);
    client.ws.close();
  });

  it("answers a subscribe to a non-uuid id as not found, not with Postgres' words", async () => {
    const client = await connect("chat");
    client.ws.send(JSON.stringify({ type: "stream.subscribe", conversation_id: "c1790483463291" }));
    const err = await client.waitFor((m): m is Extract<ServerMessage, { type: "error" }> => m.type === "error");
    expect(err.error).toBe("not found");
    client.ws.close();
  });
});
