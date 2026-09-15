import { stripControl } from "../mcp/sanitize.ts";

/**
 * The reason a turn failed, as stored on its message row and shown under the
 * failed reply.
 *
 * Bounded because it originates in whatever a backend put in its error body,
 * which nothing else bounds: a runtime that echoes the request back, or an HTML
 * error page from a proxy in front of it, would otherwise ride along in every
 * history load of that conversation, forever.
 *
 * Its audience is wider than the event it used to be. A column is re-served on
 * every history load to everyone who can read the thread, viewer-level share
 * recipients included, and it lands in the client's offline cache. Two rules
 * follow from that:
 *
 * - The client renders it as plain `<Text>` (`Message.tsx`, `CompactionCard.tsx`),
 *   never `<Markdown>`. An upstream error body is untrusted content, and plain
 *   text is what keeps it from ever becoming stored markup. Do not change that
 *   without treating this string as hostile.
 * - Only text that came from the inference backend is stored as-is (see
 *   `markBackendErrors`). Anything else that fails mid-turn — a database write,
 *   our own code — gets `TURN_FAILED` and is logged server-side instead, because
 *   its message is ours, not the model's, and can name internal detail.
 */
export const MAX_ERROR_TEXT_CHARS = 1_000;

/** Null for an empty message, so the client's "This response failed." fallback
 * applies rather than an empty line under the icon. Control characters and ANSI
 * escapes are stripped the way `mcp/sanitize.ts` strips untrusted tool output. */
export function capErrorText(text: string | undefined): string | null {
  if (!text) return null;
  const clean = stripControl(text);
  if (!clean.trim()) return null;
  return clean.length > MAX_ERROR_TEXT_CHARS ? `${clean.slice(0, MAX_ERROR_TEXT_CHARS - 1)}…` : clean;
}

/** Recorded on a turn a server restart cut off. Ours to phrase rather than a
 * backend's, and the true reason: no process survived to finish the row. */
export const INTERRUPTED_BY_RESTART = "The server restarted before this response finished.";

/** Stored and shown when a turn failed for a reason that did not come from the
 * backend. Deliberately says nothing more: the real message is logged. */
export const TURN_FAILED = "Something went wrong on the server while finishing this response.";

const backendErrors = new WeakSet();

/**
 * Passes a completion stream through, marking anything the stream itself
 * throws as the backend's. An error thrown by the *consumer's* loop body is not
 * marked: `for await` answers a body throw with `return()`, which never reaches
 * this `catch`. That is what lets a run tell "the model failed, here is why"
 * from "our own write failed" without the provider having to tag anything.
 */
export async function* markBackendErrors<T>(source: AsyncIterable<T>): AsyncGenerator<T> {
  try {
    yield* source;
  } catch (err) {
    if (err !== null && typeof err === "object") backendErrors.add(err);
    throw err;
  }
}

export function isBackendError(err: unknown): boolean {
  return err !== null && typeof err === "object" && backendErrors.has(err);
}

/**
 * The reason to store and emit for a failed turn: the backend's own words when
 * it was the backend, otherwise `TURN_FAILED` with the real error logged.
 * `backendText` lets a caller substitute its own phrasing of a backend error
 * (the engine's vision hint).
 */
export function turnErrorText(err: unknown, label: string, backendText?: string): string {
  if (isBackendError(err)) return capErrorText(backendText ?? (err as Error).message) ?? TURN_FAILED;
  console.error(`${label}:`, err);
  return TURN_FAILED;
}
