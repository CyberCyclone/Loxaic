import type { FastifyInstance } from "fastify";
import { findQueryError } from "@loxaic/db";
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

/** Said in place of a failed query, whose own message is SQL. */
export const QUERY_FAILED = "The server could not complete this request.";

/**
 * The API's error handler. A sandbox can be started or woken from many routes
 * — exec, files, git, rewind — and a refusal from any of them is the same
 * 429, never a 500. A failed query, or an error caused by one, answers a
 * sentence rather than SQL (`@loxaic/db` has already taken its parameters
 * out, so it is logged whole). Everything else goes on to Fastify's default
 * handling.
 */
export function installApiErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err, request, reply) => {
    if (err instanceof SandboxLimitError) return reply.code(429).send(sandboxLimitBody(err));
    if (findQueryError(err)) {
      request.log.error({ err }, "request failed on a query");
      return reply.code(500).send({ error: QUERY_FAILED });
    }
    return reply.send(err);
  });
}
