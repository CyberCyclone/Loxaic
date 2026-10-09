/**
 * A send refused because pinned host models leave no GPU memory for the one
 * chosen (the server's `local_model_no_room`). `text` is the message that was
 * not sent, to put back in the message box — null when the refusal came
 * mid-run, where the message had already been sent and is in the thread.
 */
export interface NoRoomNotice {
  message: string;
  text: string | null;
  /** The refused send carried attachments, which the message box cannot be
   * given back — the notice has to say so rather than promise them. */
  hadAttachments: boolean;
}

export const NO_ROOM_CODE = 'local_model_no_room';

/** Whether a socket `error` or a `stream.end` is a no-room refusal. */
export function isNoRoom(event: { type: string; code?: string; error_code?: string }): boolean {
  return event.type === 'error' ? event.code === NO_ROOM_CODE : event.error_code === NO_ROOM_CODE;
}

/** A send not yet accepted, remembered under the `client_ref` it went out with. */
export interface PendingSend {
  text: string;
  localMsgId: string;
  /** The conversation the send created locally, or null for an existing one. */
  localConvId: string | null;
  hadAttachments: boolean;
  /** False while the frame has not gone out yet — a workspace's conversation
   * is created over REST first. Absent means it has. The server cannot know of
   * such a send, so it must not be asked about: its "unknown" would be true,
   * and the message would be taken back just before it is sent. */
  dispatched?: boolean;
}

/**
 * A name for a send, echoed by the server as `client_ref`. The server keys what
 * became of a send by user and this name, so it must not repeat across one
 * person's devices — a timestamp alone does, for two sends in the same
 * millisecond, and would hand one device the other's conversation.
 */
export function newClientRef(now: number = Date.now(), random: () => number = Math.random): string {
  return `lm${String(now)}${random().toString(36).slice(2, 8)}`;
}

const KEPT = 20;

/**
 * Sends in flight, by `client_ref`. A refusal names its send, so with two in
 * flight the one refused is the one taken back — a single "last send" slot
 * took back the *later* send's bubble when an earlier refusal landed after it.
 * Bounded: an accepted send is never taken, and only the newest few can still
 * be waiting on an answer.
 */
export class PendingSends {
  private readonly sends = new Map<string, PendingSend>();

  remember(ref: string, send: PendingSend): void {
    this.sends.delete(ref);
    this.sends.set(ref, send);
    while (this.sends.size > KEPT) {
      const oldest = this.sends.keys().next().value;
      if (oldest === undefined) break;
      this.sends.delete(oldest);
    }
  }

  /**
   * The ref of the send that created the local conversation `localConvId` —
   * the one to ask about when a socket is replaced while that conversation is
   * still waiting to learn its real id (`send.status`).
   */
  refFor(localConvId: string): string | undefined {
    let found: string | undefined;
    for (const [ref, send] of this.sends) {
      if (send.localConvId === localConvId && send.dispatched !== false) found = ref;
    }
    return found;
  }

  /** The send `ref` has now really gone out. */
  markDispatched(ref: string): void {
    const send = this.sends.get(ref);
    if (send) send.dispatched = true;
  }

  /** The send `ref` names, forgotten as it is returned. */
  take(ref: string | undefined): PendingSend | undefined {
    if (!ref) return undefined;
    const send = this.sends.get(ref);
    this.sends.delete(ref);
    return send;
  }
}

/**
 * Which local conversation a `turn.started` gives its real id to, whether
 * that is the one still being waited on (`pendingLocalId`), and whether the
 * send it answers is one this device remembers (`known`).
 *
 * An answer naming its send (`client_ref`) settles that send's conversation and
 * no other. A replayed answer can land after the person has started another
 * thread, and taking "whatever is pending" renamed the newer thread to the
 * older one's id. Without a ref — a compaction, or an older server — it is the
 * pending one, as it always was.
 */
export function settledByTurnStarted(
  clientRef: string | undefined,
  sends: PendingSends,
  pendingLocalId: string | null,
): { localId: string | null; isPending: boolean; known: boolean } {
  if (!clientRef) return { localId: pendingLocalId, isPending: pendingLocalId !== null, known: false };
  const send = sends.take(clientRef);
  const localId = send?.localConvId ?? null;
  return { localId, isPending: localId !== null && localId === pendingLocalId, known: send !== undefined };
}

/**
 * Whether the screen should move to the conversation a `turn.started` names.
 * Its own new thread still being waited on, or the thread on screen: yes. A
 * send of ours into a conversation that already existed (a message, a retry):
 * never — it is on screen already, or the person has left it, and pulling them
 * back mid-typing is the one wrong answer. Only an answer this device cannot
 * place (no ref, an older server) is followed blindly, as it always was.
 */
export function followsTurnStarted(
  settled: { localId: string | null; isPending: boolean; known: boolean },
  activeId: string | null,
): boolean {
  if (settled.isPending) return true;
  if (!settled.known) return true;
  return settled.localId !== null && activeId === settled.localId;
}

/** What a retry is remembered as: a send with no text and no bubble, into a
 * conversation that exists — so its answer is placed, and a refusal of it
 * takes nothing back. */
export function retrySend(ref: string): PendingSend {
  return { text: '', localMsgId: ref, localConvId: null, hadAttachments: false };
}

/** The notice for a refusal of `send`, or of a send no longer known. */
export function noRoomNotice(message: string, send: PendingSend | undefined): NoRoomNotice {
  return { message, text: send ? send.text : null, hadAttachments: send?.hadAttachments ?? false };
}

/**
 * What the modal says happened to the message — only what is true of it. The
 * text goes back in the box when there was text; attachments cannot, so they
 * are named as needing adding again.
 */
export function unsentNote(notice: NoRoomNotice): string | null {
  if (notice.text === null) return null;
  if (notice.text.trim()) {
    return notice.hadAttachments
      ? 'Your message was not sent. Its text is back in the message box; add its attachments again.'
      : 'Your message was not sent. It is back in the message box.';
  }
  return notice.hadAttachments ? 'Your message was not sent. Add its attachments again.' : 'Your message was not sent.';
}

/**
 * What to say when the server has no record of a send whose answer was lost
 * with its socket (`send.unknown`). "May not", not "was not": a server that
 * restarted after starting the run no longer remembers it either.
 */
export function lostSendNote(send: PendingSend): string {
  const lead = 'The connection dropped before the server confirmed your message, so it may not have been sent.';
  if (send.text.trim()) {
    return send.hadAttachments
      ? `${lead} Its text is back in the message box; add its attachments again.`
      : `${lead} It is back in the message box.`;
  }
  return send.hadAttachments ? `${lead} Add its attachments again.` : lead;
}
