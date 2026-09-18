import type { StepsDecision } from "@loxaic/types";

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
  /**
   * Set only while the run is parked at a step check-in, cleared the moment it
   * is answered. Run-scoped like `approvals`, for the same reason — whoever
   * can act on the conversation can answer, from any device.
   *
   * A plain field rather than a Map: a run has at most one check-in
   * outstanding, and it is addressed by `stream_id`, which is ours and unique
   * — unlike a model-supplied `call_id`, which is why approvals need a
   * collision-tolerant plural lookup and this does not.
   *
   * `byUserId` is null when nobody answered and the timeout decided.
   */
  stepsDecision?: (decision: StepsDecision, byUserId: string | null) => void;
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
 * Every run with a pending approval for `callId`.
 *
 * Approve/deny carry only a call_id, so this locates; it does **not**
 * authorize — callers check the caller's role on each `conversationId` (see
 * ws/chat.ts's `mayActOnRun`) and act on the one that passes.
 *
 * Plural, deliberately. `call_id` is *model*-supplied and only unique within
 * one response: chat templates routinely emit `call_0`, `call_1`, and the
 * local fallback is `call_<index>_<ms>`, which two runs starting in the same
 * millisecond share. Returning the first match let an approval land on a
 * different run that happened to hold the same id — and, across two users,
 * silently swallow the legitimate one. Handing back all candidates lets the
 * caller pick the run they are actually allowed to answer for.
 */
/**
 * Whether a check-in answer off a socket is one we recognise.
 *
 * Takes `unknown` on purpose, the same way `isValidRef` does. The wire type
 * already *says* `StepsDecision`, so a check written against that type is
 * narrowed to a tautology and compiled away — but the type is a claim a client
 * made, not a fact, and this is the only place it becomes one.
 */
export function isStepsDecision(value: unknown): value is StepsDecision {
  return value === "continue" || value === "answer";
}

export function findRunsByApprovalCallId(callId: string): RunHandle[] {
  const out: RunHandle[] = [];
  for (const handle of runsByStreamId.values()) {
    if (handle.approvals.has(callId)) out.push(handle);
  }
  return out;
}
