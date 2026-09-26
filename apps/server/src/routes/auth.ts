import type { FastifyInstance, FastifyReply } from "fastify";
import { auth } from "../auth";
import { isBanned } from "../auth/ban.ts";
import { authenticateForPasswordChange } from "../auth/middleware.ts";
import { clearMustChangePassword } from "../auth/password-reset.ts";

export function authRoutes(app: FastifyInstance) {
  // Sign up
  app.post("/api/auth/sign-up", async (request, reply) => {
    const { email, password, name } = request.body as {
      email: string;
      password: string;
      name?: string;
    };
    if (!email || !password) {
      reply.code(400);
      return { error: "Email and password required" };
    }
    const res = await auth.api.signUpEmail({
      // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- an empty name must still fall back to the email local-part; ?? would keep the empty string.
      body: { email, password, name: name || email.split("@")[0] },
      headers: new Headers(request.headers as HeadersInit),
      asResponse: true,
    });
    return forwardAuthResponse(res, reply);
  });

  // Sign in
  app.post("/api/auth/sign-in", async (request, reply) => {
    const { email, password } = request.body as {
      email: string;
      password: string;
    };
    if (!email || !password) {
      reply.code(400);
      return { error: "Email and password required" };
    }
    const res = await auth.api.signInEmail({
      body: { email, password },
      headers: new Headers(request.headers as HeadersInit),
      asResponse: true,
    });
    return forwardAuthResponse(res, reply);
  });

  // Sign out
  app.post("/api/auth/sign-out", async (request, reply) => {
    const res = await auth.api.signOut({
      headers: new Headers(request.headers as HeadersInit),
      asResponse: true,
    });
    return forwardAuthResponse(res, reply);
  });

  // Session. Outside the middleware on purpose — a user who must change their
  // password has to be able to learn who they are — but a ban is still a ban.
  // better-auth only checks one at sign-in, so a session that was live when the
  // ban landed kept answering here: a client whose socket was refused (4001)
  // asked, was told the user was fine, and reconnected forever under a banner
  // blaming the server. 401, like a dead session, is what makes a client sign
  // out; signing in again then gets better-auth's own "banned" answer.
  app.get("/api/auth/session", async (request, reply) => {
    const result = await auth.api.getSession({
      headers: new Headers(request.headers as HeadersInit),
    });
    if (!result) {
      reply.code(401);
      return { error: "No session" };
    }
    if (isBanned(result.user)) {
      reply.code(401);
      return { error: "Account suspended", code: "account_suspended" };
    }
    return result;
  });

  // Change password. Always revokes every other session: a password change is
  // most often "someone else may have it", and a checkbox to keep them signed
  // in is a way to get that wrong. better-auth's revokeOtherSessions deletes
  // *every* session, this one included, and mints a replacement — returned as
  // `token` in the body (and set as the cookie). A client that does not swap
  // to it is signed out by its own password change.
  //
  // Reachable for a user who must change their password (that is its whole
  // purpose), which is why it authenticates through
  // authenticateForPasswordChange rather than authenticate. Never log the body.
  app.post("/api/auth/change-password", async (request, reply) => {
    const { currentPassword, newPassword } = (request.body ?? {}) as {
      currentPassword?: unknown;
      newPassword?: unknown;
    };
    if (typeof currentPassword !== "string" || typeof newPassword !== "string" || !currentPassword || !newPassword) {
      reply.code(400);
      return { error: "Current and new password required" };
    }
    // The one check better-auth does not make. After a reset the current
    // password is the temporary one an admin read off a screen (or a terminal
    // kept in its scrollback), and clearing the flag while it still works is
    // the exact outcome the flag exists to prevent. Checked before the
    // current password is verified, so it costs nothing and leaks nothing.
    if (currentPassword === newPassword) {
      reply.code(400);
      return { error: "Choose a password you have not used before.", code: "PASSWORD_UNCHANGED" };
    }
    const session = await authenticateForPasswordChange(request, reply);
    const res = await auth.api.changePassword({
      body: { currentPassword, newPassword, revokeOtherSessions: true },
      headers: new Headers(request.headers as HeadersInit),
      asResponse: true,
    });
    const ok = res.ok;
    // better-auth's own errors (INVALID_PASSWORD, PASSWORD_TOO_SHORT, …) come
    // back as `{ code, message }` and are forwarded untouched; the client
    // branches on `code`.
    const body = await forwardAuthResponse(res, reply);
    // The id is the authenticated session's, not a claim in the forwarded
    // payload — and a failure here must not turn a change that has already
    // happened (every old session revoked) into a 500 that reads as "failed".
    if (ok) {
      try {
        await clearMustChangePassword(session.user.id);
      } catch (err) {
        request.log.error({ err, userId: session.user.id }, "password changed but must_change_password was not cleared");
      }
    }
    return body;
  });

  // Token (for WebSocket / native Bearer auth)
  app.get("/api/auth/token", async (request, reply) => {
    const result = await auth.api.getSession({
      headers: new Headers(request.headers as HeadersInit),
    });
    if (!result) {
      reply.code(401);
      return { error: "No session" };
    }
    // The raw session token doubles as a Bearer token — see the `bearer`
    // plugin in ../auth/index.ts, which accepts it via `Authorization: Bearer <token>`.
    return { token: result.session.token };
  });
}

// better-auth signs its own session cookie (HMAC over the raw token); we must
// forward its real Set-Cookie header(s) rather than reconstruct one, or the
// cookie fails signature verification on every subsequent request.
async function forwardAuthResponse(res: Response, reply: FastifyReply) {
  for (const cookie of res.headers.getSetCookie()) {
    reply.header("set-cookie", cookie);
  }
  // The bearer plugin's way of announcing a new session token (sign-in, and a
  // password change that re-mints the session). Our clients read the token
  // from the body; forwarded so the documented contract holds too.
  const bearer = res.headers.get("set-auth-token");
  if (bearer) reply.header("set-auth-token", bearer);
  reply.code(res.status);
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
