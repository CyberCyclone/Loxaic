import { describe, expect, it } from 'vitest';
import { liveCompactionLabel } from './compactionState';

describe('liveCompactionLabel', () => {
  it('says it is queued, then loading, then compacting', () => {
    expect(liveCompactionLabel({ queuePosition: 2, loadingModel: true })).toBe('Queued · #2');
    expect(liveCompactionLabel({ queuePosition: null, loadingModel: true })).toBe('Loading model…');
    expect(liveCompactionLabel({})).toBe('Compacting…');
  });
});
