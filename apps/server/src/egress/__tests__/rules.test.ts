import { describe, expect, it } from "vitest";
import { parseGraphql } from "../graphql.ts";
import {
  MAX_RECEIVE_PACK_HEADER,
  MAX_REF_UPDATES,
  checkGraphql,
  checkPush,
  checkRestWrite,
  classifyGitRequest,
  parseReceivePack,
  rejectedPushResponse,
  repoOfPath,
  type EgressScope,
  type Lookups,
  type PullInfo,
  type ReceivePackCommands,
} from "../rules.ts";

const SCOPE: EgressScope = { repo: "octo/real", branch: "loxaic/feature" };
const SCRATCH: EgressScope = { repo: null, branch: null };
const A = "a".repeat(40);
const B = "b".repeat(40);
const ZERO = "0".repeat(40);

const pkt = (s: string) => `${(Buffer.byteLength(s) + 4).toString(16).padStart(4, "0")}${s}`;
const commands = (...lines: string[]) => Buffer.from(lines.map(pkt).join("") + "0000PACK...binary", "latin1");

describe("repoOfPath / classifyGitRequest", () => {
  it("reads owner/name, lower case, without .git", () => {
    expect(repoOfPath("/Octo/Real.git/info/refs")).toBe("octo/real");
    expect(repoOfPath("/octo")).toBeNull();
  });

  it("tells reads from pushes", () => {
    const u = (p: string) => new URL(`https://github.com${p}`);
    expect(classifyGitRequest("GET", u("/o/r.git/info/refs?service=git-upload-pack"))).toEqual({ kind: "upload-pack" });
    expect(classifyGitRequest("POST", u("/o/r.git/git-upload-pack"))).toEqual({ kind: "upload-pack" });
    expect(classifyGitRequest("GET", u("/o/r.git/info/refs?service=git-receive-pack"))).toEqual({ kind: "receive-pack-advert", repo: "o/r" });
    expect(classifyGitRequest("POST", u("/o/r.git/git-receive-pack"))).toEqual({ kind: "receive-pack", repo: "o/r" });
    expect(classifyGitRequest("POST", u("/o/r.git/info/lfs/objects/batch"))).toEqual({ kind: "other" });
  });
});

describe("parseReceivePack", () => {
  it("reads every ref update up to the flush, with the first line's capabilities", () => {
    const buf = commands(`${A} ${B} refs/heads/loxaic/feature\0report-status side-band-64k agent=git/2\n`, `${A} ${ZERO} refs/heads/old\n`);
    const parsed = parseReceivePack(buf) as ReceivePackCommands;
    expect(parsed.updates).toEqual([
      { oldSha: A, newSha: B, ref: "refs/heads/loxaic/feature" },
      { oldSha: A, newSha: ZERO, ref: "refs/heads/old" },
    ]);
    expect(parsed.capabilities).toEqual(["report-status", "side-band-64k", "agent=git/2"]);
    expect(buf.toString("latin1", parsed.end)).toBe("PACK...binary");
  });

  it("accepts sha-256 ids and skips shallow lines", () => {
    const long = "c".repeat(64);
    const parsed = parseReceivePack(commands(`shallow ${A}\n`, `${long} ${long} refs/heads/x\0report-status\n`)) as ReceivePackCommands;
    expect(parsed.updates).toEqual([{ oldSha: long, newSha: long, ref: "refs/heads/x" }]);
  });

  it("asks for more bytes until the commands are complete", () => {
    const full = commands(`${A} ${B} refs/heads/x\0report-status\n`);
    expect(parseReceivePack(full.subarray(0, 10))).toBeNull();
    expect(parseReceivePack(full.subarray(0, 2))).toBeNull();
  });

  it("refuses bytes that cannot be commands", () => {
    for (const buf of [
      Buffer.from("zzzz"),
      Buffer.from("0002"),
      commands("push-cert\0report-status\n"),
      commands(`${A} ${B}\n`),
      commands(`${A} ${B} refs/heads/a b\n`),
    ]) {
      expect(parseReceivePack(buf)).toHaveProperty("error");
    }
  });

  it("refuses too many updates, and commands that never end", () => {
    const many = Array.from({ length: MAX_REF_UPDATES + 1 }, (_, i) => `${A} ${B} refs/heads/b${String(i)}\n`);
    expect(parseReceivePack(commands(...many))).toEqual({ error: "too many ref updates" });
    const endless = Buffer.from(pkt(`${A} ${B} refs/heads/x\n`).repeat(MAX_RECEIVE_PACK_HEADER / 80 + 10), "latin1");
    expect(parseReceivePack(endless)).toHaveProperty("error");
  });
});

describe("checkPush", () => {
  const u = (ref: string, newSha = B) => ({ oldSha: A, newSha, ref });

  it("lets the workspace's own branch be created, updated and force-pushed", () => {
    expect(checkPush([u("refs/heads/loxaic/feature")], SCOPE, "octo/real")).toEqual({ allow: true });
    expect(checkPush([{ oldSha: ZERO, newSha: B, ref: "refs/heads/loxaic/feature" }], SCOPE, "octo/real")).toEqual({ allow: true });
  });

  it.each([
    ["the default branch", [u("refs/heads/main")], "octo/real"],
    ["a tag", [u("refs/tags/v1")], "octo/real"],
    ["another branch beside its own", [u("refs/heads/loxaic/feature"), u("refs/heads/other")], "octo/real"],
    ["a branch whose name only starts the same", [u("refs/heads/loxaic/feature-2")], "octo/real"],
    ["its branch in another repository", [u("refs/heads/loxaic/feature")], "octo/other"],
    ["a deletion of its own branch", [u("refs/heads/loxaic/feature", ZERO)], "octo/real"],
  ])("refuses %s", (_name, updates, repo) => {
    const verdict = checkPush(updates, SCOPE, repo);
    expect(verdict.allow).toBe(false);
  });

  it("refuses every push outside a GitHub workspace", () => {
    expect(checkPush([u("refs/heads/loxaic/feature")], SCRATCH, "octo/real")).toMatchObject({ allow: false, reason: expect.stringContaining("read GitHub but not write") as unknown });
  });

  it("says which branch it may push to", () => {
    expect(checkPush([u("refs/heads/main")], SCOPE, "octo/real")).toEqual({
      allow: false,
      reason: "Loxaic lets this workspace push only to refs/heads/loxaic/feature of octo/real.",
    });
  });
});

describe("rejectedPushResponse", () => {
  const parsed = (caps: string) => parseReceivePack(commands(`${A} ${B} refs/heads/main\0${caps}\n`)) as ReceivePackCommands;

  it("reports each ref as rejected with the reason, in side-band when asked", () => {
    const out = rejectedPushResponse(parsed("report-status side-band-64k"), "only your branch\nreally").toString("latin1");
    expect(out).toContain("\u0002only your branch really\n");
    expect(out).toContain("unpack ok\n");
    expect(out).toContain("ng refs/heads/main only your branch really\n");
    expect(out.endsWith("0000")).toBe(true);
  });

  it("sends the plain report without side-band", () => {
    const out = rejectedPushResponse(parsed("report-status"), "no").toString("latin1");
    expect(out).toBe(`${pkt("unpack ok\n")}${pkt("ng refs/heads/main no\n")}0000`);
  });
});

function lookups(over: Partial<{ pulls: Record<number, PullInfo>; repoId: string | null; nodes: Record<string, Awaited<ReturnType<Lookups["node"]>>> }> = {}): Lookups {
  const own: PullInfo = { repo: "octo/real", headRef: "loxaic/feature", headRepo: "octo/real" };
  const pulls = over.pulls ?? { 1: own, 2: { ...own, headRef: "someone-else" } };
  const nodes = over.nodes ?? {
    PR_own: { type: "PullRequest", pull: own },
    PR_other: { type: "PullRequest", pull: { ...own, headRef: "someone-else" } },
    PR_fork: { type: "PullRequest", pull: { ...own, headRepo: "fork/real" } },
    PR_elsewhere: { type: "PullRequest", pull: { repo: "octo/other", headRef: "loxaic/feature", headRepo: "octo/other" } },
    I_here: { type: "Issue", repo: "octo/real" },
    I_elsewhere: { type: "Issue", repo: "octo/other" },
    U_someone: { type: "other" },
  };
  return {
    pull: (n) => Promise.resolve(pulls[n] ?? null),
    repoNodeId: () => Promise.resolve(over.repoId === undefined ? "R_real" : over.repoId),
    node: (id) => Promise.resolve(nodes[id] ?? null),
  };
}

describe("checkRestWrite", () => {
  const allowed = async (method: string, path: string, body: unknown = {}, scope = SCOPE) =>
    (await checkRestWrite(method, path, body, scope, lookups())).allow;

  it("allows opening the branch's pull request, and nothing else's", async () => {
    expect(await allowed("POST", "/repos/octo/real/pulls", { head: "loxaic/feature", base: "main" })).toBe(true);
    expect(await allowed("POST", "/repos/Octo/Real/pulls", { head: "octo:loxaic/feature" })).toBe(true);
    expect(await allowed("POST", "/repos/octo/real/pulls", { head: "main" })).toBe(false);
    expect(await allowed("POST", "/repos/octo/real/pulls", { head: "fork:loxaic/feature" })).toBe(false);
    expect(await allowed("POST", "/repos/octo/real/pulls", {})).toBe(false);
    expect(await allowed("POST", "/repos/octo/other/pulls", { head: "loxaic/feature" })).toBe(false);
  });

  it("allows editing its own pull request, but never closing it", async () => {
    expect(await allowed("PATCH", "/repos/octo/real/pulls/1", { title: "t", body: "b" })).toBe(true);
    expect(await allowed("PATCH", "/repos/octo/real/pulls/1", { state: "closed" })).toBe(false);
    expect(await allowed("PATCH", "/repos/octo/real/pulls/2", { title: "t" })).toBe(false);
    expect(await allowed("PATCH", "/repos/octo/real/pulls/99", { title: "t" })).toBe(false);
  });

  it("allows comments in the repository, and reviewers, labels and assignees on its own pull request", async () => {
    expect(await allowed("POST", "/repos/octo/real/issues/5/comments", { body: "hi" })).toBe(true);
    expect(await allowed("POST", "/repos/octo/real/pulls/2/comments", { body: "hi" })).toBe(true);
    expect(await allowed("POST", "/repos/octo/real/pulls/1/requested_reviewers", { reviewers: ["a"] })).toBe(true);
    expect(await allowed("POST", "/repos/octo/real/issues/1/labels", { labels: ["x"] })).toBe(true);
    expect(await allowed("POST", "/repos/octo/real/issues/2/labels", { labels: ["x"] })).toBe(false);
    expect(await allowed("POST", "/repos/octo/other/issues/5/comments", { body: "hi" })).toBe(false);
  });

  it.each([
    ["PUT", "/repos/octo/real/pulls/1/merge"],
    ["DELETE", "/repos/octo/real/git/refs/heads/main"],
    ["DELETE", "/repos/octo/real"],
    ["PATCH", "/repos/octo/real"],
    ["POST", "/repos/octo/real/git/refs"],
    ["PUT", "/repos/octo/real/contents/README.md"],
    ["POST", "/repos/octo/real/hooks"],
    ["PUT", "/repos/octo/real/collaborators/someone"],
    ["POST", "/user/repos"],
    ["POST", "/gists"],
  ])("refuses %s %s", async (method, path) => {
    expect(await allowed(method, path, { title: "x" })).toBe(false);
  });

  it("refuses every write outside a GitHub workspace", async () => {
    expect(await checkRestWrite("POST", "/repos/octo/real/issues/1/comments", {}, SCRATCH, lookups())).toMatchObject({ allow: false });
  });
});

describe("checkGraphql", () => {
  const check = async (doc: string, variables: unknown, scope = SCOPE, l = lookups()) => {
    const ops = parseGraphql(doc);
    if (!Array.isArray(ops)) throw new Error(ops.error);
    return checkGraphql(ops, variables, scope, l);
  };
  const create = "mutation PullRequestCreate($input:CreatePullRequestInput!){createPullRequest(input: $input){pullRequest{id,url}}}";
  const one = (field: string) => `mutation M($input: X!) { ${field}(input: $input) { clientMutationId } }`;

  it("lets every query through, in any scope", async () => {
    expect(await check("query { viewer { login } }", {}, SCRATCH)).toEqual({ allow: true });
  });

  it("allows gh's createPullRequest from the branch, on the workspace's repository", async () => {
    const input = { repositoryId: "R_real", baseRefName: "main", headRefName: "loxaic/feature", title: "t", body: "" };
    expect(await check(create, { input })).toEqual({ allow: true });
    expect(await check(create, { input: { ...input, headRepositoryId: "R_real" } })).toEqual({ allow: true });
    expect((await check(create, { input: { ...input, headRefName: "main" } })).allow).toBe(false);
    expect((await check(create, { input: { ...input, repositoryId: "R_other" } })).allow).toBe(false);
    expect((await check(create, { input: { ...input, headRepositoryId: "R_fork" } })).allow).toBe(false);
    // The repository's id could not be learned: refused, not assumed.
    expect((await check(create, { input }, SCOPE, lookups({ repoId: null }))).allow).toBe(false);
  });

  it("allows comments on the repository's issues and pull requests only", async () => {
    expect(await check(one("addComment"), { input: { subjectId: "I_here", body: "x" } })).toEqual({ allow: true });
    expect(await check(one("addComment"), { input: { subjectId: "PR_other", body: "x" } })).toEqual({ allow: true });
    expect((await check(one("addComment"), { input: { subjectId: "I_elsewhere", body: "x" } })).allow).toBe(false);
    expect((await check(one("addComment"), { input: { subjectId: "U_someone", body: "x" } })).allow).toBe(false);
    expect((await check(one("addComment"), { input: { subjectId: "missing", body: "x" } })).allow).toBe(false);
  });

  it("allows changing its own pull request, but not closing it, and not anyone else's", async () => {
    expect(await check(one("updatePullRequest"), { input: { pullRequestId: "PR_own", title: "t" } })).toEqual({ allow: true });
    expect(await check(one("requestReviews"), { input: { pullRequestId: "PR_own", userIds: ["U"] } })).toEqual({ allow: true });
    expect(await check(one("addLabelsToLabelable"), { input: { labelableId: "PR_own", labelIds: ["L"] } })).toEqual({ allow: true });
    expect((await check(one("updatePullRequest"), { input: { pullRequestId: "PR_own", state: "CLOSED" } })).allow).toBe(false);
    for (const id of ["PR_other", "PR_fork", "PR_elsewhere", "I_here"]) {
      expect((await check(one("updatePullRequest"), { input: { pullRequestId: id, title: "t" } })).allow, id).toBe(false);
    }
  });

  it.each([
    "mergePullRequest",
    "closePullRequest",
    "deleteRef",
    "updateRef",
    "createRef",
    "createCommitOnBranch",
    "deleteRepository",
    "updateRepository",
    "addPullRequestReview",
    "enablePullRequestAutoMerge",
    // Names that exist on Object.prototype must not find a table entry.
    "constructor",
    "toString",
  ])("refuses %s", async (name) => {
    expect((await check(one(name), { input: { pullRequestId: "PR_own" } })).allow).toBe(false);
  });

  it("refuses a disallowed mutation hidden behind an alias, or beside an allowed one", async () => {
    const aliased = "mutation M($input: X!) { addComment: mergePullRequest(input: $input) { clientMutationId } }";
    expect((await check(aliased, { input: { pullRequestId: "PR_own" } })).allow).toBe(false);
    const both = "mutation M($a: X!, $b: Y!) { addComment(input: $a) { clientMutationId } mergePullRequest(input: $b) { clientMutationId } }";
    expect((await check(both, { a: { subjectId: "I_here", body: "x" }, b: { pullRequestId: "PR_own" } })).allow).toBe(false);
  });

  it("checks every operation, not only the one operationName picks", async () => {
    const doc = `query Harmless { viewer { login } } ${one("mergePullRequest")}`;
    expect((await check(doc, { input: { pullRequestId: "PR_own" } })).allow).toBe(false);
  });

  it("refuses what it cannot see: literal inputs, missing variables, fragments, subscriptions", async () => {
    expect((await check('mutation { addComment(input: { subjectId: "I_here", body: "x" }) { clientMutationId } }', {})).allow).toBe(false);
    expect((await check(one("addComment"), {})).allow).toBe(false);
    expect((await check(one("addComment"), { input: "I_here" })).allow).toBe(false);
    expect((await check("fragment F on Mutation { mergePullRequest(input: $i) { clientMutationId } } mutation M($i: X) { ...F }", { i: {} })).allow).toBe(false);
    expect((await check("subscription { x }", {})).allow).toBe(false);
  });

  it("refuses every mutation outside a GitHub workspace", async () => {
    expect((await check(one("addComment"), { input: { subjectId: "I_here", body: "x" } }, SCRATCH)).allow).toBe(false);
  });
});
