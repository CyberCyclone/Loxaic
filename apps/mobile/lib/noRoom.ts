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

  /** The send `ref` names, forgotten as it is returned. */
  take(ref: string | undefined): PendingSend | undefined {
    if (!ref) return undefined;
    const send = this.sends.get(ref);
    this.sends.delete(ref);
    return send;
  }
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
