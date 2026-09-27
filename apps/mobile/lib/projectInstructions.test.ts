import { describe, expect, it } from 'vitest';
import { describeProjectInstructions } from './projectInstructions';

const found = { status: 'found' as const, path: 'AGENTS.md', tokens: 76_830, sourceBytes: 307_321, sourceTruncated: false };

describe('describeProjectInstructions', () => {
  it('says nothing for a scratch workspace or when it was not told', () => {
    expect(describeProjectInstructions({ status: 'none' }, 'scratch')).toBeNull();
    expect(describeProjectInstructions(undefined, 'github')).toBeNull();
  });

  it('keeps "not looked yet" apart from "there is none"', () => {
    expect(describeProjectInstructions(null, 'github')).toMatch(/when the first message is sent/);
    expect(describeProjectInstructions({ status: 'none' }, 'local')).toBe('No AGENTS.md or CLAUDE.md at the root of this project.');
  });

  it('says whether the file went in whole or as an outline', () => {
    expect(describeProjectInstructions({ ...found, mode: 'full' }, 'github')).toBe('AGENTS.md (~77k tokens) is included in full.');
    expect(describeProjectInstructions({ ...found, mode: 'outline' }, 'github')).toMatch(/^AGENTS\.md \(~77k tokens\) is more than this model's context window can spare/);
    expect(describeProjectInstructions({ ...found, tokens: 812, mode: null }, 'local')).toBe('AGENTS.md (~812 tokens) found.');
  });

  it('says when only part of a huge file was read', () => {
    const out = describeProjectInstructions({ ...found, mode: 'outline', sourceBytes: 1024 * 1024, sourceTruncated: true }, 'github');
    expect(out).toMatch(/Only its first 1 MB was read\.$/);
  });
});
