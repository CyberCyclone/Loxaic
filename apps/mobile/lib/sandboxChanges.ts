/**
 * What a chat's sandbox has yet to pick up (the server's `pending_changes`),
 * in the words its banner uses. Pure.
 */
import type { SandboxChange } from '@loxaic/types';
import { formatCpus, formatMemory } from './sandboxAllocation';

export const RESTART_SANDBOX_NOTE =
  'Restarting stops anything running in this sandbox. Your files in /home/loxaic move to the new one; ' +
  'anything installed elsewhere does not. The next message re-reads the whole conversation once.';

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
