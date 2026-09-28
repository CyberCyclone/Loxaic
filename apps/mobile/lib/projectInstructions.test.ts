import { describe, expect, it } from 'vitest';
import { describeProjectInstructions, instructionsUpdateLine } from './projectInstructions';

const found = { status: 'found' as const, path: 'AGENTS.md', tokens: 76_830, sourceBytes: 307_321, sourceTruncated: false };

describe('describeProjectInstructions', () => {
  it('says nothing for a scratch workspace or when it was not told', () => {
    expect(describeProjectInstructions({ status: 'none' }, 'scratch')).toBeNull();
    expect(describeProjectInstructions(undefined, 'github')).toBeNull();
  });

  it('keeps "not looked yet" apart from "there is none"', () => {
    expect(describeProjectInstructions(null, 'github')).toMatch(/when the first message is sent/);
    expect(describeProjectInstructions(null, 'local', 'direct')).toMatch(/when the first message is sent/);
    // Read inside its container, which only the agent's first command starts.
    expect(describeProjectInstructions(null, 'local', 'container')).toMatch(/inside the container, once the agent has started it/);
    expect(describeProjectInstructions({ status: 'none' }, 'local')).toBe('No AGENTS.md, CLAUDE.md or GEMINI.md at the root of this project.');
  });

  it('says why it could not be read, apart from "none" and "not yet"', () => {
    expect(describeProjectInstructions({ status: 'unavailable', reason: 'no-github-connection' }, 'github')).toMatch(/GitHub isn't connected/);
    expect(describeProjectInstructions({ status: 'unavailable', reason: 'machine-offline' }, 'local')).toMatch(/is offline/);
    expect(describeProjectInstructions({ status: 'unavailable', reason: 'error' }, 'github')).toMatch(/^Couldn't read/);
  });

  it('says whether the file went in whole or as an outline', () => {
    expect(describeProjectInstructions({ ...found, mode: 'full' }, 'github')).toBe('AGENTS.md (~77k tokens) is included in full.');
    expect(describeProjectInstructions({ ...found, mode: 'outline' }, 'github')).toMatch(/^AGENTS\.md \(~77k tokens\) is more than this model's context window can spare/);
    expect(describeProjectInstructions({ ...found, tokens: 812, mode: null }, 'local')).toBe('AGENTS.md (~812 tokens) found.');
  });

  it('speaks of a file and what it imports together', () => {
    const imported = { ...found, path: 'CLAUDE.md', tokens: 900, imports: 2 };
    expect(describeProjectInstructions({ ...imported, mode: 'full' }, 'github')).toBe('CLAUDE.md and the 2 files it imports (~900 tokens) are included in full.');
    expect(describeProjectInstructions({ ...imported, imports: 1, mode: 'outline' }, 'github')).toMatch(/^CLAUDE\.md and the file it imports \(~900 tokens\) are more than .* gets their opening/);
    expect(describeProjectInstructions({ ...imported, imports: 0, mode: 'full' }, 'github')).toBe('CLAUDE.md (~900 tokens) is included in full.');
  });

  it('says when only part of a huge file was read', () => {
    const out = describeProjectInstructions({ ...found, mode: 'outline', sourceBytes: 1024 * 1024, sourceTruncated: true }, 'github');
    expect(out).toMatch(/Only its first 1 MB was read\.$/);
  });
});

describe('a changed file', () => {
  it('says the agent was told in the chat, and when it moves into its instructions', () => {
    const out = describeProjectInstructions({ ...found, mode: 'full', tokens: 900, pendingUpdate: true }, 'local');
    expect(out).toMatch(/is included in full\. It has changed since this conversation started: the agent was given the changes in the chat, and they move into its instructions at the next compaction\.$/);
    expect(describeProjectInstructions({ status: 'none', pendingUpdate: true }, 'github')).toMatch(/has an instructions file now/);
  });

  it('shows the server\'s summary on the message it rode on', () => {
    expect(instructionsUpdateLine({ path: 'AGENTS.md', summary: 'AGENTS.md: 1 section changed' })).toBe(
      'AGENTS.md: 1 section changed. The agent was given the change with this message.',
    );
  });
});
