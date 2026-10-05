import type { CheckinReason, PermissionMode, StepsDecision, TimeoutBasis, WaitDeadlineFields } from '@loxaic/api-client';

/**
 * When a parked run stops waiting, on *this device's* clock.
 *
 * The server stamps `expires_at` on its own clock. A phone a minute fast would
 * show a minute too few if it counted down to that directly, so the deadline
 * is converted once, on receipt: a live event is taken as just emitted (its
 * `timeout_ms` from now — off only by delivery latency), and a snapshot is
 * corrected by the `server_now` its `stream.sync` carries.
 */
export interface WaitDeadline {
  /** Local epoch ms at which the wait ends. */
  deadlineAt: number;
  timeoutMs: number;
  basis?: TimeoutBasis;
}

export interface PendingCheckin {
  n: number;
  max: number;
  reason: CheckinReason;
  pattern?: { tool: string }[];
  deadline?: WaitDeadline;
  /** What an unanswered check-in will do, and where it is on the ladder. */
  onTimeout?: StepsDecision;
  unattended?: number;
  autoContinues?: number;
}

export interface PendingApproval {
  callId: string;
  tool: string;
  args: Record<string, unknown>;
  deadline?: WaitDeadline;
  /** The asking run's mode, and the one user whose "Allow always" the server
   * records. Both absent from a server that predates them. */
  mode?: PermissionMode;
  granterUserId?: string;
  /** The run that asked. The answer has to name it — see `approvalStreamId`. */
  streamId?: string;
}

/** `serverNow` present means "from a snapshot"; absent means "live, just now". */
export function localDeadline(src: WaitDeadlineFields, now: number, serverNow?: number): WaitDeadline | undefined {
  if (src.timeout_ms == null) return undefined;
  const deadlineAt =
    serverNow != null && src.expires_at != null ? now + (src.expires_at - serverNow) : now + src.timeout_ms;
  return { deadlineAt, timeoutMs: src.timeout_ms, ...(src.timeout_basis ? { basis: src.timeout_basis } : {}) };
}

export function toPendingCheckin(
  src: WaitDeadlineFields & {
    n: number;
    max: number;
    reason: CheckinReason;
    pattern?: { tool: string }[];
    on_timeout?: StepsDecision;
    unattended?: number;
    auto_continues?: number;
  },
  now: number,
  serverNow?: number,
): PendingCheckin {
  const deadline = localDeadline(src, now, serverNow);
  return {
    n: src.n,
    max: src.max,
    reason: src.reason,
    ...(src.pattern ? { pattern: src.pattern } : {}),
    ...(deadline ? { deadline } : {}),
    ...(src.on_timeout ? { onTimeout: src.on_timeout } : {}),
    ...(src.unattended != null ? { unattended: src.unattended } : {}),
    ...(src.auto_continues != null ? { autoContinues: src.auto_continues } : {}),
  };
}

export function toPendingApproval(
  src: WaitDeadlineFields & {
    call_id: string;
    tool: string;
    args: Record<string, unknown>;
    mode?: PermissionMode;
    granter_user_id?: string;
  },
  now: number,
  serverNow?: number,
  streamId?: string,
): PendingApproval {
  const deadline = localDeadline(src, now, serverNow);
  return {
    callId: src.call_id,
    tool: src.tool,
    args: src.args,
    ...(deadline ? { deadline } : {}),
    ...(src.mode ? { mode: src.mode } : {}),
    ...(src.granter_user_id ? { granterUserId: src.granter_user_id } : {}),
    ...(streamId ? { streamId } : {}),
  };
}

/**
 * The run an Allow or Deny is for.
 *
 * A call id is the model's and repeats (`call_0` every message), and an answer
 * that names no run is given to the first run holding that id that the person
 * may act on — any of their conversations', sub-agents included. So pressing
 * Allow on one thread could run a write waiting in another, one whose prompt
 * nobody had been shown, while the thread on screen stayed parked until its
 * timeout. The stream the prompt arrived on is the answer; the conversation's
 * tracked stream stands in for a prompt recorded without one. Undefined only
 * when neither is known, which sends the answer as an older client would.
 */
export function approvalStreamId(
  pending: PendingApproval | null | undefined,
  callId: string,
  trackedStreamId: string | undefined,
): string | undefined {
  if (pending?.callId === callId && pending.streamId) return pending.streamId;
  return trackedStreamId;
}
