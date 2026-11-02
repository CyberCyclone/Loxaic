import type { SandboxChange } from "@loxaic/types";

/** What decides a sandbox's container. A part left out is unknown (a row that
 * predates recording it) or does not apply, and is never reported as changed. */
export interface SandboxSpec {
  memoryMb?: number;
  cpus?: number;
  network?: boolean;
  kvm?: boolean;
  /** A custom image's pinned digest. Loxaic's own image is left out: it moves
   * with every upgrade, and a banner on every chat would say nothing. */
  image?: string;
}

/** A sandbox row's `limits` and `image` as a spec. */
export function specOfRow(row: { limits: unknown; image: string }): SandboxSpec {
  const limits = (row.limits ?? {}) as { memory?: number; cpu?: number; network?: boolean; kvm?: boolean };
  return { memoryMb: limits.memory, cpus: limits.cpu, network: limits.network, kvm: limits.kvm, image: row.image };
}

/** How a sandbox made to `made` differs from one made to `now`. */
export function sandboxChanges(made: SandboxSpec, now: SandboxSpec): SandboxChange[] {
  const changes: SandboxChange[] = [];
  if (made.memoryMb !== undefined && now.memoryMb !== undefined && made.memoryMb !== now.memoryMb) {
    changes.push({ kind: "memory", fromMb: made.memoryMb, toMb: now.memoryMb });
  }
  if (made.cpus !== undefined && now.cpus !== undefined && made.cpus !== now.cpus) {
    changes.push({ kind: "cpus", from: made.cpus, to: now.cpus });
  }
  if (made.network !== undefined && now.network !== undefined && made.network !== now.network) {
    changes.push({ kind: "network", to: now.network });
  }
  if (made.kvm !== undefined && now.kvm !== undefined && made.kvm !== now.kvm) {
    changes.push({ kind: "kvm", to: now.kvm });
  }
  if (made.image !== undefined && now.image !== undefined && made.image !== now.image) {
    changes.push({ kind: "image" });
  }
  return changes;
}
