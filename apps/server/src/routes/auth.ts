import type { FastifyInstance, FastifyReply } from "fastify";
import { auth } from "../auth";

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
      body: { email, password, name: name ?? email.split("@")[0] },
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

  // Session
  app.get("/api/auth/session", async (request, reply) => {
    const result = await auth.api.getSession({
      headers: new Headers(request.headers as HeadersInit),
    });
    if (!result) {
      reply.code(401);
      return { error: "No session" };
    }
    return result;
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
  reply.code(res.status);
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
