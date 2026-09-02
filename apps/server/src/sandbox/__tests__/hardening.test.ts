import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { v4 as uuid } from "uuid";
import { db, eq, inArray } from "@shannon/db";
import { sandboxes, user } from "@shannon/db/schema";
import { getConversationSandbox, SandboxLimitError } from "../../agent/sandbox-manager.ts";
import { sandboxImageReady } from "./docker-available.ts";

/**
 * Real-Docker proof of the container's isolation posture.
 *
 * Asserted from *inside* a running sandbox rather than by reading back the
 * HostConfig we just sent: the question is what the container can actually do,
 * and inspecting our own create call would only prove we passed the flags we
 * passed. A capability check that runs in the container answers the real
 * question — and would still fail if a future Docker/Podman version quietly
 * ignored one of them.
 */
const userId = `test-hardening-${uuid()}`;
const conversationId = randomUUID();

const dockerReady = await sandboxImageReady();

beforeAll(async () => {
  if (!dockerReady) return;
  await db.insert(user).values({
    id: userId,
    name: "Hardening Test",
    email: `${userId}@example.test`,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}, 60_000);

afterAll(async () => {
  if (!dockerReady) return;
  await db.delete(sandboxes).where(eq(sandboxes.ownerId, userId));
  await db.delete(user).where(eq(user.id, userId));
}, 60_000);

describe.skipIf(!dockerReady)("container hardening", () => {
  it("runs as a non-root user", async () => {
    const handle = await getConversationSandbox(userId, conversationId);
    const { stdout } = await handle.exec(["id", "-u"]);
    expect(stdout.trim()).not.toBe("0");
  }, 60_000);

  it("holds no capabilities at all", async () => {
    // CapEff is the effective capability set as a hex mask; with CapDrop:ALL
    // it must be exactly zero. Non-root alone does NOT give you this — a
    // container starts with a default set (CHOWN, SETUID, NET_RAW, …)
    // regardless of uid.
    const handle = await getConversationSandbox(userId, conversationId);
    const { stdout } = await handle.exec(["bash", "-c", "grep CapEff /proc/self/status"]);
    const mask = stdout.trim().split(/\s+/)[1];
    expect(Number.parseInt(mask, 16)).toBe(0);
  }, 60_000);

  it("cannot regain privileges through a setuid binary", async () => {
    // no-new-privileges is what makes the dropped capabilities durable rather
    // than merely a starting position.
    const handle = await getConversationSandbox(userId, conversationId);
    const { stdout } = await handle.exec(["bash", "-c", "grep NoNewPrivs /proc/self/status"]);
    expect(stdout.trim().split(/\s+/)[1]).toBe("1");
  }, 60_000);

  it("cannot write to the image's own system directories", async () => {
    // Already true from the non-root user, and asserted here so a future
    // change to the image's USER line fails loudly rather than silently
    // handing the agent write access to its own tooling.
    const handle = await getConversationSandbox(userId, conversationId);
    const { stdout } = await handle.exec([
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
    const handle = await getConversationSandbox(userId, conversationId);
    const { stdout } = await handle.exec([
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

  beforeAll(async () => {
    await db.insert(user).values({
      id: limitUser,
      name: "Limit Test",
      email: `${limitUser}@example.test`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  afterAll(async () => {
    await db.delete(sandboxes).where(eq(sandboxes.ownerId, limitUser));
    await db.delete(user).where(inArray(user.id, [limitUser]));
  });

  it("refuses a user past the cap, with a message they can act on", async () => {
    // Rows rather than real containers: the limit is counted from the
    // bookkeeping table, and standing up five containers to prove an
    // arithmetic check would cost minutes for no extra confidence.
    await db.insert(sandboxes).values(
      Array.from({ length: 5 }, () => ({
        ownerId: limitUser,
        conversationId: randomUUID(),
        containerId: `fake-${randomUUID()}`,
        provider: "container" as const,
        image: "shannon-sandbox",
        status: "running" as const,
        limits: { memory: 512, cpu: 1 },
      })),
    );

    await expect(getConversationSandbox(limitUser, randomUUID())).rejects.toBeInstanceOf(
      SandboxLimitError,
    );
    await expect(getConversationSandbox(limitUser, randomUUID())).rejects.toThrow(/per-user limit/);
  }, 60_000);

  it("does not count another user's sandboxes against you", async () => {
    // The cap is per user; one heavy user must not lock everyone else out,
    // which would turn a capacity guard into a denial of service.
    const other = `test-sandbox-limit-other-${uuid()}`;
    await db.insert(user).values({
      id: other,
      name: "Other",
      email: `${other}@example.test`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    try {
      const handle = await getConversationSandbox(other, randomUUID());
      expect(handle).toBeTruthy();
      await handle.stop().catch(() => undefined);
    } finally {
      await db.delete(sandboxes).where(eq(sandboxes.ownerId, other));
      await db.delete(user).where(eq(user.id, other));
    }
  }, 60_000);
});
