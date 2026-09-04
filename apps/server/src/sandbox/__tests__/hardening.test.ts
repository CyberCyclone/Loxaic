import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { v4 as uuid } from "uuid";
import Fastify from "fastify";
import { db, eq, inArray } from "@shannon/db";
import { sandboxes, user } from "@shannon/db/schema";
import { getConversationSandbox, SandboxLimitError } from "../../agent/sandbox-manager.ts";
import type { SandboxHandle } from "../provider.ts";
import { sandboxImageReady } from "./docker-available.ts";

/**
 * Real-Docker proof of the container's isolation posture, and of the per-user
 * cap that sits in front of it.
 *
 * Asserted from *inside* a running sandbox rather than by reading back the
 * HostConfig we just sent: the question is what the container can actually do,
 * and inspecting our own create call would only prove we passed the flags we
 * passed. A capability check that runs in the container answers the real
 * question — and would still fail if a future Docker/Podman version quietly
 * ignored one of them.
 *
 * Every container this file starts is stopped in teardown. The sandbox runs
 * `tail -f /dev/null`, so AutoRemove never fires on its own; a test that
 * deleted the row without stopping the container leaked a 512MB/1CPU container
 * per run that only a later boot's label sweep could find.
 */
const currentUser = { id: "" };
vi.mock("../../auth/middleware", () => ({
  authenticate: () => Promise.resolve(currentUser.id),
}));
const { sandboxRoutes } = await import("../../routes/sandbox.ts");

const userId = `test-hardening-${uuid()}`;
const conversationId = randomUUID();
let handle: SandboxHandle | undefined;

const dockerReady = await sandboxImageReady();

async function insertUser(id: string, name: string): Promise<void> {
  await db.insert(user).values({
    id,
    name,
    email: `${id}@example.test`,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

/** inject()'s json() is `any`; read it through a shape so the assertion is
 * real rather than a no-op the lint config rejects. */
function errorOf(res: { json: () => unknown }): string {
  return (res.json() as { error: string }).error;
}

/** Runs `fn` with the per-user cap set to `limit`, restoring the env after. */
async function withLimit<T>(limit: number, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.SANDBOX_MAX_PER_USER;
  process.env.SANDBOX_MAX_PER_USER = String(limit);
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.SANDBOX_MAX_PER_USER;
    else process.env.SANDBOX_MAX_PER_USER = prev;
  }
}

beforeAll(async () => {
  if (!dockerReady) return;
  await insertUser(userId, "Hardening Test");
  handle = await getConversationSandbox(userId, conversationId);
}, 90_000);

afterAll(async () => {
  if (!dockerReady) return;
  await handle?.stop().catch(() => undefined);
  await db.delete(sandboxes).where(eq(sandboxes.ownerId, userId));
  await db.delete(user).where(eq(user.id, userId));
}, 60_000);

describe.skipIf(!dockerReady)("container hardening", () => {
  function sandbox(): SandboxHandle {
    if (!handle) throw new Error("no sandbox handle — beforeAll did not run");
    return handle;
  }

  it("runs as a non-root user", async () => {
    const { stdout } = await sandbox().exec(["id", "-u"]);
    expect(stdout.trim()).not.toBe("0");
  }, 60_000);

  it("holds no capabilities at all", async () => {
    // CapEff is the effective capability set as a hex mask; with CapDrop:ALL
    // it must be exactly zero. Non-root alone does NOT give you this — a
    // container starts with a default set (CHOWN, SETUID, NET_RAW, …)
    // regardless of uid.
    const { stdout } = await sandbox().exec(["bash", "-c", "grep CapEff /proc/self/status"]);
    const mask = stdout.trim().split(/\s+/)[1];
    expect(Number.parseInt(mask, 16)).toBe(0);
  }, 60_000);

  it("cannot regain privileges through a setuid binary", async () => {
    // no-new-privileges is what makes the dropped capabilities durable rather
    // than merely a starting position.
    const { stdout } = await sandbox().exec(["bash", "-c", "grep NoNewPrivs /proc/self/status"]);
    expect(stdout.trim().split(/\s+/)[1]).toBe("1");
  }, 60_000);

  it("cannot write to the image's own system directories", async () => {
    // Already true from the non-root user, and asserted here so a future
    // change to the image's USER line fails loudly rather than silently
    // handing the agent write access to its own tooling.
    const { stdout } = await sandbox().exec([
      "bash",
      "-c",
      'for d in /usr/local/bin /usr/bin /etc; do touch "$d/probe" 2>/dev/null && echo "WRITABLE:$d"; done; echo done',
    ]);
    expect(stdout).not.toContain("WRITABLE:");
  }, 60_000);

  it("still runs the work it exists for", async () => {
    // The hardening is only correct if the sandbox remains useful: a bash
    // command, a file write in the workdir, and the Python the document
    // extractors depend on.
    const { stdout } = await sandbox().exec([
      "bash",
      "-c",
      'echo hello > /home/shannon/probe.txt && cat /home/shannon/probe.txt && python3 -c "print(2+2)"',
    ]);
    expect(stdout).toContain("hello");
    expect(stdout).toContain("4");
  }, 60_000);
});

describe.skipIf(!dockerReady)("per-user sandbox limit", () => {
  const limitUser = `test-sandbox-limit-${uuid()}`;
  const handles: SandboxHandle[] = [];
  const app = Fastify();

  beforeAll(async () => {
    await insertUser(limitUser, "Limit Test");
    sandboxRoutes(app);
    await app.ready();
  });

  afterAll(async () => {
    for (const h of handles) await h.stop().catch(() => undefined);
    await db.delete(sandboxes).where(eq(sandboxes.ownerId, limitUser));
    await db.delete(user).where(inArray(user.id, [limitUser]));
    await app.close();
  }, 60_000);

  it("refuses a user at the cap, with a message they can act on", async () => {
    // One *real* sandbox and a cap of one: the cap is now reconciled against
    // reality before it refuses, so a fake row would be cleared rather than
    // counted — the test has to hold a genuinely live sandbox to hit it.
    handles.push(await getConversationSandbox(limitUser, randomUUID()));
    await withLimit(1, async () => {
      await expect(getConversationSandbox(limitUser, randomUUID())).rejects.toBeInstanceOf(
        SandboxLimitError,
      );
      await expect(getConversationSandbox(limitUser, randomUUID())).rejects.toThrow(/per-user limit/);
    });
  }, 120_000);

  it("clears rows whose container is gone instead of counting them forever", async () => {
    // A daemon restart takes every AutoRemove container with it and leaves the
    // rows saying `running`. Before reconciliation these counted against the
    // cap indefinitely — "wait for an idle sandbox to be reaped", for a reap
    // that would never come. With one live sandbox and five dead rows, a cap
    // of two must let creation proceed.
    await db.insert(sandboxes).values(
      Array.from({ length: 5 }, () => ({
        ownerId: limitUser,
        conversationId: randomUUID(),
        containerId: `gone-${randomUUID()}`,
        provider: "container" as const,
        image: "shannon-sandbox",
        status: "running" as const,
        limits: { memory: 512, cpu: 1 },
      })),
    );
    await withLimit(2, async () => {
      handles.push(await getConversationSandbox(limitUser, randomUUID()));
    });
    const stale = await db
      .select({ status: sandboxes.status })
      .from(sandboxes)
      .where(eq(sandboxes.ownerId, limitUser));
    expect(stale.filter((r) => r.status === "running")).toHaveLength(2);
  }, 120_000);

  it("enforces the cap on POST /v1/sandboxes too, as a 429", async () => {
    // The second creation path. A cap honoured by only one of two is not a
    // cap, and rows made here are never in the in-process map, so they could
    // lock the same user out of agent sandboxes with no reaper to help.
    currentUser.id = limitUser;
    await withLimit(1, async () => {
      const res = await app.inject({ method: "POST", url: "/v1/sandboxes", payload: {} });
      expect(res.statusCode).toBe(429);
      expect(errorOf(res)).toContain("per-user limit");
    });
  }, 60_000);

  it("does not count another user's sandboxes against you", async () => {
    // The cap is per user; one heavy user must not lock everyone else out,
    // which would turn a capacity guard into a denial of service.
    const other = `test-sandbox-limit-other-${uuid()}`;
    await insertUser(other, "Other");
    let otherHandle: SandboxHandle | undefined;
    try {
      await withLimit(1, async () => {
        otherHandle = await getConversationSandbox(other, randomUUID());
      });
      expect(otherHandle).toBeTruthy();
    } finally {
      await otherHandle?.stop().catch(() => undefined);
      await db.delete(sandboxes).where(eq(sandboxes.ownerId, other));
      await db.delete(user).where(eq(user.id, other));
    }
  }, 120_000);
});
