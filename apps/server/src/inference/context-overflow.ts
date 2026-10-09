/**
 * A backend refusing a request because it is longer than the model's context.
 *
 * Loxaic refuses such a request itself when it knows the window
 * (`fillDecision`'s "cannot"), but it does not always know it — a hosted model
 * that reports no size, a size an admin set wrong, a backend whose slot is
 * smaller than its listing says. Then the backend refuses, each in its own
 * words, and before this the person saw the words and had no way out but a
 * new conversation. Recognised, the refusal carries `context_overflow`, and
 * the failed reply offers "Edit message" and Retry (#166).
 *
 * Matched on what each backend actually sends, never on "context" alone:
 * - OpenAI: `code: "context_length_exceeded"`, "This model's maximum context
 *   length is 8192 tokens…";
 * - vLLM: the same "maximum context length" sentence;
 * - llama.cpp: `type: "exceed_context_size_error"`, "request (N tokens) exceeds
 *   the available context size (M tokens), try increasing it" (read from
 *   b11342's server library), and "Context size has been exceeded.";
 * - LM Studio: "…is greater than the context length…";
 * - Anthropic: "prompt is too long: N tokens > M maximum".
 */

export const CONTEXT_OVERFLOW = "context_overflow" as const;

/** The backend's refusal, kept in its own words, marked so the run can say
 * which way out there is. */
export class ContextOverflowError extends Error {
  readonly code = CONTEXT_OVERFLOW;
  constructor(message: string) {
    super(message);
    this.name = "ContextOverflowError";
  }
}

const OVERFLOW_CODES = new Set(["context_length_exceeded", "exceed_context_size_error", "string_above_max_length"]);

const OVERFLOW_TEXT = [
  /maximum context length/i,
  /exceeds the available context size/i,
  /context size has been exceeded/i,
  /greater than the context length/i,
  /prompt is too long/i,
  /context[_ ]length[_ ]exceeded/i,
];

/** What a backend's error body says about itself, as far as it says. */
export interface BackendErrorFields {
  message?: unknown;
  code?: unknown;
  type?: unknown;
}

export function isContextOverflow(error: BackendErrorFields): boolean {
  for (const field of [error.code, error.type]) {
    if (typeof field === "string" && OVERFLOW_CODES.has(field)) return true;
  }
  const message = error.message;
  return typeof message === "string" && OVERFLOW_TEXT.some((re) => re.test(message));
}

/**
 * The error object out of a backend's error body: `{"error": {...}}` (OpenAI,
 * llama.cpp, vLLM, LM Studio) or `{"error": "text"}`, or nothing usable.
 */
export function backendErrorFields(body: unknown): BackendErrorFields | null {
  if (typeof body !== "object" || body === null) return null;
  const error = (body as { error?: unknown }).error;
  if (typeof error === "string") return { message: error };
  if (typeof error === "object" && error !== null) return error;
  return null;
}
