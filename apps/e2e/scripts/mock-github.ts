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
 * `/user/repos`, `/repos/:owner/:repo`, and `/repos/:owner/:repo/branches` to
 * exercise every route `apps/server/src/routes/github.ts` calls. One fixed
 * token ("e2e-github-token") is "valid"; anything else 401s, matching a real
 * bad-credential response closely enough for the client's error handling to
 * be exercised honestly.
 */
import { createServer, type Server } from 'node:http';
import type { IncomingMessage } from 'node:http';

export const VALID_TOKEN = 'e2e-github-token';

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

/** Every PR the mock has "opened", in call order. Module-scoped: a fresh
 * server per stand-up starts empty, and a spec reads this back through
 * `GET /__e2e/pulls` to confirm a push through the Inspector's panel reached
 * (the fixture standing in for) GitHub with the right head and base — proof
 * independent of whatever the UI claims happened. */
let pulls: RecordedPull[] = [];

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
  return [
    { id: 1, full_name: 'e2e/bugfix-app', private: false, default_branch: 'main', clone_url: cloneUrlFor('bugfix-app') },
    { id: 2, full_name: 'e2e/other-repo', private: true, default_branch: 'trunk', clone_url: cloneUrlFor('other-repo') },
  ];
}

const BRANCHES = new Map<string, string[]>([
  ['e2e/bugfix-app', ['main', 'feature/one']],
  ['e2e/other-repo', ['trunk']],
]);

function json(res: import('node:http').ServerResponse, status: number, body: unknown, headers?: Record<string, string>): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

let server: Server | null = null;

export async function startMockGithub(opts?: {
  cloneUrlFor?: (name: string) => string;
}): Promise<{ url: string; stop: () => Promise<void> }> {
  pulls = [];
  const REPOS = repos(opts?.cloneUrlFor ?? ((name) => `https://example.test/e2e/${name}.git`));
  server = createServer((req, res) => {
    void (async () => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    // Unauthenticated and outside the token gate below: this is the harness
    // itself asking what was recorded, not a call GitHub would ever receive.
    if (url.pathname === '/__e2e/pulls') {
      json(res, 200, pulls);
      return;
    }

    const auth = req.headers.authorization ?? '';
    const token = auth.replace(/^Bearer /, '');
    if (token !== VALID_TOKEN) {
      json(res, 401, { message: 'Bad credentials' });
      return;
    }

    const pullsMatch = /^\/repos\/([^/]+)\/([^/]+)\/pulls$/.exec(url.pathname);
    if (pullsMatch && req.method === 'POST') {
      const owner = pullsMatch[1];
      const repo = pullsMatch[2];
      const raw = await readBody(req);
      const input = JSON.parse(raw) as { head: string; base: string; title: string; body?: string };
      const number = pulls.length + 1;
      const pull: RecordedPull = {
        number,
        html_url: `https://github.example/${owner}/${repo}/pull/${String(number)}`,
        owner, repo, head: input.head, base: input.base, title: input.title, body: input.body,
      };
      pulls.push(pull);
      json(res, 201, { number: pull.number, html_url: pull.html_url });
      return;
    }

    if (url.pathname === '/user') {
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
      const fullName = `${branchesMatch[1]}/${branchesMatch[2]}`;
      const names = BRANCHES.get(fullName);
      if (!names) { json(res, 404, { message: 'Not Found' }); return; }
      json(res, 200, names.map((name) => ({ name })));
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
