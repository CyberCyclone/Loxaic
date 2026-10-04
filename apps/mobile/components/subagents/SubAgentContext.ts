import { createContext } from 'react';
import type { SubAgentView } from '@/lib/subAgents';

/**
 * How a sub-agent's card in the transcript reaches its state and its panel.
 *
 * A context rather than props for the reason the plan card uses one: the card
 * sits under MessageList → Message, which every surface shares. Where no
 * screen provides this — plain chat, which cannot spawn a sub-agent, and the
 * inside of a sub-agent's own panel — a `subagent` call renders as the
 * ordinary tool card.
 */
export interface SubAgentsUi {
  /** The sub-agent a tool call started, if this thread knows of it. */
  forCall: (callId: string | undefined, messageId: string | undefined) => SubAgentView | undefined;
  open: (childConvId: string) => void;
  stop: (childConvId: string) => void;
  isStopping: (childConvId: string) => boolean;
  /** Whether this person may stop a sub-agent or answer it: editor or better
   * on the thread. A viewer watches. */
  canAct: boolean;
}

export const SubAgentContext = createContext<SubAgentsUi | null>(null);
