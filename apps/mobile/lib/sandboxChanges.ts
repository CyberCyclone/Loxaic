/**
 * What a chat's sandbox has yet to pick up (the server's `pending_changes`),
 * in the words its banner uses. Pure.
 */
import type { SandboxChange } from '@loxaic/types';
import { formatCpus, formatMemory } from './sandboxAllocation';

export const RESTART_SANDBOX_NOTE =
  'Restarting stops anything running in this sandbox. Your files in /home/loxaic move to the new one; ' +
  'anything installed elsewhere does not. The next message re-reads the whole conversation once.';

const KNOWN = new Set<string>(['memory', 'cpus', 'network', 'kvm', 'image']);

/** The changes a chat's banner shows, from its sandbox rows: the server puts
 * them on the one a restart would replace, whichever that is. Kinds this build
 * doesn't know are left out, so a newer server's alone show no banner. */
export function pendingChangesOf(rows: { pending_changes?: SandboxChange[] }[]): SandboxChange[] {
  const changes = rows.find((row) => row.pending_changes?.length)?.pending_changes ?? [];
  return changes.filter((change) => KNOWN.has(change.kind));
}

function line(change: SandboxChange): string {
  switch (change.kind) {
    case 'memory':
      return `Memory ${formatMemory(change.fromMb)} → ${formatMemory(change.toMb)}`;
    case 'cpus':
      return `${formatCpus(change.from)} → ${formatCpus(change.to)}`;
    case 'network':
      return `Network ${change.to ? 'on' : 'off'}`;
    case 'kvm':
      return `Hardware virtualisation ${change.to ? 'on' : 'off'}`;
    case 'image':
      return 'A newer pull of its image';
  }
}

/** The changes on one line. A kind this build doesn't know says nothing, so an
 * older app on a newer server still shows the rest. */
export function sandboxChangesText(changes: SandboxChange[]): string {
  return changes.map(line).filter(Boolean).join(' · ');
}
