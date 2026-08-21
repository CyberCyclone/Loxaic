import type { FastifyInstance } from "fastify";
import { auth } from "../auth";

export async function authRoutes(app: FastifyInstance) {
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
    const result = await auth.api.signUpEmail({
      body: { email, password, name: name || email.split("@")[0] },
      headers: request.headers as Record<string, string>,
    });
    const sessionToken = (result as { token?: string })?.token;
    if (sessionToken) setSessionCookie(sessionToken, reply);
    return result;
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
    const result = await auth.api.signInEmail({
      body: { email, password },
      headers: request.headers as Record<string, string>,
    });
    const sessionToken = (result as { token?: string })?.token;
    if (sessionToken) setSessionCookie(sessionToken, reply);
    return result;
  });

  // Sign out
  app.post("/api/auth/sign-out", async (request, reply) => {
    const result = await auth.api.signOut({
      headers: request.headers as Record<string, string>,
    });
    return result;
  });

  // Session
  app.get("/api/auth/session", async (request, reply) => {
    const result = await auth.api.getSession({
      headers: request.headers as Record<string, string>,
    });
    if (!result) {
      reply.code(401);
      return { error: "No session" };
    }
    return result;
  });

  // Token (for WS auth)
  app.get("/api/auth/token", async (request, reply) => {
    const session = await auth.api.getSession({
      headers: request.headers as Record<string, string>,
    });
    if (!session) {
      reply.code(401);
      return { error: "No session" };
    }
    // Return session token for WebSocket auth
    const cookieHeader = request.headers.cookie || "";
    const match = cookieHeader.match(/better-auth\.session_token=([^;]+)/);
    return { token: match ? match[1] : null };
  });
}

function setAuthCookies(result: object, reply: { header: (name: string, value: string) => void }) {
  const headers = (result as Record<string, unknown>)?.headers as
    | Headers
    | Record<string, string | string[]>
    | undefined;
  if (headers instanceof Headers) {
    const cookies = headers.getSetCookie();
    for (const cookie of cookies) {
      reply.header("set-cookie", cookie);
    }
  } else if (headers) {
    const cookieVal = headers["set-cookie"] || headers["Set-Cookie"];
    if (cookieVal) {
      if (Array.isArray(cookieVal)) {
        for (const c of cookieVal) reply.header("set-cookie", c);
      } else {
        reply.header("set-cookie", cookieVal as string);
      }
    }
  }
}

function setSessionCookie(token: string, reply: { header: (name: string, value: string) => void }) {
  const maxAge = 60 * 60 * 24 * 30; // 30 days
  reply.header("set-cookie", `better-auth.session_token=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`);
}