import { describe, expect, it } from 'vitest';
import type { SandboxChange } from '@loxaic/types';
import { sandboxChangesText } from './sandboxChanges';

describe('sandboxChangesText', () => {
  it('says what each change is', () => {
    expect(sandboxChangesText([{ kind: 'memory', fromMb: 512, toMb: 32_768 }])).toBe('Memory 512 MB → 32 GB');
    expect(sandboxChangesText([{ kind: 'cpus', from: 1, to: 6 }])).toBe('1 CPU → 6 CPUs');
    expect(sandboxChangesText([{ kind: 'network', to: true }])).toBe('Network on');
    expect(sandboxChangesText([{ kind: 'network', to: false }])).toBe('Network off');
    expect(sandboxChangesText([{ kind: 'kvm', to: true }])).toBe('Hardware virtualisation on');
    expect(sandboxChangesText([{ kind: 'image' }])).toBe('A newer pull of its image');
  });

  it('puts several on one line, in the order given', () => {
    expect(sandboxChangesText([{ kind: 'memory', fromMb: 768, toMb: 1024 }, { kind: 'image' }])).toBe('Memory 768 MB → 1 GB · A newer pull of its image');
  });

  it('leaves out a kind this build does not know', () => {
    const newer = { kind: 'gpu' } as unknown as SandboxChange;
    expect(sandboxChangesText([newer, { kind: 'image' }])).toBe('A newer pull of its image');
  });
});
