/**
 * A send refused because pinned host models leave no GPU memory for the one
 * chosen (the server's `local_model_no_room`). `text` is the message that was
 * not sent, to put back in the message box — null when the refusal came
 * mid-run, where the message had already been sent and is in the thread.
 */
export interface NoRoomNotice {
  message: string;
  text: string | null;
}

export const NO_ROOM_CODE = 'local_model_no_room';

/** Whether a socket `error` or a `stream.end` is a no-room refusal. */
export function isNoRoom(event: { type: string; code?: string; error_code?: string }): boolean {
  return event.type === 'error' ? event.code === NO_ROOM_CODE : event.error_code === NO_ROOM_CODE;
}
