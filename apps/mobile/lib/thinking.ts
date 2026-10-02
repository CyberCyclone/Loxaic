import { effectiveThinkingLevel, type ModelThinking, type ThinkingLevel } from '@loxaic/types';
import { isServerConvId } from '@/lib/streamMessages';

/**
 * What the composer's `+` menu shows for thinking. Pure, so the rules are unit
 * tested; the menu (ComposerPlusMenu, .web) only renders them.
 */

export interface ThinkingOption {
  level: ThinkingLevel;
  label: string;
}

/** Said in place of a level list, for a model that takes none. */
export const NO_THINKING_REASON = "This model doesn't take a thinking level";

/** The choices a model offers: Off / On for a toggle, otherwise its levels,
 * with `None` read as "Off". */
export function thinkingOptions(thinking: ModelThinking): ThinkingOption[] {
  if (thinking.toggle) {
    return [
      ...(thinking.levels.includes('None') ? [{ level: 'None' as const, label: 'Off' }] : []),
      { level: 'Medium', label: 'On' },
    ];
  }
  return thinking.levels.map((level) => ({ level, label: level === 'None' ? 'Off' : level }));
}

/** The option that is really in force: the conversation's level, clamped to
 * what this model offers the way the server clamps it. */
export function selectedThinkingOption(thinking: ModelThinking, level: ThinkingLevel): ThinkingOption {
  const effective = effectiveThinkingLevel(thinking, level);
  const options = thinkingOptions(thinking);
  return options.find((o) => o.level === effective) ?? options[0];
}

/**
 * Whether changing the level costs a re-read of the conversation: llama.cpp
 * renders the level into the system prompt, the front of the cached prefix.
 * A hosted API's field is not part of the prompt text.
 */
export function levelChangeRereads(thinking: ModelThinking): boolean {
  return thinking.dialect === 'llama';
}

/**
 * The level a conversation's sends carry: its own, else — for a conversation
 * the server has not given an id yet (no id, or a local `c<ts>`/`pending-*`
 * placeholder) — the one chosen before it existed, else Settings' default.
 */
export function conversationThinkingLevel(input: {
  activeId: string | null;
  byConversation: Partial<Record<string, ThinkingLevel>>;
  pending: ThinkingLevel | null;
  fallback: ThinkingLevel;
}): ThinkingLevel {
  const real = input.activeId !== null && isServerConvId(input.activeId);
  const own = real && input.activeId ? input.byConversation[input.activeId] : undefined;
  if (own) return own;
  if (!real && input.pending) return input.pending;
  return input.fallback;
}

/** Where a choice is kept: on the conversation once it exists on the server,
 * otherwise as the pending choice its first send carries. */
export function thinkingTarget(activeId: string | null): 'conversation' | 'pending' {
  return activeId !== null && isServerConvId(activeId) ? 'conversation' : 'pending';
}
