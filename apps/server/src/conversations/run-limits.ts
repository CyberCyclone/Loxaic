import { db, eq } from "@loxaic/db";
import { conversations } from "@loxaic/db/schema";
import { LIMITS_ON, type RunLimitChoices, type RunLimits } from "@loxaic/types";
import { getRunByConversation, setRunLimits } from "../streams/registry.ts";
import { announceConversationEvent } from "../streams/watchers.ts";

/** Choices as the columns they set, leaving out any not made. */
export function runLimitColumns(choices: RunLimitChoices | undefined): Partial<RunLimits> {
  return choices?.progress_review_off !== undefined ? { progressReviewOff: choices.progress_review_off } : {};
}

/** A conversation's switches as a run starts. An unreadable row means the
 * review on: it is only ever off because someone said so. Only a chat or an
 * agent thread can switch it off, whatever its column says: a routine runs
 * unattended and a sub-agent's parent waits on it, so each is always reviewed. */
export async function loadRunLimits(conversationId: string): Promise<RunLimits> {
  try {
    const row = await db.query.conversations.findFirst({
      where: eq(conversations.id, conversationId),
      columns: { kind: true, progressReviewOff: true },
    });
    if (row?.kind !== "chat" && row?.kind !== "agent") return LIMITS_ON;
    return { progressReviewOff: row.progressReviewOff };
  } catch {
    return LIMITS_ON;
  }
}

/**
 * A change of the stored switch, as it reaches everything following the
 * conversation: its live run, and the owner's other devices. Only the run's
 * sender switches the review off mid-run (anyone else's applies from the next
 * run); switching it back on reaches the run whoever sent it. Its sub-agents
 * are not touched: they are reviewed whatever their parent's switch says.
 */
export function applyRunLimits(userId: string, conversationId: string, limits: RunLimits): void {
  const run = getRunByConversation(conversationId);
  if (run) {
    const current = run.limits ?? LIMITS_ON;
    const next: RunLimits = run.userId === userId ? limits : { progressReviewOff: current.progressReviewOff && limits.progressReviewOff };
    if (next.progressReviewOff !== current.progressReviewOff) setRunLimits(run, next);
  }
  announceConversationEvent({
    type: "conversation.limits",
    conversation_id: conversationId,
    progress_review_off: limits.progressReviewOff,
  });
}
