import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { v4 as uuid } from "uuid";
import { db, eq } from "@loxaic/db";
import { conversations, user } from "@loxaic/db/schema";
import type { ServerMessage } from "@loxaic/types";

/**
 * The thread list's liveness watch (#282): a socket asks which of the
 * conversations its list shows have a run going, and is told — live — when
 * one starts, changes state, or ends. The notices are the row's whole truth
 * (`run: null` means idle), and a socket must never hear about a conversation
 * it cannot see or stopped watching.
 *
 * The run registry drives the announcements through the process-wide activity
 * channel; this exercises the delivery half — the set, the authorization, and
 * what reaches the socket — with real rows, as the other delivery tests do.
 */
/** Flipped to stand in for a share revoked while the socket stays open. */
const access = vi.hoisted(() => ({ revoked: false }));
vi.mock("../../streams/authz.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../streams/authz.ts")>();
  return {
    ...actual,
    assertConversationAccess: () =>
      access.revoked ? Promise.reject(new actual.NotFoundError()) : Promise.resolve(),
  };
});

const { createDelivery } = await import("../delivery.ts");
const { registerRun, setRunApproval, unregisterRun, setRunQueuePosition } = await import("../../streams/registry.ts");

type RunNotice = Extract<ServerMessage, { type: "conversation.run" }>;
const runNotices = (sent: ServerMessage[], conversationId: string): RunNotice[] =>
  sent.filter((m): m is RunNotice => m.type === "conversation.run" && m.conversation_id === conversationId);

describe("conversations.watch", () => {
  const userId = `test-run-watch-${uuid()}`;
  const otherId = `test-run-watch-other-${uuid()}`;
  let mineId: string;
  let idleId: string;
  let foreignId: string;

  beforeAll(async () => {
    const now = new Date();
    await db.insert(user).values([
      { id: userId, name: "Watcher", email: `${userId}@example.test`, emailVerified: true, createdAt: now, updatedAt: now },
      { id: otherId, name: "Other", email: `${otherId}@example.test`, emailVerified: true, createdAt: now, updatedAt: now },
    ]);
    const rows = await db.insert(conversations).values([
      { ownerId: userId, title: "mine", kind: "chat" },
      { ownerId: userId, title: "idle", kind: "chat" },
      { ownerId: otherId, title: "foreign", kind: "chat" },
    ]).returning();
    [mineId, idleId, foreignId] = rows.map((r) => r.id);
  });

  afterAll(async () => {
    await db.delete(conversations).where(eq(conversations.ownerId, userId));
    await db.delete(conversations).where(eq(conversations.ownerId, otherId));
    await db.delete(user).where(eq(user.id, userId));
    await db.delete(user).where(eq(user.id, otherId));
  });

  function handleFor(conversationId: string) {
    return {
      streamId: uuid(),
      conversationId,
      userId,
      abort: new AbortController(),
      approvals: new Map<never, never>(),
    };
  }

  it("answers a watch with the busy rows only, and follows the run live", async () => {
    const handle = handleFor(mineId);
    registerRun(handle);
    try {
      const sent: ServerMessage[] = [];
      const delivery = createDelivery(userId, (m) => sent.push(m), () => 0);
      await delivery.handleConversationsWatch([mineId, idleId]);

      // The busy row is named; the idle row is not — absence already says it,
      // and fifty `run: null` messages per list refresh carries no news.
      await vi.waitFor(() => {
        expect(runNotices(sent, mineId).at(-1)).toMatchObject({ run: "running" });
      });
      expect(runNotices(sent, idleId)).toEqual([]);

      setRunApproval(handle, "call_0", () => undefined);
      await vi.waitFor(() => {
        expect(runNotices(sent, mineId).at(-1)).toMatchObject({ run: "awaiting_approval" });
      });

      unregisterRun(handle.streamId);
      await vi.waitFor(() => {
        expect(runNotices(sent, mineId).at(-1)).toMatchObject({ run: null });
      });
      delivery.close();
    } finally {
      unregisterRun(handle.streamId);
    }
  });

  it("carries the queue place, and each move in line", async () => {
    const sent: ServerMessage[] = [];
    const delivery = createDelivery(userId, (m) => sent.push(m), () => 0);
    await delivery.handleConversationsWatch([mineId]);
    const handle = handleFor(mineId);
    registerRun(handle);
    try {
      await vi.waitFor(() => {
        expect(runNotices(sent, mineId).at(-1)).toMatchObject({ run: "running" });
      });
      setRunQueuePosition(handle, 3);
      setRunQueuePosition(handle, 2);
      await vi.waitFor(() => {
        expect(runNotices(sent, mineId).at(-1)).toMatchObject({ run: "queued", queue_position: 2 });
      });
      // A re-announcement of the same place says nothing new.
      const before = runNotices(sent, mineId).length;
      setRunQueuePosition(handle, 2);
      await new Promise((r) => setTimeout(r, 50));
      expect(runNotices(sent, mineId)).toHaveLength(before);
      delivery.close();
    } finally {
      unregisterRun(handle.streamId);
    }
  });

  it("hears nothing for a conversation the caller cannot see", async () => {
    const handle = handleFor(foreignId);
    registerRun(handle);
    try {
      const sent: ServerMessage[] = [];
      const delivery = createDelivery(userId, (m) => sent.push(m), () => 0);
      // The foreign id is dropped from the watch by the batch authz, so no
      // notice — at watch time or later — exactly as `stream.stop` no-ops.
      await delivery.handleConversationsWatch([mineId, foreignId]);
      setRunApproval(handle, "call_0", () => undefined);
      await new Promise((r) => setTimeout(r, 100));
      expect(runNotices(sent, foreignId)).toEqual([]);
      delivery.close();
    } finally {
      unregisterRun(handle.streamId);
    }
  });

  it("hears nothing for ids that are not conversation ids", async () => {
    const sent: ServerMessage[] = [];
    const delivery = createDelivery(userId, (m) => sent.push(m), () => 0);
    // A client's optimistic placeholder must never reach a Postgres query.
    await expect(delivery.handleConversationsWatch(["c1790483463291", "pending-xyz", 42])).resolves.toBeUndefined();
    expect(sent).toEqual([]);
    delivery.close();
  });

  it("replaces the watched set: a row that left the list goes silent", async () => {
    const sent: ServerMessage[] = [];
    const delivery = createDelivery(userId, (m) => sent.push(m), () => 0);
    await delivery.handleConversationsWatch([mineId]);
    await delivery.handleConversationsWatch([idleId]);
    const handle = handleFor(mineId);
    registerRun(handle);
    try {
      await new Promise((r) => setTimeout(r, 50));
      expect(runNotices(sent, mineId)).toEqual([]);
      delivery.close();
    } finally {
      unregisterRun(handle.streamId);
    }
  });

  it("stops telling a socket whose access was revoked while it watched", async () => {
    const handle = handleFor(mineId);
    registerRun(handle);
    try {
      const sent: ServerMessage[] = [];
      const delivery = createDelivery(userId, (m) => sent.push(m), () => 0);
      await delivery.handleConversationsWatch([mineId]);
      await vi.waitFor(() => {
        expect(runNotices(sent, mineId).at(-1)).toMatchObject({ run: "running" });
      });
      access.revoked = true;
      try {
        const before = sent.length;
        setRunApproval(handle, "call_0", () => undefined);
        await new Promise((r) => setTimeout(r, 150));
        expect(sent.slice(before)).toEqual([]);
      } finally {
        access.revoked = false;
      }
      delivery.close();
    } finally {
      unregisterRun(handle.streamId);
    }
  });

  it("announces nothing for an idle row's plain watch, and re-tells a busy row", async () => {
    // The initial reply is a snapshot of liveness, not a firehose: watching
    // an all-idle list sends zero messages; a busy row is re-told on every
    // watch (replacement semantics, e.g. after a socket reopened).
    const sent: ServerMessage[] = [];
    const delivery = createDelivery(userId, (m) => sent.push(m), () => 0);
    await delivery.handleConversationsWatch([idleId]);
    await new Promise((r) => setTimeout(r, 50));
    expect(sent).toEqual([]);

    const handle = handleFor(idleId);
    registerRun(handle);
    await delivery.handleConversationsWatch([idleId]);
    await vi.waitFor(() => {
      expect(runNotices(sent, idleId).at(-1)).toMatchObject({ run: "running" });
    });
    unregisterRun(handle.streamId);
    delivery.close();
  });
});
