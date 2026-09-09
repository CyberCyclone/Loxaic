import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { v4 as uuid } from "uuid";
import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import WebSocket from "ws";
import { db, eq } from "@loxaic/db";
import { conversations, sandboxes, user } from "@loxaic/db/schema";

/**
 * `/ws/sandbox/:id` end to end over a real socket against a real host-mode
 * sandbox — only the session lookup is faked, the same seam ws/executor's
 * test uses.
 *
 * The case that matters most is the two-frame one. The protocol used to
 * append a newline to every `terminal.input`, which silently turned every
 * keystroke into a submitted line: with a real terminal that corrupts arrow
 * keys, Ctrl-C and anything typed a character at a time. Splitting one
 * command across two frames is the only way to state that from the outside.
 */
const ownerId = `test-terminal-owner-${uuid()}`;
const strangerId = `test-terminal-stranger-${uuid()}`;
const currentUser = { id: ownerId };

vi.mock("../../auth/middleware", () => ({
  resolveSessionFromToken: (token: string) =>
    Promise.resolve(token === "good" ? { user: { id: currentUser.id } } : null),
}));

const { sandboxTerminalWs } = await import("../sandbox.ts");
const { destroyConversationSandboxes, getConversationSandbox } = await import("../../agent/sandbox-manager.ts");

let app: FastifyInstance;
let port: number;
let root: string;
const sockets: WebSocket[] = [];
/** Conversations this file made, so its cleanup can name them. */
const conversationIds: string[] = [];

beforeAll(async () => {
  app = Fastify();
  await app.register(websocket);
  sandboxTerminalWs(app);
  await app.listen({ port: 0, host: "127.0.0.1" });
  port = (app.server.address() as AddressInfo).port;
  await db.insert(user).values([
    { id: ownerId, name: "Owner", email: `${ownerId}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
    { id: strangerId, name: "Stranger", email: `${strangerId}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
  ]);
});

afterAll(async () => {
  await app.close();
  await db.delete(user).where(eq(user.id, ownerId));
  await db.delete(user).where(eq(user.id, strangerId));
});

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "loxaic-terminal-ws-"));
  process.env.SANDBOX_HOST_ROOT = path.join(root, "sandboxes");
  process.env.SANDBOX_MODE = "host";
  currentUser.id = ownerId;
});

afterEach(async () => {
  for (const s of sockets.splice(0)) s.close();
  await new Promise((r) => setTimeout(r, 20));
  // Scoped to this file's own conversations. `stopAllSandboxes("host")` would
  // have done it in one line and is wrong here: it sweeps every running host
  // row in the shared database, so it stops the sandbox another suite is
  // asserting on (AGENTS.md — the same hazard the abandoned reaper has).
  for (const id of conversationIds.splice(0)) await destroyConversationSandboxes(id);
  Reflect.deleteProperty(process.env, "SANDBOX_HOST_ROOT");
  Reflect.deleteProperty(process.env, "SANDBOX_MODE");
  rmSync(root, { recursive: true, force: true });
  // Scoped to this file's own rows — an unscoped delete would take another
  // suite's sandboxes with it (AGENTS.md).
  await db.delete(sandboxes).where(eq(sandboxes.ownerId, ownerId));
  await db.delete(conversations).where(eq(conversations.ownerId, ownerId));
});

interface TerminalEvent {
  type: string;
  data?: string;
  tty?: boolean;
  workdir?: string;
  message?: string;
}

/**
 * A conversation with a live host sandbox, and that sandbox's row id.
 *
 * Two forms of the working directory, because they are genuinely different
 * answers: `terminal.ready` reports the handle's own path, while `pwd` inside
 * the shell reports the physical one — macOS puts temp directories under a
 * `/var` → `/private/var` symlink.
 */
async function sandboxFor(): Promise<{ sandboxId: string; workdir: string; physicalWorkdir: string }> {
  const [conversation] = await db
    .insert(conversations)
    .values({ ownerId, title: "terminal", kind: "agent" })
    .returning();
  conversationIds.push(conversation.id);
  const handle = await getConversationSandbox(ownerId, conversation.id);
  const row = await db.query.sandboxes.findFirst({
    where: eq(sandboxes.conversationId, conversation.id),
  });
  if (!row) throw new Error("no sandbox row");
  return { sandboxId: row.id, workdir: handle.workdir, physicalWorkdir: realpathSync(handle.workdir) };
}

function open(sandboxId: string, token = "good"): WebSocket {
  const ws = new WebSocket(`ws://127.0.0.1:${String(port)}/ws/sandbox/${sandboxId}?token=${token}`);
  sockets.push(ws);
  return ws;
}

/** Collects events until `predicate` is satisfied, then resolves with all of
 * them — output arrives in arbitrary chunks, so waiting on one frame is not a
 * thing that can be done reliably. */
function collect(
  ws: WebSocket,
  predicate: (events: TerminalEvent[]) => boolean,
  timeoutMs = 15_000,
): Promise<TerminalEvent[]> {
  const events: TerminalEvent[] = [];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timed out; saw ${JSON.stringify(events)}`));
    }, timeoutMs);
    const settle = () => {
      if (!predicate(events)) return;
      clearTimeout(timer);
      resolve(events);
    };
    ws.on("message", (raw) => {
      events.push(JSON.parse((raw as Buffer).toString()) as TerminalEvent);
      settle();
    });
    ws.on("close", () => { settle(); });
  });
}

const outputOf = (events: TerminalEvent[]) =>
  events.filter((e) => e.type === "terminal.output").map((e) => e.data ?? "").join("");

describe("/ws/sandbox/:id", () => {
  it("announces whether it got a TTY, and where it opened", async () => {
    const { sandboxId, workdir } = await sandboxFor();
    const ws = open(sandboxId);
    const [ready] = await collect(ws, (e) => e.some((x) => x.type === "terminal.ready"));
    expect(ready).toEqual({ type: "terminal.ready", tty: false, workdir });
  });

  it("passes input through raw, so one command may arrive in two frames", async () => {
    const { sandboxId } = await sandboxFor();
    const ws = open(sandboxId);
    await collect(ws, (e) => e.some((x) => x.type === "terminal.ready"));

    const done = collect(ws, (e) => outputOf(e).includes("term-ok"));
    // Appending a newline to each frame — what this used to do — would run
    // `echo term` and then `-ok` instead, and neither prints "term-ok".
    ws.send(JSON.stringify({ type: "terminal.input", data: "echo term" }));
    await new Promise((r) => setTimeout(r, 50));
    ws.send(JSON.stringify({ type: "terminal.input", data: "-ok\n" }));

    expect(outputOf(await done)).toContain("term-ok");
  });

  it("runs commands in the workspace's working directory", async () => {
    const { sandboxId, physicalWorkdir } = await sandboxFor();
    const ws = open(sandboxId);
    await collect(ws, (e) => e.some((x) => x.type === "terminal.ready"));
    const done = collect(ws, (e) => outputOf(e).includes(physicalWorkdir));
    ws.send(JSON.stringify({ type: "terminal.input", data: "pwd\n" }));
    expect(outputOf(await done)).toContain(physicalWorkdir);
  });

  it("accepts a resize it cannot act on, and ignores a nonsensical one", async () => {
    const { sandboxId } = await sandboxFor();
    const ws = open(sandboxId);
    await collect(ws, (e) => e.some((x) => x.type === "terminal.ready"));
    for (const size of [{ cols: 100, rows: 30 }, { cols: 0, rows: 0 }, { cols: 1e9, rows: 5 }, { cols: "80", rows: 24 }]) {
      ws.send(JSON.stringify({ type: "terminal.resize", ...size }));
    }
    // Still alive and still working afterwards, which is the whole assertion:
    // a pipe session has no window size, and none of these may end it.
    const done = collect(ws, (e) => outputOf(e).includes("alive"));
    ws.send(JSON.stringify({ type: "terminal.input", data: "echo alive\n" }));
    expect(outputOf(await done)).toContain("alive");
  });

  it("says the session ended rather than just dropping the socket", async () => {
    const { sandboxId } = await sandboxFor();
    const ws = open(sandboxId);
    await collect(ws, (e) => e.some((x) => x.type === "terminal.ready"));
    const done = collect(ws, (e) => e.some((x) => x.type === "terminal.exit"));
    ws.send(JSON.stringify({ type: "terminal.input", data: "exit\n" }));
    expect((await done).some((e) => e.type === "terminal.exit")).toBe(true);
  });

  it("caps how many terminals one user may hold open, and frees the slot on close", async () => {
    // Under SANDBOX_MODE=host each terminal is an unbounded bash on the
    // server itself; the executor caps its own shells at the same number.
    const { sandboxId } = await sandboxFor();
    const held: WebSocket[] = [];
    for (let i = 0; i < 8; i++) {
      const ws = open(sandboxId);
      await new Promise<void>((resolve) => { ws.once("message", () => { resolve(); }); });
      held.push(ws);
    }
    const ninth = open(sandboxId);
    expect(await closeCode(ninth)).toBe(4429);

    const first = held.shift();
    first?.close();
    await new Promise((r) => setTimeout(r, 50));
    const again = open(sandboxId);
    await new Promise<void>((resolve) => { again.once("message", () => { resolve(); }); });
    for (const ws of [...held, again]) ws.close();
  });

  it("is owner-only, and refuses a bad token or an unknown sandbox the same way", async () => {
    const { sandboxId } = await sandboxFor();

    const badToken = open(sandboxId, "nope");
    expect(await closeCode(badToken)).toBe(4001);

    const missing = open(uuid());
    expect(await closeCode(missing)).toBe(4004);

    currentUser.id = strangerId;
    try {
      const theirs = open(sandboxId);
      expect(await closeCode(theirs)).toBe(4004);
    } finally {
      currentUser.id = ownerId;
    }
  });
});

function closeCode(ws: WebSocket): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error("socket never closed")); }, 15_000);
    ws.once("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}
