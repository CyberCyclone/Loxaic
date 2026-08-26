import type Docker from "dockerode";
import { and, db, eq } from "@shannon/db";
import { sandboxes } from "@shannon/db/schema";
import {
  createSandbox,
  getContainer,
  isContainerRunning,
  stopSandbox,
} from "../sandbox/orchestrator";

/** How long a conversation's sandbox may sit unused before it's reaped. */
const IDLE_TTL_MS = 30 * 60 * 1000;
/** How often the reaper looks for idle sandboxes. */
const REAP_INTERVAL_MS = 5 * 60 * 1000;

interface Entry { rowId: string; containerId: string; lastUsedAt: number }

/** conversationId → live sandbox. */
const active = new Map<string, Entry>();
/** conversationId → in-flight creation, so concurrent tool calls share one. */
const pending = new Map<string, Promise<Entry>>();

/**
 * Returns the conversation's sandbox container, creating it on first use.
 * Sandboxes deliberately outlive the WebSocket: a client that reconnects
 * mid-task keeps its working directory.
 */
export async function getConversationSandbox(
  userId: string,
  conversationId: string,
): Promise<Docker.Container> {
  const entry = await resolveEntry(userId, conversationId);
  entry.lastUsedAt = Date.now();
  return getContainer(entry.containerId);
}

async function resolveEntry(userId: string, conversationId: string): Promise<Entry> {
  const cached = active.get(conversationId);
  if (cached && (await isContainerRunning(cached.containerId))) return cached;
  if (cached) {
    // Container vanished (crash, engine restart, manual docker rm).
    active.delete(conversationId);
    await markStopped(cached.rowId);
  }

  const inFlight = pending.get(conversationId);
  if (inFlight) return inFlight;

  const creation = createEntry(userId, conversationId).finally(() => {
    pending.delete(conversationId);
  });
  pending.set(conversationId, creation);
  return creation;
}

async function createEntry(userId: string, conversationId: string): Promise<Entry> {
  // A previous process may have left a usable sandbox recorded in the DB.
  const existing = await db.query.sandboxes.findFirst({
    where: and(
      eq(sandboxes.conversationId, conversationId),
      eq(sandboxes.ownerId, userId),
      eq(sandboxes.status, "running"),
    ),
  });
  if (existing) {
    if (await isContainerRunning(existing.containerId)) {
      const entry: Entry = { rowId: existing.id, containerId: existing.containerId, lastUsedAt: Date.now() };
      active.set(conversationId, entry);
      return entry;
    }
    await markStopped(existing.id);
  }

  const info = await createSandbox(userId, {});
  const [row] = await db
    .insert(sandboxes)
    .values({
      ownerId: userId,
      conversationId,
      containerId: info.containerId,
      image: "shannon-sandbox",
      status: "running",
      limits: { memory: 512, cpu: 1 },
    })
    .returning();

  const entry: Entry = { rowId: row.id, containerId: info.containerId, lastUsedAt: Date.now() };
  active.set(conversationId, entry);
  return entry;
}

async function markStopped(rowId: string): Promise<void> {
  await db
    .update(sandboxes)
    .set({ status: "stopped", stoppedAt: new Date() })
    .where(eq(sandboxes.id, rowId))
    .catch(() => undefined);
}

/** Stops and forgets every sandbox idle for longer than IDLE_TTL_MS. */
export async function reapIdleSandboxes(now = Date.now()): Promise<number> {
  let reaped = 0;
  for (const [conversationId, entry] of [...active.entries()]) {
    if (now - entry.lastUsedAt < IDLE_TTL_MS) continue;
    active.delete(conversationId);
    await stopSandbox(entry.containerId).catch(() => undefined);
    await markStopped(entry.rowId);
    reaped++;
  }
  return reaped;
}

export function startSandboxReaper(onReap?: (count: number) => void): NodeJS.Timeout {
  const timer = setInterval(() => {
    reapIdleSandboxes()
      .then((n) => { if (n > 0) onReap?.(n); })
      .catch(() => undefined);
  }, REAP_INTERVAL_MS);
  timer.unref();
  return timer;
}
