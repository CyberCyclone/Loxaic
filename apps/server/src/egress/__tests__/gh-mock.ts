/**
 * A pretend api.github.com GraphQL endpoint for the operations `gh` sends
 * for the commands Loxaic's agent and Inspector use — recorded from a real
 * `gh` 2.101 with `GH_DEBUG=api` — plus the node lookup the egress proxy
 * makes (proxy.ts). Shared by the server's tests and the e2e harness's mock
 * GitHub (apps/e2e/scripts/mock-github.ts), so both answer `gh` the same way.
 *
 * Only what `gh` reads is filled in; a field it asks for and gets nothing
 * back for decodes as empty, which is what `gh` does with a real repository
 * that has none of it.
 */

export interface MockRepo {
  owner: string;
  name: string;
  nodeId: string;
  defaultBranch: string;
}

export interface MockPull {
  number: number;
  id: string;
  repo: string;
  title: string;
  body: string;
  baseRefName: string;
  headRefName: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  url: string;
}

export class GhMock {
  readonly repos: MockRepo[] = [];
  readonly pulls: MockPull[] = [];

  constructor(private readonly webBase = "https://github.com") {}

  repo(owner: string, name: string): MockRepo | undefined {
    return this.repos.find((r) => r.owner.toLowerCase() === owner.toLowerCase() && r.name.toLowerCase() === name.toLowerCase());
  }

  addPull(repo: MockRepo, input: { title: string; body?: string; baseRefName: string; headRefName: string }): MockPull {
    const number = this.pulls.filter((p) => p.repo === `${repo.owner}/${repo.name}`).length + 1;
    const pull: MockPull = {
      number,
      id: `PR_${repo.name}_${String(number)}`,
      repo: `${repo.owner}/${repo.name}`,
      title: input.title,
      body: input.body ?? "",
      baseRefName: input.baseRefName,
      headRefName: input.headRefName,
      state: "OPEN",
      url: `${this.webBase}/${repo.owner}/${repo.name}/pull/${String(number)}`,
    };
    this.pulls.push(pull);
    return pull;
  }

  /** The REST answers the proxy's own lookups ask for (proxy.ts
   * `lookupsFor`): a repository's node id and a pull request's head. Null
   * for anything else, which a caller answers as it likes. */
  rest(method: string, url: string): { status: number; body: unknown } | null {
    if (method !== "GET") return null;
    const m = /^\/repos\/([^/]+)\/([^/]+)(?:\/pulls\/(\d+))?\/?(?:\?.*)?$/.exec(url);
    if (!m) return null;
    const repo = this.repo(m[1], m[2]);
    if (!repo) return { status: 404, body: { message: "Not Found" } };
    const fullName = `${repo.owner}/${repo.name}`;
    if (!m[3]) {
      return {
        status: 200,
        body: { id: 1, node_id: repo.nodeId, name: repo.name, full_name: fullName, default_branch: repo.defaultBranch, owner: { login: repo.owner } },
      };
    }
    const pull = this.pulls.find((p) => p.repo === fullName && p.number === Number(m[3]));
    if (!pull) return { status: 404, body: { message: "Not Found" } };
    return {
      status: 200,
      body: {
        number: pull.number,
        node_id: pull.id,
        html_url: pull.url,
        title: pull.title,
        state: pull.state === "OPEN" ? "open" : "closed",
        head: { ref: pull.headRefName, repo: { full_name: fullName } },
        base: { ref: pull.baseRefName, repo: { full_name: fullName } },
      },
    };
  }

  /** The JSON answer to one GraphQL request body. */
  answer(body: { query?: string; variables?: Record<string, unknown> }): unknown {
    const query = body.query ?? "";
    const v = body.variables ?? {};
    const name = /\b(?:query|mutation)\s+([A-Za-z_]\w*)/.exec(query)?.[1];
    const str = (key: string) => (typeof v[key] === "string" ? (v[key]) : "");

    if (query.includes("node(id:")) {
      const pull = this.pulls.find((p) => p.id === v.id);
      if (!pull) return { data: { node: null } };
      return {
        data: {
          node: {
            __typename: "PullRequest",
            headRefName: pull.headRefName,
            repository: { nameWithOwner: pull.repo },
            headRepository: { nameWithOwner: pull.repo },
          },
        },
      };
    }
    if (name === "RepositoryInfo") {
      const repo = this.repo(str("owner"), str("name"));
      if (!repo) return { data: { repository: null }, errors: [{ type: "NOT_FOUND", message: "Could not resolve to a Repository" }] };
      return {
        data: {
          repository: {
            id: repo.nodeId,
            databaseId: 1,
            name: repo.name,
            owner: { login: repo.owner },
            sshUrl: `git@github.com:${repo.owner}/${repo.name}.git`,
            hasIssuesEnabled: true,
            description: "",
            hasWikiEnabled: false,
            viewerPermission: "WRITE",
            defaultBranchRef: { name: repo.defaultBranch },
            parent: null,
            mergeCommitAllowed: true,
            rebaseMergeAllowed: true,
            squashMergeAllowed: true,
          },
        },
      };
    }
    if (name === "PullRequestForBranch") {
      const repo = this.repo(str("owner"), str("repo"));
      const states = Array.isArray(v.states) ? (v.states as string[]) : ["OPEN"];
      const nodes = this.pulls
        .filter((p) => repo && p.repo === `${repo.owner}/${repo.name}` && p.headRefName === str("headRefName") && states.includes(p.state))
        .map((p) => ({
          url: p.url,
          id: p.id,
          number: p.number,
          state: p.state,
          baseRefName: p.baseRefName,
          headRefName: p.headRefName,
          isCrossRepository: false,
          headRepositoryOwner: { id: "U_owner", login: repo?.owner ?? "" },
        }));
      return { data: { repository: { pullRequests: { nodes }, defaultBranchRef: { name: repo?.defaultBranch ?? "main" } } } };
    }
    if (/createPullRequest\s*\(/.test(query)) {
      const input = (v.input ?? {}) as { repositoryId?: string; title?: string; body?: string; baseRefName?: string; headRefName?: string };
      const repo = this.repos.find((r) => r.nodeId === input.repositoryId);
      if (!repo) return { data: { createPullRequest: null }, errors: [{ message: "Could not resolve to a node" }] };
      const head = (input.headRefName ?? "").replace(/^[^:]+:/, "");
      if (this.pulls.some((p) => p.repo === `${repo.owner}/${repo.name}` && p.headRefName === head && p.state === "OPEN")) {
        return { data: { createPullRequest: null }, errors: [{ message: `A pull request already exists for ${repo.owner}:${head}.` }] };
      }
      const pull = this.addPull(repo, {
        title: input.title ?? "",
        body: input.body,
        baseRefName: input.baseRefName ?? repo.defaultBranch,
        headRefName: head,
      });
      return { data: { createPullRequest: { pullRequest: { id: pull.id, url: pull.url } } } };
    }
    if (name === "PullRequestByNumber") {
      const repo = this.repo(str("owner"), str("repo"));
      const pull = this.pulls.find((p) => repo && p.repo === `${repo.owner}/${repo.name}` && p.number === v.pr_number);
      if (!pull) return { data: { repository: { pullRequest: null } }, errors: [{ type: "NOT_FOUND", message: "Could not resolve to a PullRequest" }] };
      return {
        data: {
          repository: {
            pullRequest: {
              url: pull.url,
              number: pull.number,
              title: pull.title,
              state: pull.state,
              body: pull.body,
              author: { login: repo?.owner ?? "", id: "U_owner", name: repo?.owner ?? "" },
              isDraft: false,
              baseRefName: pull.baseRefName,
              headRefName: pull.headRefName,
              headRepository: { id: repo?.nodeId ?? "", name: repo?.name ?? "", nameWithOwner: pull.repo },
              isCrossRepository: false,
              commits: { totalCount: 1 },
              additions: 1,
              deletions: 0,
              createdAt: "2026-01-01T00:00:00Z",
              id: pull.id,
            },
          },
        },
      };
    }
    if (name === "PullRequestProjectItems") {
      return { data: { repository: { pullRequest: { projectItems: { totalCount: 0, nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } };
    }
    return { data: {} };
  }
}
