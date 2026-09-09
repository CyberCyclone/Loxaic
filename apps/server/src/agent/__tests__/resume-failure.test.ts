/**
 * What the manager records when resuming a paused sandbox fails.
 *
 * Only a provider's own "gone" answer may become `destroyed`. Every other
 * failure — the engine unreachable, the user's machine offline, a timeout —
 * has to reach the caller as an error and leave the row exactly as it was:
 * a paused workspace the user can retry into costs nothing, a tombstoned one
 * costs them the session, and the boot sweep then deletes the container that
 * was still holding it. The providers are mocked because a real one cannot
 * be made to fail transiently on demand.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { v4 as uuid } from "uuid";
import { db, eq } from "@loxaic/db";
import { conversations, sandboxes, user } from "@loxaic/db/schema";
import { SandboxGoneError } from "../../sandbox/errors.ts";
import type { SandboxHandle, SandboxProvider } from "../../sandbox/provider.ts";

const behaviour = { start: (): Promise<void> => Promise.resolve() };

vi.mock("../../sandbox/provider.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../sandbox/provider.ts")>();
  const handle = {
    provider: "host",
    ref: "resume-failure-ref",
    root: "/nowhere",
    workdir: "/nowhere",
    start: () => behaviour.start(),
    exists: () => Promise.resolve(true),
    isRunning: () => Promise.resolve(false),
    stop: () => Promise.resolve(),
    destroy: () => Promise.resolve(),
  } as unknown as SandboxHandle;
  const provider = {
    kind: "host",
    available: () => Promise.resolve({ ok: true }),
    create: () => Promise.reject(new Error("create must not be reached")),
    attach: () => Promise.resolve(handle),
  } as unknown as SandboxProvider;
  return {
    ...actual,
    getProviderByKind: () => Promise.resolve(provider),
    getSandboxProvider: () => Promise.resolve(provider),
  };
});

const { attachRunningSandbox, getConversationSandbox } = await import("../sandbox-manager.ts");

const userId = `test-resume-failure-${uuid()}`;

beforeAll(async () => {
  await db.insert(user).values({
    id: userId,
    name: "Resume",
    email: `${userId}@example.test`,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
});

afterAll(async () => {
  await db.delete(sandboxes).where(eq(sandboxes.ownerId, userId));
  await db.delete(conversations).where(eq(conversations.ownerId, userId));
  await db.delete(user).where(eq(user.id, userId));
});

beforeEach(() => {
  behaviour.start = () => Promise.resolve();
});

async function pausedRow() {
  const [conversation] = await db
    .insert(conversations)
    .values({ ownerId: userId, title: "Resume", kind: "agent" })
    .returning();
  const [row] = await db
    .insert(sandboxes)
    .values({
      ownerId: userId,
      conversationId: conversation.id,
      containerId: "resume-failure-ref",
      provider: "host",
      image: "host",
      status: "stopped",
      limits: { memory: 512, cpu: 1 },
    })
    .returning();
  return { ...row, conversationId: conversation.id };
}

const statusOf = async (id: string) =>
  (await db.query.sandboxes.findFirst({ where: eq(sandboxes.id, id) }))?.status;

describe("a transient failure to resume is not 'gone'", () => {
  it("reaching by row: the error propagates and the row stays paused", async () => {
    const row = await pausedRow();
    behaviour.start = () => Promise.reject(new Error("engine unreachable"));
    await expect(attachRunningSandbox(row)).rejects.toThrow("engine unreachable");
    expect(await statusOf(row.id)).toBe("stopped");
  });

  it("reaching by conversation: the tool call fails, and no second sandbox is made", async () => {
    const row = await pausedRow();
    behaviour.start = () => Promise.reject(new Error("engine unreachable"));
    await expect(getConversationSandbox(userId, row.conversationId)).rejects.toThrow("engine unreachable");
    expect(await statusOf(row.id)).toBe("stopped");
    const rows = await db.query.sandboxes.findMany({ where: eq(sandboxes.conversationId, row.conversationId) });
    expect(rows).toHaveLength(1);
  });

  it("the provider's own 'gone' is the one answer recorded as destroyed", async () => {
    const row = await pausedRow();
    behaviour.start = () => Promise.reject(new SandboxGoneError("no such sandbox"));
    await expect(attachRunningSandbox(row)).resolves.toBeNull();
    expect(await statusOf(row.id)).toBe("destroyed");
  });
});
