import { describe, expect, it } from 'vitest';
import type { McpServer } from '@loxaic/api-client';
import { applyToggle, carriesChoices, overridesToSend, switchRows, toggleTarget } from './mcpSwitches';

const server = (id: string, extra: Partial<McpServer> = {}): McpServer => ({
  id,
  ownerId: 'me',
  name: id.toUpperCase(),
  slug: id,
  transport: 'stdio',
  command: null,
  args: null,
  url: null,
  headers: null,
  env: null,
  builtinKey: null,
  enabled: true,
  allowPrivateNetwork: false,
  toolPolicies: {},
  knownTools: { a: 'h', b: 'h' },
  lastConnectedAt: null,
  lastError: null,
  createdAt: '',
  updatedAt: '',
  secretKeys: [],
  ...extra,
});

describe('switchRows', () => {
  it('lists only globally enabled servers, with their tool counts', () => {
    const rows = switchRows([server('gh'), server('off', { enabled: false })], 'chat', null);
    expect(rows.map((r) => [r.id, r.toolCount])).toEqual([['gh', 2]]);
  });

  it("follows the kind's default until the conversation chooses", () => {
    const gh = server('gh', { onInChat: false, onInAgent: true });
    expect(switchRows([gh], 'chat', null)[0]).toMatchObject({ on: false, explicit: false });
    expect(switchRows([gh], 'agent', null)[0]).toMatchObject({ on: true, explicit: false });
    expect(switchRows([gh], 'chat', { enabledServerIds: ['gh'] })[0]).toMatchObject({ on: true, explicit: true });
  });

  it('treats a server from before the defaults existed as on everywhere', () => {
    const old = server('old');
    for (const kind of ['chat', 'agent', 'routine'] as const) expect(switchRows([old], kind, null)[0].on).toBe(true);
  });
});

describe('toggleTarget', () => {
  it('holds choices for a conversation the server has not made yet', () => {
    expect(toggleTarget(null)).toBe('pending');
    expect(toggleTarget('c1790000000000')).toBe('pending');
    expect(toggleTarget('pending-ab12cd')).toBe('pending');
  });

  it('PATCHes one that exists', () => {
    expect(toggleTarget('0b8f4a7e-3c1d-4f2a-9e6b-5d4c3b2a1f0e')).toBe('patch');
  });
});

describe('applyToggle / overridesToSend', () => {
  it('records an explicit choice either way', () => {
    const off = applyToggle(null, 'gh', false);
    expect(off).toEqual({ disabledServerIds: ['gh'], enabledServerIds: [] });
    expect(applyToggle(off, 'gh', true)).toEqual({ disabledServerIds: [], enabledServerIds: ['gh'] });
  });

  it('sends nothing when nothing was chosen, so an ordinary send is unchanged', () => {
    expect(overridesToSend(null)).toBeUndefined();
    expect(overridesToSend({ disabledServerIds: [], enabledServerIds: [] })).toBeUndefined();
    expect(overridesToSend({ disabledServerIds: ['gh'] })).toEqual({ disabledServerIds: ['gh'] });
  });
});

describe('carriesChoices', () => {
  const REAL = '11111111-1111-4111-8111-111111111111';
  const OTHER = '22222222-2222-4222-8222-222222222222';

  it('carries the choices into the conversation the placeholder became', () => {
    expect(carriesChoices('c1790000000000', REAL, { localId: 'c1790000000000', realId: REAL })).toBe(true);
    expect(carriesChoices('pending-abc', REAL, { localId: 'pending-abc', realId: REAL })).toBe(true);
  });

  it('drops them when an unsent new chat is left for an existing thread', () => {
    expect(carriesChoices(null, OTHER, null)).toBe(false);
    // Even with an older promotion still on record.
    expect(carriesChoices(null, OTHER, { localId: 'c1', realId: OTHER })).toBe(false);
  });

  it('drops them when the thread is left while its send is still in flight', () => {
    expect(carriesChoices('c1', OTHER, null)).toBe(false);
    expect(carriesChoices('c1', OTHER, { localId: 'c1', realId: REAL })).toBe(false);
  });

  it('never carries on the first render', () => {
    expect(carriesChoices(undefined, REAL, { localId: 'c1', realId: REAL })).toBe(false);
  });
});
