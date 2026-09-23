// The HTTP transport for model requests — the ones that can legitimately wait
// minutes before a single byte comes back.
//
// Why npm `undici` rather than the global `fetch`: Node's built-in fetch is
// undici with `headersTimeout` and `bodyTimeout` of 300 000 ms, and llama.cpp
// (and LM Studio, built on it) send no response headers for a streaming
// completion until prompt processing has finished. A prompt that takes longer
// than five minutes to evaluate was therefore cut off by our own client — the
// backend logged "Client disconnected" at exactly 300 s and we logged nothing
// but "fetch failed". The fix is a dispatcher whose timeouts are far past any
// real prompt evaluation, and that dispatcher has to be driven by a `fetch`
// from the *same* undici: handing
// an npm-undici Agent to Node's bundled fetch is unreliable across undici
// majors, and the packaged desktop runs Electron 33's Node 20 (undici 6) while
// dev runs Node 24 (undici 7). Importing both from one package makes the pair
// identical on every runtime. It is used for inference calls only; quick probes
// (`/props`, `/v1/models`) keep the global fetch and their own short timeouts.
import { Agent, fetch, type RequestInit, type Response } from "undici";

export interface InferenceTimeouts {
  /** Prompt evaluation happens before headers are sent. */
  headersTimeout: number;
  /** Idle time between chunks. A reasoning model can pause for a long time. */
  bodyTimeout: number;
  /** Reaching the server is not the slow part; a wrong address should fail fast. */
  connectTimeout: number;
}

/**
 * How long a connected model request may wait for its headers, or between two
 * chunks of its body, before we give up on it. Both timeouts are this.
 *
 * It is a trade between two failures. Too short, and a real prompt is cut off
 * by our own client: 300 s did exactly that to a 39k-token prompt. Disabled
 * (0), and a backend that wedges *after* accepting the connection — a stuck
 * model load, a proxy holding the socket — keeps the run alive forever. Stop
 * is then the only way out, and the run holds its inference slot the whole
 * time: at concurrency 1, which is what LM Studio always resolves to, every
 * other conversation on the deployment queues behind it, and an automatic
 * compaction has nobody watching to press Stop at all. An hour is an order of
 * magnitude past any prompt evaluation we have seen, and still ends a wedge.
 */
export const INFERENCE_TIMEOUT_CEILING_MS = 60 * 60 * 1000;

const DEFAULT_TIMEOUTS: InferenceTimeouts = {
  headersTimeout: INFERENCE_TIMEOUT_CEILING_MS,
  bodyTimeout: INFERENCE_TIMEOUT_CEILING_MS,
  connectTimeout: 10_000,
};

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

/** The dispatcher every model request uses unless a test passes its own. */
export function inferenceDispatcher(): Agent {
  return (shared ??= createInferenceDispatcher());
}

export async function inferenceFetch(
  url: string,
  init: Omit<RequestInit, "dispatcher">,
  dispatcher: Agent = inferenceDispatcher(),
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
  return new Error(message ?? fallbackMessage(code), { cause: err });
}

/**
 * Names the error code and nothing else. undici's own message for these
 * ("connect EHOSTUNREACH 10.0.0.5:4002") carries the backend's address, and
 * this sentence reaches every client on the conversation — shared viewers
 * included. The code is what someone debugging needs; the original error stays
 * on `cause` for the server side. Shape-checked so only a bare code gets in.
 */
function fallbackMessage(code: string | undefined): string {
  return code !== undefined && /^[A-Z][A-Z0-9_]{1,63}$/.test(code)
    ? `The request to the model server failed (${code}).`
    : "The request to the model server failed.";
}
