import type { FastifyInstance } from "fastify";
import { SandboxLimitError } from "../agent/sandbox-manager.ts";

/** A refused sandbox start (#254), as every route answers it: the sentence,
 * plus the numbers a client can draw the allocation from. */
export function sandboxLimitBody(err: SandboxLimitError) {
  return {
    error: err.message,
    code: err.code,
    reason: err.reason,
    used: err.used,
    need: err.need,
    allocation: err.allocation,
  };
}

/**
 * The API's error handler. A sandbox can be started or woken from many routes
 * — exec, files, git, rewind — and a refusal from any of them is the same
 * 429, never a 500. Everything else goes on to Fastify's default handling.
 */
export function installApiErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof SandboxLimitError) return reply.code(429).send(sandboxLimitBody(err));
    return reply.send(err);
  });
}
