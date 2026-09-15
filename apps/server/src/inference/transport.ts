// The HTTP transport for model requests — the ones that can legitimately wait
// minutes before a single byte comes back.
//
// Why npm `undici` rather than the global `fetch`: Node's built-in fetch is
// undici with `headersTimeout` and `bodyTimeout` of 300 000 ms, and llama.cpp
// (and LM Studio, built on it) send no response headers for a streaming
// completion until prompt processing has finished. A prompt that takes longer
// than five minutes to evaluate was therefore cut off by our own client — the
// backend logged "Client disconnected" at exactly 300 s and we logged nothing
// but "fetch failed". The fix is a dispatcher with both timeouts disabled, and
// that dispatcher has to be driven by a `fetch` from the *same* undici: handing
// an npm-undici Agent to Node's bundled fetch is unreliable across undici
// majors, and the packaged desktop runs Electron 33's Node 20 (undici 6) while
// dev runs Node 24 (undici 7). Importing both from one package makes the pair
// identical on every runtime. It is used for inference calls only; quick probes
// (`/props`, `/v1/models`) keep the global fetch and their own short timeouts.
import { Agent, fetch, type RequestInit, type Response } from "undici";

export interface InferenceTimeouts {
  /** 0 disables it. Prompt evaluation happens before headers are sent. */
  headersTimeout: number;
  /** 0 disables it. A reasoning model can pause between chunks for a long time. */
  bodyTimeout: number;
  /** Reaching the server is not the slow part; a wrong address should fail fast. */
  connectTimeout: number;
}

// Nothing time-bounds a model request once it is connected: Stop (the run's
// AbortSignal) is how a person ends one. A peer that vanishes without closing
// the socket is still noticed eventually, because undici enables TCP
// keep-alive on its sockets.
const DEFAULT_TIMEOUTS: InferenceTimeouts = { headersTimeout: 0, bodyTimeout: 0, connectTimeout: 10_000 };

/** Exported so a test can build one with deliberately short timeouts. */
export function createInferenceDispatcher(overrides: Partial<InferenceTimeouts> = {}): Agent {
  const t = { ...DEFAULT_TIMEOUTS, ...overrides };
  return new Agent({
    headersTimeout: t.headersTimeout,
    bodyTimeout: t.bodyTimeout,
    connect: { timeout: t.connectTimeout },
  });
}

let shared: Agent | null = null;

export async function inferenceFetch(
  url: string,
  init: Omit<RequestInit, "dispatcher">,
  dispatcher: Agent = (shared ??= createInferenceDispatcher()),
): Promise<Response> {
  try {
    return await fetch(url, { ...init, dispatcher });
  } catch (err) {
    throw inferenceNetworkError(err, init.signal ?? undefined);
  }
}

interface CodedError { code?: unknown; message?: unknown; errors?: unknown }

function errorCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined;
  const e = err as CodedError;
  if (typeof e.code === "string") return e.code;
  // Happy-eyeballs connects report every attempt in an AggregateError.
  if (Array.isArray(e.errors)) return e.errors.map(errorCode).find((c) => c !== undefined);
  return undefined;
}

/**
 * Turns undici's bare "fetch failed" / "terminated" into a sentence that says
 * what happened, since that message is what reaches the person whose turn
 * ended. An abort passes through untouched: it is a Stop, not a failure, and
 * the run loop recognises it by name.
 */
export function inferenceNetworkError(err: unknown, signal?: AbortSignal): unknown {
  if (!(err instanceof Error)) return err;
  if (err.name === "AbortError" || signal?.aborted) return err;
  const cause = (err as Error & { cause?: unknown }).cause;
  const code = errorCode(cause) ?? errorCode(err);
  const detail = cause instanceof Error ? cause.message : err.message;
  const message = ((): string | null => {
    switch (code) {
      case "UND_ERR_HEADERS_TIMEOUT":
        return "The model server did not start its reply before the request timed out.";
      case "UND_ERR_BODY_TIMEOUT":
        return "The model server stopped sending its reply before the request timed out.";
      case "UND_ERR_CONNECT_TIMEOUT":
        return "Could not reach the model server: the connection attempt timed out.";
      case "ECONNREFUSED":
        return "Could not reach the model server: the connection was refused. Is it running?";
      case "ENOTFOUND":
      case "EAI_AGAIN":
        return "Could not reach the model server: its address could not be resolved.";
      case "UND_ERR_SOCKET":
      case "ECONNRESET":
      case "EPIPE":
        return "The model server closed the connection before its reply finished.";
      default:
        return null;
    }
  })();
  // Only network-level failures are rewritten; anything else already says
  // what it is.
  if (message === null && err.message !== "fetch failed" && err.message !== "terminated") return err;
  return new Error(message ?? `The request to the model server failed: ${detail}`, { cause: err });
}
