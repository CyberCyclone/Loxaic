import type { AllocatedSandbox, SandboxAllocation, SandboxUsage } from '@loxaic/api-client';
import type { ToolNotice } from '@loxaic/types';

/**
 * Everything the Sandboxes screen and the admin allocation controls decide
 * (#254), kept pure so it is unit-tested: how a figure reads, how full a bar
 * is, what a row may do, and what an admin typed.
 */

/** The same wording as the server's refusal (apps/server/src/agent/allocation.ts),
 * so the screen and the message a run got never disagree on a number. */
export function formatMemory(mb: number): string {
  if (mb < 1024) return `${String(Math.round(mb))} MB`;
  const gb = mb / 1024;
  return `${Number.isInteger(gb) ? String(gb) : gb.toFixed(1)} GB`;
}

export function formatCpus(cpus: number): string {
  const rounded = Math.round(cpus * 100) / 100;
  return `${String(rounded)} CPU${rounded === 1 ? '' : 's'}`;
}

export type AllocationBarKey = 'memory' | 'cpus' | 'running';

export interface AllocationBar {
  key: AllocationBarKey;
  label: string;
  /** "1 GB of 2.5 GB". */
  value: string;
  /** 0..1, for the bar's width; capped, since a lowered allocation can leave
   * a user over it. */
  fraction: number;
  /** Nothing more fits on this measure. */
  full: boolean;
}

function fraction(used: number, total: number): number {
  if (total <= 0) return 1;
  return Math.min(1, Math.max(0, used / total));
}

export function allocationBars(allocation: SandboxAllocation, used: SandboxUsage): AllocationBar[] {
  return [
    {
      key: 'memory',
      label: 'Memory',
      value: `${formatMemory(used.memoryMb)} of ${formatMemory(allocation.memoryMb)}`,
      fraction: fraction(used.memoryMb, allocation.memoryMb),
      full: used.memoryMb >= allocation.memoryMb,
    },
    {
      key: 'cpus',
      label: 'CPUs',
      value: `${formatCpus(used.cpus)} of ${formatCpus(allocation.cpus)}`,
      fraction: fraction(used.cpus, allocation.cpus),
      full: used.cpus >= allocation.cpus,
    },
    {
      key: 'running',
      label: 'Running',
      value: `${String(used.running)} of ${String(allocation.maxRunning)}`,
      fraction: fraction(used.running, allocation.maxRunning),
      full: used.running >= allocation.maxRunning,
    },
  ];
}

/** Loxaic's own sandbox: what most new chats start. */
const DEFAULT_SANDBOX = { memoryMb: 512, cpus: 1 };

/**
 * Whether another sandbox of Loxaic's own image would start now. When it
 * would not, the screen says to pause one: the case a person reaches this
 * screen from. A larger image may still not fit when this says it would; the
 * refusal that chat got says so with its own numbers.
 */
export function roomForAnother(allocation: SandboxAllocation, used: SandboxUsage): boolean {
  return (
    used.running + 1 <= allocation.maxRunning &&
    Math.round((used.memoryMb + DEFAULT_SANDBOX.memoryMb) * 100) <= Math.round(allocation.memoryMb * 100) &&
    Math.round((used.cpus + DEFAULT_SANDBOX.cpus) * 100) <= Math.round(allocation.cpus * 100)
  );
}

/** Where a person's allocation comes from, in a line. */
export function allocationSource(overridden: Record<keyof SandboxAllocation, boolean>): string {
  return overridden.memoryMb || overridden.cpus || overridden.maxRunning
    ? 'An administrator set this allocation for you.'
    : 'This is the default allocation for everyone on this server.';
}

export type RowAction =
  | { kind: 'pause' }
  /** A run is using it: Pause comes back when it ends. */
  | { kind: 'busy' }
  /** Paused already: the next message in its chat starts it. */
  | { kind: 'paused' }
  /** A host sandbox: nothing to pause, and nothing it holds is counted. */
  | { kind: 'host' };

export function rowAction(sandbox: Pick<AllocatedSandbox, 'provider' | 'status' | 'busy'>): RowAction {
  if (sandbox.status === 'stopped') return { kind: 'paused' };
  if (sandbox.provider !== 'container') return { kind: 'host' };
  return sandbox.busy ? { kind: 'busy' } : { kind: 'pause' };
}

/** What a row says it holds. A host sandbox holds nothing that is counted. */
export function rowSize(sandbox: Pick<AllocatedSandbox, 'provider' | 'memory_mb' | 'cpus'>): string {
  if (sandbox.provider !== 'container') return 'Runs directly on the server';
  return `${formatMemory(sandbox.memory_mb)} · ${formatCpus(sandbox.cpus)}`;
}

/** Running first, then paused; newest use first within each. */
export function orderSandboxes(rows: AllocatedSandbox[]): AllocatedSandbox[] {
  return [...rows].sort((a, b) => {
    if (a.status !== b.status) return a.status === 'running' ? -1 : 1;
    return b.last_used_at.localeCompare(a.last_used_at);
  });
}

/** The server's bounds (settings.ts ALLOCATION_BOUNDS); memory is typed in GB. */
export const ALLOCATION_INPUT_BOUNDS = {
  memoryGb: { min: 0.25, max: 1024 },
  cpus: { min: 0.25, max: 256 },
  maxRunning: { min: 1, max: 100 },
} as const;

/** What an admin typed into the three allocation fields. An empty field
 * means "the default" for a user's override, and "unchanged" for the
 * default itself; the caller decides which. */
export interface AllocationDraft {
  memoryGb: string;
  cpus: string;
  maxRunning: string;
}

export type ParsedAllocation =
  | { ok: true; value: Partial<Record<keyof SandboxAllocation, number | null>> }
  | { ok: false; field: keyof AllocationDraft; error: string };

/**
 * Reads the admin's fields into an allocation patch. Each field is a number
 * within the server's bounds, or empty (→ `null`). Memory is typed in GB and
 * sent in whole MB, as the server stores it.
 */
export function parseAllocationDraft(draft: AllocationDraft): ParsedAllocation {
  const value: Partial<Record<keyof SandboxAllocation, number | null>> = {};
  const memory = draft.memoryGb.trim();
  if (memory === '') value.memoryMb = null;
  else {
    const gb = Number(memory);
    const { min, max } = ALLOCATION_INPUT_BOUNDS.memoryGb;
    if (!Number.isFinite(gb) || gb < min || gb > max) {
      return { ok: false, field: 'memoryGb', error: `Memory must be between ${String(min)} and ${String(max)} GB.` };
    }
    value.memoryMb = Math.round(gb * 1024);
  }
  const cpus = draft.cpus.trim();
  if (cpus === '') value.cpus = null;
  else {
    const n = Number(cpus);
    const { min, max } = ALLOCATION_INPUT_BOUNDS.cpus;
    if (!Number.isFinite(n) || n < min || n > max) {
      return { ok: false, field: 'cpus', error: `CPUs must be between ${String(min)} and ${String(max)}.` };
    }
    value.cpus = n;
  }
  const running = draft.maxRunning.trim();
  if (running === '') value.maxRunning = null;
  else {
    const n = Number(running);
    const { min, max } = ALLOCATION_INPUT_BOUNDS.maxRunning;
    if (!Number.isInteger(n) || n < min || n > max) {
      return {
        ok: false,
        field: 'maxRunning',
        error: `Running sandboxes must be a whole number from ${String(min)} to ${String(max)}.`,
      };
    }
    value.maxRunning = n;
  }
  return { ok: true, value };
}

/** The fields an admin edits, filled from an allocation (GB for memory). */
export function draftFrom(allocation: Partial<SandboxAllocation>): AllocationDraft {
  return {
    memoryGb: allocation.memoryMb === undefined ? '' : String(Math.round((allocation.memoryMb / 1024) * 100) / 100),
    cpus: allocation.cpus === undefined ? '' : String(allocation.cpus),
    maxRunning: allocation.maxRunning === undefined ? '' : String(allocation.maxRunning),
  };
}

/** One line summing up a user's allocation for the admin list. */
export function allocationSummary(allocation: SandboxAllocation, used: SandboxUsage): string {
  return (
    `${formatMemory(allocation.memoryMb)} · ${formatCpus(allocation.cpus)} · ` +
    `${String(used.running)} of ${String(allocation.maxRunning)} running`
  );
}

/** What a tool card says when its sandbox was refused for the allocation
 * (#254): the full text is in the result; this is the line beside the way out. */
export function allocationNoticeText(reason: ToolNotice['reason']): string {
  return reason === 'too_big'
    ? 'This sandbox is larger than your whole allocation. Only an administrator can raise it.'
    : 'Your sandbox allocation is full. Pause a sandbox to make room, then try again.';
}
