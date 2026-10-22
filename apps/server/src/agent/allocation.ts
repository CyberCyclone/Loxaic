import { and, db, eq, isNull } from "@loxaic/db";
import { userSandboxAllocations } from "@loxaic/db/schema";
import {
  AllocationPatchError,
  getSandboxSettings,
  parseAllocationPatch,
  type SandboxAllocation,
} from "../settings.ts";

/**
 * Per-user sandbox allocations (#254): what one user's running sandboxes may
 * hold together. The decision is pure (`allocationDecision`); the manager
 * (sandbox-manager.ts) supplies what is running and reserved, and refuses with
 * `SandboxLimitError` when the answer is no. Nothing here pauses anything —
 * an over-allocated user is told, and chooses what to pause.
 */

/** What one sandbox holds while it runs. */
export interface SandboxNeed {
  memoryMb: number;
  cpus: number;
}

/** What a user's running (and about-to-run) sandboxes hold together. */
export interface AllocationUsage {
  running: number;
  memoryMb: number;
  cpus: number;
}

export type AllocationReason = "too_big" | "count" | "memory" | "cpus";

export type AllocationDecision = { ok: true } | { ok: false; reason: AllocationReason };

/** Container limits are set in whole bytes and nano-CPUs, and summed here as
 * MB and CPUs; comparing at a hundredth of a CPU keeps 0.1 + 0.2 from being
 * refused as over 0.3. */
function over(total: number, limit: number): boolean {
  return Math.round(total * 100) > Math.round(limit * 100);
}

/**
 * Whether one more sandbox needing `need` fits beside `used`.
 *
 * "Too big" comes first: a sandbox larger than the whole allocation can never
 * start, however much is paused, and telling the user to pause something
 * would send them looking for room that cannot exist.
 */
export function allocationDecision(used: AllocationUsage, need: SandboxNeed, allocation: SandboxAllocation): AllocationDecision {
  if (over(need.memoryMb, allocation.memoryMb) || over(need.cpus, allocation.cpus)) return { ok: false, reason: "too_big" };
  if (used.running + 1 > allocation.maxRunning) return { ok: false, reason: "count" };
  if (over(used.memoryMb + need.memoryMb, allocation.memoryMb)) return { ok: false, reason: "memory" };
  if (over(used.cpus + need.cpus, allocation.cpus)) return { ok: false, reason: "cpus" };
  return { ok: true };
}

/** What a sandbox row holds while it runs, read from the limits it recorded
 * at creation. Only containers have their memory and CPU enforced, so only
 * they spend it; a host sandbox still counts towards the number running. */
export function rowNeed(row: { provider: string; limits?: unknown }): SandboxNeed {
  if (row.provider !== "container") return { memoryMb: 0, cpus: 0 };
  const limits = (typeof row.limits === "object" && row.limits !== null ? row.limits : {}) as Record<string, unknown>;
  return {
    memoryMb: typeof limits.memory === "number" ? limits.memory : DEFAULT_NEED.memoryMb,
    cpus: typeof limits.cpu === "number" ? limits.cpu : DEFAULT_NEED.cpus,
  };
}

/** Adds one sandbox's need to a usage, in place. */
export function addNeed(usage: AllocationUsage, need: SandboxNeed): AllocationUsage {
  usage.running++;
  usage.memoryMb += need.memoryMb;
  usage.cpus += need.cpus;
  return usage;
}

/** What these running rows hold together: the one sum the check, the
 * Sandboxes screen and the admin list all use. */
export function usageOf(rows: { provider: string; limits?: unknown }[]): AllocationUsage {
  const usage: AllocationUsage = { running: 0, memoryMb: 0, cpus: 0 };
  for (const row of rows) addNeed(usage, rowNeed(row));
  return usage;
}

/** A container with no limits of its own: container-engine.ts's defaults. */
export const DEFAULT_NEED: SandboxNeed = { memoryMb: 512, cpus: 1 };

export function formatMemory(mb: number): string {
  if (mb < 1024) return `${String(Math.round(mb))} MB`;
  const gb = mb / 1024;
  return `${Number.isInteger(gb) ? String(gb) : gb.toFixed(1)} GB`;
}

export function formatCpus(cpus: number): string {
  const rounded = Math.round(cpus * 100) / 100;
  return `${String(rounded)} CPU${rounded === 1 ? "" : "s"}`;
}

const PAUSE_HINT = "Pause one in Settings → Sandboxes, or ask an admin to raise your allocation.";

/** The refusal, in words that name the numbers and what to do. It is also
 * what the model reads, so it says plainly that a person has to act. */
export function allocationMessage(
  reason: AllocationReason,
  used: AllocationUsage,
  need: SandboxNeed,
  allocation: SandboxAllocation,
): string {
  switch (reason) {
    case "too_big":
      return (
        `This sandbox needs ${formatMemory(need.memoryMb)} and ${formatCpus(need.cpus)}, more than your whole ` +
        `sandbox allocation (${formatMemory(allocation.memoryMb)}, ${formatCpus(allocation.cpus)}). ` +
        "Ask an admin to raise your allocation."
      );
    case "count":
      // Against the allocation's number, never "which is your allocation":
      // an admin may have lowered it below what is already running, and the
      // count includes starts still on their way.
      return (
        `You have ${String(used.running)} sandbox${used.running === 1 ? "" : "es"} running or starting, and your ` +
        `allocation allows ${String(allocation.maxRunning)}. ${PAUSE_HINT}`
      );
    case "memory":
      return (
        `Your running sandboxes use ${formatMemory(used.memoryMb)} of the ${formatMemory(allocation.memoryMb)} of ` +
        `memory in your allocation, and this one needs ${formatMemory(need.memoryMb)}. ${PAUSE_HINT}`
      );
    case "cpus":
      return (
        `Your running sandboxes use ${formatCpus(used.cpus)} of the ${formatCpus(allocation.cpus)} in your ` +
        `allocation, and this one needs ${formatCpus(need.cpus)}. ${PAUSE_HINT}`
      );
  }
}

/** One user's allocation as resolved, and which parts an admin set for them. */
export interface ResolvedAllocation {
  allocation: SandboxAllocation;
  overridden: Record<keyof SandboxAllocation, boolean>;
}

/**
 * A user's allocation from their override row (absent: none) and the
 * server-wide default: each part an admin set, the default for the rest.
 * `SANDBOX_MAX_PER_USER` pins the count for everyone, overrides included —
 * an env pin is the operator speaking. Pure, so the admin list and the check
 * resolve one way.
 */
export function resolveAllocation(
  row: { memoryMb: number | null; cpus: number | null; maxRunning: number | null } | undefined,
  fallback: SandboxAllocation,
  countPinned: boolean,
): ResolvedAllocation {
  const memoryMb = row?.memoryMb ?? null;
  const cpus = row?.cpus ?? null;
  const maxRunning = countPinned ? null : (row?.maxRunning ?? null);
  return {
    allocation: {
      memoryMb: memoryMb ?? fallback.memoryMb,
      cpus: cpus ?? fallback.cpus,
      maxRunning: maxRunning ?? fallback.maxRunning,
    },
    overridden: { memoryMb: memoryMb !== null, cpus: cpus !== null, maxRunning: maxRunning !== null },
  };
}

export async function allocationFor(userId: string): Promise<ResolvedAllocation> {
  const settings = getSandboxSettings();
  const row = await db.query.userSandboxAllocations.findFirst({ where: eq(userSandboxAllocations.userId, userId) });
  return resolveAllocation(row, settings.allocation, settings.envOverrides.maxRunning);
}

export class AllocationInputError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "AllocationInputError";
    this.status = status;
  }
}

/**
 * Sets an admin's override for one user. Each field is a value, `null` to
 * follow the default again, or absent to leave as it is; a row whose fields
 * are all null is deleted, so "no row" stays the one way to say "default".
 */
export async function setAllocationOverride(userId: string, input: unknown): Promise<ResolvedAllocation> {
  let patch: Partial<Record<keyof SandboxAllocation, number | null>>;
  try {
    patch = parseAllocationPatch(input, { allowNull: true });
  } catch (err) {
    if (err instanceof AllocationPatchError) throw new AllocationInputError(err.message, err.pinned ? 409 : 400);
    throw err;
  }
  const now = new Date();
  // One statement, so two admins saving different fields at once both land.
  const [row] = await db
    .insert(userSandboxAllocations)
    .values({ userId, memoryMb: null, cpus: null, maxRunning: null, ...patch, updatedAt: now })
    .onConflictDoUpdate({ target: userSandboxAllocations.userId, set: { ...patch, updatedAt: now } })
    .returning();
  if (row.memoryMb === null && row.cpus === null && row.maxRunning === null) {
    // Conditional, so an override another admin saved in between survives.
    await db
      .delete(userSandboxAllocations)
      .where(
        and(
          eq(userSandboxAllocations.userId, userId),
          isNull(userSandboxAllocations.memoryMb),
          isNull(userSandboxAllocations.cpus),
          isNull(userSandboxAllocations.maxRunning),
        ),
      );
  }
  return allocationFor(userId);
}

export async function clearAllocationOverride(userId: string): Promise<void> {
  await db.delete(userSandboxAllocations).where(eq(userSandboxAllocations.userId, userId));
}
