import { describe, expect, it } from 'vitest';
import { permissionBadge, permissionBarView, permissionCheckNote, runModeNote, splitMcpTool } from './permissionBar';

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

describe('bash approvals', () => {
  it('offers Allow always only with the server-proposed rules, and names them', () => {
    const view = permissionBarView({ tool: 'bash', mode: 'manual', granterUserId: ME, rules: ['gh pr create *'] }, ME);
    expect(view).toMatchObject({ canAllowAlways: true, alwaysLabel: 'Always allow `gh pr create *`', checkNote: null });
    expect(permissionBarView({ tool: 'bash', mode: 'manual', granterUserId: ME, rules: ['make *', 'npm test *'] }, ME).alwaysLabel).toBe(
      'Always allow `make *` and `npm test *`',
    );
  });

  it('offers no standing grant for the whole tool: no rules, no Allow always', () => {
    for (const rules of [undefined, []]) {
      expect(permissionBarView({ tool: 'bash', mode: 'manual', granterUserId: ME, rules }, ME)).toMatchObject({
        canAllowAlways: false,
        alwaysLabel: null,
      });
    }
  });

  it('offers it to nobody but the granter', () => {
    expect(permissionBarView({ tool: 'bash', granterUserId: 'other', rules: ['make *'] }, ME).canAllowAlways).toBe(false);
  });

  it('says why auto mode is asking', () => {
    const note = (check: Parameters<typeof permissionCheckNote>[0]) => permissionCheckNote(check);
    expect(note({ by: 'classifier', outcome: 'ask', reason: 'It pushes.' })).toBe("Auto mode's permission check asked you: It pushes.");
    expect(note({ by: 'classifier', outcome: 'timeout' })).toContain('took too long');
    expect(note({ by: 'classifier', outcome: 'unparseable' })).toContain('no clear answer');
    expect(note(undefined)).toBeNull();
    expect(permissionBarView({ tool: 'fs_write', check: { by: 'classifier', outcome: 'ask' } }, ME).checkNote).toContain('asking you');
  });

  it('names the asking run’s mode when the selector says another (#311), and keeps the check line', () => {
    const view = permissionBarView(
      { tool: 'bash', mode: 'manual', granterUserId: ME, check: { by: 'classifier', outcome: 'ask' } },
      ME,
      'planning',
    );
    expect(view.modeNote).toBe('This run is in Manual mode. Planning applies from your next message.');
    expect(view.checkNote).toContain('asking you');
    expect(permissionBarView({ tool: 'github__create_issue', mode: 'auto', granterUserId: ME }, ME, 'manual').modeNote).toBe(
      'This run is in Auto mode. Manual applies from your next message.',
    );
  });

  it('says nothing about the mode when the two agree, or either is unknown', () => {
    expect(permissionBarView({ tool: 'bash', mode: 'auto' }, ME, 'auto').modeNote).toBeNull();
    // An older server, which names no mode: never guessed from the selector.
    expect(permissionBarView({ tool: 'bash' }, ME, 'auto').modeNote).toBeNull();
    expect(permissionBarView({ tool: 'fs_write', mode: 'manual' }, ME).modeNote).toBeNull();
    expect(runModeNote('manual', undefined)).toBeNull();
  });
});

describe('permissionBadge', () => {
  it.each([
    [{ by: 'readonly' as const }, 'Read-only command · ran without asking'],
    [{ by: 'rule' as const, rule: 'npm test' }, 'Allowed by your rule `npm test`'],
    [{ by: 'isolated' as const }, 'Ran without asking · sandbox has no network'],
    [{ by: 'classifier' as const, reason: 'Runs tests.' }, 'Allowed by the permission check · Runs tests.'],
    [{ by: 'denied' as const, rule: 'rm *' }, 'Denied by your rule `rm *`'],
    [{ by: 'refused' as const }, 'Refused · planning mode runs only read-only commands'],
  ])('%j', (permission, text) => {
    expect(permissionBadge(permission)).toBe(text);
  });

  it('says nothing for a call someone approved', () => {
    expect(permissionBadge(undefined)).toBeNull();
  });
});
