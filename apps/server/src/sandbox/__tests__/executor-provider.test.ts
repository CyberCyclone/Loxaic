import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { v4 as uuid } from "uuid";
import Fastify from "fastify";
import { db, eq } from "@loxaic/db";
import { conversations, sandboxes, user } from "@loxaic/db/schema";
import {
  __resetExecutorsForTest,
  handleExecutorResult,
  registerExecutor,
  type ExecutorConnection,
} from "../../executor/registry.ts";
import { createExecutorService } from "../../executor/service.ts";
import type { ServerToExecutor } from "../../executor/protocol.ts";
import { decodeExecutorRef, encodeExecutorRef } from "../executor-provider.ts";

/**
 * A `local` workspace end to end inside one process: the registry holds a
 * connection whose far end is a real `createExecutorService` over a real
 * temp directory, so `getConversationSandbox` → executor provider →
 * registry → service → filesystem is exercised with only the socket
 * elided. Also the two things that must be impossible: the server's own
 * SANDBOX_MODE choosing this provider, and a per-request field minting one.
 */
const ownerId = `test-executor-owner-${uuid()}`;
const strangerId = `test-executor-stranger-${uuid()}`;
let root: string;
let unregister: (() => void) | null = null;

/** An "executor" wired straight to a service, answering on the next tick. */
function inProcessExecutor(executorId: string, userId: string, roots: () => string[]): ExecutorConnection {
  const service = createExecutorService({ roots, executorId });
  return {
    executorId,
    userId,
    name: "Casey's laptop",
    platform: process.platform,
    capabilities: { direct: true, container: false },
    roots: roots(),
    send(message: ServerToExecutor) {
      if (message.type !== "call") return;
      void service
        .handle(message.method, message.params)
        .then((value) => { handleExecutorResult(executorId, { type: "result", id: message.id, ok: true, value }); })
        .catch((err: unknown) => {
          handleExecutorResult(executorId, { type: "result", id: message.id, ok: false, error: (err as Error).message });
        });
    },
    close: () => undefined,
  };
}

vi.mock("../../auth/middleware", () => ({
  authenticate: () => Promise.resolve(ownerId),
}));

const { getConversationSandbox, stopAllSandboxes } = await import("../../agent/sandbox-manager.ts");
const { sandboxRoutes } = await import("../../routes/sandbox.ts");

beforeAll(async () => {
  await db.insert(user).values([
    { id: ownerId, name: "Owner", email: `${ownerId}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
    { id: strangerId, name: "Stranger", email: `${strangerId}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
  ]);
});

afterAll(async () => {
  await db.delete(user).where(eq(user.id, ownerId));
  await db.delete(user).where(eq(user.id, strangerId));
});

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "loxaic-executor-provider-")));
});

afterEach(async () => {
  unregister?.();
  unregister = null;
  __resetExecutorsForTest();
  await stopAllSandboxes("executor");
  await db.delete(sandboxes).where(eq(sandboxes.ownerId, ownerId));
  await db.delete(conversations).where(eq(conversations.ownerId, ownerId));
  rmSync(root, { recursive: true, force: true });
});

async function localConversation(executorId: string, dir: string): Promise<string> {
  const [row] = await db
    .insert(conversations)
    .values({
      ownerId,
      title: "local",
      kind: "agent",
      workspace: { kind: "local", executorId, executorName: "Casey's laptop", path: dir, isolation: "direct" },
    })
    .returning();
  return row.id;
}

describe("a local workspace runs on the executor", () => {
  it("creates the sandbox on the user's machine and reads and writes through it", async () => {
    unregister = registerExecutor(inProcessExecutor("laptop", ownerId, () => [root]));
    const convId = await localConversation("laptop", root);

    const handle = await getConversationSandbox(ownerId, convId);
    expect(handle.provider).toBe("executor");
    expect(handle.workdir).toBe(root);
    await handle.writeFile(path.join(root, "notes.txt"), "from the agent\n");
    expect(readFileSync(path.join(root, "notes.txt"), "utf8")).toBe("from the agent\n");
    expect(await handle.readFile(path.join(root, "notes.txt"))).toBe("from the agent\n");
    const result = await handle.exec(["pwd"]);
    expect(result.stdout.trim()).toBe(root);

    const rows = await db.query.sandboxes.findMany({ where: eq(sandboxes.conversationId, convId) });
    expect(rows).toHaveLength(1);
    expect(rows[0].provider).toBe("executor");
    expect(decodeExecutorRef(rows[0].containerId)).toEqual({ executorId: "laptop", ref: root });
  });

  it("reuses the row on the next call, and survives the row being marked stopped", async () => {
    unregister = registerExecutor(inProcessExecutor("laptop", ownerId, () => [root]));
    const convId = await localConversation("laptop", root);
    await getConversationSandbox(ownerId, convId);
    await stopAllSandboxes("executor");
    const again = await getConversationSandbox(ownerId, convId);
    expect(again.workdir).toBe(root);
    const rows = await db.query.sandboxes.findMany({ where: eq(sandboxes.conversationId, convId) });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("running");
  });

  it("fails the tool call with the offline message when the machine is not connected, and keeps the row", async () => {
    unregister = registerExecutor(inProcessExecutor("laptop", ownerId, () => [root]));
    const convId = await localConversation("laptop", root);
    await getConversationSandbox(ownerId, convId);
    unregister?.();
    unregister = null;

    await expect(getConversationSandbox(ownerId, convId)).rejects.toThrow(/Your machine Casey's laptop is offline — open the Loxaic desktop app/);
    const rows = await db.query.sandboxes.findMany({ where: eq(sandboxes.conversationId, convId) });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).not.toBe("destroyed");

    // Back online: the same row, the same directory.
    unregister = registerExecutor(inProcessExecutor("laptop", ownerId, () => [root]));
    const handle = await getConversationSandbox(ownerId, convId);
    expect(handle.workdir).toBe(root);
  });

  it("refuses a directory the machine has not approved, in the executor's own words", async () => {
    unregister = registerExecutor(inProcessExecutor("laptop", ownerId, () => [path.join(root, "allowed")]));
    mkdirSync(path.join(root, "allowed"));
    const convId = await localConversation("laptop", root);
    await expect(getConversationSandbox(ownerId, convId)).rejects.toThrow(/not inside a folder you have chosen/);
  });

  it("refuses a machine registered by someone else, even if named in the workspace", async () => {
    unregister = registerExecutor(inProcessExecutor("their-laptop", strangerId, () => [root]));
    const convId = await localConversation("their-laptop", root);
    await expect(getConversationSandbox(ownerId, convId)).rejects.toThrow(/registered to a different user/);
  });

  it("ignores the server's SANDBOX_MODE entirely", async () => {
    process.env.SANDBOX_MODE = "off";
    try {
      unregister = registerExecutor(inProcessExecutor("laptop", ownerId, () => [root]));
      const convId = await localConversation("laptop", root);
      const handle = await getConversationSandbox(ownerId, convId);
      expect(handle.provider).toBe("executor");
    } finally {
      Reflect.deleteProperty(process.env, "SANDBOX_MODE");
    }
  });
});

describe("cancellation on the executor path", () => {
  it("sends nothing at all for a signal that is already aborted", async () => {
    // After a Stop every remaining call in a batch arrives so; the other two
    // providers do not start the command, and neither should a call to the
    // user's machine — a cancel racing the call it names was the old shape.
    const calls: string[] = [];
    const inner = inProcessExecutor("laptop-preaborted", ownerId, () => [root]);
    unregister = registerExecutor({
      ...inner,
      send(message) {
        if (message.type === "call") calls.push(message.method);
        inner.send(message);
      },
    });
    const convId = await localConversation("laptop-preaborted", root);
    const handle = await getConversationSandbox(ownerId, convId);
    const before = calls.length;
    const controller = new AbortController();
    controller.abort();
    const result = await handle.exec(["bash", "-lc", `echo ran > ${path.join(root, "ran.txt")}`], { signal: controller.signal });
    expect(result.exitCode).toBe(130);
    expect(calls.length).toBe(before);
    expect(existsSync(path.join(root, "ran.txt"))).toBe(false);
  });
});

describe("nothing else can pick the executor provider", () => {
  it("POST /v1/sandboxes derives its kind from the mode, whatever the body says", async () => {
    const hostRoot = mkdtempSync(path.join(os.tmpdir(), "loxaic-executor-host-"));
    process.env.SANDBOX_MODE = "host";
    process.env.SANDBOX_HOST_ROOT = hostRoot;
    const app = Fastify();
    sandboxRoutes(app);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/v1/sandboxes",
        payload: { provider: "executor", local: { executorId: "laptop", path: root, isolation: "direct" } },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ provider: string }>().provider).toBe("host");
    } finally {
      await app.close();
      Reflect.deleteProperty(process.env, "SANDBOX_MODE");
      Reflect.deleteProperty(process.env, "SANDBOX_HOST_ROOT");
      rmSync(hostRoot, { recursive: true, force: true });
    }
  });

  it("round-trips the persisted ref, splitting on the first colon only", () => {
    expect(decodeExecutorRef(encodeExecutorRef("id-1", "/Users/casey/code"))).toEqual({ executorId: "id-1", ref: "/Users/casey/code" });
    expect(decodeExecutorRef(encodeExecutorRef("id-1", "C:\\Users\\casey"))).toEqual({ executorId: "id-1", ref: "C:\\Users\\casey" });
    expect(() => decodeExecutorRef("no-colon")).toThrow(/malformed/);
  });
});
