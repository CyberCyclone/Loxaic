import { and, db, eq } from "@shannon/db";
import { conversations, sandboxes } from "@shannon/db/schema";
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

/**
 * How many sandboxes one user may hold at once.
 *
 * Env-backed with a default rather than a `server_settings` field: it is a
 * capacity guard rather than a security posture (the isolation itself is not
 * negotiable), and the sandbox settings row is deliberately about mode,
 * engine, and network. Read at call time, like every other sandbox env var.
 */
const DEFAULT_MAX_SANDBOXES_PER_USER = 5;

function maxSandboxesPerUser(): number {
  const raw = Number(process.env.SANDBOX_MAX_PER_USER);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_MAX_SANDBOXES_PER_USER;
}

export class SandboxLimitError extends Error {
  constructor(limit: number) {
    super(
      `You already have ${String(limit)} sandboxes running, which is the per-user limit. ` +
        `Close a conversation that is using one, or wait for an idle sandbox to be reaped.`,
    );
    this.name = "SandboxLimitError";
  }
}

/**
 * Sandboxes this process is *about to* create, per user, counted alongside the
 * rows. The check is check-then-create with no transaction, and `pending`
 * de-duplicates per conversation only — so a user at 4 who fires tool calls in
 * three conversations at once had all three pass the check before any row
 * existed and landed at 7. A reservation taken before `provider.create` and
 * released after the insert (or on failure) closes that within a process.
 */
const inFlight = new Map<string, number>();

export function releaseSandboxSlot(userId: string): void {
  const n = (inFlight.get(userId) ?? 0) - 1;
  if (n <= 0) inFlight.delete(userId);
  else inFlight.set(userId, n);
}

/**
 * Refuses when the user is at their cap; otherwise reserves a slot the caller
 * must release with `releaseSandboxSlot` once the row exists (or creation
 * fails). Exported because `POST /v1/sandboxes` is a second creation path and
 * a cap that only one of two paths honours is not a cap.
 *
 * Before refusing, the counted rows are reconciled against reality. A row can
 * say `running` when its container is long gone — a Docker daemon restart
 * takes every AutoRemove container with it, and nothing else marks those rows:
 * the boot sweep stops containers *no row claims* (the other direction), the
 * idle reaper walks the in-process map (empty after a restart), and
 * `createEntry` reconciles exactly one conversation's row. Counting them meant
 * "wait for an idle sandbox to be reaped" — a wait that would never end.
 */
export async function assertUnderUserLimit(userId: string): Promise<void> {
  const limit = maxSandboxesPerUser();
  const reserved = inFlight.get(userId) ?? 0;
  let rows = await runningRowsFor(userId);
  if (rows.length + reserved >= limit) {
    await markDeadRowsStopped(rows);
    rows = await runningRowsFor(userId);
  }
  if (rows.length + reserved >= limit) throw new SandboxLimitError(limit);
  inFlight.set(userId, reserved + 1);
}

async function runningRowsFor(userId: string) {
  return db
    .select({ id: sandboxes.id, containerId: sandboxes.containerId, provider: sandboxes.provider })
    .from(sandboxes)
    .where(and(eq(sandboxes.ownerId, userId), eq(sandboxes.status, "running")));
}

/**
 * Marks `running` rows whose sandbox no longer exists as stopped.
 *
 * Liveness is asked of the provider that owns each row, per row, rather than
 * diffed against a container listing: a listing that comes back empty cannot
 * say whether the engine is down or every container is gone, and those need
 * opposite handling. `attach().isRunning()` returning false is a definite
 * answer; a throw means the engine could not be reached, and the row is left
 * alone rather than marked stopped on no evidence.
 */
async function markDeadRowsStopped(
  rows: { id: string; containerId: string; provider: string }[],
): Promise<number> {
  let marked = 0;
  for (const row of rows) {
    try {
      const provider = await getProviderByKind(row.provider as SandboxKind);
      const handle = await provider.attach(row.containerId);
      if (await handle.isRunning()) continue;
    } catch {
      continue;
    }
    await markStopped(row.id);
    marked++;
  }
  return marked;
}

async function createEntry(
  provider: SandboxProvider,
  userId: string,
  conversationId: string,
): Promise<Entry> {
  // A previous process may have left a usable sandbox recorded in the DB —
  // but only if it was created under the *same* provider kind as the one
  // active now; a row left over from a prior SANDBOX_MODE is dead weight.
  //
  // Looked up by conversation alone, not by who is asking. A shared
  // conversation has several legitimate participants, and filtering on the
  // caller meant an editor's first tool call after a restart created a
  // *second* container for the same conversation — the first still running,
  // no longer in `active`, and invisible to the orphan sweep because a row
  // still claimed it.
  const existing = await db.query.sandboxes.findFirst({
    where: and(
      eq(sandboxes.conversationId, conversationId),
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

  // Per-user ceiling on live sandboxes.
  //
  // Container limits are per *container* — memory, CPU, pids — so one user
  // with a conversation per tab could hold N times all of them and starve
  // everyone else on a shared host. The `shannon.user` label existed for
  // bookkeeping; this is what turns it into a budget.
  //
  // Counted from the `sandboxes` table rather than the in-process map,
  // because the map is per process and the limit is about the machine. Rows
  // are marked stopped by every teardown path, and the boot sweep reconciles
  // what a crash left behind.
  await assertUnderUserLimit(userId);
  try {
    return await createEntryReserved(provider, userId, conversationId);
  } finally {
    releaseSandboxSlot(userId);
  }
}

async function createEntryReserved(
  provider: SandboxProvider,
  userId: string,
  conversationId: string,
): Promise<Entry> {
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
  // The row's owner is the *conversation's* owner, never whoever triggered
  // the tool call. Every sandbox route — terminal, exec, file read/write —
  // authorizes on `sandboxes.ownerId`, and terminal access is arbitrary code
  // execution rather than participation in a chat. Recording the sender here
  // meant a shared editor who happened to trigger the first tool call took
  // ownership of the sandbox and the terminal with it, while the real owner
  // was 404'd out of their own conversation's sandbox.
  const conversation = await db.query.conversations.findFirst({
    where: eq(conversations.id, conversationId),
    columns: { ownerId: true },
  });
  const [row] = await db
    .insert(sandboxes)
    .values({
      ownerId: conversation?.ownerId ?? userId,
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
    forgetOverflowWrites(entry.ref);
    await markStopped(entry.rowId);
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
    await markStopped(entry.rowId);
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
 * Boot-time counterpart of the DB recovery path, for containers the DB has
 * lost track of: a crash between `provider.create` and the row insert (or a
 * failed seed) leaves a running container no row claims and no in-memory
 * entry knows about, so stop any labeled sandbox container that is unclaimed.
 * Mirrors the stream log's boot-time orphan recovery.
 *
 * Container provider only: host-mode sandboxes are plain directories with no
 * process to stop, and the identifying label only exists on containers.
 */
export async function sweepOrphanSandboxes(): Promise<number> {
  const rows = await db.query.sandboxes
    .findMany({
      where: eq(sandboxes.status, "running"),
      columns: { id: true, containerId: true, provider: true },
    })
    .catch(() => []);

  // Direction two: rows whose container is gone. Not gated on the container
  // listing being non-empty — after a daemon restart the listing *is* empty
  // and every row is stale, which is exactly the case to reconcile. The
  // per-row liveness check leaves rows alone when the engine is unreachable.
  await markDeadRowsStopped(rows.filter((r) => r.provider === "container"));

  // Direction one: containers no row claims.
  const ids = await listSandboxContainers();
  if (ids.length === 0) return 0;
  const known = new Set<string>();
  for (const entry of active.values()) known.add(entry.ref);
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
