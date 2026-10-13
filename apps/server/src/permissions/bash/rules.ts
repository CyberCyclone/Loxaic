/**
 * Command rules: what a person has allowed, asked to be asked about, or
 * denied, by command prefix (`gh pr view *`), matched against one simple
 * command at a time (parse.ts's Segment). Also what "Allow always" proposes
 * from a command that was approved, and the few commands that ask by default
 * whatever the mode.
 *
 * A pattern is space-separated tokens with an optional trailing `*` meaning
 * "and any arguments, or none". Tokens match whole words: `gh pr view *` does
 * not match `gh pr viewer`. Patterns carry no quoting and no shell syntax, so
 * what a rule allows is exactly what it reads as.
 */
import type { Redirect, Segment, Word } from "./parse.ts";
import { hasOnlyBenignEnv, isHarmlessRedirect, isReadOnlySegment, unwrap } from "./readonly.ts";

export type RuleAction = "allow" | "ask" | "deny";

export interface CommandRule {
  pattern: string;
  action: RuleAction;
}

export const MAX_PATTERN_CHARS = 200;

/** Commands a wildcard rule may not cover: each runs whatever it is given, so
 * `python *` would allow every program there is. An exact rule is fine. */
const NO_WILDCARD = new Set([
  "bash", "sh", "zsh", "dash", "fish", "ksh", "python", "python2", "python3", "node", "nodejs", "perl",
  "ruby", "php", "deno", "lua", "Rscript", "eval", "exec", "source", ".", "sudo", "su", "doas", "env",
  "xargs", "find", "awk", "gawk", "ssh", "scp", "nohup", "time", "timeout", "nice", "command", "builtin",
]);

/** Proposed as the exact command, never a wildcard: one approval of
 * `rm -rf build` is not a reason to allow every `rm`. */
const EXACT_ONLY = new Set([
  ...NO_WILDCARD,
  "rm", "rmdir", "mv", "cp", "chmod", "chown", "chgrp", "dd", "mkfs", "kill", "killall", "pkill",
  "shutdown", "reboot", "ln", "truncate", "shred", "curl", "wget",
]);

/** How many words name the operation, beyond the command itself. */
const LEVELS: Record<string, number> = {
  gh: 3,
  git: 2, cargo: 2, go: 2, kubectl: 2, helm: 2, pip: 2, pip3: 2, uv: 2, poetry: 2, make: 2,
  brew: 2, apt: 2, "apt-get": 2, npm: 2, pnpm: 2, yarn: 2, bun: 2, docker: 2, dotnet: 2,
  mvn: 2, gradle: 2, terraform: 2,
};

// eslint-disable-next-line no-control-regex -- refusing control characters is the point
const SHELL_META = /[;&|<>`$(){}\\'"\u0000-\u001f\u007f]/;

/** Why a pattern is not acceptable, or null when it is. */
export function validatePattern(pattern: string): string | null {
  const p = pattern.trim();
  if (p.length === 0) return "A rule needs a command.";
  if (p.length > MAX_PATTERN_CHARS) return `A rule can be at most ${String(MAX_PATTERN_CHARS)} characters.`;
  if (SHELL_META.test(p)) return "A rule is plain words: no quotes, redirects, pipes or other shell syntax.";
  const tokens = p.split(/\s+/);
  const wildcard = tokens[tokens.length - 1] === "*";
  if (wildcard && tokens.length === 1) return "A rule can't be just `*`.";
  if (tokens.slice(0, wildcard ? -1 : undefined).some((t) => t.includes("*"))) {
    return "`*` may only be the last word of a rule.";
  }
  if (wildcard && (NO_WILDCARD.has(tokens[0]) || tokens[0].includes("/"))) {
    return `\`${tokens[0]} *\` would allow any program; allow an exact command instead.`;
  }
  return null;
}

export function normalizePattern(pattern: string): string {
  return pattern.trim().split(/\s+/).join(" ");
}

/** A write redirect a rule can carry: a file under the working directory,
 * and never inside `.git`, where a hook or a config entry would run later
 * under a command nobody is asked about. The same line `isSensitiveWrite`
 * draws for `fs_write` and `fs_edit`. */
function isWorkspaceRedirect(r: Redirect): boolean {
  if (isHarmlessRedirect(r)) return true;
  const t = r.target;
  if (!t || t.dynamic || t.glob) return false;
  if (r.op === "<>" || r.op.startsWith("<")) return false;
  const parts = t.text.split("/");
  return !t.text.startsWith("/") && !parts.includes("..") && !parts.includes(".git") && t.text.length > 0;
}

const basename = (text: string) => text.slice(text.lastIndexOf("/") + 1);

/**
 * Whether `pattern` covers this command.
 *
 * `strict` is for allow rules: the command must be exactly what the rule
 * reads as, so no unusual environment prefix and no redirect outside the
 * working directory. Ask and deny rules are matched loosely instead, by the
 * command's basename and ignoring both, since erring there only asks more.
 */
export function ruleMatches(pattern: string, seg: Segment, strict: boolean): boolean {
  const tokens = normalizePattern(pattern).split(" ");
  const wildcard = tokens[tokens.length - 1] === "*";
  const fixed = wildcard ? tokens.slice(0, -1) : tokens;
  const argv: Word[] = unwrap(seg.argv);
  if (argv.length === 0) return false;
  if (strict && (!hasOnlyBenignEnv(seg) || !seg.redirects.every(isWorkspaceRedirect))) return false;
  if (argv.length < fixed.length || (!wildcard && argv.length !== fixed.length)) return false;
  return fixed.every((t, n) => {
    const w = argv[n];
    if (w.dynamic || w.glob) return false;
    return n === 0 && !strict ? basename(w.text) === basename(t) : w.text === t;
  });
}

/**
 * The rule "Allow always" would record for this command, or null when no rule
 * could say exactly this: a computed or path-named command, an unusual
 * environment prefix, a redirect outside the working directory.
 */
export function proposeRule(seg: Segment): string | null {
  if (!hasOnlyBenignEnv(seg) || !seg.redirects.every(isWorkspaceRedirect)) return null;
  const argv = unwrap(seg.argv);
  const head = argv.at(0);
  if (!head || head.dynamic || head.glob || head.quoted || head.text.includes("/")) return null;
  const literal = (w: Word) => !w.dynamic && !w.glob && !/\s/.test(w.text) && !SHELL_META.test(w.text) && !w.text.includes("*");

  if (EXACT_ONLY.has(head.text)) {
    if (!argv.every(literal)) return null;
    const exact = argv.map((w) => w.text).join(" ");
    return validatePattern(exact) === null ? exact : null;
  }

  let levels = LEVELS[head.text] ?? 1;
  const second = argv[1]?.text;
  if (["npm", "pnpm", "yarn", "bun"].includes(head.text) && (second === "run" || second === "run-script")) levels = 3;
  if (head.text === "docker" && second === "compose") levels = 3;

  const parts = [head.text];
  for (let n = 1; n < argv.length && parts.length < levels; n++) {
    const w = argv[n];
    if (head.text === "git" && w.text === "-C") {
      n++;
      continue;
    }
    if (w.text.startsWith("-")) break;
    if (!literal(w)) break;
    parts.push(w.text);
  }
  const pattern = `${parts.join(" ")} *`;
  return validatePattern(pattern) === null ? pattern : null;
}

/**
 * Commands that ask in every mode, auto included, unless an allow rule
 * covers them: they reach past the workspace in ways nothing else contains.
 * Pushing, GitHub writes, and running as someone else.
 */
export function isBuiltinAsk(seg: Segment): boolean {
  const argv = unwrap(seg.argv);
  const head = argv[0] ? basename(argv[0].text) : "";
  if (head === "sudo" || head === "su" || head === "doas") return true;
  if (head === "git") {
    const sub = argv.slice(1).find((w, n, all) => !w.text.startsWith("-") && all[n - 1]?.text !== "-C" && all[n - 1]?.text !== "-c");
    return sub?.text === "push";
  }
  if (head === "gh") return !isReadOnlySegment(seg);
  return false;
}
