/**
 * What the egress proxy (proxy.ts) lets a sandbox do on GitHub with its
 * owner's token. Pure: every lookup GitHub has to answer is handed in.
 *
 * Reads go anywhere the token can read — the same reach the GitHub MCP server
 * had, and the token's own scope is the boundary (Settings → GitHub
 * recommends a fine-grained token for the repositories it should reach).
 * Writes are narrow, and only from a GitHub workspace, to its own repository:
 * - git pushes only to `refs/heads/<the workspace's branch>`, never deleting
 *   it and never a tag;
 * - opening and editing the pull request whose head is that branch,
 *   commenting on the repository's issues and pull requests, asking for
 *   reviews and labels on that pull request.
 * Everything else — merging, closing, deleting, other branches, other
 * repositories, settings — is refused with a sentence saying so.
 *
 * Asking the user before `gh pr create` is not this module's job: the command
 * rules ask first (permissions/bash/rules.ts). This is what holds however the
 * request was made.
 */
import type { GraphqlOperation } from "./graphql.ts";

export interface EgressScope {
  /** `owner/name`, lower case, of the workspace's repository — null outside a
   * GitHub workspace, where nothing may be written. */
  repo: string | null;
  branch: string | null;
}

export type Verdict = { allow: true } | { allow: false; reason: string };

const ALLOW: Verdict = { allow: true };
const refuse = (reason: string): Verdict => ({ allow: false, reason });

const READ_ONLY_HERE =
  "Loxaic lets this sandbox read GitHub but not write to it: only a conversation with a GitHub workspace can push or open a pull request, and only for its own repository.";

function onlyBranch(scope: EgressScope): string {
  return `Loxaic lets this workspace push only to refs/heads/${scope.branch ?? "its own branch"} of ${scope.repo ?? "its repository"}.`;
}

/** `owner/name` from a path's first two segments, lower case, without `.git`. */
export function repoOfPath(pathname: string): string | null {
  const [owner, name] = pathname.replace(/^\/+/, "").split("/");
  if (!owner || !name) return null;
  return `${owner}/${name.replace(/\.git$/i, "")}`.toLowerCase();
}

// ── git smart HTTP (github.com) ─────────────────────────────

export type GitRequest =
  | { kind: "upload-pack" }
  | { kind: "receive-pack-advert"; repo: string }
  | { kind: "receive-pack"; repo: string }
  | { kind: "other" };

export function classifyGitRequest(method: string, url: URL): GitRequest {
  const path = url.pathname;
  const repo = repoOfPath(path);
  if (method === "GET" && path.endsWith("/info/refs")) {
    const service = url.searchParams.get("service");
    if (service === "git-receive-pack" && repo) return { kind: "receive-pack-advert", repo };
    return { kind: "upload-pack" };
  }
  if (method === "POST" && path.endsWith("/git-upload-pack")) return { kind: "upload-pack" };
  if (method === "POST" && path.endsWith("/git-receive-pack") && repo) return { kind: "receive-pack", repo };
  return { kind: "other" };
}

export const ZERO_SHA = /^0+$/;

export interface RefUpdate {
  oldSha: string;
  newSha: string;
  ref: string;
}

/** Where the commands of a receive-pack request end, if they are all here. */
export interface ReceivePackCommands {
  updates: RefUpdate[];
  /** Capabilities from the first command line (after its NUL). */
  capabilities: string[];
  /** Byte offset just past the flush packet that ends the commands. */
  end: number;
}

export const MAX_RECEIVE_PACK_HEADER = 64 * 1024;
export const MAX_REF_UPDATES = 100;

/**
 * The ref updates at the start of a `git-receive-pack` body: pkt-lines of
 * `old new ref[\0capabilities]` up to a flush (`0000`). Null when more bytes
 * are needed; `{ error }` when the bytes cannot be commands.
 */
export function parseReceivePack(buf: Buffer): ReceivePackCommands | null | { error: string } {
  const updates: RefUpdate[] = [];
  let capabilities: string[] = [];
  let i = 0;
  for (;;) {
    if (i + 4 > buf.length) return buf.length > MAX_RECEIVE_PACK_HEADER ? { error: "commands too long" } : null;
    const lenHex = buf.toString("latin1", i, i + 4);
    if (!/^[0-9a-f]{4}$/.test(lenHex)) return { error: "not a pkt-line" };
    const len = parseInt(lenHex, 16);
    if (len === 0) return { updates, capabilities, end: i + 4 };
    if (len < 4) return { error: "bad pkt-line length" };
    if (i + len > buf.length) return i + len > MAX_RECEIVE_PACK_HEADER ? { error: "commands too long" } : null;
    let line = buf.toString("utf8", i + 4, i + len).replace(/\n$/, "");
    const nul = line.indexOf("\0");
    if (nul !== -1) {
      if (updates.length === 0) capabilities = line.slice(nul + 1).split(" ").filter(Boolean);
      line = line.slice(0, nul);
    }
    // `shallow` lines may precede the commands; push-certs are not used here.
    if (!line.startsWith("shallow ")) {
      const m = /^([0-9a-f]{40,64}) ([0-9a-f]{40,64}) (\S+)$/.exec(line);
      if (!m) return { error: "not a ref update" };
      updates.push({ oldSha: m[1], newSha: m[2], ref: m[3] });
      if (updates.length > MAX_REF_UPDATES) return { error: "too many ref updates" };
    }
    i += len;
  }
}

export function checkPush(updates: readonly RefUpdate[], scope: EgressScope, repo: string): Verdict {
  if (!scope.repo || !scope.branch) return refuse(READ_ONLY_HERE);
  if (repo !== scope.repo) return refuse(onlyBranch(scope));
  for (const u of updates) {
    if (u.ref !== `refs/heads/${scope.branch}`) return refuse(onlyBranch(scope));
    if (ZERO_SHA.test(u.newSha)) return refuse(`Loxaic does not let this workspace delete ${u.ref}.`);
  }
  return ALLOW;
}

const pkt = (payload: Buffer | string): Buffer => {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
  return Buffer.concat([Buffer.from((body.length + 4).toString(16).padStart(4, "0"), "latin1"), body]);
};

/**
 * A receive-pack result refusing every update, so `git push` prints
 * `! [remote rejected] main -> main (<reason>)` and the reason reaches the
 * model instead of a bare HTTP 403. Wrapped in side-band when the client asked
 * for it, as it always does.
 */
export function rejectedPushResponse(commands: ReceivePackCommands, reason: string): Buffer {
  const clean = reason.replace(/[\r\n]+/g, " ").slice(0, 400);
  const report = Buffer.concat([
    pkt("unpack ok\n"),
    ...commands.updates.map((u) => pkt(`ng ${u.ref} ${clean}\n`)),
    Buffer.from("0000", "latin1"),
  ]);
  const sideBand = commands.capabilities.some((c) => c === "side-band-64k" || c === "side-band");
  if (!sideBand) return report;
  const chunks: Buffer[] = [pkt(Buffer.concat([Buffer.from([2]), Buffer.from(`${clean}\n`, "utf8")]))];
  for (let off = 0; off < report.length; off += 65_000) {
    chunks.push(pkt(Buffer.concat([Buffer.from([1]), report.subarray(off, off + 65_000)])));
  }
  chunks.push(Buffer.from("0000", "latin1"));
  return Buffer.concat(chunks);
}

// ── REST (api.github.com) ───────────────────────────────────

export interface PullInfo {
  repo: string;
  headRef: string;
  /** The head repository, `owner/name` lower case. */
  headRepo: string;
}

export interface Lookups {
  /** A pull request of the workspace's repository, by number. */
  pull(number: number): Promise<PullInfo | null>;
  /** The workspace repository's GraphQL node id. */
  repoNodeId(): Promise<string | null>;
  /** What a GraphQL node id names, as far as these rules care. */
  node(id: string): Promise<{ type: "PullRequest"; pull: PullInfo } | { type: "Issue"; repo: string } | { type: "other" } | null>;
}

const ownPull = (pull: PullInfo | null, scope: EgressScope): boolean =>
  pull !== null && pull.repo === scope.repo && pull.headRepo === scope.repo && pull.headRef === scope.branch;

const headMatches = (head: unknown, scope: EgressScope): boolean => {
  if (typeof head !== "string" || !scope.branch || !scope.repo) return false;
  const owner = scope.repo.split("/")[0];
  return head === scope.branch || head.toLowerCase() === `${owner}:${scope.branch}`.toLowerCase();
};

export async function checkRestWrite(
  method: string,
  pathname: string,
  body: unknown,
  scope: EgressScope,
  lookups: Lookups,
): Promise<Verdict> {
  if (!scope.repo || !scope.branch) return refuse(READ_ONLY_HERE);
  const m = /^\/repos\/([^/]+)\/([^/]+)\/(.*)$/.exec(pathname);
  if (!m || `${m[1]}/${m[2]}`.toLowerCase() !== scope.repo) {
    return refuse(`Loxaic lets this workspace write only to ${scope.repo} on GitHub.`);
  }
  const rest = m[3].replace(/\/+$/, "");
  const fields = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
  if (method === "POST" && rest === "pulls") {
    return headMatches(fields.head, scope)
      ? ALLOW
      : refuse(`Loxaic lets this workspace open a pull request only from ${scope.branch}.`);
  }
  let n = /^pulls\/(\d+)$/.exec(rest);
  if (n && method === "PATCH") {
    if ("state" in fields) return refuse("Loxaic does not let the agent close or reopen a pull request.");
    return ownPull(await lookups.pull(Number(n[1])), scope)
      ? ALLOW
      : refuse(`Loxaic lets this workspace edit only the pull request from ${scope.branch}.`);
  }
  if (method === "POST" && /^issues\/\d+\/comments$/.test(rest)) return ALLOW;
  if (method === "POST" && /^pulls\/\d+\/comments$/.test(rest)) return ALLOW;
  n = /^(?:pulls\/(\d+)\/requested_reviewers|issues\/(\d+)\/(?:labels|assignees))$/.exec(rest);
  if (n && method === "POST") {
    return ownPull(await lookups.pull(Number(n.at(1) ?? n.at(2))), scope)
      ? ALLOW
      : refuse(`Loxaic lets this workspace change only the pull request from ${scope.branch}.`);
  }
  return refuse(`Loxaic does not let the agent ${method} ${pathname} on GitHub; ask the user to do that.`);
}

// ── GraphQL (api.github.com/graphql) ────────────────────────

/** Mutations whose subject must be this workspace's own pull request, and
 * the input field naming it. */
const OWN_PULL_MUTATIONS = new Map<string, string>([
  ["updatePullRequest", "pullRequestId"],
  ["requestReviews", "pullRequestId"],
  ["markPullRequestReadyForReview", "pullRequestId"],
  ["addLabelsToLabelable", "labelableId"],
  ["addAssigneesToAssignable", "assignableId"],
]);

export async function checkGraphql(
  ops: readonly GraphqlOperation[],
  variables: unknown,
  scope: EgressScope,
  lookups: Lookups,
): Promise<Verdict> {
  const vars = variables !== null && typeof variables === "object" ? (variables as Record<string, unknown>) : {};
  for (const op of ops) {
    if (op.type === "subscription") return refuse("Loxaic does not proxy GraphQL subscriptions.");
    if (op.type !== "mutation") continue;
    if (!scope.repo || !scope.branch) return refuse(READ_ONLY_HERE);
    if (op.hasTopLevelFragment) return refuse("Loxaic can't check a mutation written with fragments.");
    for (const field of op.fields) {
      const inputArg = field.args.input;
      if (inputArg?.kind !== "variable") {
        return refuse(`Loxaic can only check ${field.name} with its input passed as a variable.`);
      }
      const input = vars[inputArg.name];
      if (input === null || typeof input !== "object") return refuse(`${field.name} has no input.`);
      const fields = input as Record<string, unknown>;
      const verdict = await checkMutation(field.name, fields, scope, lookups);
      if (!verdict.allow) return verdict;
    }
  }
  return ALLOW;
}

async function checkMutation(
  name: string,
  input: Record<string, unknown>,
  scope: EgressScope,
  lookups: Lookups,
): Promise<Verdict> {
  if (name === "createPullRequest") {
    const repoId = await lookups.repoNodeId();
    if (!repoId || input.repositoryId !== repoId) {
      return refuse(`Loxaic lets this workspace open a pull request only on ${String(scope.repo)}.`);
    }
    if (input.headRepositoryId !== undefined && input.headRepositoryId !== repoId) {
      return refuse(`Loxaic lets this workspace open a pull request only from ${String(scope.branch)}.`);
    }
    return headMatches(input.headRefName, scope)
      ? ALLOW
      : refuse(`Loxaic lets this workspace open a pull request only from ${String(scope.branch)}.`);
  }
  if (name === "addComment") {
    const node = typeof input.subjectId === "string" ? await lookups.node(input.subjectId) : null;
    const repo = node?.type === "PullRequest" ? node.pull.repo : node?.type === "Issue" ? node.repo : null;
    return repo === scope.repo ? ALLOW : refuse(`Loxaic lets this workspace comment only on ${String(scope.repo)}.`);
  }
  const idField = OWN_PULL_MUTATIONS.get(name);
  if (idField) {
    if (name === "updatePullRequest" && "state" in input) {
      return refuse("Loxaic does not let the agent close or reopen a pull request.");
    }
    const id = input[idField];
    const node = typeof id === "string" ? await lookups.node(id) : null;
    return node?.type === "PullRequest" && ownPull(node.pull, scope)
      ? ALLOW
      : refuse(`Loxaic lets this workspace change only the pull request from ${String(scope.branch)}.`);
  }
  return refuse(`Loxaic does not let the agent run ${name} on GitHub; ask the user to do that.`);
}
