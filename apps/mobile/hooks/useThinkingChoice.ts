import { useCallback, useEffect, useRef, useState } from 'react';
import type { ModelInfo, ThinkingLevel } from '@loxaic/types';
import type { ComposerThinking } from '@/components/composer/ComposerPlusMenu';
import { useSettings, useThinkingLevels } from '@/hooks/useSettings';
import type { Promotion } from '@/lib/mcpSwitches';
import { conversationThinkingLevel, pendingOwner, thinkingTarget } from '@/lib/thinking';

/**
 * The thinking level for the conversation on screen, shared by Chat and Agent:
 * the level its sends carry and the `+` menu's Thinking row.
 *
 * A conversation keeps its own level (on this device). A new chat holds the
 * choice as pending until its first send, which carries it; the choice then
 * moves onto the chat's local id, and from there onto the id the server gives
 * that same chat. Before this, choosing a level on a new chat did nothing.
 */
export function useThinkingChoice(input: {
  activeId: string | null;
  promotion: Promotion | null;
  /** The selected model, or undefined while the model list is loading. */
  model: ModelInfo | undefined;
  modelsLoaded: boolean;
}): { level: ThinkingLevel; composer: ComposerThinking | null } {
  const { activeId, promotion, model, modelsLoaded } = input;
  const [settings] = useSettings();
  const [byConversation, setByConversation] = useThinkingLevels();
  const [pending, setPending] = useState<ThinkingLevel | null>(null);

  const level = conversationThinkingLevel({
    activeId,
    byConversation,
    pending,
    fallback: settings.defaultThinkingLevel,
  });

  // A new chat's first send carried the pending choice, and the chat now has a
  // local id: the choice moves onto that id, so it belongs to this chat alone.
  const owner = pendingOwner(activeId, pending);
  useEffect(() => {
    if (owner === null || pending === null) return;
    setByConversation((prev) => ({ ...prev, [owner]: pending }));
    setPending(null);
  }, [owner, pending, setByConversation]);

  // ...and onto the real id once the server names that same chat.
  const handled = useRef<Promotion | null>(null);
  useEffect(() => {
    if (!promotion || handled.current === promotion) return;
    handled.current = promotion;
    setByConversation((prev) => {
      // Partial: the stored map need not hold this chat at all.
      const moved = (prev as Partial<Record<string, ThinkingLevel>>)[promotion.localId];
      if (moved === undefined) return prev;
      const { [promotion.localId]: _local, ...rest } = prev;
      return { ...rest, [promotion.realId]: moved };
    });
  }, [promotion, setByConversation]);

  const onChange = useCallback(
    (next: ThinkingLevel) => {
      if (activeId !== null && thinkingTarget(activeId) === 'conversation') {
        setByConversation((prev) => ({ ...prev, [activeId]: next }));
      } else {
        setPending(next);
      }
    },
    [activeId, setByConversation],
  );

  // No row until the list says what the model takes: "doesn't take a level"
  // while it is still loading would be a claim nobody made.
  const composer: ComposerThinking | null = modelsLoaded && model ? { capability: model.thinking ?? null, level, onChange } : null;
  return { level, composer };
}
