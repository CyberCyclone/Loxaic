import type { ExtraOption, LlamaOptionInfo } from '@loxaic/api-client';

/**
 * Extra llama.cpp options as rows an admin types: `key = value`, checked as
 * they are typed against what the running build lists in its `--help`.
 *
 * The server is the authority and checks the same things again
 * (apps/server/src/llama/extra-options.ts). These say so at the row, before
 * Save, in the same words.
 */

/** The server's limit (MAX_EXTRA_OPTIONS). */
export const MAX_ROWS = 32;

export interface OptionRow {
  key: string;
  value: string;
}

/** A key as llama.cpp's preset takes it: the option's name without dashes. */
export function cleanKey(raw: string): string {
  return raw.trim().replace(/^-+/, '');
}

const KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** A row with nothing typed in it, which Save leaves out. */
function blank(row: OptionRow): boolean {
  return !row.key.trim() && !row.value.trim();
}

/** The option a key names, by any of its names. */
export function optionFor(key: string, options: LlamaOptionInfo[] | null): LlamaOptionInfo | null {
  const name = cleanKey(key);
  if (!name || !options) return null;
  return options.find((o) => o.names.includes(name)) ?? null;
}

/**
 * What is wrong with each row, or null. A blank row is fine (it is dropped).
 * With no option list nothing is judged here: the section says why options
 * cannot be set, and the server refuses.
 *
 * `kept` is what is stored. A stored row the running build does not know (set
 * under another version) is not a problem while it is left as it is: it is
 * kept and not passed, which the section says, and refusing it would block
 * saving everything else. The server applies the same rule.
 */
export function rowProblems(rows: OptionRow[], options: LlamaOptionInfo[] | null, kept: OptionRow[] = []): (string | null)[] {
  const seen = new Map<LlamaOptionInfo, string>();
  const seenUnknown = new Set<string>();
  return rows.map((row) => {
    if (blank(row)) return null;
    const key = cleanKey(row.key);
    if (!key) return "Type the option's name";
    if (!KEY.test(key)) return `"${key}" is not an option name`;
    if (!options) return null;
    const option = optionFor(key, options);
    if (!option) {
      const value = row.value.trim();
      if (kept.some((k) => k.key === key && k.value === value) && !seenUnknown.has(key)) {
        seenUnknown.add(key);
        return null;
      }
      return `This llama.cpp build has no option "${key}"`;
    }
    if (option.reserved) return `"${key}" can't be set here. ${option.reserved}`;
    const earlier = seen.get(option);
    if (earlier !== undefined) return earlier === key ? `"${key}" is set twice` : `"${key}" is the same option as "${earlier}", set above`;
    seen.set(option, key);
    if (/[\r\n]/.test(row.value)) return 'A value must be on one line';
    const value = row.value.trim();
    if (!option.takesValue) {
      const v = value.toLowerCase();
      if (v !== 'true' && v !== 'false') return `"${key}" is a switch: its value is true or false`;
    } else if (!value) return `"${key}" needs a value`;
    return null;
  });
}

/** The rows as they are sent: blank ones left out, keys without dashes. */
export function rowsToSave(rows: OptionRow[]): ExtraOption[] {
  return rows.filter((r) => !blank(r)).map((r) => ({ key: cleanKey(r.key), value: r.value.trim() }));
}

/** Whether two lists would save the same. */
export function sameOptions(a: OptionRow[], b: OptionRow[]): boolean {
  return JSON.stringify(rowsToSave(a)) === JSON.stringify(rowsToSave(b));
}

/** The line under a row: what the option does, once the key names one. */
export function rowHint(row: OptionRow, options: LlamaOptionInfo[] | null): string | null {
  const option = optionFor(row.key, options);
  if (!option || option.reserved) return null;
  const what = option.description || null;
  if (!option.takesValue) return what ? `${what} · a switch: true or false` : 'A switch: true or false';
  return what;
}

/**
 * Rows being edited, and the saved list they started from. What decides
 * whether a poll may replace them is whether they were edited (would save
 * differently from `base`), not whether anyone ever typed: an edit undone by
 * hand follows the server again (found in review).
 */
export interface OptionDraft {
  rows: OptionRow[];
  base: OptionRow[];
}

export function draftOf(saved: OptionRow[]): OptionDraft {
  return { rows: saved, base: saved };
}

/** The draft once the server says `saved`: taken over when unedited, kept
 * (with its base) when edited, so a poll never throws typing away. */
export function followSaved(draft: OptionDraft, saved: OptionRow[]): OptionDraft {
  return sameOptions(draft.rows, draft.base) ? draftOf(saved) : draft;
}

/** Edited here while the saved list changed elsewhere: saving would replace
 * that change. */
export function changedElsewhere(draft: OptionDraft, saved: OptionRow[]): boolean {
  return !sameOptions(draft.rows, draft.base) && !sameOptions(draft.base, saved);
}

/**
 * A server refusal that names a row (`index` into the list sent, which leaves
 * blank rows out) as the draft row it came from, or null. Only while the rows
 * are the ones that were sent: once they change, the client's own checking is
 * what speaks.
 */
export interface ServerProblem {
  index: number;
  message: string;
  /** `rowsToSave` of the rows that were sent. */
  sent: string;
}

export function withServerProblem(problems: (string | null)[], rows: OptionRow[], refusal: ServerProblem | null): (string | null)[] {
  if (refusal?.sent !== JSON.stringify(rowsToSave(rows))) return problems;
  let n = -1;
  const at = rows.findIndex((r) => !blank(r) && ++n === refusal.index);
  if (at < 0) return problems;
  return problems.map((p, i) => (i === at ? (p ?? refusal.message) : p));
}
