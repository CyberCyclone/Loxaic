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
 * The level a conversation's sends carry: its own — keyed by whatever id it has
 * now, the local `c<ts>`/`pending-*` placeholder included — else, for a chat
 * that does not exist yet, the choice made before it existed, else Settings'
 * default.
 */
export function conversationThinkingLevel(input: {
  activeId: string | null;
  byConversation: Partial<Record<string, ThinkingLevel>>;
  pending: ThinkingLevel | null;
  fallback: ThinkingLevel;
}): ThinkingLevel {
  const own = input.activeId !== null ? input.byConversation[input.activeId] : undefined;
  if (own) return own;
  // Also for a placeholder in the moment before the pending choice is moved
  // onto it (see `pendingOwner`).
  const real = input.activeId !== null && isServerConvId(input.activeId);
  if (!real && input.pending) return input.pending;
  return input.fallback;
}

/** Where a choice is kept: on the conversation as soon as it has any id, or as
 * the pending choice for a chat that has none yet. */
export function thinkingTarget(activeId: string | null): 'conversation' | 'pending' {
  return activeId !== null ? 'conversation' : 'pending';
}

/**
 * The local placeholder a pending choice now belongs to: the id a new chat
 * took when its first send went out (that send carried the choice), or null.
 * Moving the choice onto that id, rather than holding one pending slot until
 * some promotion arrives, is what ties it to the chat it was made for — two
 * new chats in flight, or an unsent one left for another thread, otherwise put
 * one chat's level on another (the MCP switches' `carriesChoices` lesson).
 */
export function pendingOwner(activeId: string | null, pending: ThinkingLevel | null): string | null {
  if (pending === null || activeId === null || isServerConvId(activeId)) return null;
  return activeId;
}
