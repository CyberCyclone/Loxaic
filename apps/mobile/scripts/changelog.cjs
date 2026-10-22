/**
 * The changelog Settings shows, written from git history each time Metro
 * bundles the app (metro.config.js calls `writeChangelog`).
 *
 * Built at bundle time because nothing that ships has git: the server payload
 * is pruned to `dist`, Docker leaves out `.git`, and a phone never had it. Every
 * way the app is bundled — a web export, an OTA update, Electron's `build:web`,
 * a dev session — runs Metro, so the list always matches the bundle it is in.
 * Not `app.config.js` `extra`: the app config feeds the runtime fingerprint, so
 * a changelog there would force a new native build on every release.
 *
 * CommonJS because metro.config.js `require`s it, on whatever Node an EAS build
 * server runs. Everything but `writeChangelog` is a pure function of its input.
 */
'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const OUT_FILE = path.resolve(__dirname, '../lib/changelog.generated.json');

// The same shape as apps/desktop/scripts/stamp-version.mjs's TAG_PATTERN; keep
// them in step. That file is ESM, which an older Node cannot require.
const TAG_PATTERN = /^v(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/;

const DEPENDABOT = 'dependabot[bot]';

/**
 * Release tags newest first, by semver with a stable release after its own
 * betas — the order apps/desktop/scripts/next-tag.mjs's `orderTags` uses.
 * Anything that is not a release tag of ours is dropped.
 *
 * @param {{ tag: string, date: string }[]} tags
 * @returns {{ tag: string, date: string, prerelease: boolean }[]}
 */
function orderReleases(tags) {
  return tags
    .map((t) => {
      const m = TAG_PATTERN.exec(t.tag);
      if (!m) return null;
      const [major, minor, patch] = [m[1], m[2], m[3]].map(Number);
      const prerelease = m[4] !== undefined;
      return { ...t, prerelease, key: [major, minor, patch, prerelease ? 0 : 1, prerelease ? Number(m[4]) : 0] };
    })
    .filter((t) => t !== null)
    .sort((a, b) => {
      for (let i = 0; i < a.key.length; i++) {
        if (a.key[i] !== b.key[i]) return b.key[i] - a.key[i];
      }
      return 0;
    })
    .map(({ key: _key, ...t }) => t);
}

/**
 * The commit range each release covers, newest first. A beta covers everything
 * since the tag before it, of either kind; a stable release covers everything
 * since the previous stable release, so all of its betas, because a stable tag
 * is usually promoted from the last beta's commit and has nothing of its own.
 * `since: null` is the start of history.
 *
 * @param {{ tag: string, date: string }[]} tags
 * @returns {{ tag: string, date: string, since: string | null }[]}
 */
function planReleases(tags) {
  const ordered = orderReleases(tags);
  return ordered.map((release, i) => {
    const older = ordered.slice(i + 1);
    const previous = release.prerelease ? older[0] : older.find((t) => !t.prerelease);
    return { tag: release.tag, date: release.date, since: previous ? previous.tag : null };
  });
}

const TRAILING_REFS = /(?:\s*\(#\d+\))+\s*$/;
const INLINE_REF = /\(#(\d+)\)/g;
const MERGE_PR = /^Merge pull request #(\d+) from \S+/;
// A merge of one branch into another (`Merge origin/master into 22-mcp`,
// `Merge branch 'dev'`), from before PRs were squashed: it says nothing a user
// would read, and what it merged is listed on its own.
const BRANCH_MERGE = /^Merge (?!pull request #\d+ from )/;
const CLOSING = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi;

/**
 * One commit as a changelog entry. A squash merge's subject ends in the PR
 * number, after the issue it closes when there is one: `Title (#310) (#311)`.
 * So the last trailing `(#N)` is the PR and any before it are tickets, as is
 * a `(#N)` inside the subject (`Stage 7 (#22): server wiring`). A closing keyword in the body (`Fixes #12`) names a ticket too; a bare `#12`
 * in prose does not, since squash bodies mention other work freely.
 *
 * @param {{ sha: string, subject: string, body: string }} commit
 * @returns {{ sha: string, title: string, tickets: number[], pr: number | null }}
 */
function parseCommit({ sha, subject, body }) {
  let title = subject.trim();
  let pr = null;
  const tickets = [];

  const merge = MERGE_PR.exec(title);
  if (merge) {
    pr = Number(merge[1]);
    const firstLine = body.split('\n').map((l) => l.trim()).find((l) => l !== '');
    title = firstLine ?? title;
  } else {
    const refs = TRAILING_REFS.exec(title);
    if (refs) {
      const numbers = [...refs[0].matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
      pr = numbers.pop() ?? null;
      tickets.push(...numbers);
      title = title.slice(0, refs.index).trim();
    }
    for (const m of title.matchAll(INLINE_REF)) tickets.push(Number(m[1]));
  }

  for (const m of body.matchAll(CLOSING)) tickets.push(Number(m[1]));
  const unique = [...new Set(tickets)].filter((n) => n !== pr);
  return { sha, title, tickets: unique, pr };
}

/** Dependency bumps and branch-into-branch merges are not news to a user.
 * @param {{ author: string, subject: string }} commit */
function isShown(commit) {
  return commit.author !== DEPENDABOT && !BRANCH_MERGE.test(commit.subject);
}

/**
 * @param {{ sha: string, author: string, subject: string, body: string }[]} commits
 */
function toEntries(commits) {
  return commits.filter(isShown).map(parseCommit);
}

/**
 * The file the app reads: releases newest first, then whatever HEAD has on top
 * of the newest tag (nothing, in a release build, which is built at its tag).
 *
 * @param {{
 *   repoUrl: string | null,
 *   releases: { tag: string, date: string, commits: Parameters<typeof toEntries>[0] }[],
 *   unreleased: Parameters<typeof toEntries>[0],
 * }} input
 */
function buildChangelog({ repoUrl, releases, unreleased }) {
  return {
    available: true,
    repoUrl,
    unreleased: toEntries(unreleased),
    releases: releases.map((r) => ({ tag: r.tag, date: r.date, entries: toEntries(r.commits) })),
  };
}

/**
 * `https://github.com/owner/repo` for a GitHub remote in any of its spellings,
 * credentials dropped; null for anything else, so the app shows tickets and
 * commits without links rather than links to the wrong place.
 *
 * @param {string} remote
 * @returns {string | null}
 */
function githubRepoUrl(remote) {
  const m = /github\.com[:/]+([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(remote.trim());
  return m ? `https://github.com/${m[1]}/${m[2]}` : null;
}

const FIELD = '\x1f';
const RECORD = '\x1e';

/** @param {string} raw */
function parseLog(raw) {
  return raw
    .split(RECORD)
    .map((r) => r.replace(/^\n/, ''))
    .filter((r) => r !== '')
    .map((r) => {
      const [sha = '', author = '', subject = '', body = ''] = r.split(FIELD);
      return { sha, author, subject, body };
    });
}

/**
 * @param {string} cwd
 * @param {string[]} args
 */
function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
}

/**
 * Reads the changelog out of the repository at `cwd`, or returns null when the
 * history is not there to read: no git (a Docker build), not a repository, or
 * a shallow clone (an EAS build server, a default CI checkout), whose ranges
 * would silently stop at the clone's depth.
 *
 * @param {string} cwd
 */
function readChangelog(cwd) {
  try {
    if (git(cwd, ['rev-parse', '--is-shallow-repository']).trim() !== 'false') return null;
  } catch {
    return null;
  }

  const log = (range) =>
    parseLog(git(cwd, ['log', '--first-parent', `--format=%H${FIELD}%an${FIELD}%s${FIELD}%b${RECORD}`, range]));

  const tags = git(cwd, ['for-each-ref', '--merged=HEAD', '--format=%(refname:short)%09%(creatordate:short)', 'refs/tags'])
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => {
      const [tag = '', date = ''] = l.split('\t');
      return { tag, date };
    });
  const plan = planReleases(tags);

  let repoUrl = null;
  try {
    repoUrl = githubRepoUrl(git(cwd, ['remote', 'get-url', 'origin']));
  } catch {
    // No origin: entries show without links.
  }

  return buildChangelog({
    repoUrl,
    releases: plan.map((r) => ({ tag: r.tag, date: r.date, commits: log(r.since ? `${r.since}..${r.tag}` : r.tag) })),
    unreleased: log(plan[0] ? `${plan[0].tag}..HEAD` : 'HEAD'),
  });
}

/**
 * Writes the changelog for the repository at `cwd` to `outFile`. When the
 * history cannot be read, an existing file is kept (a Docker build copies the
 * one the checkout last bundled with), and with none the app is told there is
 * no changelog in this build rather than shown an empty one.
 *
 * @param {{ cwd?: string, outFile?: string }} [options]
 * @returns {'written' | 'unchanged' | 'kept' | 'unavailable'}
 */
function writeChangelog({ cwd = __dirname, outFile = OUT_FILE } = {}) {
  const changelog = readChangelog(cwd);
  if (!changelog) {
    if (fs.existsSync(outFile)) return 'kept';
    fs.writeFileSync(outFile, `${JSON.stringify({ available: false })}\n`);
    return 'unavailable';
  }
  const text = `${JSON.stringify(changelog)}\n`;
  // Unchanged is left alone, so Metro's watcher has nothing to re-bundle.
  if (fs.existsSync(outFile) && fs.readFileSync(outFile, 'utf8') === text) return 'unchanged';
  fs.writeFileSync(outFile, text);
  return 'written';
}

module.exports = {
  OUT_FILE,
  buildChangelog,
  githubRepoUrl,
  orderReleases,
  parseCommit,
  parseLog,
  planReleases,
  writeChangelog,
};

if (require.main === module) {
  console.log(`[changelog] ${writeChangelog()}: ${OUT_FILE}`);
}
