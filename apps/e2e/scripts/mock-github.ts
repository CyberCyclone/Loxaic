/**
 * A minimal stand-in for the GitHub REST API, so e2e specs can drive the
 * GitHub connection flow — and, in later stages, a repo/branch picker and
 * git actions — without ever reaching the real github.com or needing a real
 * token.
 *
 * `apps/server/src/github/client.ts` reads `GITHUB_API_URL` at call time
 * specifically so this can be pointed at from the outside: standup.ts passes
 * this server's URL into the spawned server's env, exactly like every other
 * test seam it wires up.
 *
 * Deliberately not a full fixture library — just enough of `/user`,
 * `/user/repos`, `/repos/:owner/:repo`, `/repos/:owner/:repo/branches` and
 * `/repos/:owner/:repo/branches/:branch` to exercise every route the server
 * calls, plus `POST /graphql` for the operations `gh` sends to read and open
 * pull requests (answered by the server's own GhMock, so the server's tests
 * and this harness answer `gh` the same way). `gh` reaches it only through
 * the server's egress proxy, which adds the token. Anything that is not one of the two tokens below 401s, matching a
 * real bad-credential response closely enough for the client's error handling
 * to be exercised honestly.
 *
 * **Two tokens, because the interesting failure is not a rejected one.**
 * `VALID_TOKEN` behaves like a classic PAT: it reports its scopes and can
 * reach everything. `METADATA_ONLY_TOKEN` reproduces the real bug this fixture
 * exists for — a fine-grained token that reports *no* scopes at all, lists and
 * resolves repositories perfectly well (`Metadata: read`), and is refused on
 * anything needing `Contents: read`. That combination is what let a workspace
 * be created against a repo whose clone was then refused inside a container.
 * A spec cannot reconfigure this server (it is started once per stand-up and
 * its URL crosses a process boundary), so both behaviours have to be reachable
 * by choosing a token.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';
import { GhMock } from '../../server/src/egress/__tests__/gh-mock.ts';

export const VALID_TOKEN = 'e2e-github-token';

/** A fine-grained token holding `Metadata: read` and nothing else. See the
 * module comment: this is the token that connects successfully and still
 * cannot clone. */
export const METADATA_ONLY_TOKEN = 'e2e-github-metadata-only';

interface RecordedPull {
  number: number;
  html_url: string;
  owner: string;
  repo: string;
  head: string;
  base: string;
  title: string;
  body?: string;
}

/** Pull requests, and the GraphQL answers about them. Replaced per stand-up,
 * so a fresh server starts empty; a spec reads what was opened back through
 * `GET /__e2e/pulls` to confirm it reached (the fixture standing in for)
 * GitHub with the right head and base — proof independent of whatever the UI
 * claims happened. */
let gh = new GhMock();

function recordedPulls(): RecordedPull[] {
  return gh.pulls.map((p) => {
    const [owner, repo] = p.repo.split('/');
    return { number: p.number, html_url: p.url, owner, repo, head: p.headRefName, base: p.baseRefName, title: p.title, body: p.body };
  });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk: Buffer) => { data += chunk.toString(); });
    req.on('end', () => { resolve(data); });
  });
}

/**
 * Clone URLs point at the harness's own git server (git-server.ts) when one
 * is running, so the server's real workspace path — look the repo up, clone
 * exactly what GitHub reported — is what a spec exercises. Without a git
 * server (the settings spec alone) they are inert placeholders.
 */
function repos(cloneUrlFor: (name: string) => string) {
  return withNodeIds([
    { id: 1, full_name: 'e2e/bugfix-app', private: false, default_branch: 'main', clone_url: cloneUrlFor('bugfix-app') },
    { id: 2, full_name: 'e2e/other-repo', private: true, default_branch: 'trunk', clone_url: cloneUrlFor('other-repo') },
    // Real-model lane only (apps/e2e/fixtures/seeded-app): a repo, not a
    // pre-seeded sandbox, so the real-model suite exercises the same clone
    // path the mock lane's GitHub-workspace specs do. See real-model-build.spec.ts.
    { id: 3, full_name: 'e2e/seeded-app', private: false, default_branch: 'main', clone_url: cloneUrlFor('seeded-app') },
    // A repo with its own AGENTS.md, and another in pkg/sub
    // (apps/e2e/fixtures/instructions-app). See agent-instructions.spec.ts.
    { id: 4, full_name: 'e2e/instructions-app', private: false, default_branch: 'main', clone_url: cloneUrlFor('instructions-app') },
    // Only a CLAUDE.md, which imports its rules with @path
    // (apps/e2e/fixtures/imports-app).
    { id: 5, full_name: 'e2e/imports-app', private: false, default_branch: 'main', clone_url: cloneUrlFor('imports-app') },
    // agent-gh-proxy.spec.ts's own, so the pull request it opens is always #1
    // however many other specs open one on bugfix-app in the same run.
    { id: 6, full_name: 'e2e/gh-app', private: false, default_branch: 'main', clone_url: cloneUrlFor('gh-app') },
    // Skills of its own in .agents/skills and .claude/skills
    // (apps/e2e/fixtures/skills-app). See agent-repo-skills.spec.ts.
    { id: 7, full_name: 'e2e/skills-app', private: false, default_branch: 'main', clone_url: cloneUrlFor('skills-app') },
  ]);
}

/** GraphQL ids, which the egress proxy checks a `createPullRequest` against. */
function withNodeIds<T extends { full_name: string }>(list: T[]): (T & { node_id: string })[] {
  return list.map((r) => ({ ...r, node_id: `R_${r.full_name.replace(/\W/g, '_')}` }));
}

const BRANCHES = new Map<string, string[]>([
  ['e2e/bugfix-app', ['main', 'feature/one']],
  ['e2e/other-repo', ['trunk']],
  ['e2e/seeded-app', ['main']],
  ['e2e/instructions-app', ['main']],
  ['e2e/imports-app', ['main']],
  ['e2e/gh-app', ['main']],
  ['e2e/skills-app', ['main']],
]);

function json(res: import('node:http').ServerResponse, status: number, body: unknown, headers?: Record<string, string>): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

let server: Server | null = null;

export async function startMockGithub(opts?: {
  cloneUrlFor?: (name: string) => string;
  /** The fixture directory a repo's files are served from, by repo name —
   * the same directories the git server makes repos of, so what the contents
   * API returns is what a clone would check out. */
  fixtureDirFor?: (name: string) => string | undefined;
}): Promise<{ url: string; stop: () => Promise<void> }> {
  const REPOS = repos(opts?.cloneUrlFor ?? ((name) => `https://github.com/e2e/${name}.git`));
  gh = new GhMock();
  for (const r of REPOS) {
    const [owner, name] = r.full_name.split('/');
    gh.repos.push({ owner, name, nodeId: r.node_id, defaultBranch: r.default_branch });
  }
  server = createServer((req, res) => {
    void (async () => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    // Unauthenticated and outside the token gate below: this is the harness
    // itself asking what was recorded, not a call GitHub would ever receive.
    if (url.pathname === '/__e2e/pulls') {
      json(res, 200, recordedPulls());
      return;
    }

    // `Bearer` from the server's REST client, `token` (GitHub's other form)
    // from the egress proxy.
    const auth = req.headers.authorization ?? '';
    const token = auth.replace(/^(?:Bearer|token) /, '');
    if (token !== VALID_TOKEN && token !== METADATA_ONLY_TOKEN) {
      json(res, 401, { message: 'Bad credentials' });
      return;
    }
    const metadataOnly = token === METADATA_ONLY_TOKEN;
    /** GitHub's own wording for a fine-grained token that may not do this. */
    const forbidden = { message: 'Resource not accessible by personal access token' };

    if (url.pathname === '/graphql' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req)) as { query?: string; variables?: Record<string, unknown> };
      json(res, 200, gh.answer(body));
      return;
    }
    // A pull request by number — the egress proxy's own lookup, before it
    // lets an edit to one through.
    const pullRest = /^\/repos\/[^/]+\/[^/]+\/pulls\/\d+$/.test(url.pathname) ? gh.rest(req.method ?? 'GET', url.pathname) : null;
    if (pullRest) {
      json(res, pullRest.status, pullRest.body);
      return;
    }

    if (url.pathname === '/user') {
      // The header is the whole point of the split: a fine-grained token sends
      // none, which is what makes the connection screen's scope line vanish.
      if (metadataOnly) {
        json(res, 200, { login: 'e2e-fine', name: 'E2E Fine-grained', email: 'e2e-fine@example.test' });
        return;
      }
      json(res, 200, { login: 'e2e-bot', name: 'E2E Bot', email: 'e2e-bot@example.test' }, { 'x-oauth-scopes': 'repo' });
      return;
    }
    if (url.pathname === '/user/repos') {
      json(res, 200, REPOS);
      return;
    }
    const repoMatch = /^\/repos\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (repoMatch) {
      const fullName = `${repoMatch[1]}/${repoMatch[2]}`;
      const repo = REPOS.find((r) => r.full_name === fullName);
      if (!repo) { json(res, 404, { message: 'Not Found' }); return; }
      json(res, 200, repo);
      return;
    }
    const branchesMatch = /^\/repos\/([^/]+)\/([^/]+)\/branches$/.exec(url.pathname);
    if (branchesMatch) {
      if (metadataOnly) { json(res, 403, forbidden); return; }
      const fullName = `${branchesMatch[1]}/${branchesMatch[2]}`;
      const names = BRANCHES.get(fullName);
      if (!names) { json(res, 404, { message: 'Not Found' }); return; }
      json(res, 200, names.map((name) => ({ name })));
      return;
    }
    // One branch. Gated on `Contents: read` exactly as the list above is, and
    // served because the server's workspace pre-flight asks for it before
    // anything is cloned — without this route every GitHub-workspace spec
    // would be refused for a base branch the fixture does have. The trailing
    // capture is greedy on purpose: branch names contain slashes.
    // GET /repos/:owner/:repo/contents/:path with the raw media type — how
    // the server reads a workspace's AGENTS.md before anything is cloned.
    const contentsMatch = /^\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/.exec(url.pathname);
    if (contentsMatch) {
      if (metadataOnly) { json(res, 403, forbidden); return; }
      const dir = opts?.fixtureDirFor?.(contentsMatch[2]);
      const rel = decodeURIComponent(contentsMatch[3]);
      const file = dir ? path.resolve(dir, rel) : null;
      // A directory is listed in JSON, whatever was asked for — how the server
      // finds a repository's skills before anything is cloned.
      if (dir && file?.startsWith(`${path.resolve(dir)}${path.sep}`) && existsSync(file) && statSync(file).isDirectory()) {
        json(res, 200, readdirSync(file, { withFileTypes: true }).map((e) => ({
          name: e.name,
          path: `${rel}/${e.name}`,
          type: e.isDirectory() ? 'dir' : 'file',
        })));
        return;
      }
      if (!dir || !file?.startsWith(`${path.resolve(dir)}${path.sep}`) || !existsSync(file) || !statSync(file).isFile()) {
        json(res, 404, { message: 'Not Found' });
        return;
      }
      res.writeHead(200, { 'content-type': 'application/vnd.github.raw' });
      res.end(readFileSync(file));
      return;
    }
    const branchMatch = /^\/repos\/([^/]+)\/([^/]+)\/branches\/(.+)$/.exec(url.pathname);
    if (branchMatch) {
      if (metadataOnly) { json(res, 403, forbidden); return; }
      const fullName = `${branchMatch[1]}/${branchMatch[2]}`;
      const wanted = decodeURIComponent(branchMatch[3]);
      const names = BRANCHES.get(fullName);
      if (!names?.includes(wanted)) { json(res, 404, { message: 'Branch not found' }); return; }
      json(res, 200, { name: wanted });
      return;
    }
    json(res, 404, { message: 'not found in e2e github fixture' });
    })();
  });

  await new Promise<void>((resolve) => { server?.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('[e2e] mock github server has no port');
  const url = `http://127.0.0.1:${String(address.port)}`;

  return {
    url,
    stop: () =>
      new Promise<void>((resolve) => {
        server?.close(() => { resolve(); });
        server = null;
      }),
  };
}
