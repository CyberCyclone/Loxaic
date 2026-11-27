import { describe, expect, it } from 'vitest';
import { reloadPrefsNow } from './prefsReload';

describe('reloadPrefsNow', () => {
  it('asks again for prefs it could not load once the server is back', () => {
    expect(reloadPrefsNow({ wasReachable: false, reachable: true, loaded: false })).toBe(true);
  });
  it('leaves prefs it has alone', () => {
    expect(reloadPrefsNow({ wasReachable: false, reachable: true, loaded: true })).toBe(false);
  });
  it('does not ask while the server is away, or again while it stays reachable', () => {
    expect(reloadPrefsNow({ wasReachable: true, reachable: false, loaded: false })).toBe(false);
    expect(reloadPrefsNow({ wasReachable: false, reachable: false, loaded: false })).toBe(false);
    expect(reloadPrefsNow({ wasReachable: true, reachable: true, loaded: false })).toBe(false);
  });
});
