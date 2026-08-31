import type { FastifyRequest, FastifyReply } from "fastify";
import { auth } from "../auth";

type VerifiedSession = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;

/**
 * A ban is only enforced when a session is *created* (better-auth's admin
 * plugin checks it in `session.create.before`); nothing re-checks it on the
 * read path. Its own ban endpoints delete the user's sessions, so a ban
 * applied through those takes effect at once — but a ban applied any other
 * way, notably the direct `UPDATE "user" SET banned = true` an operator would
 * reach for (the same shape as the role-promotion recovery path documented in
 * AGENTS.md), would otherwise never be enforced at all.
 *
 * An expired ban counts as lifted, mirroring better-auth's own auto-unban.
 */
function isBanned(user: VerifiedSession["user"]): boolean {
  if (!user.banned) return false;
  if (user.banExpires && new Date(user.banExpires).getTime() < Date.now()) return false;
  return true;
}

/**
 * Bearer token → session, or null when the token is invalid *or the user is
 * banned*.
 *
 * For WebSocket handlers, which have no `FastifyReply` to write a status onto
 * and close the socket with their own code instead. They previously called
 * `auth.api.getSession` directly, which meant a banned user kept every live
 * socket — including an interactive sandbox terminal — until the session
 * expired on its own.
 */
export async function resolveSessionFromToken(token: string): Promise<VerifiedSession | null> {
  const session = await auth.api.getSession({
    headers: new Headers({ authorization: `Bearer ${token}` }),
  });
  if (!session || isBanned(session.user)) return null;
  return session;
}

/**
 * Token → verified, non-banned session; otherwise sends the response and
 * throws.
 *
 * Every HTTP entry point below funnels through this, so the parts that must
 * stay identical — session lookup, ban enforcement, status codes — can't
 * drift apart as one of them gains a check the others don't. Only *where the
 * token comes from* is allowed to differ.
 */
async function verifyToken(token: string, reply: FastifyReply): Promise<VerifiedSession> {
  const session = await auth.api.getSession({
    headers: new Headers({ authorization: `Bearer ${token}` }),
  });
  if (!session) {
    reply.code(401).send({ error: "Invalid session" });
    throw new Error("Unauthorized");
  }
  if (isBanned(session.user)) {
    reply.code(403).send({ error: "Account suspended" });
    throw new Error("Forbidden");
  }
  return session;
}

async function resolveSession(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<VerifiedSession> {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    reply.code(401).send({ error: "Missing authorization header" });
    throw new Error("Unauthorized");
  }
  return await verifyToken(header.slice(7), reply);
}

export async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<string> {
  const session = await resolveSession(request, reply);
  return session.user.id;
}

/**
 * Like {@link authenticate}, but also accepts `?token=` — for URLs loaded by
 * `<img>`/`Image`, which can't set an Authorization header. Same precedent as
 * the WS routes' `/ws/chat?token=`.
 *
 * The header is still preferred when present; the query parameter is a
 * fallback, not an override, so a page that *can* set a header never has its
 * auth downgraded to one that leaks into logs and referrers.
 */
export async function authenticateHeaderOrQuery(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<string> {
  const header = request.headers.authorization;
  const token = header?.startsWith("Bearer ")
    ? header.slice(7)
    : (request.query as { token?: string }).token;
  if (!token) {
    reply.code(401).send({ error: "Missing authorization" });
    throw new Error("Unauthorized");
  }
  const session = await verifyToken(token, reply);
  return session.user.id;
}

/** Like {@link authenticate}, but also requires the session user to hold the
 * "admin" role (better-auth admin plugin) — used to gate server-level
 * settings (e.g. sandbox engine/mode) that affect every user. */
export async function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<string> {
  const session = await resolveSession(request, reply);
  if (session.user.role !== "admin") {
    reply.code(403).send({ error: "Admin access required" });
    throw new Error("Forbidden");
  }
  return session.user.id;
}
