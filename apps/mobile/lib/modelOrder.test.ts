import { describe, expect, it } from 'vitest';
import { loadedFirst, loadState } from './modelOrder';

const m = (id: string, over: { loaded?: boolean; loading?: boolean; location?: 'server' | 'device' | 'remote' } = {}) => ({
  id,
  location: over.location ?? ('server' as const),
  loaded: over.loaded ?? false,
  loading: over.loading,
});

describe('loaded host models first', () => {
  it('puts loaded, then loading, then the rest, keeping the server order within each', () => {
    const order = loadedFirst([m('a'), m('b', { loaded: true }), m('c', { loading: true }), m('d'), m('e', { loaded: true })]);
    expect(order.map((x) => x.id)).toEqual(['b', 'e', 'c', 'a', 'd']);
  });

  it('leaves hosted models alone — they are always "loaded", which says nothing', () => {
    const order = loadedFirst([m('x', { location: 'remote', loaded: true }), m('y', { location: 'remote', loaded: true })]);
    expect(order.map((x) => x.id)).toEqual(['x', 'y']);
    expect(loadState(m('x', { location: 'remote', loaded: true }))).toBeNull();
  });

  it('reports no state for an unloaded host model, or one from an older server', () => {
    expect(loadState(m('a'))).toBeNull();
    expect(loadState(m('a', { loaded: true }))).toBe('loaded');
    expect(loadState(m('a', { loading: true }))).toBe('loading');
  });
});
