import { describe, expect, it } from 'vitest';
import type { AllocatedSandbox } from '@loxaic/api-client';
import {
  allocationBars,
  allocationNoticeText,
  allocationSource,
  allocationSummary,
  anyOverridden,
  changedParts,
  draftFrom,
  followSaved,
  inspectorLinkPlan,
  formatCpus,
  formatMemory,
  orderSandboxes,
  parseAllocationDraft,
  pollsIn,
  roomForAnother,
  rowAction,
  rowSize,
} from './sandboxAllocation';

const allocation = { memoryMb: 2560, cpus: 5, maxRunning: 5 };

describe('figures', () => {
  it('reads memory in MB below a GB and GB above, as the server words it', () => {
    expect(formatMemory(512)).toBe('512 MB');
    expect(formatMemory(2560)).toBe('2.5 GB');
    expect(formatMemory(16_384)).toBe('16 GB');
  });

  it('reads CPUs with the right plural and no float noise', () => {
    expect(formatCpus(1)).toBe('1 CPU');
    expect(formatCpus(0.1 + 0.2)).toBe('0.3 CPUs');
    expect(formatCpus(5)).toBe('5 CPUs');
  });
});

describe('allocationBars', () => {
  it('shows each measure against the allocation', () => {
    const bars = allocationBars(allocation, { running: 2, memoryMb: 1024, cpus: 2 });
    expect(bars.map((b) => [b.key, b.value, b.fraction, b.full])).toEqual([
      ['memory', '1 GB of 2.5 GB', 0.4, false],
      ['cpus', '2 CPUs of 5 CPUs', 0.4, false],
      ['running', '2 of 5', 0.4, false],
    ]);
  });

  it('caps a bar at full when a lowered allocation leaves the user over it', () => {
    const [memory, , running] = allocationBars({ memoryMb: 1024, cpus: 5, maxRunning: 1 }, { running: 3, memoryMb: 1536, cpus: 3 });
    expect(memory.fraction).toBe(1);
    expect(memory.full).toBe(true);
    expect(running.value).toBe('3 of 1');
  });
});

describe('roomForAnother', () => {
  it('says yes while one more default sandbox fits', () => {
    expect(roomForAnother(allocation, { running: 4, memoryMb: 2048, cpus: 4 })).toBe(true);
  });

  it('says no once the count, memory or CPUs would be passed', () => {
    expect(roomForAnother(allocation, { running: 5, memoryMb: 0, cpus: 0 })).toBe(false);
    expect(roomForAnother(allocation, { running: 1, memoryMb: 2100, cpus: 1 })).toBe(false);
    expect(roomForAnother(allocation, { running: 1, memoryMb: 512, cpus: 4.5 })).toBe(false);
  });
});

describe('allocationSource', () => {
  it('names an admin only when one set any part of it', () => {
    expect(allocationSource({ memoryMb: false, cpus: false, maxRunning: false })).toContain('default allocation');
    expect(allocationSource({ memoryMb: true, cpus: false, maxRunning: false })).toContain('administrator set');
  });
});

describe('a row', () => {
  const row = (over: Partial<AllocatedSandbox>): AllocatedSandbox => ({
    id: 's1',
    conversation_id: 'c1',
    title: 'Chat',
    provider: 'container',
    status: 'running',
    memory_mb: 512,
    cpus: 1,
    last_used_at: '2026-10-22T00:00:00.000Z',
    busy: false,
    ...over,
  });

  it('offers Pause only on an idle running container', () => {
    expect(rowAction(row({}))).toEqual({ kind: 'pause' });
    expect(rowAction(row({ busy: true }))).toEqual({ kind: 'busy' });
    expect(rowAction(row({ status: 'stopped' }))).toEqual({ kind: 'paused' });
    expect(rowAction(row({ provider: 'host' }))).toEqual({ kind: 'host' });
  });

  it('says what a container holds, and that a host one holds nothing counted', () => {
    expect(rowSize(row({ memory_mb: 16_384, cpus: 8 }))).toBe('16 GB · 8 CPUs');
    expect(rowSize(row({ provider: 'host' }))).toBe('Runs directly on the server');
  });

  it('lists running before paused, newest use first', () => {
    const ordered = orderSandboxes([
      row({ id: 'old-paused', status: 'stopped', last_used_at: '2026-10-01T00:00:00.000Z' }),
      row({ id: 'old-running', last_used_at: '2026-10-02T00:00:00.000Z' }),
      row({ id: 'new-paused', status: 'stopped', last_used_at: '2026-10-20T00:00:00.000Z' }),
      row({ id: 'new-running', last_used_at: '2026-10-21T00:00:00.000Z' }),
    ]);
    expect(ordered.map((r) => r.id)).toEqual(['new-running', 'old-running', 'new-paused', 'old-paused']);
  });
});

describe('parseAllocationDraft', () => {
  it('reads GB into whole MB and keeps fractional CPUs', () => {
    expect(parseAllocationDraft({ memoryGb: '16', cpus: '2.5', maxRunning: '3' })).toEqual({
      ok: true,
      value: { memoryMb: 16_384, cpus: 2.5, maxRunning: 3 },
    });
    expect(parseAllocationDraft({ memoryGb: '0.5', cpus: '1', maxRunning: '1' })).toEqual({
      ok: true,
      value: { memoryMb: 512, cpus: 1, maxRunning: 1 },
    });
  });

  it('reads an empty field as the default', () => {
    expect(parseAllocationDraft({ memoryGb: ' ', cpus: '', maxRunning: '' })).toEqual({
      ok: true,
      value: { memoryMb: null, cpus: null, maxRunning: null },
    });
  });

  it('refuses what the server would, naming the field', () => {
    expect(parseAllocationDraft({ memoryGb: '0.1', cpus: '', maxRunning: '' })).toMatchObject({ ok: false, field: 'memoryGb' });
    expect(parseAllocationDraft({ memoryGb: 'lots', cpus: '', maxRunning: '' })).toMatchObject({ ok: false, field: 'memoryGb' });
    expect(parseAllocationDraft({ memoryGb: '', cpus: '0', maxRunning: '' })).toMatchObject({ ok: false, field: 'cpus' });
    expect(parseAllocationDraft({ memoryGb: '', cpus: '', maxRunning: '1.5' })).toMatchObject({ ok: false, field: 'maxRunning' });
    expect(parseAllocationDraft({ memoryGb: '', cpus: '', maxRunning: '101' })).toMatchObject({ ok: false, field: 'maxRunning' });
  });
});

describe('draftFrom and allocationSummary', () => {
  it('fills the fields in the units they are typed in, blank where absent', () => {
    expect(draftFrom(allocation)).toEqual({ memoryGb: '2.5', cpus: '5', maxRunning: '5' });
    expect(draftFrom({ cpus: 8 })).toEqual({ memoryGb: '', cpus: '8', maxRunning: '' });
  });

  it('sums a user up in one line', () => {
    expect(allocationSummary(allocation, { running: 1, memoryMb: 512, cpus: 1 })).toBe('2.5 GB · 5 CPUs · 1 of 5 running');
  });
});

describe('allocationNoticeText', () => {
  it('sends a full allocation to Pause, and a too-big sandbox to an administrator', () => {
    expect(allocationNoticeText('count')).toContain('Pause a sandbox');
    expect(allocationNoticeText('memory')).toContain('Pause a sandbox');
    expect(allocationNoticeText('too_big')).toContain('Only an administrator');
  });
});

describe('anyOverridden', () => {
  it('is true when an admin set any one part, and false when none', () => {
    const none = { memoryMb: false, cpus: false, maxRunning: false };
    expect(anyOverridden(none)).toBe(false);
    expect(anyOverridden({ ...none, memoryMb: true })).toBe(true);
    expect(anyOverridden({ ...none, cpus: true })).toBe(true);
    expect(anyOverridden({ ...none, maxRunning: true })).toBe(true);
  });
});

describe('a pinned running count', () => {
  it('is neither checked nor sent, whatever the field shows', () => {
    // SANDBOX_MAX_PER_USER=200: above what an admin could type.
    const parsed = parseAllocationDraft({ memoryGb: '4', cpus: '2', maxRunning: '200' }, { maxRunningPinned: true });
    expect(parsed).toEqual({ ok: true, value: { memoryMb: 4096, cpus: 2 } });
  });

  it('is still checked when nothing pins it', () => {
    expect(parseAllocationDraft({ memoryGb: '4', cpus: '2', maxRunning: '200' }).ok).toBe(false);
  });
});

describe('changedParts', () => {
  const opened = { memoryGb: '', cpus: '2', maxRunning: '' };

  it('sends only the fields typed since the dialog opened', () => {
    const draft = { memoryGb: '', cpus: '4', maxRunning: '' };
    const parsed = parseAllocationDraft(draft);
    if (!parsed.ok) throw new Error('parse');
    // Memory and running are untouched: another admin's override of either survives.
    expect(changedParts(opened, draft, parsed.value)).toEqual({ cpus: 4 });
  });

  it('sends a cleared field as null, to put it back on the default', () => {
    const draft = { memoryGb: '', cpus: '', maxRunning: '' };
    const parsed = parseAllocationDraft(draft);
    if (!parsed.ok) throw new Error('parse');
    expect(changedParts(opened, draft, parsed.value)).toEqual({ cpus: null });
  });

  it('sends nothing when nothing changed, spaces aside', () => {
    const draft = { memoryGb: ' ', cpus: '2 ', maxRunning: '' };
    const parsed = parseAllocationDraft(draft);
    if (!parsed.ok) throw new Error('parse');
    expect(changedParts(opened, draft, parsed.value)).toEqual({});
  });

  it('never sends a pinned count, even if its field changed', () => {
    const draft = { memoryGb: '', cpus: '2', maxRunning: '9' };
    const parsed = parseAllocationDraft(draft, { maxRunningPinned: true });
    if (!parsed.ok) throw new Error('parse');
    expect(changedParts(opened, draft, parsed.value)).toEqual({});
  });
});

describe('followSaved', () => {
  const was = { memoryGb: '2.5', cpus: '5', maxRunning: '5' };
  const now = { memoryGb: '4', cpus: '5', maxRunning: '5' };

  it('follows a new saved value when nothing was typed', () => {
    expect(followSaved(was, was, now)).toEqual({ draft: now, baseline: now });
  });

  it('keeps what is being typed when the saved value changes under it', () => {
    const typing = { ...was, cpus: '8' };
    expect(followSaved(typing, was, now)).toEqual({ draft: typing, baseline: now });
  });
});

describe('inspectorLinkPlan', () => {
  it('closes the sheet first on a phone, and opens the screen once it has gone', () => {
    expect(inspectorLinkPlan(false, 300)).toEqual({ close: true, delayMs: 300 });
  });

  it('leaves the side panel open, and opens the screen at once', () => {
    expect(inspectorLinkPlan(true, 300)).toEqual({ close: false, delayMs: 0 });
  });
});

describe('pollsIn', () => {
  it('polls only in the foreground', () => {
    expect(pollsIn('active')).toBe(true);
    expect(pollsIn('background')).toBe(false);
    expect(pollsIn('inactive')).toBe(false);
  });
});
