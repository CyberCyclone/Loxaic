import { describe, expect, it } from 'vitest';
import { pagingFrom, prependOlder, withNewestPage } from './historyPages';
import type { Message } from './types';

const m = (id: string | undefined, text = id ?? ''): Message => ({ id, role: 'user', text });
/** A message with its place in the thread, as both the page and a snapshot carry it. */
const at = (id: string | undefined, lamport: number, text = id ?? ''): Message => ({ id, role: 'user', text, lamport });
const ids = (msgs: readonly Message[]) => msgs.map((x) => x.id ?? x.text);

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

  it('puts an older page around a snapshot message that is older still', () => {
    // A reconnect placed one of the last runs' messages (30) below the newest
    // page (50, 60); the next page back holds 10-40, around it.
    const merged = prependOlder([at('s30', 30), at('p50', 50), at('p60', 60)], [at('o10', 10), at('o20', 20), at('o40', 40)]);
    expect(ids(merged)).toEqual(['o10', 'o20', 's30', 'o40', 'p50', 'p60']);
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

  it('puts the history in front of a live run that has positions too', () => {
    const merged = withNewestPage([at('r1', 300, 'live'), at('r2', 301)], [at('h1', 100), at('h2', 200), at('r1', 300, 'stored')], false);
    expect(merged.map((x) => x.text)).toEqual(['h1', 'h2', 'live', 'r2']);
  });

  it('keeps an older run that synced before the page below it, not after it (#281)', () => {
    // On the beta: the planning run (answers 101, plan 102) synced before the
    // newest page (accept 104 … final answer 606) arrived. Put in front, the
    // page left the plan last, with no reply after it — Accept offered again.
    const loaded = [at('answers', 101), at('plan', 102)];
    const page = [at('accept', 104), at('work', 105), at('final', 606)];
    expect(ids(withNewestPage(loaded, page, false))).toEqual(['answers', 'plan', 'accept', 'work', 'final']);
  });

  it('orders a page around snapshot messages on both sides of it', () => {
    // An older run synced (102), then the newest run (700, 701) began, and
    // only then did the page (104-606) land.
    const loaded = [at('plan', 102), at('next', 700), at('nextReply', 701)];
    const page = [at('accept', 104), at('final', 606)];
    expect(ids(withNewestPage(loaded, page, false))).toEqual(['plan', 'accept', 'final', 'next', 'nextReply']);
  });

  it('keeps a bubble still being sent last', () => {
    const loaded = [at('plan', 102), m(undefined, 'sending')];
    const page = [at('accept', 104), at('final', 606)];
    expect(ids(withNewestPage(loaded, page, false))).toEqual(['plan', 'accept', 'final', 'sending']);
  });

  it('puts history without positions in front, as for a server before paging', () => {
    expect(ids(withNewestPage([at('r1', 300)], [m('h1'), m('h2')], false))).toEqual(['h1', 'h2', 'r1']);
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
