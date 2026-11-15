import { createContext } from 'react';
import type { RunReview } from '@loxaic/api-client';

/**
 * How a progress review's card in the transcript opens its panel.
 *
 * A context for the reason the sub-agent card uses one: the card sits under
 * MessageList, which every surface shares. A thread's screen provides a
 * panel of its own; inside a sub-agent's panel the same card opens the
 * review in that panel, since no sheet goes over another.
 */
export interface RunReviewsUi {
  open: (review: RunReview) => void;
}

export const RunReviewContext = createContext<RunReviewsUi | null>(null);
