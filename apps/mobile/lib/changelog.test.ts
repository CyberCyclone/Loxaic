import { describe, expect, it } from 'vitest';
import { commitUrl, parseChangelog, ticketUrl } from './changelog';

const REPO = 'https://github.com/CyberCyclone/Loxaic';

describe('parseChangelog', () => {
  it('reads a generated changelog', () => {
    const raw = { available: true, repoUrl: REPO, unreleased: [], releases: [{ tag: 'v1.0.0', date: '2026-10-01', entries: [] }] };
    expect(parseChangelog(raw)).toEqual({ repoUrl: REPO, unreleased: [], releases: raw.releases });
  });

  it('calls a build whose history could not be read one with no changelog', () => {
    expect(parseChangelog({ available: false })).toBeNull();
  });

  it('calls anything malformed no changelog rather than crashing', () => {
    expect(parseChangelog(null)).toBeNull();
    expect(parseChangelog('nope')).toBeNull();
    expect(parseChangelog({ available: true, releases: {} , unreleased: [] })).toBeNull();
    expect(parseChangelog({ available: true, releases: [] })).toBeNull();
  });

  it('calls a file with a malformed entry or release no changelog, so the modal never reads one', () => {
    const entry = { sha: 'a'.repeat(40), title: 'T', tickets: [1], pr: 2 };
    const file = (releases: unknown[], unreleased: unknown[] = []) => ({ available: true, repoUrl: REPO, releases, unreleased });
    expect(parseChangelog(file([{ tag: 'v1.0.0', date: 'd', entries: [entry] }]))).not.toBeNull();
    expect(parseChangelog(file([{ tag: 'v1.0.0', date: 'd' }]))).toBeNull();
    expect(parseChangelog(file([{ tag: 'v1.0.0', date: 'd', entries: [{ ...entry, tickets: undefined }] }]))).toBeNull();
    expect(parseChangelog(file([{ tag: 'v1.0.0', date: 'd', entries: [{ ...entry, tickets: ['1'] }] }]))).toBeNull();
    expect(parseChangelog(file([], [{ ...entry, sha: undefined }]))).toBeNull();
    expect(parseChangelog(file([], [{ ...entry, sha: 'not a sha' }]))).toBeNull();
    expect(parseChangelog(file([], [{ ...entry, pr: 'x' }]))).toBeNull();
    expect(parseChangelog(file([null]))).toBeNull();
  });

  it('drops a repository address that is not https, so nothing links to it', () => {
    expect(parseChangelog({ available: true, repoUrl: 'javascript:alert(1)', releases: [], unreleased: [] })?.repoUrl).toBeNull();
  });
});

describe('ticketUrl / commitUrl', () => {
  it('links into the repository', () => {
    expect(ticketUrl(REPO, 310)).toBe(`${REPO}/issues/310`);
    expect(commitUrl(REPO, 'abc123')).toBe(`${REPO}/commit/abc123`);
  });

  it('gives no link without a repository', () => {
    expect(ticketUrl(null, 310)).toBeNull();
    expect(commitUrl(null, 'abc123')).toBeNull();
  });
});
