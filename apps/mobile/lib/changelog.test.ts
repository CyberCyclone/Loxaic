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
