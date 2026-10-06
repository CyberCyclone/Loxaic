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
