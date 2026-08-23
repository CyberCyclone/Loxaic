import type { DiffLine } from './types';

/** Above this line-product, an LCS diff table gets too big to compute cheaply. */
const MAX_DIFF_CELLS = 250_000;

/**
 * Line-level diff via a classic LCS backtrace. Good enough for source files;
 * not attempting hunk-context trimming like a real unified diff — the caller
 * (ToolCallCard) scrolls a fixed-height box, so showing every line is fine.
 */
function lcsDiff(oldLines: string[], newLines: string[]): DiffLine[] {
  const n = oldLines.length;
  const m = newLines.length;
  const table: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] = oldLines[i] === newLines[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      out.push({ type: 'ctx', text: oldLines[i] });
      i++; j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      out.push({ type: 'del', text: oldLines[i] });
      i++;
    } else {
      out.push({ type: 'add', text: newLines[j] });
      j++;
    }
  }
  while (i < n) out.push({ type: 'del', text: oldLines[i++] });
  while (j < m) out.push({ type: 'add', text: newLines[j++] });
  return out;
}

/**
 * Renders a fs_write/fs_edit diff for a single file as ToolCallCard-ready
 * lines. Returns undefined when there's nothing to show.
 */
export function computeLineDiff(oldContent: string | null, newContent: string | null): DiffLine[] {
  const oldLines = oldContent === null ? [] : oldContent.split('\n');
  const newLines = newContent === null ? [] : newContent.split('\n');

  if (oldContent === null) {
    return newLines.map((text) => ({ type: 'add' as const, text }));
  }
  if (newContent === null) {
    return oldLines.map((text) => ({ type: 'del' as const, text }));
  }
  if (oldLines.length * newLines.length > MAX_DIFF_CELLS) {
    return [{ type: 'meta', text: `${oldLines.length} lines → ${newLines.length} lines (too large to diff line-by-line)` }];
  }
  return lcsDiff(oldLines, newLines);
}
