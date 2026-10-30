/**
 * Replaces what a Postgres `jsonb` value cannot hold: NUL, and a lone
 * surrogate (`\p{Cs}` under the `u` flag matches only unpaired ones). Both pass
 * `JSON.stringify` and are refused by the database with `22P05`, so a tool's
 * bytes would otherwise fail the whole row and every result in it.
 *
 * U+FFFD rather than deletion, so a reader can see something was there.
 * Idempotent, which is what lets the prompt and the stored row each go through
 * it on their own and still replay the same bytes.
 */
// eslint-disable-next-line no-control-regex
const UNSTORABLE = /[\u0000\p{Cs}]/gu;

export function jsonbSafe<T>(value: T): T;
export function jsonbSafe(value: unknown): unknown {
  if (typeof value === "string") return value.replace(UNSTORABLE, "\ufffd");
  if (Array.isArray(value)) return value.map((item: unknown) => jsonbSafe(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [jsonbSafe(key), jsonbSafe(item)]));
  }
  return value;
}
