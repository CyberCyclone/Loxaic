import type { FastifyInstance } from "fastify";
import { describeQueryError, isQueryError } from "@loxaic/db";
import { QUERY_FAILED } from "../streams/error-text.ts";
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
 * 429, never a 500. A failed query never reaches Fastify's default handling,
 * which would log it whole and put its message, parameters included, in the
 * 500 body. Everything else goes on to that default handling.
 */
export function installApiErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err, request, reply) => {
    if (err instanceof SandboxLimitError) return reply.code(429).send(sandboxLimitBody(err));
    if (isQueryError(err)) {
      request.log.error(describeQueryError(err));
      return reply.code(500).send({ statusCode: 500, error: "Internal Server Error", message: QUERY_FAILED });
    }
    return reply.send(err);
  });
}
