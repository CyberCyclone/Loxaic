/**
 * Query-string redaction for the request log.
 *
 * Two routes accept credentials in the query string because their clients
 * cannot set an Authorization header — `/ws/chat?token=` (WebSocket) and
 * `/v1/files/:ref?token=` (an `<img>` src). Fastify's default pino request
 * serializer logs `req.url` verbatim, which writes those full session tokens
 * to stdout at info level: one line per socket, and one per thumbnail render.
 * From there they reach `docker compose logs`, the desktop supervisor's
 * captured child stdout, any reverse-proxy access log, and any bug report
 * with logs attached — each one replayable as a bearer token against every
 * authenticated route.
 */

/** Matched case-insensitively against query parameter names. */
const SENSITIVE_PARAMS = new Set([
  "token",
  "access_token",
  "refresh_token",
  "api_key",
  "apikey",
  "password",
  "secret",
]);

export const REDACTED = "REDACTED";

/**
 * `url` with the value of every sensitive query parameter replaced. The path
 * is left untouched, so log lines still group by route.
 *
 * Returns the input unchanged when there was nothing to redact, rather than a
 * re-serialized equivalent — a URL that never carried a credential should not
 * come out of the logger with different percent-encoding than it went in.
 */
export function redactUrl(url: string): string {
  const q = url.indexOf("?");
  if (q === -1) return url;

  const params = new URLSearchParams(url.slice(q + 1));
  let touched = false;
  for (const key of [...params.keys()]) {
    if (!SENSITIVE_PARAMS.has(key.toLowerCase())) continue;
    // `set` collapses a repeated key to one entry. That is fine here: the
    // point is that no variant of the value survives into the log.
    params.set(key, REDACTED);
    touched = true;
  }
  if (!touched) return url;
  return `${url.slice(0, q)}?${params.toString()}`;
}
