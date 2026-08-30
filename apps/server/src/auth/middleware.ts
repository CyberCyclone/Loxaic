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
 * Bearer token → verified, non-banned session; otherwise sends the response
 * and throws.
 *
 * Both entry points below share this so the parts that must stay identical —
 * token parsing, session lookup, ban enforcement — can't drift apart as one
 * of them gains a check the other doesn't.
 */
async function resolveSession(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<VerifiedSession> {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    reply.code(401).send({ error: "Missing authorization header" });
    throw new Error("Unauthorized");
  }
  const token = header.slice(7);
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

export async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<string> {
  const session = await resolveSession(request, reply);
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
