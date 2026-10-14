import { describe, expect, it } from 'vitest';
import type { PaletteSkill } from '@loxaic/api-client';
import { bumpSkill, filterSkills, skillNamed } from './skillPalette';

const skill = (name: string, description = '', uses = 0): PaletteSkill => ({ name, description, source: 'builtin', uses });

/** The server's order is most-used first; these pin what the client does with it. */
const LIST = [
  skill('debug', 'Find the root cause of a bug', 5),
  skill('code-review', 'Review code changes for bugs', 2),
  skill('security-review', 'Review code for vulnerabilities', 1),
  skill('commit', 'Commit work with git'),
  skill('pr-description', 'Write a pull request description; review the diff first'),
];

describe('filterSkills', () => {
  it('lists everything, in the server order, for a bare slash', () => {
    expect(filterSkills(LIST, '').map((s) => s.name)).toEqual(LIST.map((s) => s.name));
  });

  it('ranks name prefixes, then names containing it, then descriptions, keeping the order in each', () => {
    expect(filterSkills(LIST, 'rev').map((s) => s.name)).toEqual(['code-review', 'security-review', 'pr-description']);
    expect(filterSkills(LIST, 'co').map((s) => s.name)).toEqual(['code-review', 'commit', 'security-review']);
  });

  it('ignores case and lists nothing when nothing matches', () => {
    expect(filterSkills(LIST, 'DEB').map((s) => s.name)).toEqual(['debug']);
    expect(filterSkills(LIST, 'zzz')).toEqual([]);
  });
});

describe('bumpSkill', () => {
  it('moves a skill up as its count passes others, ahead of those it ties with', () => {
    const once = bumpSkill(LIST, 'commit');
    expect(once.map((s) => [s.name, s.uses])).toEqual([
      ['debug', 5], ['code-review', 2], ['commit', 1], ['security-review', 1], ['pr-description', 0],
    ]);
    expect(bumpSkill(bumpSkill(once, 'commit'), 'commit')[1].name).toBe('commit');
  });
});

describe('skillNamed', () => {
  it('finds a name whatever its case', () => {
    expect(skillNamed(LIST, 'Commit')?.name).toBe('commit');
    expect(skillNamed(LIST, 'nope')).toBeUndefined();
  });
});
