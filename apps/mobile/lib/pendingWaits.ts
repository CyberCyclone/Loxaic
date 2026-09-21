import type { CheckinReason, StepsDecision, TimeoutBasis, WaitDeadlineFields } from '@loxaic/api-client';

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
  src: WaitDeadlineFields & { call_id: string; tool: string; args: Record<string, unknown> },
  now: number,
  serverNow?: number,
): PendingApproval {
  const deadline = localDeadline(src, now, serverNow);
  return { callId: src.call_id, tool: src.tool, args: src.args, ...(deadline ? { deadline } : {}) };
}
