import { describe, expect, it } from 'vitest';
import { deleteSkillMessage, overrideNote } from './skillScreen';

describe('overrideNote', () => {
  it('says what overriding compact changes, and that compaction still happens on its own', () => {
    expect(overrideNote('compact')).toMatch(/\/compact will send your skill as a message instead of compacting/);
    expect(overrideNote('compact')).toMatch(/still compacts by itself/);
  });
  it('says how to get any other built-in back', () => {
    expect(overrideNote('debug')).toBe('This replaces the built-in debug for you. Delete it to get the built-in back.');
  });
});

describe('deleteSkillMessage', () => {
  it('says the built-in returns when the skill was an override', () => {
    expect(deleteSkillMessage({ name: 'debug', overridesBuiltin: true })).toMatch(/built-in debug comes back/);
    expect(deleteSkillMessage({ name: 'notes', overridesBuiltin: false })).not.toMatch(/built-in/);
  });
});
