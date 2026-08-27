import { and, db, eq } from "@shannon/db";
import { sandboxes } from "@shannon/db/schema";
import { getProviderByKind, getSandboxProvider } from "../sandbox/provider.ts";
import type { SandboxHandle, SandboxKind, SandboxProvider } from "../sandbox/provider.ts";

/** How long a conversation's sandbox may sit unused before it's reaped. */
const IDLE_TTL_MS = 30 * 60 * 1000;
/** How often the reaper looks for idle sandboxes. */
const REAP_INTERVAL_MS = 5 * 60 * 1000;

interface Entry { rowId: string; provider: SandboxKind; ref: string; lastUsedAt: number }

/** conversationId → live sandbox. */
const active = new Map<string, Entry>();
/** conversationId → in-flight creation, so concurrent tool calls share one. */
const pending = new Map<string, Promise<Entry>>();

/**
 * Returns the conversation's sandbox handle, creating it on first use.
 * Sandboxes deliberately outlive the WebSocket: a client that reconnects
 * mid-task keeps its working directory.
 */
export async function getConversationSandbox(
  userId: string,
  conversationId: string,
): Promise<SandboxHandle> {
  const provider = await getSandboxProvider();
  if (!provider) throw new Error("sandboxes are disabled (SANDBOX_MODE=off)");

  const entry = await resolveEntry(provider, userId, conversationId);
  entry.lastUsedAt = Date.now();
  const entryProvider = entry.provider === provider.kind ? provider : await getProviderByKind(entry.provider);
  return entryProvider.attach(entry.ref);
}

async function resolveEntry(
  currentProvider: SandboxProvider,
  userId: string,
  conversationId: string,
): Promise<Entry> {
  const cached = active.get(conversationId);
  if (cached) {
    // Operate through the provider the cached entry actually belongs to,
    // not necessarily today's configured provider — a mode switch mid-run
    // must not make a perfectly live container/host-dir look vanished.
    const owner = cached.provider === currentProvider.kind ? currentProvider : await getProviderByKind(cached.provider);
    const handle = await owner.attach(cached.ref);
    if (await handle.isRunning()) return cached;
    // Either vanished (crash, engine restart, manual `docker rm`), or the
    // mode changed since it was created — either way it's no longer usable.
    active.delete(conversationId);
    await markStopped(cached.rowId);
  }

  const inFlight = pending.get(conversationId);
  if (inFlight) return inFlight;

  const creation = createEntry(currentProvider, userId, conversationId).finally(() => {
    pending.delete(conversationId);
  });
  pending.set(conversationId, creation);
  return creation;
}

async function createEntry(
  provider: SandboxProvider,
  userId: string,
  conversationId: string,
): Promise<Entry> {
  // A previous process may have left a usable sandbox recorded in the DB —
  // but only if it was created under the *same* provider kind as the one
  // active now; a row left over from a prior SANDBOX_MODE is dead weight.
  const existing = await db.query.sandboxes.findFirst({
    where: and(
      eq(sandboxes.conversationId, conversationId),
      eq(sandboxes.ownerId, userId),
      eq(sandboxes.status, "running"),
      eq(sandboxes.provider, provider.kind),
    ),
  });
  if (existing) {
    const handle = await provider.attach(existing.containerId);
    if (await handle.isRunning()) {
      const entry: Entry = { rowId: existing.id, provider: provider.kind, ref: existing.containerId, lastUsedAt: Date.now() };
      active.set(conversationId, entry);
      return entry;
    }
    await markStopped(existing.id);
  }

  const handle = await provider.create(userId, {});
  const [row] = await db
    .insert(sandboxes)
    .values({
      ownerId: userId,
      conversationId,
      containerId: handle.ref,
      provider: provider.kind,
      image: provider.kind === "container" ? (process.env.SANDBOX_IMAGE ?? "shannon-sandbox") : "host",
      status: "running",
      limits: { memory: 512, cpu: 1 },
    })
    .returning();

  const entry: Entry = { rowId: row.id, provider: provider.kind, ref: handle.ref, lastUsedAt: Date.now() };
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
    const provider = await getProviderByKind(entry.provider);
    const handle = await provider.attach(entry.ref);
    await handle.stop().catch(() => undefined);
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
