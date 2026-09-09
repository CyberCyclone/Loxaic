import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import WebSocket from "ws";
import { __resetExecutorsForTest, callExecutor, getExecutor } from "../../executor/registry.ts";
import { EXECUTOR_PROTOCOL_VERSION, type ServerToExecutor } from "../../executor/protocol.ts";

/**
 * `/ws/executor` end to end over a real socket: this test plays the executor.
 * Only the session lookup is stubbed — "good" is a valid token for user-1,
 * anything else is not — which is the same seam every other WS handler's
 * tests would use, and the one thing a unit test cannot otherwise reach.
 */
const userId = "user-1";
vi.mock("../../auth/middleware", () => ({
  resolveSessionFromToken: (token: string) => Promise.resolve(token === "good" ? { user: { id: userId } } : null),
  authenticate: () => Promise.resolve(userId),
}));

const { executorWsHandler } = await import("../executor.ts");
const { executorRoutes } = await import("../../routes/executors.ts");

let app: FastifyInstance;
let port: number;
const sockets: WebSocket[] = [];

beforeAll(async () => {
  app = Fastify();
  await app.register(websocket);
  executorWsHandler(app);
  executorRoutes(app);
  await app.listen({ port: 0, host: "127.0.0.1" });
  port = (app.server.address() as AddressInfo).port;
});

afterAll(async () => {
  await app.close();
});

afterEach(async () => {
  for (const s of sockets.splice(0)) s.close();
  await new Promise((r) => setTimeout(r, 20));
  __resetExecutorsForTest();
});

function hello(overrides: Record<string, unknown> = {}) {
  return {
    type: "hello",
    version: EXECUTOR_PROTOCOL_VERSION,
    executorId: "laptop-1",
    name: "Laptop",
    platform: "darwin",
    capabilities: { direct: true, container: false },
    roots: ["/Users/casey/code"],
    ...overrides,
  };
}

function open(token: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${String(port)}/ws/executor?token=${token}`);
  sockets.push(ws);
  return new Promise((resolve, reject) => {
    ws.once("open", () => { resolve(ws); });
    ws.once("error", reject);
  });
}

function closeCode(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => { ws.once("close", (code) => { resolve(code); }); });
}

function nextMessage(ws: WebSocket): Promise<ServerToExecutor> {
  return new Promise((resolve) => {
    ws.once("message", (data) => { resolve(JSON.parse((data as Buffer).toString()) as ServerToExecutor); });
  });
}

/** Connects, says hello, and waits for the welcome. */
async function connectedExecutor(overrides: Record<string, unknown> = {}): Promise<WebSocket> {
  const ws = await open("good");
  const welcome = nextMessage(ws);
  ws.send(JSON.stringify(hello(overrides)));
  expect(await welcome).toEqual({ type: "welcome" });
  return ws;
}

describe("/ws/executor", () => {
  it("rejects a missing or invalid token before reading anything", async () => {
    const missing = new WebSocket(`ws://127.0.0.1:${String(port)}/ws/executor`);
    sockets.push(missing);
    expect(await closeCode(missing)).toBe(4001);
    const bad = await open("bad");
    expect(await closeCode(bad)).toBe(4001);
  });

  it("registers on a valid hello and lists the machine for its user", async () => {
    await connectedExecutor();
    expect(getExecutor("laptop-1")?.userId).toBe(userId);
    const res = await app.inject({ method: "GET", url: "/v1/executors" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject([{ id: "laptop-1", name: "Laptop", roots: ["/Users/casey/code"] }]);
  });

  it("closes the socket when the first frame is not a valid hello", async () => {
    const ws = await open("good");
    ws.send(JSON.stringify({ type: "result", id: "x", ok: true, value: 1 }));
    expect(await closeCode(ws)).toBe(4002);
    expect(getExecutor("laptop-1")).toBeNull();

    const badId = await open("good");
    badId.send(JSON.stringify(hello({ executorId: "has:colon" })));
    expect(await closeCode(badId)).toBe(4002);

    const badRoots = await open("good");
    badRoots.send(JSON.stringify(hello({ roots: "not-a-list" })));
    expect(await closeCode(badRoots)).toBe(4002);
  });

  it("strips control characters from the name and caps its length", async () => {
    await connectedExecutor({ name: `  Lap\x00top${"x".repeat(200)}  ` });
    const name = getExecutor("laptop-1")?.name ?? "";
    expect(name.startsWith("Laptop")).toBe(true);
    expect(name.length).toBeLessThanOrEqual(64);
  });

  it("routes a server call to the executor and its result back", async () => {
    const ws = await connectedExecutor();
    ws.on("message", (data) => {
      const msg = JSON.parse((data as Buffer).toString()) as ServerToExecutor;
      if (msg.type === "call") {
        ws.send(JSON.stringify({ type: "result", id: msg.id, ok: true, value: { method: msg.method, params: msg.params } }));
      }
    });
    const answer = await callExecutor("laptop-1", "readFile", { ref: "/x", path: "a" });
    expect(answer).toEqual({ method: "readFile", params: { ref: "/x", path: "a" } });
  });

  it("takes a roots update after the hello", async () => {
    const ws = await connectedExecutor();
    ws.send(JSON.stringify({ type: "roots", roots: ["/a", "/b"] }));
    await new Promise((r) => setTimeout(r, 30));
    expect(getExecutor("laptop-1")?.roots).toEqual(["/a", "/b"]);
  });

  it("unregisters when the socket closes, and fails the call that was in flight", async () => {
    const ws = await connectedExecutor();
    const pending = callExecutor("laptop-1", "exec", { ref: "/x", command: ["sleep", "9"] }, { timeoutMs: 30_000 });
    ws.close();
    await expect(pending).rejects.toThrow(/disconnected/);
    await new Promise((r) => setTimeout(r, 30));
    expect(getExecutor("laptop-1")).toBeNull();
    const res = await app.inject({ method: "GET", url: "/v1/executors" });
    expect(res.json()).toEqual([]);
  });
});
