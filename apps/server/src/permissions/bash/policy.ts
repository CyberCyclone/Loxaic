/**
 * Whether a `bash` call runs, asks, is checked, or is refused — the one
 * decision the tool loop asks of a command (engine.ts's runOneToolCall).
 *
 * A command line is judged by its simple commands (parse.ts): it is only as
 * allowed as its least allowed part, so `ls && rm -rf build` asks about the
 * `rm`. Precedence per part: a person's deny, then their ask, then their
 * allow, then the built-in "always ask" commands (rules.ts), then the
 * built-in read-only set (readonly.ts). What nothing covers falls to the
 * mode:
 * - manual (and chat) asks;
 * - auto runs it where the sandbox is truly isolated (a container with no
 *   network: the worst it can do is wreck a disposable directory), and
 *   otherwise sends it to the permission check (classifier.ts);
 * - planning refuses anything that is not built-in read-only. A person's
 *   allow rules do not count there: planning is for looking, and its
 *   description says so.
 */
import { parseCommand, type Segment } from "./parse.ts";
import { isReadOnlySegment } from "./readonly.ts";
import { isBuiltinAsk, proposeRule, ruleMatches, type CommandRule } from "./rules.ts";

export type BashMode = "manual" | "auto" | "planning";

export type RanBy = "readonly" | "rule" | "isolated";

export type BashDecision =
  | { kind: "deny"; rule: string; reason: string }
  | { kind: "refuse"; reason: string }
  | { kind: "run"; by: RanBy; rule?: string }
  | { kind: "ask"; rules: string[]; reason: string }
  | { kind: "classify"; rules: string[] };

type Part =
  | { state: "deny"; rule: string }
  | { state: "ask-rule"; rule: string }
  | { state: "allowed"; rule: string }
  | { state: "builtin-ask" }
  | { state: "readonly" }
  | { state: "open" };

function judge(seg: Segment, rules: readonly CommandRule[]): Part {
  const first = (action: CommandRule["action"], strict: boolean) =>
    rules.find((r) => r.action === action && ruleMatches(r.pattern, seg, strict));
  const deny = first("deny", false);
  if (deny) return { state: "deny", rule: deny.pattern };
  const ask = first("ask", false);
  if (ask) return { state: "ask-rule", rule: ask.pattern };
  const allow = first("allow", true);
  if (allow) return { state: "allowed", rule: allow.pattern };
  if (isBuiltinAsk(seg)) return { state: "builtin-ask" };
  if (isReadOnlySegment(seg)) return { state: "readonly" };
  return { state: "open" };
}

/** The rules "Allow always" would record: one per part that needs approval,
 * or none at all when any such part has no rule that says exactly it. */
function proposals(segments: readonly Segment[], parts: readonly Part[]): string[] {
  const out: string[] = [];
  for (let n = 0; n < segments.length; n++) {
    if (parts[n].state !== "open" && parts[n].state !== "builtin-ask") continue;
    const rule = proposeRule(segments[n]);
    if (rule === null) return [];
    if (!out.includes(rule)) out.push(rule);
  }
  return out;
}

export function decideBash(input: {
  command: string;
  mode: BashMode;
  rules: readonly CommandRule[];
  /** A container sandbox with no network (see isolationFor). */
  isolated: boolean;
}): BashDecision {
  const { mode, rules, isolated } = input;
  const parsed = parseCommand(input.command);
  if (!parsed.ok) {
    const reason = `Loxaic can't check this command by its parts (${parsed.reason}).`;
    if (mode === "planning") return { kind: "refuse", reason: `${reason} Planning mode runs only read-only commands.` };
    if (mode === "auto") return isolated ? { kind: "run", by: "isolated" } : { kind: "classify", rules: [] };
    return { kind: "ask", rules: [], reason };
  }
  const segments = parsed.segments;
  if (segments.length === 0) return { kind: "run", by: "readonly" };
  const parts = segments.map((seg) => judge(seg, rules));

  const denied = parts.find((p): p is Extract<Part, { state: "deny" }> => p.state === "deny");
  if (denied) {
    return { kind: "deny", rule: denied.rule, reason: `Not run: your rule \`${denied.rule}\` denies this command.` };
  }
  // Planning runs read-only commands and nothing else, before any ask rule is
  // looked at: an ask rule only ever adds a question, so it must not turn a
  // refusal into a prompt someone can approve. Judged on the command itself,
  // since a part's state records only the rule that matched it first.
  if (mode === "planning" && !segments.every(isReadOnlySegment)) {
    return {
      kind: "refuse",
      reason: "Not run: planning mode runs only read-only commands (listing, reading, searching, git and gh reads).",
    };
  }
  const askRule = parts.find((p): p is Extract<Part, { state: "ask-rule" }> => p.state === "ask-rule");
  if (askRule) return { kind: "ask", rules: [], reason: `Your rule \`${askRule.rule}\` asks about this command.` };
  if (mode === "planning") return { kind: "run", by: "readonly" };

  if (parts.some((p) => p.state === "builtin-ask")) {
    return { kind: "ask", rules: proposals(segments, parts), reason: "Pushing, GitHub writes and sudo always ask." };
  }
  if (parts.every((p) => p.state === "readonly")) return { kind: "run", by: "readonly" };
  const open = parts.some((p) => p.state === "open");
  if (!open) {
    const rule = parts.find((p): p is Extract<Part, { state: "allowed" }> => p.state === "allowed")?.rule;
    return { kind: "run", by: "rule", ...(rule ? { rule } : {}) };
  }
  const proposed = proposals(segments, parts);
  if (mode === "auto") return isolated ? { kind: "run", by: "isolated" } : { kind: "classify", rules: proposed };
  return { kind: "ask", rules: proposed, reason: "" };
}
