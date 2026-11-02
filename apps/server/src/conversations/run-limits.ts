import { db, eq } from "@loxaic/db";
import { conversations } from "@loxaic/db/schema";
import { LIMITS_ON, type RunLimitChoices, type RunLimits } from "@loxaic/types";
import { getRunByConversation, listChildRuns, setRunLimits } from "../streams/registry.ts";
import { announceConversationEvent } from "../streams/watchers.ts";

/** Choices as the columns they set, leaving out any not made. */
export function runLimitColumns(choices: RunLimitChoices | undefined): Partial<RunLimits> {
  return {
    ...(choices?.step_limit_off !== undefined ? { stepLimitOff: choices.step_limit_off } : {}),
    ...(choices?.loop_check_off !== undefined ? { loopCheckOff: choices.loop_check_off } : {}),
  };
}

/** A conversation's limits as a run starts. An unreadable row means every limit
 * on: a limit is only ever off because someone said so. */
export async function loadRunLimits(conversationId: string): Promise<RunLimits> {
  try {
    const row = await db.query.conversations.findFirst({
      where: eq(conversations.id, conversationId),
      columns: { stepLimitOff: true, loopCheckOff: true },
    });
    return row ?? LIMITS_ON;
  } catch {
    return LIMITS_ON;
  }
}

/**
 * A change of the stored limits, as it reaches everything following the
 * conversation: its live run and that run's sub-agents, when `userId` sent it
 * (a live run is switched only by its sender; anyone else's change applies from
 * the next run), and the owner's other devices.
 */
export function applyRunLimits(userId: string, conversationId: string, limits: RunLimits): void {
  const run = getRunByConversation(conversationId);
  if (run?.userId === userId) {
    setRunLimits(run, limits, userId);
    for (const child of listChildRuns(conversationId)) setRunLimits(child, limits, userId);
  }
  announceConversationEvent({
    type: "conversation.limits",
    conversation_id: conversationId,
    step_limit_off: limits.stepLimitOff,
    loop_check_off: limits.loopCheckOff,
  });
}
