import { describe, expect, it } from 'vitest';
import type { ModelThinking } from '@loxaic/types';
import {
  conversationThinkingLevel,
  levelChangeRereads,
  selectedThinkingOption,
  thinkingOptions,
  thinkingTarget,
  pendingOwner,
} from './thinking';

const graded: ModelThinking = {
  levels: ['None', 'Low', 'Medium', 'High'],
  toggle: false,
  dialect: 'llama',
  wire: { None: 'none', Low: 'low', Medium: 'medium', High: 'high' },
};
const toggle: ModelThinking = { levels: ['None', 'Medium'], toggle: true, dialect: 'llama', wire: {} };
const hosted: ModelThinking = { levels: ['Low', 'Medium', 'High'], toggle: false, dialect: 'openai', wire: { Low: 'low', Medium: 'medium', High: 'high' } };

const REAL = '0b6f5c1e-2f1a-4c7e-9a52-3d1c8e7f4a10';

describe('thinkingOptions', () => {
  it('lists a graded model\'s levels, None read as Off', () => {
    expect(thinkingOptions(graded).map((o) => o.label)).toEqual(['Off', 'Low', 'Medium', 'High']);
  });

  it('gives a toggle model Off and On only', () => {
    expect(thinkingOptions(toggle)).toEqual([
      { level: 'None', label: 'Off' },
      { level: 'Medium', label: 'On' },
    ]);
  });

  it('offers no Off on a model that cannot be switched off', () => {
    expect(thinkingOptions(hosted).map((o) => o.level)).toEqual(['Low', 'Medium', 'High']);
  });
});

describe('selectedThinkingOption', () => {
  it('shows the level the server will really send', () => {
    expect(selectedThinkingOption(graded, 'High').label).toBe('High');
    // Clamped the way the server clamps: no Off on a hosted model.
    expect(selectedThinkingOption(hosted, 'None').label).toBe('Low');
    expect(selectedThinkingOption(toggle, 'High').label).toBe('On');
    expect(selectedThinkingOption(toggle, 'None').label).toBe('Off');
  });
});

describe('levelChangeRereads', () => {
  it('warns only where the level is part of the prompt text', () => {
    expect(levelChangeRereads(graded)).toBe(true);
    expect(levelChangeRereads(hosted)).toBe(false);
  });
});

describe('conversationThinkingLevel', () => {
  it("uses the conversation's own level, under whatever id it has", () => {
    expect(conversationThinkingLevel({ activeId: REAL, byConversation: { [REAL]: 'High' }, pending: 'Low', fallback: 'Medium' })).toBe('High');
    expect(conversationThinkingLevel({ activeId: 'c1700000000000', byConversation: { c1700000000000: 'Low' }, pending: null, fallback: 'Medium' })).toBe('Low');
  });

  it('uses the choice made before a new chat existed, until it is moved onto the chat', () => {
    expect(conversationThinkingLevel({ activeId: null, byConversation: {}, pending: 'High', fallback: 'Medium' })).toBe('High');
    // The render after the first send, before the move: still the pending choice.
    expect(conversationThinkingLevel({ activeId: 'pending-ab12', byConversation: {}, pending: 'Low', fallback: 'Medium' })).toBe('Low');
  });

  it("falls back to the default, never to another chat's pending choice", () => {
    expect(conversationThinkingLevel({ activeId: REAL, byConversation: {}, pending: 'High', fallback: 'Medium' })).toBe('Medium');
    expect(conversationThinkingLevel({ activeId: null, byConversation: {}, pending: null, fallback: 'Low' })).toBe('Low');
  });
});

describe('thinkingTarget', () => {
  it('keeps a choice on the conversation as soon as it has any id', () => {
    expect(thinkingTarget(REAL)).toBe('conversation');
    expect(thinkingTarget('c1700000000000')).toBe('conversation');
    expect(thinkingTarget(null)).toBe('pending');
  });
});

describe('pendingOwner', () => {
  it('gives a pending choice to the placeholder of the chat whose first send carried it', () => {
    expect(pendingOwner('c1700000000000', 'High')).toBe('c1700000000000');
    expect(pendingOwner('pending-x', 'Low')).toBe('pending-x');
  });

  it('gives it to nobody else', () => {
    // Left for an existing thread: that thread keeps its own level, and the
    // choice waits for the next new chat.
    expect(pendingOwner(REAL, 'High')).toBeNull();
    expect(pendingOwner(null, 'High')).toBeNull();
    expect(pendingOwner('c1700000000000', null)).toBeNull();
  });
});
