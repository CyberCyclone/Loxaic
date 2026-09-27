import { describe, expect, it } from 'vitest';
import type { ContextToolSource } from '@loxaic/types';
import type { McpSwitchRow } from './mcpSwitches';
import { toolSourceRows } from './toolSourceRows';

const sources: ContextToolSource[] = [
  { key: 'brave', kind: 'mcp', name: 'Brave', tools: 8, tokens: 11_000 },
  { key: 'builtin', kind: 'builtin', name: 'Built-in tools', tools: 8, tokens: 1_000 },
  { key: 'gh', kind: 'mcp', name: 'GitHub', tools: 45, tokens: 16_000 },
];

const sw = (id: string, on: boolean, name = id): McpSwitchRow => ({
  id,
  name,
  toolCount: 1,
  lastError: null,
  on,
  explicit: false,
});

describe('toolSourceRows', () => {
  it('puts builtins first, then servers by cost, with no notes while nothing changed', () => {
    const rows = toolSourceRows(sources, [sw('gh', true), sw('brave', true)]);
    expect(rows.map((r) => r.key)).toEqual(['builtin', 'gh', 'brave']);
    expect(rows.every((r) => r.note === null)).toBe(true);
    expect(rows[0]).toMatchObject({ on: null, switchable: false });
  });

  it('says what switching a server off will free from the next message', () => {
    const gh = toolSourceRows(sources, [sw('gh', false), sw('brave', true)]).find((r) => r.key === 'gh');
    expect(gh).toMatchObject({ on: false, switchable: true });
    expect(gh?.note).toBe(`Off · frees ~${(16_000).toLocaleString()} tokens from your next message`);
  });

  it('lists a server switched on since, with no figure yet', () => {
    const rows = toolSourceRows(sources, [sw('gh', true), sw('brave', true), sw('new', true, 'New')]);
    expect(rows.at(-1)).toMatchObject({ key: 'new', tokens: null, on: true, note: 'On · counted from your next message' });
  });

  it('does not list a server that is off and was not in the request', () => {
    expect(toolSourceRows(sources, [sw('gh', true), sw('brave', true), sw('quiet', false)]).map((r) => r.key)).not.toContain('quiet');
  });

  it('shows a server removed or disabled everywhere as off, with no switch', () => {
    const brave = toolSourceRows(sources, [sw('gh', true)]).find((r) => r.key === 'brave');
    expect(brave).toMatchObject({ on: false, switchable: false });
  });
});
