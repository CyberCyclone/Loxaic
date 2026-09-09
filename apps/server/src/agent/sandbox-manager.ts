import { and, db, eq, inArray, lt, ne } from "@loxaic/db";
import { conversations, sandboxes } from "@loxaic/db/schema";
import { getProviderByKind, getSandboxProvider } from "../sandbox/provider.ts";
import type { CreateSandboxConfig, SandboxHandle, SandboxKind, SandboxProvider } from "../sandbox/provider.ts";
import type { Workspace } from "@loxaic/types";
import { loadWorkspace } from "./workspace.ts";
import { getConnection, getOwnerToken } from "../github/connection.ts";
import { listSandboxContainers } from "../sandbox/container-provider.ts";
import { seedSandbox } from "../sandbox/seed.ts";
import { getSandboxRetention } from "../settings.ts";

/**
 * How often the reapers run.
 *
 * Both timers are measured in hours or days, so the tick only has to be small
 * relative to them — it is also what bounds how stale `last_used_at` gets for
 * a sandbox in active use (see the flush below).
 *
 * Overridable because a five-minute tick is longer than any end-to-end test
 * can wait, and the alternative — a test that reaches past the timer and stops
 * a container itself — would assert nothing about the timer that is the actual
 * subject. Read at call time like every other sandbox env var.
 */
function reapIntervalMs(): number {
  const raw = process.env.SANDBOX_REAP_INTERVAL_MS;
  const value = raw === undefined ? NaN : Number(raw);
  return Number.isInteger(value) && value > 0 ? value : 5 * 60 * 1000;
}

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
  // The workspace decides the provider, not the other way round: a `local`
  // workspace runs on the user's own machine regardless of what this server's
  // SANDBOX_MODE says — off, host, or hosting-blocked, none of it applies to
  // a command that never executes here. Everything else uses the configured
  // provider. Loaded here, once per tool call, rather than per creation —
  // resolveEntry's cached path needs it too, to know which provider to ask.
  const loaded = await loadWorkspace(conversationId);
  const workspace: Workspace = loaded?.workspace ?? { kind: "scratch" };
  const provider = workspace.kind === "local" ? await getProviderByKind("executor") : await getSandboxProvider();
  if (!provider) throw new Error("sandboxes are disabled (SANDBOX_MODE=off)");

  const entry = await resolveEntry(provider, userId, conversationId, workspace);
  entry.lastUsedAt = Date.now();
  const entryProvider = entry.provider === provider.kind ? provider : await getProviderByKind(entry.provider);
  return entryProvider.attach(entry.ref);
}

/**
 * Attaches to a sandbox recorded by a row, resuming it if it is paused.
 *
 * The counterpart of `getConversationSandbox` for the paths that reach a
 * sandbox by *row* rather than by conversation — the REST exec/file routes and
 * the terminal WebSocket. They previously attached and used the handle
 * directly, which was fine while "stopped" meant "gone": the attach simply
 * failed and the row was a tombstone. Now that a stopped sandbox is a paused
 * one holding real work, those routes have to be able to wake it, or a user
 * whose workspace paused overnight gets `container … is not running` from
 * every one of them with no way back short of sending a chat message.
 *
 * Returns null when the sandbox is genuinely gone, which callers render as the
 * same 404 a missing row gets.
 */
export async function attachRunningSandbox(row: {
  id: string;
  containerId: string;
  provider: string;
}): Promise<SandboxHandle | null> {
  const provider = await getProviderByKind(row.provider as SandboxKind);
  const handle = await provider.attach(row.containerId).catch(() => null);
  if (!handle) return null;
  if (!(await resume(handle))) {
    await markDestroyed(row.id);
    return null;
  }
  await markRunning(row.id);
  return handle;
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
  workspace: Workspace,
): Promise<Entry> {
  const cached = active.get(conversationId);
  if (cached) {
    // Operate through the provider the cached entry actually belongs to,
    // not necessarily today's configured provider — a mode switch mid-run
    // must not make a perfectly live container/host-dir look vanished.
    const owner = cached.provider === currentProvider.kind ? currentProvider : await getProviderByKind(cached.provider);
    const handle = await owner.attach(cached.ref);
    if (await resume(handle)) return cached;
    // Genuinely gone (crash, engine restart, manual `docker rm`), rather than
    // merely stopped — `resume` already tried that. Nothing to recover.
    active.delete(conversationId);
    forgetOverflowWrites(cached.ref);
    await markStopped(cached.rowId, cached.lastUsedAt);
  }

  const inFlight = pending.get(conversationId);
  if (inFlight) return inFlight;

  const creation = createEntry(currentProvider, userId, conversationId, workspace).finally(() => {
    pending.delete(conversationId);
  });
  pending.set(conversationId, creation);
  return creation;
}

/**
 * How many *running* sandboxes one user may hold at once.
 *
 * Running, not existing, and that stayed true when stopping became a pause:
 * the resources this cap protects — memory, CPU, pids — are per running
 * container, and a paused one holds none of them. A user with twenty paused
 * conversations is spending disk, which is the abandoned reaper's department,
 * not this one's. Counting paused sandboxes here would instead mean a user
 * being refused a new one until they went and deleted old conversations.
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
    await markDeadRowsDestroyed(rows);
    rows = await runningRowsFor(userId);
  }
  if (rows.length + reserved >= limit) throw new SandboxLimitError(limit);
  inFlight.set(userId, reserved + 1);
}

async function runningRowsFor(userId: string) {
  // Executor sandboxes are a directory on the user's own machine and hold
  // none of the server resources this cap protects, so they neither count
  // against it nor are subject to it (see createEntry).
  return db
    .select({ id: sandboxes.id, containerId: sandboxes.containerId, provider: sandboxes.provider })
    .from(sandboxes)
    .where(and(eq(sandboxes.ownerId, userId), eq(sandboxes.status, "running"), ne(sandboxes.provider, "executor")));
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
/**
 * Reconciles rows whose sandbox the engine no longer has.
 *
 * Asks `exists()`, never `start()`: a merely *stopped* container is perfectly
 * recoverable and must not be recorded as gone, but this runs on read-only
 * paths — the per-user cap check among them — where resuming every stopped
 * container as a side effect of counting would be its own bug.
 *
 * An unreachable engine leaves rows alone, which is the conservative
 * direction: "cannot ask" must never be recorded as "destroyed".
 */
async function markDeadRowsDestroyed(
  rows: { id: string; containerId: string; provider: string; status?: string }[],
): Promise<number> {
  let marked = 0;
  for (const row of rows) {
    try {
      const provider = await getProviderByKind(row.provider as SandboxKind);
      const handle = await provider.attach(row.containerId);
      if (await handle.exists()) continue;
    } catch {
      continue;
    }
    await markDestroyed(row.id);
    marked++;
  }
  return marked;
}

async function createEntry(
  provider: SandboxProvider,
  userId: string,
  conversationId: string,
  workspace: Workspace,
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
  //
  // "stopped" counts as recoverable, and that is the whole point of the
  // stop/destroy split: a paused sandbox still holds the conversation's edits,
  // its checkout, and whatever it installed, so the right answer to someone
  // returning the next morning is to start it again rather than hand them an
  // empty directory and a re-clone. Only "destroyed" is terminal.
  const existing = await db.query.sandboxes.findFirst({
    where: and(
      eq(sandboxes.conversationId, conversationId),
      inArray(sandboxes.status, ["running", "stopped"]),
      eq(sandboxes.provider, provider.kind),
    ),
  });
  if (existing) {
    const handle = await provider.attach(existing.containerId);
    if (await resume(handle)) {
      const entry: Entry = { rowId: existing.id, provider: provider.kind, ref: existing.containerId, lastUsedAt: Date.now() };
      await markRunning(existing.id);
      active.set(conversationId, entry);
      return entry;
    }
    // Attached to a ref the engine no longer knows: the row is a tombstone for
    // something already gone, so record that rather than leaving it as a
    // "stopped" sandbox the user could be told still holds their work.
    await markDestroyed(existing.id);
  }

  // Per-user ceiling on live sandboxes.
  //
  // Container limits are per *container* — memory, CPU, pids — so one user
  // with a conversation per tab could hold N times all of them and starve
  // everyone else on a shared host. The `loxaic.user` label existed for
  // bookkeeping; this is what turns it into a budget.
  //
  // Counted from the `sandboxes` table rather than the in-process map,
  // because the map is per process and the limit is about the machine. Rows
  // are marked stopped by every teardown path, and the boot sweep reconciles
  // what a crash left behind.
  //
  // Not for executor sandboxes: those run on the user's own machine and
  // cost this server nothing to hold open.
  if (provider.kind === "executor") {
    return createEntryReserved(provider, userId, conversationId, workspace);
  }
  await assertUnderUserLimit(userId);
  try {
    return await createEntryReserved(provider, userId, conversationId, workspace);
  } finally {
    releaseSandboxSlot(userId);
  }
}

/**
 * What to hand `provider.create` for this workspace.
 *
 * A github workspace clones with the **conversation owner's** token and
 * identity — never the sender's. Sandboxes are created lazily on first tool
 * use, which may well be a shared editor's, and the row's `ownerId` is the
 * owner's for the same reason (see below). The token reaches git through the
 * exec environment only (sandbox/git.ts).
 */
async function createConfigFor(ownerId: string, workspace: Workspace): Promise<CreateSandboxConfig> {
  if (workspace.kind === "local") {
    // The executor re-validates the path against its own roots on every
    // call; this is the request, and the owner check is the provider's.
    return {
      local: { executorId: workspace.executorId, path: workspace.path, isolation: workspace.isolation, ownerId },
    };
  }
  if (workspace.kind !== "github") return {};
  const [token, connection] = await Promise.all([getOwnerToken(ownerId), getConnection(ownerId)]);
  if (!token || !connection) {
    throw new Error(
      `This conversation's workspace is a GitHub repository (${workspace.repo}), but the owner's GitHub ` +
        "connection is gone. Reconnect GitHub in Settings, or start a new conversation.",
    );
  }
  return {
    repoUrl: workspace.cloneUrl,
    branch: workspace.baseBranch,
    newBranch: workspace.branch,
    git: {
      token,
      identity: {
        name: connection.name ?? connection.login,
        // GitHub's noreply form is what its own web UI commits as for a user
        // with a private email; it attributes correctly without exposing one.
        email: connection.email ?? `${connection.login}@users.noreply.github.com`,
      },
    },
  };
}

async function createEntryReserved(
  provider: SandboxProvider,
  userId: string,
  conversationId: string,
  workspace: Workspace,
): Promise<Entry> {
  // The row's owner is the *conversation's* owner, never whoever triggered
  // the tool call — see the insert below for why. Loaded first because the
  // clone credentials are the owner's too.
  const conversation = await db.query.conversations.findFirst({
    where: eq(conversations.id, conversationId),
    columns: { ownerId: true },
  });
  const ownerId = conversation?.ownerId ?? userId;
  const config = await createConfigFor(ownerId, workspace);
  const handle = await provider.create(userId, config);
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
  // Every sandbox route — terminal, exec, file read/write — authorizes on
  // `sandboxes.ownerId`, and terminal access is arbitrary code execution
  // rather than participation in a chat. Recording the sender here meant a
  // shared editor who happened to trigger the first tool call took ownership
  // of the sandbox and the terminal with it, while the real owner was 404'd
  // out of their own conversation's sandbox.
  const [row] = await db
    .insert(sandboxes)
    .values({
      ownerId,
      conversationId,
      containerId: handle.ref,
      provider: provider.kind,
      image: provider.kind === "container" ? (process.env.SANDBOX_IMAGE ?? "loxaic-sandbox") : provider.kind,
      status: "running",
      repoUrl: config.repoUrl ?? null,
      branch: config.newBranch ?? config.branch ?? null,
      limits: { memory: 512, cpu: 1 },
    })
    .returning();

  const entry: Entry = { rowId: row.id, provider: provider.kind, ref: handle.ref, lastUsedAt: Date.now() };
  active.set(conversationId, entry);
  return entry;
}

/**
 * Make a handle usable, whether it was running or merely paused.
 *
 * Returns false only when the sandbox is really gone. `isRunning()` cannot
 * distinguish "stopped" from "removed" — both are false — so `start()` is the
 * discriminator: it is a no-op on a live sandbox, resumes a paused one, and
 * throws when there is nothing left to resume.
 */
async function resume(handle: SandboxHandle): Promise<boolean> {
  try {
    await handle.start();
    return true;
  } catch {
    return false;
  }
}

async function markRunning(rowId: string): Promise<void> {
  await db
    .update(sandboxes)
    .set({ status: "running", stoppedAt: null, lastUsedAt: new Date() })
    .where(eq(sandboxes.id, rowId))
    .catch(() => undefined);
}

/** Records a sandbox as paused-but-intact. `lastUsedAt` is written here from
 * the in-memory entry, because that is the moment the row's own copy stops
 * being able to go stale — and it is what both the reap deadline and the
 * "last used" the user sees are computed from. */
async function markStopped(rowId: string, lastUsedAt?: number): Promise<void> {
  await db
    .update(sandboxes)
    .set({
      status: "stopped",
      stoppedAt: new Date(),
      ...(lastUsedAt !== undefined ? { lastUsedAt: new Date(lastUsedAt) } : {}),
    })
    .where(eq(sandboxes.id, rowId))
    .catch(() => undefined);
}

async function markDestroyed(rowId: string): Promise<void> {
  await db
    .update(sandboxes)
    .set({ status: "destroyed", stoppedAt: new Date() })
    .where(eq(sandboxes.id, rowId))
    .catch(() => undefined);
}

/**
 * Writes the in-memory `lastUsedAt` of every live sandbox back to its row.
 *
 * Tool calls bump the in-memory value only — a database write per `bash` would
 * be absurd — so without this a sandbox in constant use would look, to a fresh
 * process reading the table, like one nobody had touched since it was created.
 * That matters because the abandoned reaper reads exactly this column.
 */
async function flushLastUsed(): Promise<void> {
  for (const entry of [...active.values()]) {
    await db
      .update(sandboxes)
      .set({ lastUsedAt: new Date(entry.lastUsedAt) })
      .where(eq(sandboxes.id, entry.rowId))
      .catch(() => undefined);
  }
}

/**
 * **Pauses** every sandbox idle for longer than the configured idle-stop
 * window, keeping its contents.
 *
 * The rename from "reap" is the substance of this function, not tidying: it
 * used to delete, so a conversation left alone over lunch came back to an
 * empty workspace and a model that had no idea why. Now it stops the
 * container, marks the row `stopped`, and the next tool call starts it again
 * with everything as it was.
 */
export async function stopIdleSandboxes(now = Date.now(), kind?: SandboxKind): Promise<number> {
  const { idleStopMs } = getSandboxRetention();
  let stopped = 0;
  for (const [conversationId, entry] of [...active.entries()]) {
    // Unfiltered in production — the idle timer is server-wide. The parameter
    // exists so a test can aim it at host sandboxes only: this walks every
    // live sandbox in the process, so a suite forcing a one-millisecond idle
    // window would otherwise pause the container another suite is mid-run in.
    // Same reasoning as stopAllSandboxes() and reapAbandonedSandboxes().
    if (kind && entry.provider !== kind) continue;
    if (now - entry.lastUsedAt < idleStopMs) continue;
    active.delete(conversationId);
    const provider = await getProviderByKind(entry.provider);
    const handle = await provider.attach(entry.ref).catch(() => null);
    await handle?.stop().catch(() => undefined);
    forgetOverflowWrites(entry.ref);
    await markStopped(entry.rowId, entry.lastUsedAt);
    stopped++;
  }
  return stopped;
}

/**
 * **Destroys** sandboxes nobody has used for the configured retention window.
 *
 * The only timer in the system that deletes a user's work, which is why it is
 * separately switchable, defaults to a month rather than hours, and reads
 * `last_used_at` from the row rather than from this process's memory — the
 * sandbox it is deciding about has, by definition, not been touched by anyone
 * for weeks and will not be in `active` at all.
 *
 * Rows still marked `running` are eligible too. After a crash or a host reboot
 * a row can stay `running` forever with nothing that would ever move it on;
 * excluding those would make an abandoned sandbox permanently unreclaimable
 * precisely because the server died while it was in use. Anything genuinely in
 * use is in `active`, has a fresh `last_used_at` (see the flush above), and so
 * cannot match this window.
 */
export async function reapAbandonedSandboxes(
  now = Date.now(),
  kind?: SandboxKind,
  ownerId?: string,
): Promise<number> {
  const { reapEnabled, reapAfterMs } = getSandboxRetention();
  if (!reapEnabled) return 0;

  const cutoff = new Date(now - reapAfterMs);
  const rows = await db.query.sandboxes
    .findMany({
      where: and(
        ne(sandboxes.status, "destroyed"),
        lt(sandboxes.lastUsedAt, cutoff),
        // Unfiltered in production — this is a server-wide janitor. `kind`
        // exists so a test can aim it at host sandboxes only, and `ownerId`
        // narrows further still: suites share one Postgres and this is a
        // DB-wide query (unlike stopIdleSandboxes/stopAllSandboxes, which
        // only ever touch this process's own in-memory `active` map), so
        // two host-mode suites running in different worker processes are
        // otherwise still visible to each other here. An unscoped call with
        // one of these suites' deliberately tiny retention windows would
        // destroy the sandbox the other one is mid-run in.
        ...(kind ? [eq(sandboxes.provider, kind)] : []),
        ...(ownerId ? [eq(sandboxes.ownerId, ownerId)] : []),
      ),
      columns: { id: true, containerId: true, provider: true, conversationId: true },
    })
    .catch(() => []);

  let destroyed = 0;
  for (const row of rows) {
    // A sandbox this process is holding open cannot be abandoned, whatever the
    // row says — the row may simply predate the next flush.
    if (row.conversationId && active.has(row.conversationId)) continue;
    const provider = await getProviderByKind(row.provider as SandboxKind);
    const handle = await provider.attach(row.containerId).catch(() => null);
    if (handle) {
      await handle.destroy().catch(() => undefined);
    }
    forgetOverflowWrites(row.containerId);
    await markDestroyed(row.id);
    destroyed++;
  }
  return destroyed;
}

/**
 * Destroys every sandbox belonging to a conversation. The deliberate reclaim
 * path: deleting the conversation is the user saying the work is finished with,
 * and it is the only thing besides the abandoned reaper that may delete one.
 */
export async function destroyConversationSandboxes(conversationId: string): Promise<number> {
  const cached = active.get(conversationId);
  if (cached) active.delete(conversationId);
  // An in-flight creation would otherwise insert its row *after* the query
  // below and outlive the deletion of the conversation it belongs to.
  const inFlight = pending.get(conversationId);
  if (inFlight) await inFlight.catch(() => undefined);

  const rows = await db.query.sandboxes
    .findMany({
      where: and(eq(sandboxes.conversationId, conversationId), ne(sandboxes.status, "destroyed")),
      columns: { id: true, containerId: true, provider: true },
    })
    .catch(() => []);

  let destroyed = 0;
  for (const row of rows) {
    const provider = await getProviderByKind(row.provider as SandboxKind);
    const handle = await provider.attach(row.containerId).catch(() => null);
    await handle?.destroy().catch(() => undefined);
    forgetOverflowWrites(row.containerId);
    await markDestroyed(row.id);
    destroyed++;
  }
  return destroyed;
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
  // Nothing here destroys anything, and after the stop/destroy split that is
  // now literally true rather than merely intended: a settings change used to
  // delete every host sandbox's working directory through stop(), which is
  // what the narrow invalidatedKinds() scoping in settings.ts existed to limit
  // the damage of.
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
    forgetOverflowWrites(entry.ref);
    await markStopped(entry.rowId, entry.lastUsedAt);
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
  // Every row that still claims a sandbox — **including paused ones**. That
  // distinction matters twice below: a paused sandbox is a live claim on its
  // container, so treating it as unclaimed would delete a user's work at every
  // boot; and it is equally a row to reconcile when the container really has
  // gone.
  const claimed = await db.query.sandboxes
    .findMany({
      where: ne(sandboxes.status, "destroyed"),
      columns: { id: true, containerId: true, provider: true, status: true },
    })
    .catch(() => []);

  // Direction two: rows whose container is genuinely gone. Not gated on the
  // container listing being non-empty — after a daemon restart the listing
  // *is* empty and every row is stale, which is exactly the case to
  // reconcile. The per-row check leaves rows alone when the engine is
  // unreachable.
  await markDeadRowsDestroyed(claimed.filter((r) => r.provider === "container"));

  // Direction three, new with stop-and-resume: rows still marked "running"
  // whose container really is running, left by a previous process.
  //
  // Containers now outlive the server (AutoRemove is off), so a restart leaves
  // every one of them running with nothing tracking it: this process has an
  // empty `active` map, so its idle timer will never see them, and the row
  // would advertise "running" indefinitely. Pausing them costs nothing — the
  // next tool call on that conversation resumes it — and makes the table
  // honest again.
  await stopStrayRunning(claimed.filter((r) => r.status === "running"));

  // Direction one: containers no row claims. Destroyed rather than stopped:
  // nothing can ever reach them again, since the only handle back to a sandbox
  // is its row.
  const ids = await listSandboxContainers();
  if (ids.length === 0) return 0;
  const known = new Set<string>();
  for (const entry of active.values()) known.add(entry.ref);
  for (const row of claimed) known.add(row.containerId);

  const provider = await getProviderByKind("container");
  let swept = 0;
  for (const id of ids) {
    if (known.has(id)) continue;
    const handle = await provider.attach(id);
    await handle.destroy().catch(() => undefined);
    swept++;
  }
  return swept;
}

/** Pauses sandboxes a previous process left running — see direction three. */
async function stopStrayRunning(
  rows: { id: string; containerId: string; provider: string; status?: string }[],
): Promise<number> {
  let stopped = 0;
  for (const row of rows) {
    if ([...active.values()].some((e) => e.ref === row.containerId)) continue;
    const provider = await getProviderByKind(row.provider as SandboxKind);
    const handle = await provider.attach(row.containerId).catch(() => null);
    if (!handle) continue;
    if (!(await handle.isRunning().catch(() => false))) continue;
    await handle.stop().catch(() => undefined);
    await markStopped(row.id);
    stopped++;
  }
  return stopped;
}

/**
 * One timer drives all three periodic jobs, in a fixed order.
 *
 * The order is load-bearing: the flush is what makes `last_used_at` current,
 * the idle stop then writes its own final value for anything it pauses, and
 * only then does the destroying reaper read the column. Running the reaper
 * first would let it judge a live sandbox by a `last_used_at` written when it
 * was created.
 */
export function startSandboxReaper(onReap?: (count: number) => void): NodeJS.Timeout {
  const timer = setInterval(() => {
    void (async () => {
      await flushLastUsed().catch(() => undefined);
      const stopped = await stopIdleSandboxes().catch(() => 0);
      if (stopped > 0) onReap?.(stopped);
      await reapAbandonedSandboxes().catch(() => 0);
    })();
  }, reapIntervalMs());
  timer.unref();
  return timer;
}
