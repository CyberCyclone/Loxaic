import { and, db, desc, eq, inArray, lt, ne, sql } from "@loxaic/db";
import { conversations, sandboxes } from "@loxaic/db/schema";
import { getProviderByKind, getSandboxProvider } from "../sandbox/provider.ts";
import type { CreateSandboxConfig, SandboxHandle, SandboxKind, SandboxProvider } from "../sandbox/provider.ts";
import { SandboxGoneError } from "../sandbox/errors.ts";
import type { Workspace } from "@loxaic/types";
import { loadWorkspace } from "./workspace.ts";
import { dropConversationCopies } from "./checkpoints.ts";
import { getConnection } from "../github/connection.ts";
import { withEgress } from "../egress/env.ts";
import { listSandboxContainers, sandboxImage } from "../sandbox/container-provider.ts";
import { getSandboxRetention, getSandboxSettings, type SandboxAllocation } from "../settings.ts";
import {
  allocationDecision,
  allocationFor,
  addNeed,
  allocationMessage,
  DEFAULT_NEED,
  rowNeed,
  usageOf,
  type AllocationReason,
  type AllocationUsage,
  type SandboxNeed,
} from "./allocation.ts";

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
  const handle = await entryProvider.attach(entry.ref);
  return loaded ? egressFor(handle, conversationId, loaded) : handle;
}

/**
 * A GitHub workspace's sandbox reaches GitHub through the egress proxy, as
 * the conversation's owner (egress/env.ts); no other sandbox is given it. The
 * proxy's reads reach whatever the owner's token can read, so handing it to a
 * scratch chat would let one list and clone the owner's private repositories
 * with nobody asked, in a conversation that was never about GitHub.
 */
function egressFor(handle: SandboxHandle, conversationId: string, loaded: { ownerId: string; workspace: Workspace }): SandboxHandle {
  return loaded.workspace.kind === "github" ? withEgress(handle, { conversationId, ownerId: loaded.ownerId }) : handle;
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
  /** What it holds when running, which waking it reserves (#254). Required,
   * so a caller cannot under-count a large image by leaving it off. */
  limits: unknown;
}): Promise<SandboxHandle | null> {
  const provider = await getProviderByKind(row.provider as SandboxKind);
  const handle = await provider.attach(row.containerId).catch(() => null);
  if (!handle) return null;
  // Waking a paused sandbox is the transition the per-user cap guards — it is
  // what makes one *running* again — so the cap applies here exactly as it
  // does in createEntry. A row with no owner in hand cannot be counted.
  if (!(await wake(handle, row))) {
    await markDestroyed(row.id);
    return null;
  }
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
  // The Inspector's git routes and the terminal reach GitHub the way the
  // agent does: through the egress proxy, as the conversation's owner, and
  // only in a GitHub workspace.
  if (!row.conversationId) return handle;
  const loaded = await loadWorkspace(row.conversationId).catch(() => null);
  return loaded && loaded.ownerId === row.ownerId ? egressFor(handle, row.conversationId, loaded) : handle;
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
 * The refusal when a sandbox would not fit the owner's allocation (#254).
 *
 * Carries the numbers as well as the sentence: the routes answer 429 with
 * them, and the engine marks the tool result so a client can offer the
 * Sandboxes screen rather than only quoting the message.
 */
export class SandboxLimitError extends Error {
  readonly code = "sandbox_allocation";
  readonly reason: AllocationReason;
  readonly used: AllocationUsage;
  readonly need: SandboxNeed;
  readonly allocation: SandboxAllocation;
  constructor(reason: AllocationReason, used: AllocationUsage, need: SandboxNeed, allocation: SandboxAllocation) {
    super(allocationMessage(reason, used, need, allocation));
    this.name = "SandboxLimitError";
    this.reason = reason;
    this.used = used;
    this.need = need;
    this.allocation = allocation;
  }
}

/**
 * Sandboxes this process is *about to* make running, per user, counted
 * alongside the rows. The check is check-then-create with no transaction, and
 * `pending` de-duplicates per conversation only — so a user with room for one
 * more who fires tool calls in three conversations at once had all three pass
 * the check before any row existed. A reservation taken before the start and
 * released once the row says `running` (or the start failed) closes that
 * within a process. It holds the sandbox's memory and CPU, not just a slot,
 * so two starts cannot both fit into the last 512 MB.
 */
const reserved = new Map<string, Set<SandboxNeed>>();

function reservedUsage(userId: string): AllocationUsage {
  const usage: AllocationUsage = { running: 0, memoryMb: 0, cpus: 0 };
  for (const need of reserved.get(userId) ?? []) addNeed(usage, need);
  return usage;
}

/** Each user's reservations are decided one at a time: between reading the
 * rows and adding its own reservation, a check must not interleave with
 * another of the same user's. */
const reserving = new Map<string, Promise<unknown>>();

/**
 * What a user's running sandboxes hold, from their rows. Executor sandboxes
 * are a directory on the user's own machine and hold none of the server's
 * resources, so they neither count nor are subject to the allocation.
 */
export async function runningUsage(userId: string, exceptRowId?: string): Promise<AllocationUsage> {
  const rows = await runningRowsFor(userId);
  return usageOf(rows.filter((row) => row.id !== exceptRowId));
}

function sum(a: AllocationUsage, b: AllocationUsage): AllocationUsage {
  return { running: a.running + b.running, memoryMb: a.memoryMb + b.memoryMb, cpus: a.cpus + b.cpus };
}

/**
 * Refuses when a sandbox needing `need` would not fit the user's allocation;
 * otherwise reserves its room and returns the release, which the caller must
 * call once the row exists (or the start failed). Exported because
 * `POST /v1/sandboxes` is a second creation path, and an allocation only one
 * of two paths honours is not an allocation.
 *
 * `exceptRowId` leaves out a running sandbox the new one replaces (an image
 * switch), which stops once the new one is up.
 *
 * Before refusing, the counted rows are reconciled against reality. A row can
 * say `running` when its container is long gone — a Docker daemon restart
 * takes every AutoRemove container with it, and nothing else marks those rows:
 * the boot sweep stops containers *no row claims* (the other direction), the
 * idle reaper walks the in-process map (empty after a restart), and
 * `createEntry` reconciles exactly one conversation's row. Counting them meant
 * telling a user to pause something that no longer exists.
 */
export function reserveSandbox(userId: string, need: SandboxNeed, exceptRowId?: string): Promise<() => void> {
  const run = (reserving.get(userId) ?? Promise.resolve()).then(() => reserveNow(userId, need, exceptRowId));
  const tail = run.catch(() => undefined);
  reserving.set(userId, tail);
  void tail.then(() => {
    if (reserving.get(userId) === tail) reserving.delete(userId);
  });
  return run;
}

async function reserveNow(userId: string, need: SandboxNeed, exceptRowId?: string): Promise<() => void> {
  const { allocation } = await allocationFor(userId);
  // The reservations are read *before* the rows. A start that finishes during
  // the row read releases its reservation once its row says `running`; read
  // after, it could be in neither count. Read before, it is in at least one
  // (or both, which only errs towards refusing).
  const measure = async () => {
    const held = reservedUsage(userId);
    return sum(await runningUsage(userId, exceptRowId), held);
  };
  let used = await measure();
  let decision = allocationDecision(used, need, allocation);
  if (!decision.ok && decision.reason !== "too_big") {
    await markDeadRowsDestroyed(await runningRowsFor(userId));
    used = await measure();
    decision = allocationDecision(used, need, allocation);
  }
  if (!decision.ok) throw new SandboxLimitError(decision.reason, used, need, allocation);
  // Its own object, so releasing one reservation never releases another of
  // the same size.
  const mine: SandboxNeed = { ...need };
  const set = reserved.get(userId) ?? new Set<SandboxNeed>();
  set.add(mine);
  reserved.set(userId, set);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    set.delete(mine);
    if (set.size === 0 && reserved.get(userId) === set) reserved.delete(userId);
  };
}

/** What a sandbox about to be made from `config` will hold while it runs —
 * the same numbers `sandboxRowValues` records for it. */
export function configNeed(kind: SandboxKind, config: CreateSandboxConfig): SandboxNeed {
  if (kind !== "container") return { memoryMb: 0, cpus: 0 };
  return {
    memoryMb: config.limits?.memory !== undefined ? Math.round(config.limits.memory / (1024 * 1024)) : DEFAULT_NEED.memoryMb,
    cpus: config.limits?.cpu !== undefined ? config.limits.cpu / 1e9 : DEFAULT_NEED.cpus,
  };
}

async function runningRowsFor(userId: string) {
  return runningRowsForUsers([userId]);
}

/** The running rows an allocation counts, for several users in one query
 * (the admin's user list). */
export async function runningRowsForUsers(userIds: string[]) {
  if (userIds.length === 0) return [];
  return db
    .select({
      id: sandboxes.id,
      ownerId: sandboxes.ownerId,
      containerId: sandboxes.containerId,
      provider: sandboxes.provider,
      limits: sandboxes.limits,
    })
    .from(sandboxes)
    .where(and(inArray(sandboxes.ownerId, userIds), eq(sandboxes.status, "running"), ne(sandboxes.provider, "executor")));
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
    if (await wake(handle, existing)) {
      const entry: Entry = { rowId: existing.id, provider: provider.kind, ref: existing.containerId, lastUsedAt: Date.now() };
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
    return createEntryReserved(provider, ownerId, conversationId, await createConfigFor(ownerId, conversationId, workspace, provider.kind));
  }
  // Counted against the owner, whose row this becomes — the same id the
  // resume path above reserves against, so the two agree. Reserved before the
  // config is built (the GitHub connection, the image's policy checks), so a
  // refused start does none of that work, and a refusal is what it reports.
  let need = await workspaceNeed(workspace, provider.kind);
  let release = await reserveSandbox(ownerId, need);
  try {
    const config = await createConfigFor(ownerId, conversationId, workspace, provider.kind);
    // The image's limits can change between the two reads; what is reserved
    // has to be what the container gets.
    const actual = configNeed(provider.kind, config);
    if (actual.memoryMb !== need.memoryMb || actual.cpus !== need.cpus) {
      release();
      need = actual;
      release = await reserveSandbox(ownerId, need);
    }
    return await createEntryReserved(provider, ownerId, conversationId, config);
  } finally {
    release();
  }
}

/**
 * What a sandbox for this workspace will hold, from its image's row alone:
 * the reservation's estimate before createConfigFor's checks run. Anything
 * the estimate cannot read falls back to the default, and the config step
 * reports the real problem.
 */
async function workspaceNeed(workspace: Workspace, kind: SandboxKind): Promise<SandboxNeed> {
  if (kind !== "container") return { memoryMb: 0, cpus: 0 };
  if (workspace.kind === "local" || !workspace.image) return DEFAULT_NEED;
  const { findImage, readLimits } = await import("../images/store.ts");
  const row = await findImage(workspace.image.id).catch(() => null);
  const limits = row?.ownerId === null ? readLimits(row.limits) : null;
  return limits ? { memoryMb: limits.memoryMb, cpus: limits.cpus } : DEFAULT_NEED;
}

/**
 * What to hand `provider.create` for this workspace.
 *
 * A github workspace clones as the **conversation owner** — their token,
 * added by the egress proxy, and their identity — never the sender.
 * Sandboxes are created lazily on first tool use, which may well be a shared
 * editor's, and the row's `ownerId` is the owner's for the same reason (see
 * below). No token enters the sandbox (sandbox/git.ts).
 */
async function createConfigFor(
  ownerId: string,
  conversationId: string,
  workspace: Workspace,
  kind: SandboxKind,
): Promise<CreateSandboxConfig> {
  if (workspace.kind === "local") {
    // The executor re-validates the path against its own roots on every
    // call; this is the request, and the owner check is the provider's.
    return {
      local: { executorId: workspace.executorId, path: workspace.path, isolation: workspace.isolation, ownerId },
    };
  }
  const image = workspace.image ? await imageConfigFor(ownerId, workspace, kind) : {};
  if (workspace.kind !== "github") return image;
  const connection = await getConnection(ownerId);
  if (!connection) {
    throw new Error(
      `This conversation's workspace is a GitHub repository (${workspace.repo}), but the owner's GitHub ` +
        "connection is gone. Reconnect GitHub in Settings, or start a new conversation.",
    );
  }
  return {
    ...image,
    repoUrl: workspace.cloneUrl,
    branch: workspace.baseBranch,
    newBranch: workspace.branch,
    git: {
      // The clone goes through the egress proxy as this conversation, which
      // adds the owner's token outside the sandbox (egress/env.ts).
      egress: { conversationId, ownerId },
      identity: {
        name: connection.name ?? connection.login,
        // GitHub's noreply form is what its own web UI commits as for a user
        // with a private email; it attributes correctly without exposing one.
        email: connection.email ?? `${connection.login}@users.noreply.github.com`,
      },
    },
  };
}

/**
 * The custom image a workspace runs in, re-checked every time a container is
 * made from it: the row may have been deleted, the policy narrowed, or (for a
 * personal image) it must still be the conversation *owner's* — never whoever
 * sent the message that is creating the sandbox. The container is made from
 * the row's pinned digest only, which its own pull proved access to.
 */
async function imageConfigFor(
  ownerId: string,
  workspace: Extract<Workspace, { kind: "scratch" | "github" }>,
  kind: SandboxKind,
): Promise<Pick<CreateSandboxConfig, "image" | "limits">> {
  const chosen = workspace.image;
  if (!chosen) return {};
  if (kind !== "container") {
    throw new Error(
      `This conversation runs in the image "${chosen.label}", which needs the container sandbox; ` +
        "this server's sandbox mode has changed since. Start a new conversation, or ask an admin.",
    );
  }
  const { customImagesBlocked, findImage, readLimits, DEFAULT_IMAGE_LIMITS, ensureImagePresent } = await import("../images/store.ts");
  const { useRefusal } = await import("../images/access.ts");
  // The engine can change after a pull too, and this path may pull again
  // (ensureImagePresent). On Podman a pull with no login can fall back to the
  // host's own, so the Docker-only rule is asked here as well as at pull time.
  const blocked = await customImagesBlocked();
  if (blocked) throw new Error(`This conversation's image "${chosen.label}" can't be used right now: ${blocked}`);
  const row = await findImage(chosen.id);
  const refusal = useRefusal(row, getSandboxSettings().customImages, ownerId, { github: workspace.kind === "github" });
  if (refusal || !row?.digest || row.uid === null || row.gid === null) {
    throw new Error(`This conversation's image "${chosen.label}" can't be used: ${refusal ?? "it has no good pull."}`);
  }
  const limits = row.ownerId === null ? (readLimits(row.limits) ?? DEFAULT_IMAGE_LIMITS) : DEFAULT_IMAGE_LIMITS;
  const digest = row.digest;
  return {
    image: {
      ref: digest,
      uid: row.uid,
      gid: row.gid,
      // A shared image's only: a personal row's limits are always the
      // defaults above, which never pass a device.
      ...(limits.kvm ? { kvm: true } : {}),
      ensure: async () => {
        const { sandboxEngine } = await import("../sandbox/container-provider.ts");
        const { docker } = await sandboxEngine();
        await ensureImagePresent(docker, row);
      },
    },
    limits: {
      memory: Math.round(limits.memoryMb * 1024 * 1024),
      cpu: Math.round(limits.cpus * 1e9),
      pids: limits.pids,
    },
  };
}

async function createEntryReserved(
  provider: SandboxProvider,
  ownerId: string,
  conversationId: string,
  config: CreateSandboxConfig,
): Promise<Entry> {
  // `ownerId` is the *conversation's* owner, never whoever triggered the tool
  // call — see the insert below for why, and createEntry for where it is
  // loaded. The clone credentials (in `config`) are the owner's too.
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
    .values(sandboxRowValues(provider.kind, ownerId, conversationId, handle.ref, config, {
      repoUrl: config.repoUrl ?? null,
      branch: config.newBranch ?? config.branch ?? null,
    }))
    .returning();

  const entry: Entry = { rowId: row.id, provider: provider.kind, ref: handle.ref, lastUsedAt: Date.now() };
  active.set(conversationId, entry);
  return entry;
}

/** A new sandbox row: what really ran (a custom image's pinned digest, or
 * Loxaic's own tag) and the limits it was given. */
function sandboxRowValues(
  kind: SandboxKind,
  ownerId: string,
  conversationId: string,
  ref: string,
  config: CreateSandboxConfig,
  checkout: { repoUrl: string | null; branch: string | null },
): typeof sandboxes.$inferInsert {
  return {
    ownerId,
    conversationId,
    containerId: ref,
    provider: kind,
    image: kind === "container" ? (config.image?.ref ?? sandboxImage()) : kind,
    status: "running",
    repoUrl: checkout.repoUrl,
    branch: checkout.branch,
    limits: {
      memory: Math.round((config.limits?.memory ?? 512 * 1024 * 1024) / (1024 * 1024)),
      cpu: (config.limits?.cpu ?? 1e9) / 1e9,
      ...(config.limits?.pids ? { pids: config.limits.pids } : {}),
      network: networkFor(kind),
    },
  };
}

/**
 * Moves a conversation to another image (#253): a new container from it,
 * with the old one's home directory copied across, and then the old one
 * destroyed. `next` is the workspace as it will be — the same one with only
 * its `image` changed. The caller holds the conversation's claim, so no run
 * can start meanwhile, and has checked the image is the owner's to use.
 *
 * With no sandbox yet there is nothing to move: only the workspace changes,
 * and the next tool call creates the container from it. Otherwise nothing
 * changes until the copy has landed and been checked, so a failure at any
 * step leaves the conversation exactly as it was, its old container included.
 *
 * What carries across is `/home/loxaic`: the checkout (its `.git` too, so a
 * GitHub branch keeps unpushed commits) and the file checkpoints under
 * `.loxaic`. What was installed outside it does not.
 */
export async function replaceConversationSandbox(
  conversationId: string,
  next: Workspace,
  signal?: AbortSignal,
): Promise<{ moved: boolean }> {
  if (next.kind === "local") throw new Error("A folder on your own machine always runs in Loxaic's own image.");
  const loaded = await loadWorkspace(conversationId);
  if (!loaded) throw new Error("That conversation no longer exists.");
  const { ownerId } = loaded;
  const stored = next.kind === "scratch" && !next.image ? null : next;
  const writeWorkspace = (tx: Pick<typeof db, "update"> = db) =>
    tx.update(conversations).set({ workspace: stored, updatedAt: new Date() }).where(eq(conversations.id, conversationId));

  // The row copied from and then destroyed must be the container the chat
  // is working in: the one this process is using, else a running one before
  // a paused one, newest first.
  const live = await db.query.sandboxes.findMany({
    where: and(
      eq(sandboxes.conversationId, conversationId),
      eq(sandboxes.ownerId, ownerId),
      inArray(sandboxes.status, ["running", "stopped"]),
    ),
    orderBy: [sql`${sandboxes.status} = 'running' desc`, desc(sandboxes.createdAt), desc(sandboxes.id)],
  });
  const inUse = active.get(conversationId)?.rowId;
  const existing = live.find((r) => r.id === inUse) ?? live.at(0);
  if (!existing) {
    await writeWorkspace();
    return { moved: false };
  }
  if (existing.provider !== "container") {
    throw new Error("This conversation's sandbox is not a container, so its image can't be changed.");
  }
  const { sandboxEngine } = await import("../sandbox/container-provider.ts");
  const { docker } = await sandboxEngine();
  // A row whose container is gone (the engine restarted, it was removed by
  // hand) has nothing to copy: recorded as gone, the switch is a workspace
  // change like the no-sandbox one above. Only the engine's own 404 counts;
  // an engine that did not answer is an error to retry, not a lost container.
  const gone = await docker.getContainer(existing.containerId).inspect().then(
    () => false,
    (err: unknown) => {
      if ((err as { statusCode?: number } | null)?.statusCode === 404) return true;
      throw err;
    },
  );
  if (gone) {
    await markDestroyed(existing.id);
    if (active.get(conversationId)?.rowId === existing.id) active.delete(conversationId);
    await writeWorkspace();
    return { moved: false };
  }

  const provider = await getProviderByKind("container");
  // The image and its limits only: the checkout comes across with the home
  // directory, so nothing is cloned again.
  const full = await createConfigFor(ownerId, conversationId, next, "container");
  const config: CreateSandboxConfig = {
    ...(full.image ? { image: full.image } : {}),
    ...(full.limits ? { limits: full.limits } : {}),
  };
  // The new container must fit the owner's allocation in place of the old
  // one, which stops once the new one is up — so a running old sandbox is left
  // out of what is counted, and a paused one never counted.
  const release = await reserveSandbox(ownerId, configNeed("container", config), existing.id);
  try {
    if (signal?.aborted) throw new Error("Stopped before the image was changed.");
    const handle = await provider.create(ownerId, config);
    let row: typeof sandboxes.$inferSelect;
    try {
      const owner = await handle.exec(["bash", "-c", "id -u; id -g"], { workdir: "/" });
      const [uid, gid] = owner.stdout.trim().split("\n").map(Number);
      if (owner.exitCode !== 0 || !Number.isInteger(uid) || !Number.isInteger(gid)) {
        throw new Error("The new image's user could not be read.");
      }
      const { copyHome } = await import("../sandbox/container-engine.ts");
      await copyHome(docker, existing.containerId, handle.ref, { uid, gid }, signal);
      const check = await handle.exec(["test", "-w", `${handle.root}/repo`], { workdir: "/" });
      if (check.exitCode !== 0) throw new Error("The copied workspace is not writable in the new image.");
      if (signal?.aborted) throw new Error("Stopped before the image was changed.");
      row = await db.transaction(async (tx) => {
        await writeWorkspace(tx);
        await tx.update(sandboxes).set({ status: "destroyed", stoppedAt: new Date() }).where(eq(sandboxes.id, existing.id));
        const [inserted] = await tx
          .insert(sandboxes)
          .values(sandboxRowValues("container", ownerId, conversationId, handle.ref, config, {
            repoUrl: existing.repoUrl,
            branch: existing.branch,
          }))
          .returning();
        return inserted;
      });
    } catch (err) {
      await handle.destroy();
      throw err;
    }
    active.set(conversationId, { rowId: row.id, provider: "container", ref: handle.ref, lastUsedAt: Date.now() });
    forgetOverflowWrites(existing.containerId);
    const old = await provider.attach(existing.containerId).catch(() => null);
    await old?.destroy().catch(() => undefined);
    return { moved: true };
  } finally {
    release();
  }
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

/**
 * Starts a sandbox's container and records it running, inside its owner's
 * allocation (#254). False when the container is gone.
 *
 * A row read as `stopped` is a wake: reserved first, and the reservation held
 * until the row says `running`, or the room would be free twice for a moment.
 * A row read as `running` is already counted, unless a Pause landed between
 * that read and this start; the conditional write below notices, and the
 * start becomes a wake like any other. Should recording it fail, a container
 * this call woke is stopped again: running with a `stopped` row, nothing
 * would ever count it.
 */
async function wake(
  handle: SandboxHandle,
  row: { id: string; provider: string; status?: string; ownerId?: string; limits?: unknown },
): Promise<boolean> {
  // Executor sandboxes hold nothing this server pays for.
  const owner = row.provider !== "executor" ? row.ownerId : undefined;
  let release = owner !== undefined && row.status === "stopped" ? await reserveSandbox(owner, rowNeed(row)) : undefined;
  try {
    if (!(await resume(handle))) return false;
    try {
      if (!release && owner !== undefined) {
        if (await touchRunning(row.id)) return true;
        release = await reserveSandbox(owner, rowNeed(row));
      }
      await markRunning(row.id);
    } catch (err) {
      if (release) await handle.stop().catch(() => undefined);
      throw err;
    }
    return true;
  } finally {
    release?.();
  }
}

/** Records a use of a row still `running`; false when it no longer is. */
async function touchRunning(rowId: string): Promise<boolean> {
  const rows = await db
    .update(sandboxes)
    .set({ lastUsedAt: new Date() })
    .where(and(eq(sandboxes.id, rowId), eq(sandboxes.status, "running")))
    .returning({ id: sandboxes.id });
  return rows.length > 0;
}

/** Not swallowed: a row that does not say `running` is a sandbox the
 * allocation cannot see, so the caller has to know the write failed. */
async function markRunning(rowId: string): Promise<void> {
  await db
    .update(sandboxes)
    .set({ status: "running", stoppedAt: null, lastUsedAt: new Date() })
    .where(eq(sandboxes.id, rowId));
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
 * Pauses one sandbox because its owner asked (#254), to free room in their
 * allocation: the same stop the idle timer makes, files kept, resumed by the
 * next tool call. The caller has checked the row is the requester's and holds
 * the conversation's claim, so no run can start while it stops; this only
 * acts on a running container, which is all an allocation counts.
 */
export async function pauseSandbox(row: {
  id: string;
  containerId: string;
  provider: string;
  conversationId: string | null;
}): Promise<void> {
  const entry = row.conversationId ? active.get(row.conversationId) : undefined;
  const mine = entry?.rowId === row.id ? entry : undefined;
  const provider = await getProviderByKind(row.provider as SandboxKind);
  // Not swallowed, unlike the idle timer's: a person pressed Pause, and an
  // engine that did not answer must not be reported as room freed.
  const handle = await provider.attach(row.containerId);
  // The row first, and only from `running`. The terminal, files and git
  // routes wake a sandbox without the conversation's claim; one that read
  // `running` before this and starts the container after it finds the row
  // `stopped` (wake()'s conditional write), and counts itself as a wake.
  // Stopping first and marking after would let that start land in between
  // and leave a running container behind a `stopped` row.
  const marked = await db
    .update(sandboxes)
    .set({
      status: "stopped",
      stoppedAt: new Date(),
      ...(mine ? { lastUsedAt: new Date(mine.lastUsedAt) } : {}),
    })
    .where(and(eq(sandboxes.id, row.id), eq(sandboxes.status, "running")))
    .returning({ id: sandboxes.id });
  if (marked.length === 0) return;
  if (mine && row.conversationId && active.get(row.conversationId) === mine) active.delete(row.conversationId);
  forgetOverflowWrites(row.containerId);
  try {
    await handle.stop();
  } catch (err) {
    // Still running: say so again, or the allocation stops counting it.
    await markRunning(row.id).catch(() => undefined);
    throw err;
  }
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
        // DB-wide query (unlike stopIdleSandboxes, which only ever touches
        // this process's own in-memory `active` map), so
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
    // First, while the workspace is still there to run it: a folder on the
    // person's own machine keeps its checkpoint copies in their home, which
    // `destroy` never touches. A machine that is offline keeps them — the
    // delete dialog says so.
    if (handle) {
      await dropConversationCopies(handle, conversationId).catch((err: unknown) => {
        console.warn(`could not remove the checkpoint copies of ${conversationId}: ${(err as Error).message}`);
      });
    }
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
