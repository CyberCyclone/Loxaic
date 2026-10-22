/**
 * The changelog bundled with this build: what each release changed, from its
 * commit messages. `scripts/changelog.cjs` writes it from git history when
 * Metro bundles the app; nothing is asked of the server, so it reads the same
 * offline.
 */

export interface ChangeEntry {
  sha: string;
  title: string;
  /** Issues the change refers to; empty when it names none. */
  tickets: number[];
  pr: number | null;
}

export interface Release {
  tag: string;
  /** YYYY-MM-DD, the day the tag was made. */
  date: string;
  entries: ChangeEntry[];
}

export interface Changelog {
  /** `https://github.com/owner/repo`, or null when the build's origin is not GitHub. */
  repoUrl: string | null;
  /** Newest first. */
  releases: Release[];
  /** Commits on top of the newest tag; empty in a release build. */
  unreleased: ChangeEntry[];
}

/** Characters of a commit hash shown, as `git log --oneline` does. */
export const SHORT_SHA = 7;

/**
 * The generated file, checked rather than trusted: a build whose history could
 * not be read carries `{ available: false }`, and an older or hand-edited file
 * is treated the same rather than crashing the modal. Null means "this build
 * has no changelog".
 */
export function parseChangelog(raw: unknown): Changelog | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const c = raw as Partial<Changelog> & { available?: unknown };
  if (c.available !== true || !Array.isArray(c.releases) || !Array.isArray(c.unreleased)) return null;
  return {
    repoUrl: typeof c.repoUrl === 'string' && c.repoUrl.startsWith('https://') ? c.repoUrl : null,
    releases: c.releases,
    unreleased: c.unreleased,
  };
}

export function ticketUrl(repoUrl: string | null, n: number): string | null {
  return repoUrl ? `${repoUrl}/issues/${String(n)}` : null;
}

export function commitUrl(repoUrl: string | null, sha: string): string | null {
  return repoUrl ? `${repoUrl}/commit/${sha}` : null;
}

export function loadChangelog(): Changelog | null {
  // `require`, not `import`: the file is gitignored and written by
  // metro.config.js, so it is always there for Metro but not for `tsc` or a
  // unit test in a fresh checkout. Read lazily, and only by the modal.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return parseChangelog(require('./changelog.generated.json') as unknown);
}
