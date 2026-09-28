import { describe, expect, it } from 'vitest';
import { ConversationWatches } from './conversationWatch';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

describe('ConversationWatches', () => {
  it('claims a real conversation once per socket', () => {
    const w = new ConversationWatches();
    expect(w.claim(A)).toBe(true);
    expect(w.claim(A)).toBe(false);
    expect(w.claim(B)).toBe(true);
  });

  it('never claims a local id the server has not heard of', () => {
    const w = new ConversationWatches();
    expect(w.claim('pending-ab12')).toBe(false);
    expect(w.claim('c1727500000000')).toBe(false);
    expect(w.claim(null)).toBe(false);
  });

  it('starts over for a new socket, and counts what its reconnect subscribed', () => {
    const w = new ConversationWatches();
    w.claim(A);
    w.reset();
    w.note([B, 'pending-x']);
    expect(w.claim(A)).toBe(true);
    expect(w.claim(B)).toBe(false);
  });
});
