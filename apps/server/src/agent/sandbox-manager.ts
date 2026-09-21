import { and, db, eq, inArray, lt, ne } from "@loxaic/db";
import { conversations, sandboxes } from "@loxaic/db/schema";
import { getProviderByKind, getSandboxProvider } from "../sandbox/provider.ts";
import type { CreateSandboxConfig, SandboxHandle, SandboxKind, SandboxProvider } from "../sandbox/provider.ts";
import { SandboxGoneError } from "../sandbox/errors.ts";
import type { Workspace } from "@loxaic/types";
import { loadWorkspace } from "./workspace.ts";
import { getConnection, getOwnerToken } from "../github/connection.ts";
import { listSandboxContainers } from "../sandbox/container-provider.ts";
import { getSandboxRetention, getSandboxSettings } from "../settings.ts";

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
  status?: string;
  ownerId?: string;
  conversationId?: string | null;
}): Promise<SandboxHandle | null> {
  const provider = await getProviderByKind(row.provider as SandboxKind);
  const handle = await provider.attach(row.containerId).catch(() => null);
  if (!handle) return null;
  // Waking a paused sandbox is the transition the per-user cap guards — it is
  // what makes one *running* again — so the cap applies here exactly as it
  // does in createEntry. A row with no owner in hand cannot be counted, and
  // executor sandboxes hold nothing this server pays for.
  const capOwner = row.status === "stopped" && row.provider !== "executor" ? row.ownerId : undefined;
  if (capOwner !== undefined) await assertUnderUserLimit(capOwner);
  let resumed: boolean;
  try {
    resumed = await resume(handle);
  } finally {
    if (capOwner !== undefined) releaseSandboxSlot(capOwner);
  }
  if (!resumed) {
    await markDestroyed(row.id);
    return null;
  }
  await markRunning(row.id);
  // Under the idle timer like any other live sandbox. `stopIdleSandboxes`
  // walks only this process's `active` map, so a sandbox woken through the
  // terminal or the files API and never registered here would run for the
  // life of the process however long it sat untouched — and occupy a slot of
  // the running cap the whole time. Registered only when no *other* sandbox
  // is already active for the conversation, since the map is keyed by it.
  if (row.conversationId) {
    const current = active.get(row.conversationId);
    if (!current || current.ref === row.containerId) {
      active.set(row.conversationId, {
        rowId: row.id,
        provider: row.provider as SandboxKind,
        ref: row.containerId,
        lastUsedAt: Date.now(),
      });
    }
  }
  return handle;
}

/** True when this process already has a live sandbox for this conversation.
 * Never creates one — callers that must not spin up a container just because
 * they might want to write to it (e.g. attachment overflow handling) check
 * this first. */
/** Test seam: forget one conversation's sandbox the way a restart forgets
 * all of them, touching nothing else — the row and the container stay. What
 * the boot sweep does to a sandbox this process is *not* tracking cannot
 * otherwise be tested without a global stop, which would take other suites'
 * sandboxes with it. */
export function __forgetActiveSandboxForTest(conversationId: string): void {
  active.delete(conversationId);
}

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
  // The row's owner is the *conversation's* owner, never whoever triggered
  // the tool call — see createEntryReserved for why. Loaded here, first,
  // because the recovery query below is scoped to it too.
  const conversation = await db.query.conversations.findFirst({
    where: eq(conversations.id, conversationId),
    columns: { ownerId: true },
  });
  const ownerId = conversation?.ownerId ?? userId;

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
  //
  // It *is* scoped to the conversation owner's rows, though. `POST
  // /v1/sandboxes` takes a `conversation_id`, and until it checked the
  // caller's role on that conversation (routes/sandbox.ts) any signed-in user
  // could plant a row here naming someone else's conversation — this lookup
  // would then hand the victim's agent a sandbox the attacker owned and could
  // exec into. The route check closes the door; this predicate is what keeps
  // a planted row harmless should another door ever open, since every
  // legitimate row is written with the owner's id (createEntryReserved).
  const existing = await db.query.sandboxes.findFirst({
    where: and(
      eq(sandboxes.conversationId, conversationId),
      eq(sandboxes.ownerId, ownerId),
      inArray(sandboxes.status, ["running", "stopped"]),
      eq(sandboxes.provider, provider.kind),
    ),
  });
  if (existing) {
    const handle = await provider.attach(existing.containerId);
    // Waking a paused sandbox is the transition the per-user cap is about — it
    // is what makes one *running* again — so it is checked here as well as on
    // creation. Without this the cap was defeatable by cycling: pause N
    // sandboxes, create N more, then resume the first N.
    const wakes = existing.status === "stopped" && provider.kind !== "executor";
    if (wakes) await assertUnderUserLimit(ownerId);
    let resumed: boolean;
    try {
      resumed = await resume(handle);
    } finally {
      if (wakes) releaseSandboxSlot(ownerId);
    }
    if (resumed) {
      const entry: Entry = { rowId: existing.id, provider: provider.kind, ref: existing.containerId, lastUsedAt: Date.now() };
      await markRunning(existing.id);
      active.set(conversationId, entry);
      return entry;
    }
    // resume() answers false only for a sandbox that is *definitely* gone;
    // anything else — an engine that did not answer — threw above and reached
    // the caller as an error to retry. So this row is a tombstone for
    // something already gone, and recording that beats leaving it as a
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
    return createEntryReserved(provider, ownerId, conversationId, workspace);
  }
  // Counted against the owner, whose row this becomes — the same id the
  // resume path above reserves against, so the two agree.
  await assertUnderUserLimit(ownerId);
  try {
    return await createEntryReserved(provider, ownerId, conversationId, workspace);
  } finally {
    releaseSandboxSlot(ownerId);
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
  ownerId: string,
  conversationId: string,
  workspace: Workspace,
): Promise<Entry> {
  // `ownerId` is the *conversation's* owner, never whoever triggered the tool
  // call — see the insert below for why, and createEntry for where it is
  // loaded. The clone credentials are the owner's too.
  const config = await createConfigFor(ownerId, workspace);
  // The owner here too, not the sender: the container's `loxaic.user` label
  // is all `create` uses it for, and labelling the sender meant a shared
  // editor's first tool call left a container labelled for one person and
  // claimed by a row owned by another — so a sweep scoped to the editor
  // listed it, found no row of theirs claiming it, and destroyed a live
  // workspace.
  const handle = await provider.create(ownerId, config);
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
      limits: { memory: 512, cpu: 1, network: networkFor(provider.kind) },
    })
    .returning();

  const entry: Entry = { rowId: row.id, provider: provider.kind, ref: handle.ref, lastUsedAt: Date.now() };
  active.set(conversationId, entry);
  return entry;
}

/**
 * Whether this sandbox has the network — recorded on the row at creation,
 * because it is fixed for the sandbox's life: a container's NetworkMode
 * cannot change under it, and a paused one resumes with what it was made
 * with. The client's "no network" banner reads this rather than the
 * server-wide setting, which says what the *next* sandbox gets — an admin
 * who turned networking on mid-conversation was otherwise shown the banner
 * vanish from exactly the workspace it still applied to. Host and executor
 * sandboxes always have their machine's network.
 */
export function networkFor(kind: SandboxKind): boolean {
  return kind === "container" ? getSandboxSettings().allowNetwork : true;
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
  } catch (err) {
    // Only the provider's own "gone" answer is false. Everything else — the
    // engine unreachable, the user's machine offline, a timeout — is rethrown
    // as itself: this used to swallow every error, and a transient failure
    // then marked a paused workspace destroyed, after which the boot sweep
    // deleted the container that was still holding the work.
    if (err instanceof SandboxGoneError) return false;
    throw err;
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
  // An in-flight creation would otherwise insert its row *after* the query
  // below and outlive the deletion of the conversation it belongs to — and it
  // ends by putting its entry in `active`, so it is awaited *before* the map
  // is cleared. Clearing first left the map holding an entry whose row and
  // container had just been destroyed.
  const inFlight = pending.get(conversationId);
  if (inFlight) await inFlight.catch(() => undefined);
  active.delete(conversationId);

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

/** Module load — the closest this module gets to "when the process started".
 * See sweepOrphanSandboxes. */
const PROCESS_STARTED_AT = Date.now();

/**
 * Boot-time counterpart of the DB recovery path, for containers the DB has
 * lost track of: a crash between `provider.create` and the row insert (or a
 * failed seed) leaves a running container no row claims and no in-memory
 * entry knows about, so stop any labeled sandbox container that is unclaimed.
 * Mirrors the stream log's boot-time orphan recovery.
 *
 * Container provider only: host-mode sandboxes are plain directories with no
 * process to stop, and the identifying label only exists on containers.
 *
 * **Only containers created before this process started are candidates**
 * (`createdBefore`, defaulting to module load). A crash orphan is by
 * definition older than this boot; everything younger is this process's own
 * and may simply not be tracked *yet* or *at all*. The boot call runs inside
 * the `listen` callback, unawaited, and reaches the listing only after walking
 * every row — seconds on a busy host, with requests already being served. An
 * upload in that window creates an extraction-pool container, which has no
 * row and no `active` entry by design: exactly the shape direction one
 * destroys, so the extraction died mid-exec. Folding the pool into `known`
 * would still leave the gap between a container existing and being
 * registered; age has no such gap. Compared against the engine's clock: if
 * that runs behind ours a young container can look old (the behaviour before
 * this rule), and if ahead an orphan waits for a later boot.
 *
 * What this does **not** cover is a second process on the same engine — a
 * desktop Solo instance beside a dev server. Rows are shared when the database
 * is, but another process's rowless extraction container older than this boot
 * is still swept.
 *
 * `ownerId` scopes all three directions to one user — rows by `ownerId`,
 * containers by the `loxaic.user` label, which createEntryReserved sets to the
 * same owner — and only a test passes it. Unscoped under vitest's parallel
 * workers, which share the database and the engine, this paused every other
 * suite's live sandbox and destroyed their rowless containers mid-test. Same
 * shape as reapAbandonedSandboxes' scope.
 */
export async function sweepOrphanSandboxes(
  scope: { ownerId?: string; createdBefore?: number } = {},
): Promise<number> {
  const { ownerId, createdBefore = PROCESS_STARTED_AT } = scope;
  // Every row that still claims a sandbox — **including paused ones**. That
  // distinction matters twice below: a paused sandbox is a live claim on its
  // container, so treating it as unclaimed would delete a user's work at every
  // boot; and it is equally a row to reconcile when the container really has
  // gone.
  const claimed = await db.query.sandboxes
    .findMany({
      where: ownerId
        ? and(ne(sandboxes.status, "destroyed"), eq(sandboxes.ownerId, ownerId))
        : ne(sandboxes.status, "destroyed"),
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
  const ids = await listSandboxContainers({
    ...(ownerId ? { userId: ownerId } : {}),
    // Infinity is "no cutoff", which a test uses to reclaim an orphan it has
    // only just made.
    ...(Number.isFinite(createdBefore) ? { createdBeforeMs: createdBefore } : {}),
  });
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
    // A sandbox that exists but is not running is exactly `stopped`, and the
    // row is corrected to say so. It used to be skipped, which after a host
    // reboot — every container down, every row still "running" — left the
    // user counted at the cap by rows nothing would ever reconcile. Not
    // existing is different: that can be gone or merely unreachable, and the
    // row is left alone on no evidence (markDeadRowsDestroyed decides).
    if (!(await handle.exists().catch(() => false))) continue;
    if (await handle.isRunning().catch(() => false)) await handle.stop().catch(() => undefined);
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
