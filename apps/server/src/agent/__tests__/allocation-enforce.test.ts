import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { v4 as uuid } from "uuid";
import Fastify from "fastify";
import { db, eq } from "@loxaic/db";
import { conversations, messages, sandboxes, usageRecords, user } from "@loxaic/db/schema";
import type { ContentBlock } from "@loxaic/types";
import {
  getConversationSandbox,
  reserveSandbox,
  SandboxLimitError,
  stopIdleSandboxes,
} from "../sandbox-manager.ts";
import { clearAllocationOverride, setAllocationOverride } from "../allocation.ts";
import { resetServerSettingsCache } from "../../settings.ts";
import { claimConversation, getRunByConversation, unregisterRun } from "../../streams/registry.ts";

/**
 * The allocation (#254) as the sandbox manager, the routes and the run engine
 * apply it. Against the host provider, so it needs no container engine: host
 * sandboxes count towards the number running (their memory and CPU are not
 * enforced, so not counted), which is enough to fill an allocation of one.
 * Memory and CPU are exercised through reservations, which count whatever
 * they are given. Pausing a real container is container-pause.test.ts.
 *
 * Each case sets its own user's override rather than an env pin, so nothing
 * here leaks into another file sharing the process.
 */
process.env.MOCK_INFERENCE = "true";

const currentUser = { id: "" };
vi.mock("../../auth/middleware", () => ({
  authenticate: () => Promise.resolve(currentUser.id),
  requireAdmin: () => Promise.resolve(currentUser.id),
}));
const { sandboxRoutes } = await import("../../routes/sandbox.ts");
const { adminUserRoutes } = await import("../../routes/admin-users.ts");
const { installApiErrorHandler } = await import("../../routes/errors.ts");

const userId = `test-allocation-enforce-${uuid()}`;
let root: string;
const app = Fastify();

beforeAll(async () => {
  await db.insert(user).values({
    id: userId,
    name: "Allocation Enforce",
    email: `${userId}@example.test`,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  installApiErrorHandler(app);
  sandboxRoutes(app);
  adminUserRoutes(app);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  const convs = await db.select({ id: conversations.id }).from(conversations).where(eq(conversations.ownerId, userId));
  for (const { id } of convs) {
    await db.delete(messages).where(eq(messages.conversationId, id));
    await db.delete(usageRecords).where(eq(usageRecords.conversationId, id));
  }
  await db.delete(conversations).where(eq(conversations.ownerId, userId));
  await db.delete(user).where(eq(user.id, userId));
});

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "loxaic-allocation-"));
  process.env.SANDBOX_HOST_ROOT = root;
  process.env.SANDBOX_MODE = "host";
  process.env.SANDBOX_IDLE_STOP_MS = String(4 * 60 * 60 * 1000);
  Reflect.deleteProperty(process.env, "SANDBOX_MAX_PER_USER");
  resetServerSettingsCache();
  currentUser.id = userId;
});

afterEach(async () => {
  for (const key of ["SANDBOX_HOST_ROOT", "SANDBOX_MODE", "SANDBOX_IDLE_STOP_MS"]) {
    Reflect.deleteProperty(process.env, key);
  }
  resetServerSettingsCache();
  rmSync(root, { recursive: true, force: true });
  await clearAllocationOverride(userId);
  await db.delete(sandboxes).where(eq(sandboxes.ownerId, userId));
});

async function newConversation(): Promise<string> {
  const [row] = await db
    .insert(conversations)
    .values({ ownerId: userId, title: "Allocation", kind: "agent" })
    .returning();
  return row.id;
}

async function rowFor(conversationId: string) {
  return db.query.sandboxes.findFirst({ where: eq(sandboxes.conversationId, conversationId) });
}

async function refusal(promise: Promise<unknown>): Promise<SandboxLimitError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(SandboxLimitError);
  return err as SandboxLimitError;
}

describe("starting and waking sandboxes", () => {
  it("refuses a second running sandbox on an allocation of one, and makes no row for it", async () => {
    await setAllocationOverride(userId, { maxRunning: 1 });
    await getConversationSandbox(userId, await newConversation());
    const second = await newConversation();
    const err = await refusal(getConversationSandbox(userId, second));
    expect(err.reason).toBe("count");
    expect(err.used.running).toBe(1);
    expect(await rowFor(second)).toBeUndefined();
  });

  it("refuses to wake a paused sandbox when the allocation is full, and leaves it paused", async () => {
    await setAllocationOverride(userId, { maxRunning: 1 });
    const first = await newConversation();
    await getConversationSandbox(userId, first);
    await stopIdleSandboxes(Date.now() + 5 * 60 * 60 * 1000, "host");
    expect((await rowFor(first))?.status).toBe("stopped");
    await getConversationSandbox(userId, await newConversation());

    expect((await refusal(getConversationSandbox(userId, first))).reason).toBe("count");
    expect((await rowFor(first))?.status).toBe("stopped");
  });

  it("follows the default again once the override is cleared", async () => {
    await setAllocationOverride(userId, { maxRunning: 1 });
    await getConversationSandbox(userId, await newConversation());
    await refusal(getConversationSandbox(userId, await newConversation()));
    await clearAllocationOverride(userId);
    await expect(getConversationSandbox(userId, await newConversation())).resolves.toBeDefined();
  });
});

describe("reservations", () => {
  it("hold memory, so two starts at once cannot share the last of it", async () => {
    // Default allocation: 2560 MB. Neither start has a row yet.
    const first = await reserveSandbox(userId, { memoryMb: 2048, cpus: 1 });
    expect((await refusal(reserveSandbox(userId, { memoryMb: 1024, cpus: 1 }))).reason).toBe("memory");
    first();
    const second = await reserveSandbox(userId, { memoryMb: 1024, cpus: 1 });
    second();
  });

  it("hold CPUs too", async () => {
    await setAllocationOverride(userId, { cpus: 2 });
    const first = await reserveSandbox(userId, { memoryMb: 256, cpus: 1.5 });
    expect((await refusal(reserveSandbox(userId, { memoryMb: 256, cpus: 1 }))).reason).toBe("cpus");
    first();
  });

  it("release once, however often the release is called", async () => {
    await setAllocationOverride(userId, { maxRunning: 2 });
    const a = await reserveSandbox(userId, { memoryMb: 256, cpus: 1 });
    const b = await reserveSandbox(userId, { memoryMb: 256, cpus: 1 });
    a();
    a();
    // b still holds its place: one more fits, not two.
    const c = await reserveSandbox(userId, { memoryMb: 256, cpus: 1 });
    expect((await refusal(reserveSandbox(userId, { memoryMb: 256, cpus: 1 }))).reason).toBe("count");
    b();
    c();
  });

  it("call a sandbox larger than the whole allocation too big, with nothing running", async () => {
    const err = await refusal(reserveSandbox(userId, { memoryMb: 16_384, cpus: 8 }));
    expect(err.reason).toBe("too_big");
    expect(err.message).toContain("Ask an admin to raise your allocation");
  });

  it("leave out the running sandbox a new one replaces", async () => {
    await setAllocationOverride(userId, { maxRunning: 1 });
    const conv = await newConversation();
    await getConversationSandbox(userId, conv);
    const row = await rowFor(conv);
    if (!row) throw new Error("no row");
    await refusal(reserveSandbox(userId, { memoryMb: 512, cpus: 1 }));
    const release = await reserveSandbox(userId, { memoryMb: 512, cpus: 1 }, row.id);
    release();
  });
});

describe("routes", () => {
  it("lists the caller's allocation, usage and sandboxes, busy while a run holds the chat", async () => {
    await setAllocationOverride(userId, { memoryMb: 4096 });
    const conv = await newConversation();
    await getConversationSandbox(userId, conv);

    const idle = await app.inject({ method: "GET", url: "/v1/sandboxes/allocation" });
    expect(idle.statusCode).toBe(200);
    const body = idle.json<{
      allocation: { memoryMb: number; maxRunning: number };
      overridden: { memoryMb: boolean; cpus: boolean };
      default: { memoryMb: number };
      used: { running: number };
      sandboxes: { conversation_id: string; title: string; status: string; provider: string; busy: boolean }[];
    }>();
    expect(body.allocation.memoryMb).toBe(4096);
    expect(body.overridden.memoryMb).toBe(true);
    expect(body.overridden.cpus).toBe(false);
    expect(body.default.memoryMb).toBe(2560);
    expect(body.used.running).toBe(1);
    expect(body.sandboxes).toEqual([
      expect.objectContaining({ conversation_id: conv, title: "Allocation", status: "running", provider: "host", busy: false }),
    ]);

    const claim = { streamId: `test-${randomUUID()}`, conversationId: conv, userId, abort: new AbortController(), approvals: new Map() };
    claimConversation(claim);
    try {
      const busy = await app.inject({ method: "GET", url: "/v1/sandboxes/allocation" });
      expect(busy.json<{ sandboxes: { busy: boolean }[] }>().sandboxes[0].busy).toBe(true);
    } finally {
      unregisterRun(claim.streamId);
    }
  });

  it("never lists another person's sandboxes", async () => {
    await getConversationSandbox(userId, await newConversation());
    currentUser.id = `someone-else-${uuid()}`;
    const res = await app.inject({ method: "GET", url: "/v1/sandboxes/allocation" });
    expect(res.json<{ sandboxes: unknown[] }>().sandboxes).toEqual([]);
  });

  it("will not pause a host sandbox, nor anyone else's", async () => {
    const conv = await newConversation();
    await getConversationSandbox(userId, conv);
    const row = await rowFor(conv);
    if (!row) throw new Error("no row");
    const host = await app.inject({ method: "POST", url: `/v1/sandboxes/${row.id}/pause` });
    expect(host.statusCode).toBe(400);
    currentUser.id = `someone-else-${uuid()}`;
    const theirs = await app.inject({ method: "POST", url: `/v1/sandboxes/${row.id}/pause` });
    expect(theirs.statusCode).toBe(404);
  });

  it("refuses to pause a sandbox a run is using", async () => {
    // A container row, so the refusal is the run and not the provider; the
    // run holds the chat, so nothing reaches the engine.
    const conv = await newConversation();
    const [row] = await db
      .insert(sandboxes)
      .values({ ownerId: userId, conversationId: conv, containerId: `none-${randomUUID()}`, provider: "container", image: "x", status: "running" })
      .returning();
    const claim = { streamId: `test-${randomUUID()}`, conversationId: conv, userId, abort: new AbortController(), approvals: new Map() };
    claimConversation(claim);
    try {
      const res = await app.inject({ method: "POST", url: `/v1/sandboxes/${row.id}/pause` });
      expect(res.statusCode).toBe(409);
      expect((await rowFor(conv))?.status).toBe("running");
    } finally {
      unregisterRun(claim.streamId);
    }
  });

  it("answers a refused wake with a 429 and the numbers, not a 500", async () => {
    await setAllocationOverride(userId, { maxRunning: 1 });
    const first = await newConversation();
    await getConversationSandbox(userId, first);
    await stopIdleSandboxes(Date.now() + 5 * 60 * 60 * 1000, "host");
    await getConversationSandbox(userId, await newConversation());
    const row = await rowFor(first);
    if (!row) throw new Error("no row");

    const res = await app.inject({ method: "POST", url: `/v1/sandboxes/${row.id}/exec`, payload: { command: "true" } });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({
      code: "sandbox_allocation",
      reason: "count",
      used: { running: 1 },
      allocation: { maxRunning: 1 },
    });
  });

  it("answers POST /v1/sandboxes over the allocation with a 429", async () => {
    await setAllocationOverride(userId, { maxRunning: 1 });
    await getConversationSandbox(userId, await newConversation());
    const res = await app.inject({ method: "POST", url: "/v1/sandboxes", payload: {} });
    expect(res.statusCode).toBe(429);
    expect(res.json<{ code: string }>().code).toBe("sandbox_allocation");
  });
});

describe("admin routes", () => {
  it("set, show and clear one user's override", async () => {
    const put = await app.inject({
      method: "PUT",
      url: `/v1/admin/users/${userId}/sandbox-allocation`,
      payload: { memoryMb: 16_384, cpus: 8 },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({
      allocation: { memoryMb: 16_384, cpus: 8, maxRunning: 5 },
      overridden: { memoryMb: true, cpus: true, maxRunning: false },
      used: { running: 0 },
    });

    const list = await app.inject({ method: "GET", url: `/v1/admin/users?q=${encodeURIComponent(userId)}` });
    const listed = list.json<{ users: { id: string; sandbox: unknown }[] }>().users.find((u) => u.id === userId);
    expect(listed?.sandbox).toMatchObject({ allocation: { memoryMb: 16_384 }, overridden: { memoryMb: true } });

    const del = await app.inject({ method: "DELETE", url: `/v1/admin/users/${userId}/sandbox-allocation` });
    expect(del.json()).toMatchObject({ overridden: { memoryMb: false, cpus: false, maxRunning: false } });
  });

  it("counts a user's running sandboxes in the list", async () => {
    await getConversationSandbox(userId, await newConversation());
    const list = await app.inject({ method: "GET", url: `/v1/admin/users?q=${encodeURIComponent(userId)}` });
    const listed = list.json<{ users: { id: string; sandbox: { used: { running: number } } }[] }>().users.find((u) => u.id === userId);
    expect(listed?.sandbox.used.running).toBe(1);
  });

  it("refuses a bad value with a 400 and an unknown user with a 404", async () => {
    const bad = await app.inject({ method: "PUT", url: `/v1/admin/users/${userId}/sandbox-allocation`, payload: { memoryMb: 1 } });
    expect(bad.statusCode).toBe(400);
    const missing = await app.inject({ method: "PUT", url: `/v1/admin/users/nobody-${uuid()}/sandbox-allocation`, payload: { memoryMb: 1024 } });
    expect(missing.statusCode).toBe(404);
  });
});

describe("a run whose sandbox is refused", () => {
  async function storedResults(convId: string) {
    const rows = await db.query.messages.findMany({ where: eq(messages.conversationId, convId) });
    return rows
      .flatMap((r) => r.content as ContentBlock[])
      .filter((b): b is Extract<ContentBlock, { kind: "tool_result" }> => b.kind === "tool_result");
  }

  async function waitFor(label: string, check: () => boolean, timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  it("stores the allocation notice with the failed result, so a reload can offer the Sandboxes screen", async () => {
    const { initStreamBroker } = await import("../../streams/index.ts");
    const { startAgentRun } = await import("../../streams/runs/agentRun.ts");
    await initStreamBroker();
    await setAllocationOverride(userId, { maxRunning: 1 });
    await getConversationSandbox(userId, await newConversation());

    const convId = await newConversation();
    await startAgentRun({ userId, content: "write a file called notes", model: "llama-3.1-8b-instruct", mode: "auto", conversationId: convId });
    let streamId = "";
    await waitFor("the run to register", () => {
      streamId = getRunByConversation(convId)?.streamId ?? "";
      return streamId !== "";
    });
    await waitFor("the run to end", () => getRunByConversation(convId) === undefined, 30_000);

    const [result] = await storedResults(convId);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("which is your allocation");
    expect(result.notice).toEqual({ kind: "sandbox_allocation", reason: "count" });

    // And live: a device following the run, or joining it mid-turn, gets it
    // from the stream as well as from a reload.
    const { getStreamBroker } = await import("../../streams/index.ts");
    const broker = getStreamBroker();
    const snapshot = broker.foldSnapshot(await broker.readFrom(streamId, 0));
    const call = snapshot.messages.flatMap((m) => m.tool_calls).find((c) => c.ok === false);
    expect(call?.notice).toEqual({ kind: "sandbox_allocation", reason: "count" });
  }, 30_000);
});
