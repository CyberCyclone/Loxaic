/**
 * The reason a turn failed, as stored on its message row and shown under the
 * failed reply.
 *
 * Bounded because it originates in whatever a backend put in its error body,
 * which nothing else bounds: a runtime that echoes the request back, or an HTML
 * error page from a proxy in front of it, would otherwise ride along in every
 * history load of that conversation, forever.
 */
export const MAX_ERROR_TEXT_CHARS = 1_000;

/** Null for an empty message, so the client's "This response failed." fallback
 * applies rather than an empty line under the icon. */
export function capErrorText(text: string | undefined): string | null {
  if (!text) return null;
  return text.length > MAX_ERROR_TEXT_CHARS ? `${text.slice(0, MAX_ERROR_TEXT_CHARS - 1)}…` : text;
}

/** Recorded on a turn a server restart cut off. Ours to phrase rather than a
 * backend's, and the true reason: no process survived to finish the row. */
export const INTERRUPTED_BY_RESTART = "The server restarted before this response finished.";
