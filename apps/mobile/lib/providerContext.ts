/**
 * The provider form's context sizes, as text fields and as the map the server
 * stores (`contextWindows`: tokens by model id, and under "*" for every model
 * the provider reports none for).
 *
 * Why the form has them at all: a model whose size is unknown can never be
 * compacted, so its conversations grow until the provider refuses a request,
 * and then every turn fails. OpenAI's model list reports no sizes.
 *
 * Pure, so the rules are tested without a form.
 */

/** The bounds the server enforces (`CONTEXT_WINDOW_MIN`/`MAX`). */
export const CONTEXT_SIZE_MIN = 1024;
export const CONTEXT_SIZE_MAX = 100_000_000;

/** A typed size in tokens: digits, with commas, spaces or underscores allowed
 * as separators. Null for an empty field, `'invalid'` for anything else that
 * is not a whole number in range. */
export function parseContextSize(text: string): number | null | 'invalid' {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const digits = trimmed.replace(/[,_\s]/g, '');
  if (!/^\d+$/.test(digits)) return 'invalid';
  const n = Number(digits);
  return n >= CONTEXT_SIZE_MIN && n <= CONTEXT_SIZE_MAX ? n : 'invalid';
}

export const CONTEXT_SIZE_ERROR = `A context size is a whole number of tokens from ${CONTEXT_SIZE_MIN.toLocaleString('en-US')} to ${CONTEXT_SIZE_MAX.toLocaleString('en-US')}.`;

/** The stored map, split into the form's two parts. */
export function splitContextWindows(stored: Record<string, number> | null | undefined): {
  fallback: string;
  perModel: Record<string, number>;
} {
  const perModel: Record<string, number> = {};
  let fallback = '';
  for (const [id, tokens] of Object.entries(stored ?? {})) {
    if (id === '*') fallback = String(tokens);
    else perModel[id] = tokens;
  }
  return { fallback, perModel };
}

/** The form's two parts, as the map to save — null when nothing is set. */
export function buildContextWindows(
  fallback: string,
  perModel: Record<string, number>,
): { ok: true; value: Record<string, number> | null } | { ok: false; error: string } {
  const parsed = parseContextSize(fallback);
  if (parsed === 'invalid') return { ok: false, error: CONTEXT_SIZE_ERROR };
  const value: Record<string, number> = { ...perModel };
  if (parsed !== null) value['*'] = parsed;
  return { ok: true, value: Object.keys(value).length > 0 ? value : null };
}

/** How many listed models report no size of their own, and so need one set.
 * An entry from an older server, which does not say, is not counted. */
export function modelsWithoutSize(
  models: { id: string; context_tokens?: number | null }[],
  perModel: Record<string, number>,
): number {
  return models.filter((m) => m.context_tokens === null && !Object.prototype.hasOwnProperty.call(perModel, m.id)).length;
}

/** "128,000 tokens", for a stored size. */
export function formatContextSize(tokens: number): string {
  return `${tokens.toLocaleString('en-US')} tokens`;
}
