import { describe, expect, it } from 'vitest';
import { hostOf } from './serverHost';

describe('hostOf', () => {
  it.each([
    ['https://pheonix.tail47eac7.ts.net', 'pheonix.tail47eac7.ts.net'],
    ['http://10.0.2.2:4000', '10.0.2.2'],
    ['http://localhost:4000/', 'localhost'],
    ['https://host.example/api/v1?x=1#y', 'host.example'],
    ['http://user:pass@secret.example:8080', 'secret.example'],
    ['http://[::1]:4000', '::1'],
  ])('%s → %s', (url, host) => {
    expect(hostOf(url)).toBe(host);
  });

  it('has nothing to say about nothing', () => {
    expect(hostOf(null)).toBeNull();
    expect(hostOf('')).toBeNull();
  });
});
