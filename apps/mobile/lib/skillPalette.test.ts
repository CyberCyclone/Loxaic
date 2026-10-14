import { describe, expect, it } from 'vitest';
import type { PaletteSkill } from '@loxaic/api-client';
import { bumpSkill, compactRequest, FALLBACK_SKILLS, filterSkills, paletteTakesEnter, scrollToShow, skillNamed, skillsFor } from './skillPalette';

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

describe('paletteTakesEnter', () => {
  it('takes Enter when the query matches a name, a bare slash included', () => {
    expect(paletteTakesEnter(filterSkills(LIST, 'deb'), 'deb', false)).toBe(true);
    expect(paletteTakesEnter(filterSkills(LIST, 'view'), 'view', false)).toBe(true);
    expect(paletteTakesEnter(filterSkills(LIST, ''), '', false)).toBe(true);
  });

  it('leaves Enter to send a message that matches only descriptions', () => {
    // "/fix" lists `debug` by its description alone; whoever typed it meant
    // to send it.
    const only = filterSkills([skill('debug', "Fix a bug's root cause"), skill('commit', 'Commit work')], 'fix');
    expect(only.map((s) => s.name)).toEqual(['debug']);
    expect(paletteTakesEnter(only, 'fix', false)).toBe(false);
  });

  it('takes Enter for a row the person moved to themselves', () => {
    expect(paletteTakesEnter(filterSkills(LIST, 'git'), 'git', true)).toBe(true);
  });
});

describe('scrollToShow', () => {
  const view = { scrollY: 100, height: 200 };
  it('leaves a row already in view alone', () => {
    expect(scrollToShow({ top: 120, height: 50 }, view)).toBeNull();
  });
  it('scrolls by as little as shows a row below or above', () => {
    expect(scrollToShow({ top: 280, height: 50 }, view)).toBe(130);
    expect(scrollToShow({ top: 40, height: 50 }, view)).toBe(40);
  });
});

describe('skillsFor', () => {
  const theirs = [skill('deploy', 'Their own')];
  it("shows a list only for the conversation it was asked for", () => {
    // A list is its conversation owner's: one fetched for a shared thread
    // must not stand in for the next thread while that one's is still coming,
    // or failed to come.
    expect(skillsFor({ for: 'a', skills: theirs }, 'a')).toBe(theirs);
    expect(skillsFor({ for: 'a', skills: theirs }, 'b')).toBe(FALLBACK_SKILLS);
    expect(skillsFor({ for: 'a', skills: theirs }, null)).toBe(FALLBACK_SKILLS);
    expect(skillsFor(null, 'a')).toBe(FALLBACK_SKILLS);
  });
});

describe('compactRequest', () => {
  it('runs the compaction while /compact is the built-in', () => {
    expect(compactRequest(FALLBACK_SKILLS)).toEqual({ kind: 'command' });
  });
  it("sends a person's own /compact as a message, which a command would have been refused for", () => {
    const overridden: PaletteSkill[] = [{ name: 'compact', description: 'Mine', source: 'user', uses: 0 }];
    expect(compactRequest(overridden)).toEqual({ kind: 'message', text: '/compact' });
  });
});
