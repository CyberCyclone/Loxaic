import type { PermissionCheckNote, PermissionMode, TimeoutBasis, WaitDeadlineFields } from '@loxaic/api-client';

/**
 * When a parked run stops waiting for an approval, on *this device's* clock.
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

export interface PendingApproval {
  callId: string;
  tool: string;
  args: Record<string, unknown>;
  deadline?: WaitDeadline;
  /** The asking run's mode, and the one user whose "Allow always" the server
   * records. Both absent from a server that predates them. */
  mode?: PermissionMode;
  granterUserId?: string;
  /** For `bash`: the command rules "Allow always" records, proposed by the
   * server. Absent or empty: no rule says exactly this, and "Allow always" is
   * not offered for it. */
  rules?: string[];
  /** Why an auto-mode command is asking (the permission check's answer). */
  check?: PermissionCheckNote;
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

/**
 * Which question a prompt on screen is, as a React `key`. The permission bar
 * dismisses a phone's keyboard when it mounts, and a prop change is not a
 * mount: switching between two threads that are both waiting — or from a
 * sub-agent's approval to the run's own — kept the same
 * instance with new props, and a keyboard left up stayed over the new
 * question's buttons. A key per question remounts it. A resync of the same
 * question keeps the key, so it does not take the keyboard from someone
 * typing ahead each time the socket reconnects.
 */
export function approvalKey(pending: PendingApproval): string {
  return `${pending.streamId ?? ''}:${pending.callId}`;
}

export function toPendingApproval(
  src: WaitDeadlineFields & {
    call_id: string;
    tool: string;
    args: Record<string, unknown>;
    mode?: PermissionMode;
    granter_user_id?: string;
    rules?: string[];
    check?: PermissionCheckNote;
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
    ...(src.rules && src.rules.length > 0 ? { rules: src.rules } : {}),
    ...(src.check ? { check: src.check } : {}),
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
