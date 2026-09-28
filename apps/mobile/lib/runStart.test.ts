import { describe, expect, it } from 'vitest';
import { localRunStart } from './runStart';

describe('localRunStart', () => {
  it('places the start by how long the run has been going on the server, not by either clock alone', () => {
    // Server says: started 6 minutes ago. This device's clock is a minute fast.
    const serverNow = 1_000_000_000;
    const now = serverNow + 60_000;
    expect(localRunStart(serverNow - 360_000, serverNow, now)).toBe(now - 360_000);
  });

  it('times from now when the server did not say', () => {
    expect(localRunStart(undefined, 5, 1_000)).toBe(1_000);
    expect(localRunStart(5, undefined, 1_000)).toBe(1_000);
  });

  it('never puts the start in the future', () => {
    expect(localRunStart(2_000, 1_000, 5_000)).toBe(5_000);
  });
});
