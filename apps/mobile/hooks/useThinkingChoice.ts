import { useCallback, useEffect, useRef, useState } from 'react';
import type { ModelInfo, ThinkingLevel } from '@loxaic/types';
import type { ComposerThinking } from '@/components/composer/ComposerPlusMenu';
import { useSettings, useThinkingLevels } from '@/hooks/useSettings';
import type { Promotion } from '@/lib/mcpSwitches';
import { conversationThinkingLevel, thinkingTarget } from '@/lib/thinking';

/**
 * The thinking level for the conversation on screen, shared by Chat and Agent:
 * the level its sends carry and the `+` menu's Thinking row.
 *
 * A conversation that exists keeps its own level (on this device). One that
 * does not yet — a new chat — holds the choice until its first send, which
 * carries it, and the level then moves onto the id the server gave it. Before
 * this, choosing a level on a new chat did nothing at all.
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

  // The new chat's choice moves onto its real id once the server names it.
  const handled = useRef<Promotion | null>(null);
  useEffect(() => {
    if (!promotion || handled.current === promotion) return;
    handled.current = promotion;
    if (pending === null) return;
    setByConversation((prev) => ({ ...prev, [promotion.realId]: pending }));
    setPending(null);
  }, [promotion, pending, setByConversation]);

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
