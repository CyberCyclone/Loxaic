/**
 * A send's `client_ref`, when it is one to echo back: a short token of plain
 * characters. It arrives off a socket, so it is a claim — only ever echoed to
 * the socket that sent it, and bounded so it cannot make the server send back
 * anything large or anything but an identifier.
 */
export function clientRefOf(msg: unknown): string | undefined {
  if (typeof msg !== "object" || msg === null) return undefined;
  const ref = (msg as { client_ref?: unknown }).client_ref;
  return typeof ref === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(ref) ? ref : undefined;
}
