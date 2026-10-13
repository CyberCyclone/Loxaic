/**
 * A git server the e2e harness runs itself, standing in for github.com, so a
 * spec can clone and push without any of it reaching the real GitHub.
 *
 * Each fixture directory becomes a bare repository `e2e/<name>` with one
 * commit on `main`, served over smart HTTP (`git http-backend`, the server's
 * own test fixture) — the transport github.com speaks. The spawned server is
 * pointed at it with `GITHUB_WEB_URL`, so a workspace's `clone_url` is the
 * real `https://github.com/e2e/<name>.git` and every clone and push goes
 * through Loxaic's egress proxy, which reaches this server on loopback.
 * Sandboxes never reach it directly.
 *
 * It refuses any request without `VALID_TOKEN` as git's Basic credential,
 * which is what the proxy adds and the sandbox never holds — so a clone that
 * works at all proves the proxy put the token there.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { startGitHttpServer } from '../../server/src/egress/__tests__/git-http-server.ts';
import { VALID_TOKEN } from './mock-github.ts';

export interface GitServer {
  /** github.com, as far as the server's egress proxy knows (GITHUB_WEB_URL). */
  webUrl: string;
  /** Where the bare repositories live: `<dir>/e2e/<name>.git`, for
   * harness-side assertions such as `git --git-dir … log <branch>`. */
  dir: string;
  /** The clone URL GitHub reports for a repository. */
  cloneUrlFor: (name: string) => string;
  stop: () => Promise<void>;
}

/** The bare repository behind `e2e/<name>`. */
export function bareRepoDir(dir: string, name: string): string {
  return path.join(dir, 'e2e', `${name}.git`);
}

/**
 * Turns `fixtureDir` into `<dir>/<name>.git` with a single commit on `main`.
 * Rebuilt from scratch every stand-up: a stale bare repo would carry pushes
 * from a previous run into this one.
 */
function bareRepoFrom(fixtureDir: string, dir: string, name: string): void {
  const work = path.join(dir, `${name}.work`);
  const bare = bareRepoDir(dir, name);
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
}): Promise<GitServer> {
  mkdirSync(path.join(opts.dir, 'e2e'), { recursive: true });
  for (const [name, fixtureDir] of Object.entries(opts.fixtures)) {
    bareRepoFrom(fixtureDir, opts.dir, name);
  }
  // Loopback only: the egress proxy runs on this machine, and nothing else
  // should be able to write to the fixtures.
  const server = await startGitHttpServer({ root: opts.dir, token: VALID_TOKEN, host: '127.0.0.1' });
  return {
    webUrl: server.url,
    dir: opts.dir,
    cloneUrlFor: (name) => `https://github.com/e2e/${name}.git`,
    stop: () => server.close(),
  };
}
