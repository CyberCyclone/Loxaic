import { describe, expect, it } from 'vitest';
import { permissionBarView, splitMcpTool } from './permissionBar';

const ME = 'user-me';

describe('splitMcpTool', () => {
  it('splits a namespaced MCP tool and leaves a builtin alone', () => {
    expect(splitMcpTool('github__create_issue')).toEqual({ server: 'github', tool: 'create_issue' });
    expect(splitMcpTool('fs_write')).toBeNull();
    expect(splitMcpTool('__odd')).toBeNull();
  });
});

describe('permissionBarView', () => {
  it('offers Allow always to the run\'s sender, with Allow once filled, in a manual run', () => {
    for (const tool of ['fs_write', 'github__create_issue']) {
      const view = permissionBarView({ tool, mode: 'manual', granterUserId: ME }, ME);
      expect(view).toMatchObject({ canAllowAlways: true, primary: 'once', note: null });
    }
  });

  it('fills Allow always and says why, for an MCP tool in an auto run', () => {
    const view = permissionBarView({ tool: 'github__create_issue', mode: 'auto', granterUserId: ME }, ME);
    expect(view.canAllowAlways).toBe(true);
    expect(view.primary).toBe('always');
    expect(view.note).toContain('create_issue from github');
    expect(view.note).toContain('every conversation and mode');
  });

  it('offers no standing grant to someone who did not send the run', () => {
    for (const mode of ['manual', 'auto'] as const) {
      const view = permissionBarView({ tool: 'github__create_issue', mode, granterUserId: 'the-owner' }, ME);
      expect(view).toMatchObject({ canAllowAlways: false, primary: 'once', note: null });
    }
  });

  it('offers none against a server that does not say whose grant it is', () => {
    expect(permissionBarView({ tool: 'github__create_issue' }, ME)).toMatchObject({
      canAllowAlways: false,
      primary: 'once',
      note: null,
    });
    // Nor when this device does not know who is signed in.
    expect(permissionBarView({ tool: 'fs_write', mode: 'manual', granterUserId: ME }, null).canAllowAlways).toBe(false);
  });
});
