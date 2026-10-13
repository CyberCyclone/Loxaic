/**
 * The built-in read-only commands: they run without asking, in every mode,
 * because they change nothing and reach nothing a person would want a say in.
 *
 * Membership is decided per simple command (parse.ts's Segment), and is
 * strict: a write redirect, a path for a command name, an unusual environment
 * prefix or one flag that writes (`sed -i`, `find -delete`, `sort -o`) and the
 * command is not read-only. It is a convenience, not a boundary: whatever is
 * not on the list is asked about (or checked, in auto mode), and the sandbox,
 * not this list, is what contains a command that does run.
 *
 * Deliberately absent: anything that sends a request somewhere a command
 * names (`curl`, `wget`, `git ls-remote <url>`, `dig`), pagers and editors,
 * `awk`, `xargs` and `tee` (each can write or run anything), and interpreters.
 */
import type { Redirect, Segment, Word } from "./parse.ts";

/** Environment prefixes that change only how output looks. Anything else
 * (`LD_PRELOAD=`, `NODE_OPTIONS=`, `GIT_SSH_COMMAND=`) can change what runs —
 * and so can a pager variable (`PAGER`, `GIT_PAGER`, `GH_PAGER`), which names a
 * program to run. Read-only commands get `PAGER=cat` from the engine already. */
const BENIGN_ENV = /^(LANG|LC_[A-Z]+|TZ|NO_COLOR|FORCE_COLOR|CI|TERM|COLUMNS|LINES)=/;

/** Prefixes that run the rest of the line as the command. Stripped before a
 * command is judged, here and by rule matching. */
export function unwrap(argv: readonly Word[]): Word[] {
  let words = [...argv];
  for (;;) {
    const head = words[0]?.text;
    if (head === "time" || head === "nohup" || head === "command") {
      if (head === "command" && words[1]?.text.startsWith("-")) return words;
      words = words.slice(1);
      continue;
    }
    if (head === "nice") {
      words = words.slice(1);
      if (words[0]?.text === "-n") words = words.slice(2);
      else if (/^-\d+$/.test(words[0]?.text ?? "")) words = words.slice(1);
      continue;
    }
    if (head === "timeout") {
      words = words.slice(1);
      while (words[0]?.text.startsWith("-")) {
        const flag = words[0].text;
        words = words.slice(flag === "-s" || flag === "-k" || flag === "--signal" || flag === "--kill-after" ? 2 : 1);
      }
      words = words.slice(1); // the duration
      continue;
    }
    return words;
  }
}

/** A redirect that only reads, duplicates a descriptor, or writes to /dev/null. */
export function isHarmlessRedirect(r: Redirect): boolean {
  const target = r.target?.text ?? "";
  if (/^\/dev\/(tcp|udp)\//.test(target)) return false;
  if (r.op === "<" || r.op === "<<" || r.op === "<<-" || r.op === "<<<") return true;
  if ((r.op === ">&" || r.op === "<&") && /^(\d+|-)$/.test(target)) return true;
  return (r.op === ">" || r.op === ">>" || r.op === "&>" || r.op === "&>>" || r.op === ">&") && target === "/dev/null" && !r.target?.dynamic;
}

export function hasOnlyBenignEnv(seg: Segment): boolean {
  return seg.assignments.every((a) => !a.dynamic && BENIGN_ENV.test(a.text));
}

const PLAIN = new Set([
  "ls", "cat", "head", "tail", "wc", "nl", "file", "stat", "du", "df", "pwd", "echo", "printf",
  "true", "false", "which", "type", "whoami", "id", "uname", "printenv", "basename", "dirname",
  "realpath", "readlink", "cut", "tr", "column", "diff", "cmp", "comm", "test", "[", "sleep", "seq",
  "grep", "egrep", "fgrep", "jq", "cd", "pushd", "popd", "od", "hexdump", "md5sum", "sha1sum",
  "sha256sum", "sha512sum", "nproc", "uptime", "free", "ps", "rev", "fold", "expand", "unexpand",
]);

/** Tools whose `--version` / `--help` is worth not asking about. */
const VERSIONED = new Set([
  "node", "npm", "pnpm", "yarn", "bun", "deno", "npx", "git", "gh", "python", "python3", "pip", "pip3",
  "uv", "go", "cargo", "rustc", "java", "javac", "docker", "make", "gcc", "g++", "clang", "tsc",
  "ruby", "php", "dotnet", "kubectl", "terraform",
]);

const has = (args: readonly string[], ...flags: string[]) =>
  args.some((a) => flags.some((f) => a === f || (f.startsWith("--") && a.startsWith(`${f}=`))));

const positionals = (args: readonly string[]) => args.filter((a) => !a.startsWith("-"));

/** `sed` scripts that only print: `Np`, `N,Mp`, `/re/p`, `d`, or `s///`
 * without the `e` (execute) and `w` (write) flags, one command only. */
function isPrintOnlySedScript(script: string): boolean {
  if (script.includes("\n") || script.includes(";")) return false;
  const addr = String.raw`(?:\d+|\$|/[^/]*/)`;
  if (new RegExp(`^(?:${addr}(?:,${addr})?)?[pd]$`).test(script)) return true;
  const sub = /^(?:\d+(?:,(?:\d+|\$))?)?s(.)/.exec(script);
  if (!sub) return false;
  const delim = sub[1];
  if (/[\\\n\s]/.test(delim)) return false;
  let parts = 0;
  let j = sub[0].length;
  for (; j < script.length && parts < 2; j++) {
    if (script[j] === "\\") j++;
    else if (script[j] === delim) parts++;
  }
  return parts === 2 && /^[gip0-9]*$/.test(script.slice(j));
}

function sedIsReadOnly(args: readonly string[]): boolean {
  if (args.some((a) => a === "-i" || a.startsWith("-i") || a.startsWith("--in-place") || a === "-s")) return false;
  const scripts: string[] = [];
  let sawScriptFlag = false;
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === "-e" || a === "--expression") {
      sawScriptFlag = true;
      scripts.push(args[k + 1] ?? "");
      k++;
    } else if (a === "-f" || a === "--file") {
      return false;
    } else if (!a.startsWith("-") && !sawScriptFlag && scripts.length === 0) {
      scripts.push(a);
    } else if (a.startsWith("-") && !/^-[nErsuz]+$|^--(quiet|silent|regexp-extended|posix|null-data)$/.test(a)) {
      return false;
    }
  }
  return scripts.length > 0 && scripts.every(isPrintOnlySedScript);
}

const GIT_READ = new Set([
  "status", "log", "show", "blame", "rev-parse", "rev-list", "ls-files", "ls-tree", "cat-file",
  "describe", "shortlog", "grep", "merge-base", "name-rev", "show-ref", "count-objects", "diff",
  "branch", "tag", "remote", "config", "stash", "worktree", "reflog", "whatchanged", "check-ignore",
]);

function gitIsReadOnly(args: readonly string[]): boolean {
  let k = 0;
  // Global options: only those that change where git looks, never what it runs.
  for (; k < args.length && args[k].startsWith("-"); k++) {
    const a = args[k];
    if (a === "-C") k++;
    else if (a !== "--no-pager" && a !== "-P") return false;
  }
  const sub = args[k];
  const rest = args.slice(k + 1);
  if (!sub || !GIT_READ.has(sub)) return false;
  // Never: an external diff, writing output to a file, a pager-run file opener.
  if (has(rest, "--ext-diff", "--output", "-O", "--open-files-in-pager", "--exec")) return false;
  switch (sub) {
    case "branch":
      return rest.every((a) => ["-a", "-r", "-v", "-vv", "--list", "-l", "--show-current", "--all", "--remotes", "--contains", "--merged", "--no-merged", "--sort", "--format"].some((f) => a === f || a.startsWith(`${f}=`))) && positionals(rest).length === 0;
    case "tag":
      return rest.length === 0 || has(rest, "-l", "--list");
    case "remote":
      return rest.length === 0 || (rest.length === 1 && rest[0] === "-v") || rest[0] === "get-url";
    case "config":
      return has(rest, "--get", "--get-all", "--get-regexp", "--list", "-l");
    case "stash":
      return rest[0] === "list" || rest[0] === "show";
    case "worktree":
      return rest[0] === "list";
    case "reflog":
      return rest.length === 0 || rest[0] === "show" || rest[0].startsWith("-");
    default:
      return true;
  }
}

const GH_READ: Partial<Record<string, readonly string[]>> = {
  pr: ["view", "list", "diff", "checks", "status"],
  issue: ["view", "list", "status"],
  repo: ["view"],
  run: ["view", "list"],
  release: ["view", "list"],
  auth: ["status"],
  search: ["repos", "issues", "prs", "code", "commits"],
};

/** `gh api` flags that take a value, and those that do not, which a read may
 * carry. Anything else — a field, `--input`, `--hostname`, a combined or
 * attached shorthand (`-iX`, `-XDELETE`, `-X=DELETE`) — is not judged, and so
 * not read-only: gh's flag parser takes forms this one would have to imitate
 * exactly to be safe, and the last of repeated `-X` wins. */
const GH_API_VALUED = new Set(["-X", "--method", "-H", "--header", "-q", "--jq", "-t", "--template", "-p", "--preview", "--cache"]);
const GH_API_SWITCHES = new Set(["-i", "--include", "--paginate", "--slurp", "--silent", "--verbose"]);

function ghApiIsReadOnly(rest: readonly string[]): boolean {
  let endpoint: string | undefined;
  for (let k = 0; k < rest.length; k++) {
    const a = rest[k];
    if (a.startsWith("--method=")) {
      if (a.slice(9).toUpperCase() !== "GET") return false;
    } else if (GH_API_VALUED.has(a)) {
      const value = rest.at(k + 1);
      if (value === undefined) return false;
      // Every method given must be GET: gh takes the last of several.
      if ((a === "-X" || a === "--method") && value.toUpperCase() !== "GET") return false;
      // A header can ask for another method too.
      if ((a === "-H" || a === "--header") && /method-override/i.test(value)) return false;
      k++;
    } else if (a.startsWith("--header=")) {
      if (/method-override/i.test(a)) return false;
    } else if (/^--(jq|template|cache|preview)=/.test(a)) {
      // Output shaping only.
    } else if (a.startsWith("-")) {
      if (!GH_API_SWITCHES.has(a)) return false;
    } else if (endpoint === undefined) {
      endpoint = a;
    } else {
      return false;
    }
  }
  // A full URL could name any host, and GraphQL can mutate.
  return endpoint !== undefined && endpoint !== "graphql" && !endpoint.includes("://");
}

function ghIsReadOnly(args: readonly string[]): boolean {
  const group = args.at(0);
  const verb = args.at(1);
  if (group === "api") return ghApiIsReadOnly(args.slice(1));
  return group !== undefined && verb !== undefined && (GH_READ[group]?.includes(verb) ?? false) && !has(args, "--web", "-w");
}

const PACKAGE_READ: Partial<Record<string, readonly string[]>> = {
  npm: ["ls", "list", "view", "info", "outdated", "explain", "why"],
  pnpm: ["ls", "list", "why", "outdated"],
  yarn: ["why", "info", "list"],
  go: ["list", "version", "env", "doc"],
  pip: ["list", "show", "freeze"],
  pip3: ["list", "show", "freeze"],
  cargo: ["tree", "metadata"],
};

/** Whether this one simple command is built-in read-only. */
export function isReadOnlySegment(seg: Segment): boolean {
  if (!seg.redirects.every(isHarmlessRedirect)) return false;
  if (!hasOnlyBenignEnv(seg)) return false;
  const argv = unwrap(seg.argv);
  const head = argv.at(0);
  if (!head) return false;
  if (head.dynamic || head.glob || head.quoted || head.text.includes("/")) return false;
  const name = head.text;
  const args = argv.slice(1).map((w) => w.text);

  if (VERSIONED.has(name) && args.length === 1 && ["--version", "-V", "-v", "--help", "-h", "version"].includes(args[0])) {
    return true;
  }
  if (PLAIN.has(name)) return true;
  switch (name) {
    case "env":
      return args.length === 0;
    case "date":
      return !has(args, "-s", "--set");
    case "sort":
      return !has(args, "-o", "--output", "--compress-program");
    case "uniq":
      return positionals(args).length < 2;
    case "tree":
      return !has(args, "-o");
    case "rg":
      // Each of these runs a program: a preprocessor per file, and ripgrep
      // 14's `--hostname-bin` for a hyperlink's `{host}`.
      return !args.some((a) => /^--(pre|pre-glob|hostname-bin)(=|$)/.test(a));
    case "find":
      return !args.some((a) => /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/.test(a));
    case "sed":
      return sedIsReadOnly(args);
    case "yq":
      return !has(args, "-i", "--inplace");
    case "git":
      return gitIsReadOnly(args);
    case "gh":
      return ghIsReadOnly(args);
    default: {
      const verbs = PACKAGE_READ[name];
      if (!verbs) return false;
      if (name === "go" && args[0] === "env") return !has(args, "-w", "-u");
      const verb = args.at(0);
      return verb !== undefined && verbs.includes(verb);
    }
  }
}
