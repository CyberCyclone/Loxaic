/**
 * Process-local registry of in-flight runs. This is deliberately NOT the
 * durable record of "what's active" (that's StreamLog meta, which survives
 * restart in Redis mode) — it only holds the things that can't be durable by
 * nature: the AbortController driving this process's inference request, and
 * pending approval resolvers for this process's tool loop.
 */
export interface RunHandle {
  streamId: string;
  conversationId: string;
  userId: string;
  abort: AbortController;
  /** call_id -> resolver. Approvals are run-scoped, not connection-scoped: a
   * different device/socket than the one that started the run can approve. */
  approvals: Map<string, (approved: boolean) => void>;
}

const runsByStreamId = new Map<string, RunHandle>();
/** conversationId -> streamId — enforces one active run per conversation. */
const runByConversation = new Map<string, string>();

export function registerRun(handle: RunHandle): void {
  runsByStreamId.set(handle.streamId, handle);
  runByConversation.set(handle.conversationId, handle.streamId);
}

export function unregisterRun(streamId: string): void {
  const handle = runsByStreamId.get(streamId);
  if (!handle) return;
  runsByStreamId.delete(streamId);
  if (runByConversation.get(handle.conversationId) === streamId) {
    runByConversation.delete(handle.conversationId);
  }
}

export function getRun(streamId: string): RunHandle | undefined {
  return runsByStreamId.get(streamId);
}

export function getRunByConversation(conversationId: string): RunHandle | undefined {
  const streamId = runByConversation.get(conversationId);
  return streamId ? runsByStreamId.get(streamId) : undefined;
}

export function isConversationBusy(conversationId: string): boolean {
  return runByConversation.has(conversationId);
}

/**
 * Finds any run with a pending approval for `callId`.
 *
 * Approve/deny carry only a call_id, so this locates the run; it does **not**
 * authorize. Callers must check the caller's role on `handle.conversationId`
 * — see ws/chat.ts's `mayActOnRun`.
 *
 * Locating and authorizing used to be the same step (`handle.userId ===
 * userId`), which stopped working once a conversation could have editors
 * besides its owner: the run's starter is not the set of people entitled to
 * answer its approvals. Keeping them separate makes the authorization
 * explicit at the call site rather than implied by a lookup.
 */
export function findRunByApprovalCallId(callId: string): RunHandle | undefined {
  for (const handle of runsByStreamId.values()) {
    if (handle.approvals.has(callId)) return handle;
  }
  return undefined;
}
