/**
 * A git server the e2e harness runs itself, so a spec can clone (and, in a
 * later stage, push to) a repository without any of it reaching the real
 * GitHub.
 *
 * Each fixture directory becomes a bare repository with one commit on `main`,
 * served over the `git://` protocol by `git daemon`. Sandboxes reach it as
 * `host.docker.internal` — resolved by Docker Desktop on its own, and by the
 * `SANDBOX_EXTRA_HOSTS=host.docker.internal:host-gateway` entry standup.ts
 * passes to the server for Linux and Podman. The mock GitHub API
 * (mock-github.ts) hands out these URLs as each repo's `clone_url`, so the
 * server's ordinary workspace path — look the repo up, clone what GitHub
 * says — is exercised end to end with nothing stubbed on the server side.
 *
 * `git://` rather than smart HTTP because it is what ships with git on every
 * platform and needs no CGI wrapper; the credential helper is never consulted
 * for it, which is fine — the token's *absence from disk* is asserted by the
 * server's own unit tests, and what this proves is the clone itself.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import path from 'node:path';

export interface GitServer {
  /** What a sandbox uses to reach a repo: `git://host.docker.internal:<port>`. */
  baseUrl: string;
  /** Where the bare repositories live, for harness-side assertions such as
   * `git --git-dir <dir>/<name>.git log <branch>`. */
  dir: string;
  cloneUrlFor: (name: string) => string;
  stop: () => void;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => { resolve(port); });
    });
  });
}

/**
 * Turns `fixtureDir` into `<dir>/<name>.git` with a single commit on `main`.
 * Rebuilt from scratch every stand-up: a stale bare repo would carry pushes
 * from a previous run into this one.
 */
function bareRepoFrom(fixtureDir: string, dir: string, name: string): void {
  const work = path.join(dir, `${name}.work`);
  const bare = path.join(dir, `${name}.git`);
  rmSync(work, { recursive: true, force: true });
  rmSync(bare, { recursive: true, force: true });
  execFileSync('cp', ['-R', fixtureDir, work]);
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'e2e',
    GIT_AUTHOR_EMAIL: 'e2e@example.test',
    GIT_COMMITTER_NAME: 'e2e',
    GIT_COMMITTER_EMAIL: 'e2e@example.test',
  };
  execFileSync('git', ['init', '-q', '-b', 'main', work], { env });
  execFileSync('git', ['-C', work, 'add', '-A'], { env });
  execFileSync('git', ['-C', work, 'commit', '-q', '-m', `fixture: ${name}`], { env });
  execFileSync('git', ['clone', '-q', '--bare', work, bare], { env });
  rmSync(work, { recursive: true, force: true });
}

export async function startGitServer(opts: {
  dir: string;
  fixtures: Record<string, string>;
  /** The hostname a *sandbox* uses to reach this machine. */
  host?: string;
}): Promise<GitServer> {
  mkdirSync(opts.dir, { recursive: true });
  for (const [name, fixtureDir] of Object.entries(opts.fixtures)) {
    bareRepoFrom(fixtureDir, opts.dir, name);
  }

  const port = await freePort();
  const host = opts.host ?? process.env.E2E_GIT_HOST ?? 'host.docker.internal';
  const child: ChildProcess = spawn(
    'git',
    [
      'daemon',
      `--base-path=${opts.dir}`,
      '--export-all',
      // Pushes, for the git-actions stage. Off by default in git daemon.
      '--enable=receive-pack',
      '--reuseaddr',
      '--listen=0.0.0.0',
      `--port=${String(port)}`,
      opts.dir,
    ],
    { stdio: 'ignore' },
  );

  // git daemon prints nothing on success and there is no handshake line, so
  // readiness is "the port answers" — probed rather than assumed.
  const deadline = Date.now() + 10_000;
  for (;;) {
    const up = await new Promise<boolean>((resolve) => {
      const c = createConnection({ host: '127.0.0.1', port }, () => { c.end(); resolve(true); });
      c.on('error', () => { resolve(false); });
    });
    if (up) break;
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(`[e2e] git daemon did not start listening on ${String(port)}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  const baseUrl = `git://${host}:${String(port)}`;
  return {
    baseUrl,
    dir: opts.dir,
    cloneUrlFor: (name) => `${baseUrl}/${name}.git`,
    stop: () => { child.kill(); },
  };
}
