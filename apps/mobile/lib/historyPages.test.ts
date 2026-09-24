import { describe, expect, it } from 'vitest';
import { pagingFrom, prependOlder, withNewestPage } from './historyPages';
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

describe('withNewestPage', () => {
  it('fills an empty thread with the page', () => {
    expect(withNewestPage([], [m('a'), m('b')], false).map((x) => x.id)).toEqual(['a', 'b']);
  });

  it("replaces a thread filled from the cache with the server's page", () => {
    expect(withNewestPage([m('old')], [m('a'), m('b')], true).map((x) => x.id)).toEqual(['a', 'b']);
  });

  it('puts the history in front of a live run instead of dropping it', () => {
    // A run already streaming when the page lands: its messages stay (live
    // copy wins), and the history the page holds is shown before them — so
    // the page's cursor describes what is on screen.
    const merged = withNewestPage([m('r1', 'live'), m('r2')], [m('h1'), m('h2'), m('r1', 'stored')], false);
    expect(merged.map((x) => x.text)).toEqual(['h1', 'h2', 'live', 'r2']);
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
