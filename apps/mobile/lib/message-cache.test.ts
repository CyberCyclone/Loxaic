import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The cache is pure logic over the storage layer, so the storage layer is the
 * only thing mocked. Testing it through a real AsyncStorage would be testing
 * AsyncStorage; testing it through the hooks would need a renderer to observe
 * what is really a data-shape question.
 */
const store = new Map<string, string>();

vi.mock('./storage', () => ({
  getJson: <T,>(key: string, fallback: T): T => {
    const raw = store.get(key);
    if (raw == null) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  },
  setJson: (key: string, value: unknown) => store.set(key, JSON.stringify(value)),
  removeItem: (key: string) => store.delete(key),
  keysWithPrefix: (prefix: string) => [...store.keys()].filter((k) => k.startsWith(prefix)),
}));

const {
  readCachedConversations,
  writeCachedConversation,
  writeCachedList,
  clearCacheForEndpoint,
} = await import('./message-cache');

const ENDPOINT = 'http://host:4100';
const USER = 'user-1';

function conv(id: string, msgCount = 1) {
  return {
    id,
    title: `thread ${id}`,
    kind: 'chat' as const,
    time: 'now',
    model: 'm',
    location: 'server' as const,
    msgs: Array.from({ length: msgCount }, (_, i) => ({
      id: `${id}-m${String(i)}`,
      role: 'user' as const,
      text: `message ${String(i)}`,
    })),
  };
}

beforeEach(() => {
  store.clear();
});

describe('message cache', () => {
  it('round-trips a conversation', () => {
    writeCachedConversation(ENDPOINT, USER, conv('a'));
    const [cached] = readCachedConversations(ENDPOINT, USER);
    expect(cached.id).toBe('a');
    expect(cached.msgs).toHaveLength(1);
  });

  it('is empty for a scope nothing was written to', () => {
    writeCachedConversation(ENDPOINT, USER, conv('a'));
    expect(readCachedConversations(ENDPOINT, 'someone-else')).toEqual([]);
    expect(readCachedConversations('http://other:4100', USER)).toEqual([]);
  });

  it('treats a trailing slash as the same endpoint', () => {
    // Otherwise one host quietly gets two half-filled caches depending on how
    // the endpoint was typed or resolved.
    writeCachedConversation(ENDPOINT, USER, conv('a'));
    expect(readCachedConversations(`${ENDPOINT}/`, USER)).toHaveLength(1);
  });

  it('replaces a conversation wholesale rather than merging', () => {
    writeCachedConversation(ENDPOINT, USER, conv('a', 3));
    writeCachedConversation(ENDPOINT, USER, conv('a', 1));
    const [cached] = readCachedConversations(ENDPOINT, USER);
    // A merge would leave 3; the server is the only writer, so the newer
    // snapshot wins outright.
    expect(cached.msgs).toHaveLength(1);
  });

  it('keeps only the newest messages of a long thread', () => {
    writeCachedConversation(ENDPOINT, USER, conv('a', 150));
    const [cached] = readCachedConversations(ENDPOINT, USER);
    expect(cached.msgs).toHaveLength(100);
    // The tail, not the head — a reader lands at the bottom of a thread.
    expect(cached.msgs.at(-1)?.text).toBe('message 149');
  });

  it('evicts the least recently written past the conversation cap', () => {
    for (let i = 0; i < 55; i++) writeCachedConversation(ENDPOINT, USER, conv(`c${String(i)}`));
    const cached = readCachedConversations(ENDPOINT, USER);
    expect(cached).toHaveLength(50);
    expect(cached.map((c) => c.id)).not.toContain('c0');
    expect(cached.map((c) => c.id)).toContain('c54');
  });

  it('drops conversations the server no longer lists', () => {
    writeCachedList(ENDPOINT, USER, [conv('a'), conv('b')]);
    writeCachedList(ENDPOINT, USER, [conv('a')]);
    const cached = readCachedConversations(ENDPOINT, USER);
    expect(cached.map((c) => c.id)).toEqual(['a']);
  });

  it('leaves no orphaned entries behind when a list shrinks', () => {
    // The index and the per-conversation keys have to stay in step, or the
    // store grows forever with rows nothing can read.
    writeCachedList(ENDPOINT, USER, [conv('a'), conv('b')]);
    writeCachedList(ENDPOINT, USER, [conv('a')]);
    expect([...store.keys()].filter((k) => k.includes('|c|b'))).toEqual([]);
  });

  it('clears one endpoint without touching another', () => {
    writeCachedConversation(ENDPOINT, USER, conv('a'));
    writeCachedConversation('http://other:4100', USER, conv('b'));

    clearCacheForEndpoint(ENDPOINT);

    expect(readCachedConversations(ENDPOINT, USER)).toEqual([]);
    // Detaching from one host must not sign the user out of a different one.
    expect(readCachedConversations('http://other:4100', USER)).toHaveLength(1);
  });

  it('clears every user of the cleared endpoint', () => {
    writeCachedConversation(ENDPOINT, USER, conv('a'));
    writeCachedConversation(ENDPOINT, 'user-2', conv('b'));
    clearCacheForEndpoint(ENDPOINT);
    expect(readCachedConversations(ENDPOINT, 'user-2')).toEqual([]);
  });
});
