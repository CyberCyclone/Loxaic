import { actingRole, atLeast, resolveAccess } from "../streams/authz.ts";
import { findRunsByApprovalCallId, getRun, type RunHandle } from "../streams/registry.ts";

/**
 * Whether this user may stop a run or answer its approvals.
 *
 * Editor or better on the run's *conversation*, not "did you start it". A
 * conversation shared for editing has more than one legitimate participant,
 * and the run's starter may well have gone offline mid-run (runs deliberately
 * outlive the socket that began them). A viewer must never reach either path.
 *
 * For a sub-agent's run the conversation that counts is its parent: a child's
 * own conversation grants nobody more than `viewer` (see `AccessGrant.parent`).
 *
 * Returns false rather than throwing: every caller deliberately no-ops on
 * refusal, so an unauthorized stop is indistinguishable from a stop for a
 * stream that never existed.
 */
export async function mayActOnRun(userId: string, conversationId: string): Promise<boolean> {
  const grant = await resolveAccess(userId, conversationId);
  return !!grant && atLeast(actingRole(grant), "editor");
}

/**
 * Answers a pending tool approval. Shared by both sockets, word for word: chat
 * is tool-capable, and the routine screen answers over the chat socket.
 *
 * Approvals are run-scoped (registry), so any of the user's sockets — either
 * surface, any device — can answer.
 *
 * `streamId`, when the client sent one, names the run. It is a claim off a
 * socket, so anything that is not a string is treated as absent. A named run
 * that holds no such approval is a no-op and **does not fall back** to the
 * plural lookup: the whole reason to name a run is that another one may hold
 * the same model-supplied call id — a parent and its sub-agent both waiting on
 * `call_0` — and answering that other one is the mistake being prevented.
 *
 * Without a stream id, several runs can hold the call id (see the registry):
 * the first one this user is allowed to act on is answered, not the first one
 * found.
 *
 * Silently no-ops otherwise — unknown, foreign or already-resolved, the same
 * "no existence oracle" rule as `stream.stop`.
 */
export async function answerApproval(
  userId: string,
  callId: unknown,
  approved: boolean,
  streamId?: unknown,
  /** "Allow always". Passed on with who answered; the engine decides whether
   * that person may grant it. */
  always = false,
): Promise<void> {
  if (typeof callId !== "string") return;
  let candidates: RunHandle[];
  if (typeof streamId === "string") {
    const named = getRun(streamId);
    candidates = named?.approvals.has(callId) ? [named] : [];
  } else {
    candidates = findRunsByApprovalCallId(callId);
  }
  for (const run of candidates) {
    if (!(await mayActOnRun(userId, run.conversationId))) continue;
    const resolve = run.approvals.get(callId);
    if (resolve) {
      run.approvals.delete(callId);
      resolve(approved, { userId, always: approved && always });
    }
    break;
  }
}
