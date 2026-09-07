import type { TerminalStatus } from '@/hooks/useSandboxTerminal';

/**
 * Escape sequences and control bytes, removed for the one renderer with no
 * emulator behind it: the native panel is a text view, so a container's
 * coloured prompt would otherwise read as `[0;32m` noise.
 *
 * Written as explicit `\u` escapes rather than literal control characters —
 * a literal ESC in a source file is invisible in every diff and review that
 * will ever look at it.
 */
const ESC = '\\u001b';
const ANSI_RE = new RegExp(
  [
    // OSC: ESC ] … terminated by BEL or ST. Window titles, mostly.
    `${ESC}\\][^\\u0007${ESC}]*(?:\\u0007|${ESC}\\\\)`,
    // CSI: ESC [ … final byte. Colour, cursor movement, erase.
    `${ESC}\\[[0-9;?]*[ -/]*[@-~]`,
    // Any other two-character escape.
    `${ESC}[@-Z\\\\-_]`,
  ].join('|'),
  'g',
);
/** Everything unprintable except tab and the newlines, which carry meaning. */
// eslint-disable-next-line no-control-regex -- matching them is the point.
const CONTROL_RE = new RegExp('[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]', 'g');

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '').replace(CONTROL_RE, '').replace(/\r\n?/g, '\n');
}

/**
 * What the panel says about itself, in one place so the two renderers cannot
 * drift apart on the thing that most needs explaining: a pipe-mode session
 * looks broken — no prompt, nothing echoed — unless it says why.
 */
export function terminalStatusLine(
  status: TerminalStatus,
  tty: boolean | null,
  workdir: string | null,
  error: string | null,
  hasSandbox: boolean,
): string {
  if (error) return error;
  switch (status) {
    case 'idle':
      return hasSandbox
        ? 'Terminal closed.'
        : 'No workspace yet — send a message and one is created the first time a tool runs.';
    case 'connecting':
      return 'Connecting…';
    case 'closed':
      return 'Session ended.';
    case 'error':
      return 'Could not open a terminal here.';
    case 'open':
      return tty === false
        ? `${workdir ?? ''} · no TTY here, so there is no prompt and nothing echoes back — commands still run, one line at a time.`
        : (workdir ?? '');
  }
}
