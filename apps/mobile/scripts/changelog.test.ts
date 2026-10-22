import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildChangelog,
  githubRepoUrl,
  orderReleases,
  parseCommit,
  parseLog,
  planReleases,
  writeChangelog,
} from './changelog.cjs';

const commit = (subject: string, body = '', author = 'Casey Gibson', sha = 'a'.repeat(40)) => ({ sha, author, subject, body });
const tags = (...names: string[]) => names.map((tag) => ({ tag, date: '2026-10-01' }));

describe('parseCommit', () => {
  it('reads a squash merge that closes an issue: the last ref is the PR, the one before it the ticket', () => {
    expect(parseCommit(commit('Rewind and retry, with file checkpoints (#166) (#276)'))).toEqual({
      sha: 'a'.repeat(40),
      title: 'Rewind and retry, with file checkpoints',
      tickets: [166],
      pr: 276,
    });
  });

  it('reads a squash merge with only its PR as no ticket', () => {
    expect(parseCommit(commit('Remove the built-in GitHub MCP server (#290)'))).toMatchObject({
      title: 'Remove the built-in GitHub MCP server',
      tickets: [],
      pr: 290,
    });
  });

  it('keeps a subject with no refs whole', () => {
    expect(parseCommit(commit('Fix a typo'))).toMatchObject({ title: 'Fix a typo', tickets: [], pr: null });
  });

  it('counts a ref inside the subject as a ticket, and leaves it in the title', () => {
    expect(parseCommit(commit('Stage 7 (#22): tool-capable chat — server wiring'))).toMatchObject({
      title: 'Stage 7 (#22): tool-capable chat — server wiring',
      tickets: [22],
      pr: null,
    });
  });

  it('titles a GitHub merge commit with its PR title from the body', () => {
    expect(parseCommit(commit('Merge pull request #72 from CyberCyclone/e2e-native-fixes', '\nNative e2e fixes\n\nmore'))).toMatchObject({
      title: 'Native e2e fixes',
      tickets: [],
      pr: 72,
    });
  });

  it('adds tickets a closing keyword names in the body, once each, and never the PR itself', () => {
    const body = '* Fix it\n\nFixes #12. Also closes #13, resolves #12 and see #99.\nCloses #300';
    expect(parseCommit(commit('Fix the thing (#12) (#300)', body)).tickets).toEqual([12, 13]);
  });

  it('does not count a bare #N in prose as a ticket', () => {
    expect(parseCommit(commit('Tidy (#5)', 'Like we did in #4.')).tickets).toEqual([]);
  });
});

describe('orderReleases / planReleases', () => {
  it('orders by semver with a stable release after its own betas, and drops other tags', () => {
    const ordered = orderReleases(tags('v0.0.1-beta.2', 'v0.0.10-beta.1', 'v0.0.1', 'nightly', 'v0.0.1-beta.10', 'v0.0.2-alpha.1'));
    expect(ordered.map((t) => t.tag)).toEqual(['v0.0.10-beta.1', 'v0.0.1', 'v0.0.1-beta.10', 'v0.0.1-beta.2']);
  });

  it('starts a beta at the tag before it, of either kind, and a stable at the previous stable', () => {
    const plan = planReleases(tags('v0.0.1-beta.1', 'v0.0.1-beta.2', 'v0.0.1', 'v0.0.2-beta.1', 'v0.0.2-beta.2', 'v0.0.2'));
    expect(plan.map((r) => [r.tag, r.since])).toEqual([
      ['v0.0.2', 'v0.0.1'],
      ['v0.0.2-beta.2', 'v0.0.2-beta.1'],
      ['v0.0.2-beta.1', 'v0.0.1'],
      ['v0.0.1', null],
      ['v0.0.1-beta.2', 'v0.0.1-beta.1'],
      ['v0.0.1-beta.1', null],
    ]);
  });
});

describe('buildChangelog', () => {
  it('drops dependency bumps and branch-into-branch merges, and keeps PR merges', () => {
    const built = buildChangelog({
      repoUrl: null,
      unreleased: [
        commit('Bump the actions group with 5 updates (#221)', '', 'dependabot[bot]'),
        commit("Merge branch 'dev' into feature"),
        commit('Merge origin/master into 22-mcp-integration'),
        commit('Merge pull request #72 from CyberCyclone/x', 'Native fixes'),
        commit('Real change (#9)'),
      ],
      releases: [{ tag: 'v0.0.1', date: '2026-10-01', commits: [commit('Bump x (#1)', '', 'dependabot[bot]')] }],
    });
    expect(built.unreleased.map((e) => e.title)).toEqual(['Native fixes', 'Real change']);
    expect(built.releases).toEqual([{ tag: 'v0.0.1', date: '2026-10-01', entries: [] }]);
    expect(built.available).toBe(true);
  });
});

describe('githubRepoUrl', () => {
  it('reads every spelling of a GitHub remote, dropping credentials', () => {
    for (const remote of [
      'git@github.com:CyberCyclone/Loxaic.git',
      'https://github.com/CyberCyclone/Loxaic.git',
      'https://github.com/CyberCyclone/Loxaic',
      'ssh://git@github.com/CyberCyclone/Loxaic.git',
      'https://x-access-token:secret@github.com/CyberCyclone/Loxaic.git\n',
    ]) {
      expect(githubRepoUrl(remote)).toBe('https://github.com/CyberCyclone/Loxaic');
    }
  });

  it('gives null for anything that is not GitHub', () => {
    expect(githubRepoUrl('https://gitlab.com/a/b.git')).toBeNull();
    expect(githubRepoUrl('/srv/git/loxaic.git')).toBeNull();
  });
});

describe('parseLog', () => {
  it('splits records and fields, with bodies that span lines', () => {
    const raw = `a\x1fCasey\x1fOne (#1)\x1fline 1\nline 2\n\x1e\nb\x1fdependabot[bot]\x1fTwo\x1f\x1e\n`;
    expect(parseLog(raw)).toEqual([
      { sha: 'a', author: 'Casey', subject: 'One (#1)', body: 'line 1\nline 2\n' },
      { sha: 'b', author: 'dependabot[bot]', subject: 'Two', body: '' },
    ]);
  });
});

describe('writeChangelog against a real repository', () => {
  const dirs: string[] = [];
  const temp = () => {
    const d = mkdtempSync(path.join(tmpdir(), 'changelog-'));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      // Hermetic: no signing or default branch from the developer's own config.
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Casey', GIT_AUTHOR_EMAIL: 'c@x', GIT_COMMITTER_NAME: 'Casey', GIT_COMMITTER_EMAIL: 'c@x' },
    });
  const commitIn = (cwd: string, subject: string) => git(cwd, 'commit', '--allow-empty', '-q', '-m', subject);
  const read = (file: string) => JSON.parse(readFileSync(file, 'utf8')) as {
    available: boolean;
    repoUrl: string | null;
    unreleased: { title: string }[];
    releases: { tag: string; entries: { title: string }[] }[];
  };

  function repo() {
    const cwd = temp();
    git(cwd, 'init', '-q', '-b', 'dev');
    git(cwd, 'remote', 'add', 'origin', 'git@github.com:CyberCyclone/Loxaic.git');
    commitIn(cwd, 'First (#1)');
    git(cwd, 'tag', '-a', 'v0.0.1-beta.1', '-m', 'v0.0.1-beta.1');
    commitIn(cwd, 'Second (#10) (#2)');
    git(cwd, 'tag', '-a', 'v0.0.1-beta.2', '-m', 'v0.0.1-beta.2');
    git(cwd, 'tag', '-a', 'v0.0.1', '-m', 'v0.0.1');
    commitIn(cwd, 'Third (#3)');
    git(cwd, 'tag', 'not-a-release');
    return cwd;
  }

  it('writes each release with its own range, a stable aggregating its betas, and what is on top of the newest tag', () => {
    const cwd = repo();
    const out = path.join(temp(), 'changelog.json');
    expect(writeChangelog({ cwd, outFile: out })).toBe('written');
    const c = read(out);
    expect(c.available).toBe(true);
    expect(c.repoUrl).toBe('https://github.com/CyberCyclone/Loxaic');
    expect(c.unreleased.map((e) => e.title)).toEqual(['Third']);
    expect(c.releases.map((r) => [r.tag, r.entries.map((e) => e.title)])).toEqual([
      ['v0.0.1', ['Second', 'First']],
      ['v0.0.1-beta.2', ['Second']],
      ['v0.0.1-beta.1', ['First']],
    ]);
    expect(writeChangelog({ cwd, outFile: out })).toBe('unchanged');
  });

  it('leaves out tags HEAD has not reached', () => {
    const cwd = repo();
    git(cwd, 'checkout', '-q', 'v0.0.1-beta.1');
    const out = path.join(temp(), 'changelog.json');
    writeChangelog({ cwd, outFile: out });
    const c = read(out);
    expect(c.releases.map((r) => r.tag)).toEqual(['v0.0.1-beta.1']);
    expect(c.unreleased).toEqual([]);
  });

  it('keeps an existing file when the history cannot be read, and with none says the build has no changelog', () => {
    const notARepo = temp();
    const out = path.join(temp(), 'changelog.json');
    expect(writeChangelog({ cwd: notARepo, outFile: out })).toBe('unavailable');
    expect(read(out)).toEqual({ available: false });

    writeFileSync(out, '{"available":true,"repoUrl":null,"releases":[],"unreleased":[]}\n');
    expect(writeChangelog({ cwd: notARepo, outFile: out })).toBe('kept');
    expect(read(out).available).toBe(true);
  });

  it('treats a shallow clone as history it cannot read', () => {
    const source = repo();
    const shallow = path.join(temp(), 'clone');
    git(temp(), 'clone', '-q', '--depth', '1', `file://${source}`, shallow);
    const out = path.join(temp(), 'changelog.json');
    expect(writeChangelog({ cwd: shallow, outFile: out })).toBe('unavailable');
    expect(existsSync(out)).toBe(true);
    expect(read(out)).toEqual({ available: false });
  });
});
