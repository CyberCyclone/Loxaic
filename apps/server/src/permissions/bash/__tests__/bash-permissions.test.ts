import { describe, expect, it } from "vitest";
import { parseCommand, MAX_COMMAND_CHARS, type Segment } from "../parse.ts";
import { isReadOnlySegment } from "../readonly.ts";
import { isBuiltinAsk, proposeRule, ruleMatches, validatePattern, type CommandRule } from "../rules.ts";
import { decideBash, type BashMode } from "../policy.ts";

const segs = (cmd: string): Segment[] => {
  const r = parseCommand(cmd);
  if (!r.ok) throw new Error(`unparseable: ${r.reason}`);
  return r.segments;
};
const argvs = (cmd: string) => segs(cmd).map((s) => s.argv.map((w) => w.text));
const one = (cmd: string): Segment => {
  const s = segs(cmd);
  if (s.length !== 1) throw new Error(`expected one command in ${cmd}, got ${String(s.length)}`);
  return s[0];
};

describe("parseCommand", () => {
  it("splits on every list operator and keeps quoting", () => {
    expect(argvs(`a 1 && b "two words" || c 'x y'; d | e |& f & g\nh`)).toEqual([
      ["a", "1"], ["b", "two words"], ["c", "x y"], ["d"], ["e"], ["f"], ["g"], ["h"],
    ]);
  });

  it("returns the commands inside subshells and substitutions too", () => {
    expect(argvs("(cd x && make) ; echo $(git rev-parse HEAD) `whoami`")).toEqual([
      ["cd", "x"], ["make"], ["git", "rev-parse", "HEAD"], ["whoami"], ["echo", "$(…)", "`…`"],
    ]);
    expect(argvs('echo "now: $(date) and `id`"')).toEqual([["date"], ["id"], ["echo", "now: $(…) and `…`"]]);
  });

  it("records assignments and redirects, and applies a subshell's redirects to what is inside", () => {
    const [s] = segs("LANG=C FOO=1 grep -r x . 2>/dev/null > out.txt");
    expect(s.assignments.map((w) => w.text)).toEqual(["LANG=C", "FOO=1"]);
    expect(s.argv.map((w) => w.text)).toEqual(["grep", "-r", "x", "."]);
    expect(s.redirects.map((r) => [r.fd, r.op, r.target?.text])).toEqual([["2", ">", "/dev/null"], [null, ">", "out.txt"]]);
    const inner = segs("(ls; pwd) > listing");
    expect(inner.every((x) => x.redirects.some((r) => r.target?.text === "listing"))).toBe(true);
  });

  it("reads heredoc bodies, refusing a substitution in an unquoted one", () => {
    expect(argvs("cat <<'EOF' > notes.md\n$(rm -rf /)\nEOF\nls")).toEqual([["cat"], ["ls"]]);
    expect(argvs("cat <<-EOF\n\tplain\n\tEOF")).toEqual([["cat"]]);
    expect(parseCommand("cat <<EOF\n$(rm -rf /)\nEOF").ok).toBe(false);
    expect(parseCommand("cat <<EOF\nno end").ok).toBe(false);
  });

  it("marks expansions and globs", () => {
    const [w1, w2, w3] = one("ls $HOME *.ts ${X}").argv.slice(1);
    expect([w1.dynamic, w2.glob, w3.dynamic]).toEqual([true, true, true]);
  });

  it.each([
    ["unterminated quote", `echo "x`],
    ["unterminated single quote", "echo 'x"],
    ["unterminated substitution", "echo $(ls"],
    ["control flow", "for f in *; do rm $f; done"],
    ["if", "if true; then ls; fi"],
    ["eval", "eval rm -rf /"],
    ["process substitution", "diff <(ls) <(ls -a)"],
    ["arithmetic", "echo $((1+2))"],
    ["computed command name", "$CMD -rf /"],
    ["globbed command name", "/bin/r* x"],
    ["parameter operators", "echo ${X:=y}"],
    ["function definition", "f() { ls; }"],
    ["brace group", "{ ls; }"],
    ["ansi-c quoting", "echo $'\\x41'"],
    ["nesting", "echo " + "$(".repeat(12) + ")".repeat(12)],
    ["too long", "x".repeat(MAX_COMMAND_CHARS + 1)],
  ])("refuses %s", (_name, cmd) => {
    expect(parseCommand(cmd).ok).toBe(false);
  });

  it("stays fast on hostile input", () => {
    for (const cmd of ["$(".repeat(8000), "'".repeat(16_000), "\\".repeat(16_000), "a ".repeat(8000), '"$('.repeat(5000)]) {
      const start = performance.now();
      parseCommand(cmd.slice(0, MAX_COMMAND_CHARS));
      expect(performance.now() - start).toBeLessThan(200);
    }
  });
});

describe("the read-only set", () => {
  it.each([
    "ls -la", "cat README.md", "grep -rn TODO src 2>/dev/null", "rg foo --type ts", "find . -name '*.ts'",
    "sed -n 1,20p file", "sed 's/a/b/g' file", "head -n 5 x", "wc -l x", "jq .name package.json",
    "git status", "git log --oneline -5", "git -C sub diff HEAD~1", "git branch -a", "git branch --show-current",
    "git remote -v", "git config --get user.name", "git stash list", "LANG=C sort x",
    "gh pr view 3", "gh issue list --state open", "gh api repos/o/r/pulls", "gh api -X GET repos/o/r",
    "gh search issues bug", "npm ls", "pnpm why react", "node --version", "echo hello", "sleep 2", "cd src",
  ])("%s is read-only", (cmd) => {
    expect(isReadOnlySegment(one(cmd))).toBe(true);
  });

  it.each([
    "echo hi > out.txt", "cat x >> y", "sed -i 's/a/b/' f", "sed 's/a/b/w out' f", "sed 's/a/b/e' f",
    "sed -f script f", "find . -delete", "find . -exec rm {} \\;", "sort -o out x", "tree -o out",
    "rg --pre ./x foo", "git branch -D main", "git branch new", "git push", "git -c core.pager=sh log",
    "git diff --output=x", "git grep -O foo", "git tag v1", "git config user.name x", "git stash",
    "gh pr create", "gh api repos/o/r/issues -f title=x", "gh api -X POST repos/o/r", "gh api graphql",
    "gh api https://evil.example/", "gh pr view --web", "npm install", "awk '{print}' f", "xargs ls",
    "tee out", "curl https://x", "LD_PRELOAD=x ls", "X=1", "./script.sh", "/bin/ls", "rm x",
    "cat < /dev/tcp/1.2.3.4/80", "date -s now", "uniq a b", "env FOO=1 ls", "touch x",
  ])("%s is not read-only", (cmd) => {
    expect(isReadOnlySegment(one(cmd))).toBe(false);
  });
});

describe("rules", () => {
  it("validates patterns", () => {
    expect(validatePattern("gh pr view *")).toBeNull();
    expect(validatePattern("npm test")).toBeNull();
    expect(validatePattern("python3 scripts/build.py")).toBeNull();
    for (const bad of ["", "*", "python *", "bash *", "/usr/bin/x *", "a * b", "npm test; rm -rf /", "a$(b)", "x".repeat(201)]) {
      expect(validatePattern(bad), bad).not.toBeNull();
    }
  });

  it("matches whole words, with * meaning any arguments or none", () => {
    expect(ruleMatches("gh pr view *", one("gh pr view 3 --comments"), true)).toBe(true);
    expect(ruleMatches("gh pr view *", one("gh pr view"), true)).toBe(true);
    expect(ruleMatches("gh pr view *", one("gh pr viewer"), true)).toBe(false);
    expect(ruleMatches("npm test", one("npm test"), true)).toBe(true);
    expect(ruleMatches("npm test", one("npm test --watch"), true)).toBe(false);
  });

  it("lets an allow rule cover only exactly what it reads as", () => {
    expect(ruleMatches("npm run build *", one("npm run build > build.log"), true)).toBe(true);
    expect(ruleMatches("npm run build *", one("npm run build > /etc/passwd"), true)).toBe(false);
    expect(ruleMatches("npm run build *", one("NODE_OPTIONS=--require=x npm run build"), true)).toBe(false);
    expect(ruleMatches("npm test", one("/usr/bin/npm test"), true)).toBe(false);
    expect(ruleMatches("npm test", one("npm $X"), true)).toBe(false);
  });

  it("matches deny and ask rules loosely", () => {
    expect(ruleMatches("rm *", one("/bin/rm -rf x > y"), false)).toBe(true);
    expect(ruleMatches("rm *", one("FOO=1 nice -n 5 rm x"), false)).toBe(true);
  });

  it.each([
    ["gh pr create --title x", "gh pr create *"],
    ["git commit -m 'fix it'", "git commit *"],
    ["git -C sub push origin main", "git push *"],
    ["npm run test -- --watch", "npm run test *"],
    ["npm install left-pad", "npm install *"],
    ["docker compose up -d", "docker compose up *"],
    ["pytest tests/a.py", "pytest *"],
    ["make", "make *"],
    ["rm -rf build", "rm -rf build"],
    ["python3 scripts/gen.py --out x", "python3 scripts/gen.py --out x"],
    ["npm run build > build.log", "npm run build *"],
  ])("proposes %s → %s", (cmd, rule) => {
    expect(proposeRule(one(cmd))).toBe(rule);
  });

  it.each(["./run.sh", "python3 -c 'import os'", "LD_PRELOAD=x make", "make > /tmp/x", "rm $FILE"])(
    "proposes nothing for %s",
    (cmd) => {
      expect(proposeRule(one(cmd))).toBeNull();
    },
  );

  it("asks by default for pushes, GitHub writes and sudo", () => {
    expect(isBuiltinAsk(one("git push origin x"))).toBe(true);
    expect(isBuiltinAsk(one("git -C sub push"))).toBe(true);
    expect(isBuiltinAsk(one("gh pr create"))).toBe(true);
    expect(isBuiltinAsk(one("gh pr merge 3"))).toBe(true);
    expect(isBuiltinAsk(one("sudo ls"))).toBe(true);
    expect(isBuiltinAsk(one("gh pr view 3"))).toBe(false);
    expect(isBuiltinAsk(one("git commit -m push"))).toBe(false);
  });
});

describe("decideBash", () => {
  const decide = (command: string, mode: BashMode, opts: { rules?: CommandRule[]; isolated?: boolean } = {}) =>
    decideBash({ command, mode, rules: opts.rules ?? [], isolated: opts.isolated ?? false });

  it("runs read-only commands unasked in every mode", () => {
    for (const mode of ["manual", "auto", "planning"] as const) {
      expect(decide("ls && git status | grep x", mode)).toEqual({ kind: "run", by: "readonly" });
    }
  });

  it("asks in manual for anything else, proposing a rule for the part that needs it", () => {
    expect(decide("ls && make build", "manual")).toEqual({ kind: "ask", rules: ["make build *"], reason: "" });
    expect(decide("make a && npm test", "manual")).toMatchObject({ kind: "ask", rules: ["make a *", "npm test *"] });
  });

  it("proposes nothing when one part can't be put in a rule", () => {
    expect(decide("make && ./run.sh", "manual")).toMatchObject({ kind: "ask", rules: [] });
  });

  it("runs in an isolated auto sandbox, and checks outside one", () => {
    expect(decide("make build", "auto", { isolated: true })).toEqual({ kind: "run", by: "isolated" });
    expect(decide("make build", "auto", { isolated: false })).toEqual({ kind: "classify", rules: ["make build *"] });
    expect(decide("for x in a; do rm $x; done", "auto", { isolated: true })).toEqual({ kind: "run", by: "isolated" });
    expect(decide("for x in a; do rm $x; done", "auto", { isolated: false })).toEqual({ kind: "classify", rules: [] });
  });

  it("asks for pushes, GitHub writes and sudo in every mode, isolated or not", () => {
    for (const isolated of [true, false]) {
      expect(decide("git push origin feat", "auto", { isolated })).toMatchObject({ kind: "ask", rules: ["git push *"] });
    }
    expect(decide("gh pr create --fill", "manual")).toMatchObject({ kind: "ask", rules: ["gh pr create *"] });
  });

  it("refuses in planning anything that is not built-in read-only, allow rules included", () => {
    expect(decide("touch x", "planning")).toMatchObject({ kind: "refuse" });
    expect(decide("make", "planning", { rules: [{ pattern: "make *", action: "allow" }] })).toMatchObject({ kind: "refuse" });
    expect(decide("if true; then ls; fi", "planning")).toMatchObject({ kind: "refuse" });
  });

  it("orders deny over ask over allow over the built-ins", () => {
    const rules: CommandRule[] = [
      { pattern: "git push *", action: "allow" },
      { pattern: "make *", action: "allow" },
      { pattern: "make clean *", action: "deny" },
      { pattern: "cat *", action: "ask" },
    ];
    expect(decide("git push origin x", "manual", { rules })).toEqual({ kind: "run", by: "rule", rule: "git push *" });
    expect(decide("make build", "manual", { rules })).toEqual({ kind: "run", by: "rule", rule: "make *" });
    expect(decide("make clean all", "auto", { rules, isolated: true })).toMatchObject({ kind: "deny", rule: "make clean *" });
    expect(decide("ls && cat x", "auto", { rules, isolated: true })).toMatchObject({ kind: "ask", rules: [] });
    expect(decide("ls && make && echo ok", "manual", { rules })).toMatchObject({ kind: "run", by: "rule" });
  });

  it("is only as allowed as its least allowed part", () => {
    const rules: CommandRule[] = [{ pattern: "make *", action: "allow" }];
    expect(decide("make && rm -rf build", "manual", { rules })).toEqual({ kind: "ask", rules: ["rm -rf build"], reason: "" });
    expect(decide("echo $(rm -rf x)", "manual")).toMatchObject({ kind: "ask", rules: ["rm -rf x"] });
  });
});
