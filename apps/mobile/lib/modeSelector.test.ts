import { describe, expect, it } from 'vitest';
import { followSelector, modeChangeNotice, type SelectorSource } from './modeSelector';

const at = (convId: string | null, runMode: SelectorSource['runMode'], storedMode: SelectorSource['storedMode']): SelectorSource => ({
  convId,
  runMode,
  storedMode,
});

describe('the mode selector follows the thread on screen (#311)', () => {
  it('opens a thread in its last mode, not Manual', () => {
    expect(followSelector('manual', null, at('A', null, 'auto'))).toBe('auto');
    expect(followSelector('manual', at('B', null, 'manual'), at('A', null, 'auto'))).toBe('auto');
  });

  it('opens a thread with a run going but no stored mode in the run’s mode', () => {
    expect(followSelector('manual', null, at('A', 'auto', null))).toBe('auto');
  });

  it('keeps a Planning pick made while a Manual run went on, on coming back', () => {
    expect(followSelector('auto', at('B', null, 'auto'), at('A', 'manual', 'planning'))).toBe('planning');
  });

  it('keeps the pick for a new thread, and for one with nothing recorded', () => {
    expect(followSelector('auto', at('A', null, 'manual'), at(null, null, null))).toBe('auto');
    expect(followSelector('auto', at('A', null, 'manual'), at('B', null, null))).toBe('auto');
  });

  it('follows the run when its mode changes: on a load, a reconnect, or a switch elsewhere', () => {
    // Heard for the first time once the snapshot lands.
    expect(followSelector('manual', at('A', null, null), at('A', 'auto', null))).toBe('auto');
    // Switched on another device.
    expect(followSelector('manual', at('A', 'manual', 'manual'), at('A', 'auto', 'manual'))).toBe('auto');
  });

  it('stays put when a resync says what it already knew', () => {
    expect(followSelector('planning', at('A', 'manual', 'planning'), at('A', 'manual', 'planning'))).toBe('planning');
  });

  it('stays put when the run ends', () => {
    expect(followSelector('planning', at('A', 'manual', 'planning'), at('A', null, 'planning'))).toBe('planning');
  });

  it('takes a last mode that arrives after the thread opened', () => {
    expect(followSelector('manual', at('A', null, null), at('A', null, 'auto'))).toBe('auto');
    // But never over a pick made here once one was known.
    expect(followSelector('planning', at('A', null, 'auto'), at('A', null, 'planning'))).toBe('planning');
  });
});

describe('what a pick says when it does not reach the run', () => {
  it('says nothing when the run switches, or none is going', () => {
    expect(modeChangeNotice('manual', 'auto')).toBeNull();
    expect(modeChangeNotice('auto', 'manual')).toBeNull();
    expect(modeChangeNotice(null, 'planning')).toBeNull();
    expect(modeChangeNotice('planning', 'planning')).toBeNull();
  });

  it('says Planning, in or out, waits for the next message', () => {
    expect(modeChangeNotice('manual', 'planning')).toBe('Planning starts with your next message. This run stays in Manual.');
    expect(modeChangeNotice('planning', 'auto')).toBe('Auto starts with your next message. This run stays in Planning.');
  });
});
