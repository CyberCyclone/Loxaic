import type { FastifyRequest, FastifyReply } from "fastify";
import { auth } from "../auth";

export async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<string> {
  const header = request.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
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
  return session.user.id;
}