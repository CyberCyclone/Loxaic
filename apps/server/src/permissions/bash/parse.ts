/**
 * A conservative parser for the commands the model hands the `bash` tool,
 * enough to decide permissions per command (bash-policy.ts), never to run
 * anything.
 *
 * Conservative means: whatever it does not understand for certain, it calls
 * unparseable, and an unparseable command is asked about. It splits a command
 * line into the simple commands that will run — across `&&`, `||`, `;`, `|`,
 * `&`, newlines, `( … )` subshells, and `$( … )` / backtick substitutions,
 * whose inner commands run too and are returned beside the outer one — and
 * records each one's assignments, words and redirects. Loops, conditionals,
 * functions, `eval`, arithmetic and process substitution are refused rather
 * than understood.
 *
 * The input is the model's, so it is hostile: one pass over the text with a
 * single cursor (a substitution is parsed in place, never re-scanned), no
 * backtracking regex, a size cap and a nesting cap.
 */

/** Longer commands are not parsed; they are asked about. */
export const MAX_COMMAND_CHARS = 16_384;
/** Substitutions and subshells nested deeper than this are asked about. */
export const MAX_NESTING = 8;

export interface Word {
  /** The word's value with quotes removed. Expansions keep their source text. */
  text: string;
  /** Contains `$VAR`, `${…}`, `$( … )` or backticks: its value is not known. */
  dynamic: boolean;
  /** Contains an unquoted glob or brace (`*`, `?`, `[`, `{`). */
  glob: boolean;
  /** Any part of it was quoted. */
  quoted: boolean;
}

export interface Redirect {
  /** `>`, `>>`, `>|`, `&>`, `&>>`, `<`, `<>`, `<<`, `<<-`, `<<<`, `>&`, `<&`. */
  op: string;
  /** The file descriptor written before the operator, if any. */
  fd: string | null;
  /** The word after the operator: a file, a heredoc delimiter, an fd. */
  target: Word | null;
}

export interface Segment {
  /** `NAME=value` words before the command. */
  assignments: Word[];
  /** The command and its arguments. Empty for a bare redirect or assignment. */
  argv: Word[];
  redirects: Redirect[];
  /** The command's own source text, for display. */
  text: string;
}

export type ParseResult = { ok: true; segments: Segment[] } | { ok: false; reason: string };

class Unparseable extends Error {}

const RESERVED = new Set([
  "if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done",
  "case", "esac", "select", "function", "{", "}", "[[", "]]", "coproc", "eval",
]);

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

interface PendingHeredoc {
  delimiter: string;
  quoted: boolean;
  stripTabs: boolean;
}

class Parser {
  private i = 0;
  private readonly heredocs: PendingHeredoc[] = [];
  readonly segments: Segment[] = [];

  constructor(private readonly src: string) {}

  private peek(offset = 0): string {
    return this.src[this.i + offset] ?? "";
  }

  private fail(reason: string): never {
    throw new Unparseable(reason);
  }

  /** A list of commands, up to `term` (consumed) or the end of input. */
  parseList(term: ")" | "`" | null, depth: number): void {
    if (depth > MAX_NESTING) this.fail("nested too deeply");
    for (;;) {
      this.skipBlanks();
      const c = this.peek();
      if (c === "") {
        if (term !== null) this.fail(term === ")" ? "unterminated ( or $(" : "unterminated backtick");
        if (this.heredocs.length > 0) this.fail("unterminated heredoc");
        return;
      }
      if (term !== null && c === term) {
        this.i++;
        return;
      }
      if (c === ")" || c === "`") this.fail(`unexpected ${c}`);
      if (c === "\n") {
        this.i++;
        this.readHeredocBodies();
        continue;
      }
      if (c === ";") {
        if (this.peek(1) === ";") this.fail("case syntax");
        this.i++;
        continue;
      }
      if (c === "&" && this.peek(1) !== ">") {
        this.i += this.peek(1) === "&" ? 2 : 1;
        continue;
      }
      if (c === "|") {
        this.i += this.peek(1) === "|" || this.peek(1) === "&" ? 2 : 1;
        continue;
      }
      if (c === "#") {
        while (this.peek() !== "" && this.peek() !== "\n") this.i++;
        continue;
      }
      if (c === "(") {
        if (this.peek(1) === "(") this.fail("arithmetic");
        this.i++;
        const before = this.segments.length;
        this.parseList(")", depth + 1);
        // Redirects after a subshell apply to every command inside it.
        const redirects = this.readTrailingRedirects(depth);
        for (const seg of this.segments.slice(before)) seg.redirects.push(...redirects);
        continue;
      }
      this.parseSimpleCommand(term, depth);
    }
  }

  private skipBlanks(): void {
    for (;;) {
      const c = this.peek();
      if (c === " " || c === "\t") this.i++;
      else if (c === "\\" && this.peek(1) === "\n") this.i += 2;
      else return;
    }
  }

  private isOperatorStart(c: string, term: ")" | "`" | null): boolean {
    return c === "" || c === "\n" || c === ";" || c === "&" || c === "|" || c === ")" || c === "(" || (term === "`" && c === "`");
  }

  private parseSimpleCommand(term: ")" | "`" | null, depth: number): void {
    const start = this.i;
    const seg: Segment = { assignments: [], argv: [], redirects: [], text: "" };
    for (;;) {
      this.skipBlanks();
      const c = this.peek();
      if (c === "&" && this.peek(1) === ">") {
        seg.redirects.push(this.readRedirect(null, depth));
        continue;
      }
      if (this.isOperatorStart(c, term)) {
        if (c === "(") this.fail("( inside a command");
        break;
      }
      if (c === "#" ) {
        // A comment only at the start of a word, which this is.
        while (this.peek() !== "" && this.peek() !== "\n") this.i++;
        break;
      }
      const fd = this.redirectFd();
      if (fd !== undefined) {
        seg.redirects.push(this.readRedirect(fd, depth));
        continue;
      }
      const wordStart = this.i;
      const word = this.readWord(term, depth);
      if (seg.argv.length === 0) {
        const raw = this.src.slice(wordStart, this.i);
        if (!word.quoted && !word.dynamic && RESERVED.has(word.text)) this.fail(`\`${word.text}\``);
        if (!word.quoted && word.text === "!" ) continue;
        if (ASSIGNMENT.test(raw)) {
          // `NAME=(…)` arrays and the like are not worth understanding.
          seg.assignments.push(word);
          continue;
        }
      }
      seg.argv.push(word);
    }
    seg.text = this.src.slice(start, this.i).trim();
    if (seg.argv.length > 0 || seg.assignments.length > 0 || seg.redirects.length > 0) this.segments.push(seg);
  }

  /**
   * An fd number written directly before a redirect operator (`2>`), `null`
   * for an operator with none, or undefined when no redirect starts here.
   */
  private redirectFd(): string | null | undefined {
    let j = this.i;
    while (/[0-9]/.test(this.src[j] ?? "")) j++;
    const op = this.src[j] ?? "";
    if (op !== ">" && op !== "<") return undefined;
    return j === this.i ? null : this.src.slice(this.i, j);
  }

  private readRedirect(fd: string | null, depth: number): Redirect {
    if (fd !== null) this.i += fd.length;
    const rest = this.src.slice(this.i, this.i + 3);
    let op: string;
    if (rest.startsWith("&>>")) op = "&>>";
    else if (rest.startsWith("&>")) op = "&>";
    else if (rest.startsWith("<<<")) op = "<<<";
    else if (rest.startsWith("<<-")) op = "<<-";
    else if (rest.startsWith("<<")) op = "<<";
    else if (rest.startsWith("<(") || rest.startsWith(">(")) this.fail("process substitution");
    else if (rest.startsWith(">>")) op = ">>";
    else if (rest.startsWith(">|")) op = ">|";
    else if (rest.startsWith(">&")) op = ">&";
    else if (rest.startsWith("<&")) op = "<&";
    else if (rest.startsWith("<>")) op = "<>";
    else op = rest.charAt(0);
    this.i += op.length;
    this.skipBlanks();
    if (this.isOperatorStart(this.peek(), null)) this.fail(`${op} without a target`);
    const target = this.readWord(null, depth);
    if (op === "<<" || op === "<<-") {
      if (target.dynamic) this.fail("heredoc delimiter with an expansion");
      this.heredocs.push({ delimiter: target.text, quoted: target.quoted, stripTabs: op === "<<-" });
    }
    return { op, fd, target };
  }

  private readTrailingRedirects(depth: number): Redirect[] {
    const out: Redirect[] = [];
    for (;;) {
      this.skipBlanks();
      if (this.peek() === "&" && this.peek(1) === ">") {
        out.push(this.readRedirect(null, depth));
        continue;
      }
      const fd = this.redirectFd();
      if (fd === undefined) return out;
      out.push(this.readRedirect(fd, depth));
    }
  }

  /** Heredoc bodies start after the newline that ends their command. */
  private readHeredocBodies(): void {
    for (let doc = this.heredocs.shift(); doc; doc = this.heredocs.shift()) {
      for (;;) {
        if (this.i >= this.src.length) this.fail("unterminated heredoc");
        let end = this.src.indexOf("\n", this.i);
        if (end === -1) end = this.src.length;
        let line = this.src.slice(this.i, end);
        this.i = Math.min(end + 1, this.src.length);
        if (doc.stripTabs) line = line.replace(/^\t+/, "");
        if (line === doc.delimiter) break;
        // An unquoted heredoc expands its body, so a substitution in it runs.
        if (!doc.quoted && (line.includes("$(") || line.includes("`"))) this.fail("substitution in a heredoc");
      }
    }
  }

  private readWord(term: ")" | "`" | null, depth: number): Word {
    const word: Word = { text: "", dynamic: false, glob: false, quoted: false };
    let first = true;
    for (;;) {
      const c = this.peek();
      if (c === "" || c === " " || c === "\t" || c === "<" || c === ">") break;
      if (this.isOperatorStart(c, term)) break;
      if (c === "\\") {
        const next = this.peek(1);
        if (next === "") this.fail("trailing backslash");
        if (next === "`" && term === "`") this.fail("nested backticks");
        this.i += 2;
        if (next !== "\n") word.text += next;
        word.quoted = true;
      } else if (c === "'") {
        const end = this.src.indexOf("'", this.i + 1);
        if (end === -1) this.fail("unterminated single quote");
        word.text += this.src.slice(this.i + 1, end);
        word.quoted = true;
        this.i = end + 1;
      } else if (c === '"') {
        this.readDoubleQuoted(word, depth);
      } else if (c === "$") {
        this.readExpansion(word, depth);
      } else if (c === "`") {
        this.i++;
        this.parseList("`", depth + 1);
        word.text += "`…`";
        word.dynamic = true;
      } else {
        if (c === "*" || c === "?" || c === "[" || c === "{") word.glob = true;
        if (c === "~" && first) word.glob = true;
        word.text += c;
        this.i++;
      }
      first = false;
    }
    return word;
  }

  private readDoubleQuoted(word: Word, depth: number): void {
    word.quoted = true;
    this.i++;
    for (;;) {
      const c = this.peek();
      if (c === "") this.fail("unterminated double quote");
      if (c === '"') {
        this.i++;
        return;
      }
      if (c === "\\") {
        const next = this.peek(1);
        if (next === "") this.fail("unterminated double quote");
        if (next === "$" || next === "`" || next === '"' || next === "\\") word.text += next;
        else if (next !== "\n") word.text += c + next;
        this.i += 2;
      } else if (c === "$") {
        this.readExpansion(word, depth);
      } else if (c === "`") {
        this.i++;
        this.parseList("`", depth + 1);
        word.text += "`…`";
        word.dynamic = true;
      } else {
        word.text += c;
        this.i++;
      }
    }
  }

  private readExpansion(word: Word, depth: number): void {
    const next = this.peek(1);
    if (next === "(") {
      if (this.peek(2) === "(") this.fail("arithmetic");
      this.i += 2;
      this.parseList(")", depth + 1);
      word.text += "$(…)";
      word.dynamic = true;
      return;
    }
    if (next === "{") {
      const end = this.src.indexOf("}", this.i + 2);
      if (end === -1) this.fail("unterminated ${");
      const body = this.src.slice(this.i + 2, end);
      // `${X:=v}` assigns and `${X:?…}` can exit; anything with an operator
      // or a nested expansion is beyond what this needs to understand.
      if (!/^[A-Za-z_][A-Za-z0-9_]*$|^[0-9@*#?$!-]$/.test(body)) this.fail("parameter expansion with an operator");
      word.text += this.src.slice(this.i, end + 1);
      word.dynamic = true;
      this.i = end + 1;
      return;
    }
    if (/[A-Za-z_]/.test(next)) {
      let j = this.i + 1;
      while (/[A-Za-z0-9_]/.test(this.src[j] ?? "")) j++;
      word.text += this.src.slice(this.i, j);
      word.dynamic = true;
      this.i = j;
      return;
    }
    if (/[0-9@*#?$!-]/.test(next) && next !== "") {
      word.text += this.src.slice(this.i, this.i + 2);
      word.dynamic = true;
      this.i += 2;
      return;
    }
    if (next === "'" || next === '"') this.fail("$'…' or $\"…\" quoting");
    word.text += "$";
    this.i++;
  }
}

/** Splits `command` into the simple commands it runs, or says why it can't. */
export function parseCommand(command: string): ParseResult {
  if (command.length > MAX_COMMAND_CHARS) return { ok: false, reason: "too long to check" };
  const parser = new Parser(command);
  try {
    parser.parseList(null, 0);
  } catch (err) {
    if (err instanceof Unparseable) return { ok: false, reason: err.message };
    throw err;
  }
  for (const seg of parser.segments) {
    const head = seg.argv.at(0);
    if (head && (head.dynamic || head.glob)) return { ok: false, reason: "a command name that is computed" };
  }
  return { ok: true, segments: parser.segments };
}
