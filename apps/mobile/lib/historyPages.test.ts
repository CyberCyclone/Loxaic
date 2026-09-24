import { describe, expect, it } from 'vitest';
import { pagingFrom, prependOlder } from './historyPages';
import type { Message } from './types';

const m = (id: string | undefined, text = id ?? ''): Message => ({ id, role: 'user', text });

describe('prependOlder', () => {
  it('puts the older page in front', () => {
    expect(prependOlder([m('c'), m('d')], [m('a'), m('b')]).map((x) => x.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('keeps the loaded copy of a message both sides have', () => {
    const merged = prependOlder([m('b', 'live'), m('c')], [m('a'), m('b', 'stored')]);
    expect(merged.map((x) => x.text)).toEqual(['a', 'live', 'c']);
  });

  it('never drops a message that has no id yet', () => {
    expect(prependOlder([m(undefined, 'sending')], [m('a')]).map((x) => x.text)).toEqual(['a', 'sending']);
  });
});

describe('pagingFrom', () => {
  it('carries the cursor only when there is more', () => {
    expect(pagingFrom({ hasMore: true, before: 'x' })).toEqual({ before: 'x', loading: false });
    expect(pagingFrom({ hasMore: false, before: null })).toEqual({ before: null, loading: false });
  });

  it('reads a server without paging as having nothing older', () => {
    expect(pagingFrom({})).toEqual({ before: null, loading: false });
  });
});
