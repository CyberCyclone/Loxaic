/**
 * Thin, unauthenticated-by-caller wrapper over the GitHub REST API. Plain
 * `fetch`, no octokit — the surface needed here (viewer identity, repo
 * listing/lookup, branches, opening a PR) is small enough that a dependency
 * buys nothing but an upgrade treadmill.
 */

/** Read at call time, never cached, so a test harness can point this at a
 * local mock server (see apps/e2e/scripts/mock-github.ts) by setting the env
 * var before the request rather than before the module loads. Not an SSRF
 * concern: this is an operator/test seam, not something a request body can
 * influence — every caller of this module already holds the user's own token. */
function apiUrl(path: string): string {
  const base = process.env.GITHUB_API_URL ?? "https://api.github.com";
  return `${base}${path}`;
}

const TIMEOUT_MS = 10_000;

export class GithubApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "GithubApiError";
    this.status = status;
  }
}

/** The one place a request actually goes out. Every caller in this module
 * routes through it so a network error or a non-2xx body is redacted and
 * shaped the same way regardless of which endpoint failed. */
/** Only ever called with a plain header object (never an array or a `Headers`
 * instance) — narrowed here rather than accepting the full `RequestInit`
 * shape, since spreading an array-typed `HeadersInit` into an object would
 * produce numeric-index keys instead of merging. */
interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

async function rawRequest(token: string, path: string, init?: RequestOptions): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); }, TIMEOUT_MS);
  try {
    const res = await fetch(apiUrl(path), {
      ...init,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "loxaic",
        ...init?.headers,
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new GithubApiError(
        `GitHub API ${String(res.status)}: ${body.split(token).join("[redacted]").slice(0, 500)}`,
        res.status,
      );
    }
    return res;
  } catch (err) {
    if (err instanceof GithubApiError) throw err;
    // Redacted defensively even though a network error is unlikely to embed
    // the Authorization header — every other error path through this module
    // does, and one silent exception is how a token ends up in a log anyway.
    throw new GithubApiError((err as Error).message.split(token).join("[redacted]"), 0);
  } finally {
    clearTimeout(timer);
  }
}

async function request<T>(token: string, path: string, init?: RequestOptions): Promise<T> {
  const res = await rawRequest(token, path, init);
  return res.json() as Promise<T>;
}

/**
 * Pages followed per listing. GitHub's `per_page` tops out at 100, and a
 * single page was all `listRepos` ever read — so anyone with more than 100
 * repositories across owner, collaborator and org membership could not pick
 * the older ones at all, and the picker rendered them as "no matches". Ten
 * pages is a thousand items, at one request each; past that a listing is not
 * a picker's problem to solve.
 */
const MAX_PAGES = 10;

/** `path` and every `rel="next"` page after it, up to MAX_PAGES. A next link
 * is followed only on the API's own origin — the header is the server's
 * text, and a listing must not be steerable off-host by it. */
async function requestAll<T>(token: string, path: string): Promise<T[]> {
  const out: T[] = [];
  const origin = new URL(apiUrl("/")).origin;
  let next: string | null = path;
  for (let page = 0; next !== null && page < MAX_PAGES; page++) {
    const res = await rawRequest(token, next);
    out.push(...((await res.json()) as T[]));
    next = nextPagePath(res.headers.get("link"), origin);
  }
  return out;
}

function nextPagePath(link: string | null, origin: string): string | null {
  if (!link) return null;
  for (const part of link.split(",")) {
    const match = /<([^>]+)>;\s*rel="next"/.exec(part.trim());
    if (!match) continue;
    let url: URL;
    try {
      url = new URL(match[1]);
    } catch {
      return null;
    }
    if (url.origin !== origin) return null;
    return `${url.pathname}${url.search}`;
  }
  return null;
}

export interface GithubViewer {
  login: string;
  name: string | null;
  email: string | null;
}

/** Validates a token and returns the identity to store alongside it. Also the
 * connection screen's "Connect" action — a bad token fails here, not silently
 * on the first clone. */
export async function getViewer(token: string): Promise<{ viewer: GithubViewer; scopes: string | null }> {
  const res = await rawRequest(token, "/user");
  // Fine-grained PATs return no X-OAuth-Scopes header at all — absence must
  // read as "unknown", not as "no scopes granted".
  const scopes = res.headers.get("x-oauth-scopes");
  const data = (await res.json()) as { login: string; name: string | null; email: string | null };
  return { viewer: { login: data.login, name: data.name, email: data.email }, scopes };
}

export interface GithubRepo {
  id: number;
  full_name: string;
  private: boolean;
  default_branch: string;
  clone_url: string;
}

/** The user's repos, most-recently-pushed first — matches how someone picks a
 * repo to work in: whatever they touched last. `q` filters here rather than
 * via GitHub's search API, which indexes separately and lags recent pushes —
 * reasoning that only holds because the whole listing (to MAX_PAGES) is in
 * hand, not just its first page. */
export async function listRepos(token: string, q?: string): Promise<GithubRepo[]> {
  const repos = await requestAll<GithubRepo>(
    token,
    "/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member",
  );
  if (!q) return repos;
  const needle = q.toLowerCase();
  return repos.filter((r) => r.full_name.toLowerCase().includes(needle));
}

export async function getRepo(token: string, owner: string, repo: string): Promise<GithubRepo> {
  return request<GithubRepo>(token, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
}

export interface GithubBranch {
  name: string;
}

export async function listBranches(token: string, owner: string, repo: string): Promise<string[]> {
  const branches = await requestAll<GithubBranch>(
    token,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches?per_page=100`,
  );
  return branches.map((b) => b.name);
}

export interface GithubPull {
  number: number;
  html_url: string;
}

/** Opens a PR. `422` from GitHub means one already exists for this head/base —
 * surfaced as a distinct error so a caller (a later stage's git route) can
 * treat "already open" as success rather than a failure. */
export async function createPull(
  token: string,
  owner: string,
  repo: string,
  input: { head: string; base: string; title: string; body?: string },
): Promise<GithubPull> {
  try {
    return await request<GithubPull>(token, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  } catch (err) {
    // 422 is GitHub's whole validation family for this endpoint — "No commits
    // between base and head", an unknown head, base equal to head — and only
    // one of them is "already exists". The message is the discriminator
    // (`errors[].message`, which the error text carries), so the rest reach
    // the caller as the GithubApiError they are.
    if (err instanceof GithubApiError && err.status === 422 && /already exists/i.test(err.message)) {
      throw new GithubPullExistsError(err.message);
    }
    throw err;
  }
}

export class GithubPullExistsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GithubPullExistsError";
  }
}
