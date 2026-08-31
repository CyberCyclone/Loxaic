import { and, db, eq } from "@shannon/db";
import { sandboxes } from "@shannon/db/schema";
import { getProviderByKind, getSandboxProvider } from "../sandbox/provider.ts";
import type { SandboxHandle, SandboxKind, SandboxProvider } from "../sandbox/provider.ts";
import { listSandboxContainers } from "../sandbox/container-provider.ts";
import { seedSandbox } from "../sandbox/seed.ts";

/** How long a conversation's sandbox may sit unused before it's reaped. */
const IDLE_TTL_MS = 30 * 60 * 1000;
/** How often the reaper looks for idle sandboxes. */
const REAP_INTERVAL_MS = 5 * 60 * 1000;

let seedWarned = false;

/** Seeding fires for every sandbox any user creates, purely because the env
 * var is set — so it gets the same one-time visibility SANDBOX_MODE=host
 * does, rather than silently reshaping every workspace if the variable ever
 * leaks into a non-test configuration. */
function warnSeedingOnce(dir: string): void {
  if (seedWarned) return;
  seedWarned = true;
  console.warn(
    `[sandbox] E2E_SANDBOX_SEED_DIR is set: every new sandbox is being pre-populated from ${dir}. ` +
      "This is a test-harness hook and should not be set in a real deployment.",
  );
}


/**
 * sandbox ref → attachment refs whose overflow file has already been written
 * into it (see writeOverflowToSandbox in streams/runs/engine.ts).
 *
 * Lives here, with the rest of a sandbox's lifecycle state, rather than beside
 * its only caller: putting it in engine.ts meant engine importing this module
 * *and* this module importing engine, and that cycle is a real hazard under
 * ESM, not just untidy.
 *
 * Keyed by the sandbox's own ref rather than the conversation id, so a
 * conversation whose sandbox is reaped and recreated writes into the new one
 * instead of assuming the old one's contents carried over.
 */
const overflowWrites = new Map<string, Set<string>>();

export function hasOverflowWrite(sandboxRef: string, attachmentRef: string): boolean {
  return overflowWrites.get(sandboxRef)?.has(attachmentRef) ?? false;
}

export function markOverflowWritten(sandboxRef: string, attachmentRef: string): void {
  const seen = overflowWrites.get(sandboxRef);
  if (seen) seen.add(attachmentRef);
  else overflowWrites.set(sandboxRef, new Set([attachmentRef]));
}

/** Drops a stopped sandbox's memo, so a later sandbox for the same
 * conversation re-writes rather than trusting a previous one's state. */
function forgetOverflowWrites(sandboxRef: string): void {
  overflowWrites.delete(sandboxRef);
}

/** rowId is null for ephemeral (incognito) sandboxes — no Postgres row. */
interface Entry { rowId: string | null; provider: SandboxKind; ref: string; lastUsedAt: number }

/** conversationId → live sandbox. */
const active = new Map<string, Entry>();
/** conversationId → in-flight creation, so concurrent tool calls share one. */
const pending = new Map<string, Promise<Entry>>();

/**
 * Returns the conversation's sandbox handle, creating it on first use.
 * Sandboxes deliberately outlive the WebSocket: a client that reconnects
 * mid-task keeps its working directory.
 *
 * `ephemeral` (incognito conversations) skips the sandboxes bookkeeping row —
 * nothing conversation-scoped touches Postgres. The sandbox then survives
 * only as long as this process knows about it: the idle reaper stops it as
 * usual, and a crashed process's leftovers are caught by the boot-time
 * orphan sweep instead of DB recovery.
 */
export async function getConversationSandbox(
  userId: string,
  conversationId: string,
  opts?: { ephemeral?: boolean },
): Promise<SandboxHandle> {
  const provider = await getSandboxProvider();
  if (!provider) throw new Error("sandboxes are disabled (SANDBOX_MODE=off)");

  const entry = await resolveEntry(provider, userId, conversationId, opts?.ephemeral === true);
  entry.lastUsedAt = Date.now();
  const entryProvider = entry.provider === provider.kind ? provider : await getProviderByKind(entry.provider);
  return entryProvider.attach(entry.ref);
}

/** True when this process already has a live sandbox for this conversation.
 * Never creates one — callers that must not spin up a container just because
 * they might want to write to it (e.g. attachment overflow handling) check
 * this first. */
export function hasActiveSandbox(conversationId: string): boolean {
  return active.has(conversationId);
}

/**
 * Reattaches to a conversation's sandbox iff one is already active in this
 * process — see {@link hasActiveSandbox}. Returns null rather than creating
 * anything when there isn't one. A stopped/idle-reaped sandbox counts as "not
 * active" even though its Postgres row and directory may still exist,
 * because reviving it here would be an implicit side effect of something
 * that looks like a read.
 */
export async function attachActiveSandbox(conversationId: string): Promise<SandboxHandle | null> {
  const entry = active.get(conversationId);
  if (!entry) return null;
  const provider = await getProviderByKind(entry.provider);
  return provider.attach(entry.ref);
}

async function resolveEntry(
  currentProvider: SandboxProvider,
  userId: string,
  conversationId: string,
  ephemeral: boolean,
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
    forgetOverflowWrites(cached.ref);
    if (cached.rowId) await markStopped(cached.rowId);
  }

  const inFlight = pending.get(conversationId);
  if (inFlight) return inFlight;

  const creation = createEntry(currentProvider, userId, conversationId, ephemeral).finally(() => {
    pending.delete(conversationId);
  });
  pending.set(conversationId, creation);
  return creation;
}

async function createEntry(
  provider: SandboxProvider,
  userId: string,
  conversationId: string,
  ephemeral: boolean,
): Promise<Entry> {
  if (!ephemeral) {
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
  }

  const handle = await provider.create(userId, {});
  // Test-only hook for the real-model e2e suite: seeds a fixture repo (an
  // INSTRUCTIONS.md + a small app) into every freshly-created sandbox, so
  // the agent has something to read and build against. Named E2E_-prefixed
  // and read at call time like every other sandbox env var, so it's inert
  // unless a harness explicitly sets it — see apps/e2e's real-model suite.
  if (process.env.E2E_SANDBOX_SEED_DIR) {
    warnSeedingOnce(process.env.E2E_SANDBOX_SEED_DIR);
    try {
      await seedSandbox(handle, process.env.E2E_SANDBOX_SEED_DIR);
    } catch (err) {
      // The handle exists but nothing tracks it yet — no row, not in
      // `active` — and a container runs `tail -f /dev/null`, so it would
      // never exit on its own. Left alone, a seed dir that fails repeatedly
      // piles up orphans only the next boot sweep can reclaim.
      await handle.stop().catch(() => undefined);
      throw err;
    }
  }
  let rowId: string | null = null;
  if (!ephemeral) {
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
    rowId = row.id;
  }

  const entry: Entry = { rowId, provider: provider.kind, ref: handle.ref, lastUsedAt: Date.now() };
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
    forgetOverflowWrites(entry.ref);
    if (entry.rowId) await markStopped(entry.rowId);
    reaped++;
  }
  return reaped;
}

/**
 * Stops every sandbox this server knows about, in memory and in the DB.
 *
 * Called when the sandbox settings change: neither the container engine nor a
 * container's network mode can be altered under a running container, so the
 * old ones have to go for the new setting to mean anything. Without this they
 * would linger for the full idle TTL still running under the old config.
 *
 * It also clears rows a *previous* mode left behind. `createEntry()`'s
 * recovery query filters on the current provider kind, so a row from another
 * kind is skipped but never marked stopped — those would otherwise read as
 * "running" forever.
 */
export async function stopAllSandboxes(kind?: SandboxKind): Promise<number> {
  let stopped = 0;

  // A creation already in flight captured the old settings, is not in
  // `active` yet, and inserts its row after the query below — so without
  // this it would survive the sweep and keep running under the engine or
  // network mode the change was meant to retire.
  if (pending.size > 0) await Promise.allSettled([...pending.values()]);

  for (const [conversationId, entry] of [...active.entries()]) {
    if (kind && entry.provider !== kind) continue;
    active.delete(conversationId);
    const provider = await getProviderByKind(entry.provider);
    const handle = await provider.attach(entry.ref).catch(() => null);
    await handle?.stop().catch(() => undefined);
    if (entry.rowId) await markStopped(entry.rowId);
    stopped++;
  }

  // Runs after the loop above has already marked its own rows stopped, so
  // nothing is counted or stopped twice.
  const rows = await db.query.sandboxes
    .findMany({ where: eq(sandboxes.status, "running") })
    .catch(() => []);
  for (const row of rows) {
    const rowKind = row.provider as SandboxKind;
    if (kind && rowKind !== kind) continue;
    const provider = await getProviderByKind(rowKind);
    // attach() throws when no engine is reachable — which is exactly the
    // case when someone is switching *away* from a dead engine. Marking the
    // row stopped is still correct and is the point of the sweep.
    const handle = await provider.attach(row.containerId).catch(() => null);
    await handle?.stop().catch(() => undefined);
    await markStopped(row.id);
    stopped++;
  }

  return stopped;
}

/**
 * Boot-time counterpart of the DB recovery path, for sandboxes with no row:
 * an ephemeral (incognito) sandbox left behind by a crashed process is
 * unreachable — no DB row, no in-memory entry — so stop any labeled sandbox
 * container this process doesn't know about and the DB doesn't claim.
 * Mirrors the stream log's boot-time orphan recovery.
 *
 * Container provider only: host-mode sandboxes are plain directories with no
 * process to stop, and the identifying label only exists on containers.
 */
export async function sweepOrphanSandboxes(): Promise<number> {
  const ids = await listSandboxContainers();
  if (ids.length === 0) return 0;

  const known = new Set<string>();
  for (const entry of active.values()) known.add(entry.ref);
  const rows = await db.query.sandboxes
    .findMany({ where: eq(sandboxes.status, "running"), columns: { containerId: true } })
    .catch(() => []);
  for (const row of rows) known.add(row.containerId);

  const provider = await getProviderByKind("container");
  let swept = 0;
  for (const id of ids) {
    if (known.has(id)) continue;
    const handle = await provider.attach(id);
    await handle.stop().catch(() => undefined);
    swept++;
  }
  return swept;
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
