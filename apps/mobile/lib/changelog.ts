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
 * The generated file, checked rather than trusted, all the way down: a build
 * whose history could not be read carries `{ available: false }`, and an older
 * or hand-edited file — an entry without `tickets`, a release without
 * `entries` — is treated the same rather than crashing the modal. Null means
 * "this build has no changelog".
 */
export function parseChangelog(raw: unknown): Changelog | null {
  if (!isRecord(raw) || raw.available !== true) return null;
  const { releases, unreleased, repoUrl } = raw;
  if (!Array.isArray(releases) || !releases.every(isRelease)) return null;
  if (!Array.isArray(unreleased) || !unreleased.every(isEntry)) return null;
  return {
    repoUrl: typeof repoUrl === 'string' && repoUrl.startsWith('https://') ? repoUrl : null,
    releases,
    unreleased,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isTicket(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

function isEntry(v: unknown): v is ChangeEntry {
  return (
    isRecord(v) &&
    typeof v.sha === 'string' &&
    /^[0-9a-f]{7,64}$/.test(v.sha) &&
    typeof v.title === 'string' &&
    Array.isArray(v.tickets) &&
    v.tickets.every(isTicket) &&
    (v.pr === null || isTicket(v.pr))
  );
}

function isRelease(v: unknown): v is Release {
  return (
    isRecord(v) &&
    typeof v.tag === 'string' &&
    typeof v.date === 'string' &&
    Array.isArray(v.entries) &&
    v.entries.every(isEntry)
  );
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
  // unit test in a fresh checkout. Called by the modal on its first opening,
  // not at launch: Metro runs a module's code on its first require.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return parseChangelog(require('./changelog.generated.json') as unknown);
}
