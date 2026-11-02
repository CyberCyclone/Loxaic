import { db, eq } from "@loxaic/db";
import { conversations } from "@loxaic/db/schema";
import { LIMITS_ON, type RunLimitChoices, type RunLimits } from "@loxaic/types";
import { getRunByConversation, setRunLimits } from "../streams/registry.ts";
import { announceConversationEvent } from "../streams/watchers.ts";

/** Choices as the columns they set, leaving out any not made. */
export function runLimitColumns(choices: RunLimitChoices | undefined): Partial<RunLimits> {
  return {
    ...(choices?.step_limit_off !== undefined ? { stepLimitOff: choices.step_limit_off } : {}),
    ...(choices?.loop_check_off !== undefined ? { loopCheckOff: choices.loop_check_off } : {}),
  };
}

/** A conversation's limits as a run starts. An unreadable row means every limit
 * on: a limit is only ever off because someone said so. Only a chat or an agent
 * thread has any to turn off, whatever its columns say: a routine runs
 * unattended and a sub-agent asks nobody, so each stays bounded. */
export async function loadRunLimits(conversationId: string): Promise<RunLimits> {
  try {
    const row = await db.query.conversations.findFirst({
      where: eq(conversations.id, conversationId),
      columns: { kind: true, stepLimitOff: true, loopCheckOff: true },
    });
    if (row?.kind !== "chat" && row?.kind !== "agent") return LIMITS_ON;
    return { stepLimitOff: row.stepLimitOff, loopCheckOff: row.loopCheckOff };
  } catch {
    return LIMITS_ON;
  }
}

/**
 * A change of the stored limits, as it reaches everything following the
 * conversation: its live run, and the owner's other devices. Turning a limit
 * off answers a parked check-in as `userId`, so only the run's sender switches
 * one off mid-run (anyone else's applies from the next run); turning one back
 * on is a brake, and reaches the run whoever sent it. Its sub-agents are not
 * touched: they run bounded whatever their parent's switches say.
 */
export function applyRunLimits(userId: string, conversationId: string, limits: RunLimits): void {
  const run = getRunByConversation(conversationId);
  if (run) {
    const current = run.limits ?? LIMITS_ON;
    const next = run.userId === userId ? limits : {
      stepLimitOff: current.stepLimitOff && limits.stepLimitOff,
      loopCheckOff: current.loopCheckOff && limits.loopCheckOff,
    };
    if (next.stepLimitOff !== current.stepLimitOff || next.loopCheckOff !== current.loopCheckOff) setRunLimits(run, next, userId);
  }
  announceConversationEvent({
    type: "conversation.limits",
    conversation_id: conversationId,
    step_limit_off: limits.stepLimitOff,
    loop_check_off: limits.loopCheckOff,
  });
}
