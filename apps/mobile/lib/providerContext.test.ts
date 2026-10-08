import { describe, expect, it } from 'vitest';
import {
  buildContextWindows,
  CONTEXT_SIZE_ERROR,
  modelsWithoutSize,
  parseContextSize,
  splitContextWindows,
} from './providerContext';

describe('parseContextSize', () => {
  it('reads whole numbers, with separators', () => {
    expect(parseContextSize('128000')).toBe(128_000);
    expect(parseContextSize(' 1,048,576 ')).toBe(1_048_576);
    expect(parseContextSize('200_000')).toBe(200_000);
  });

  it('is null for an empty field', () => {
    expect(parseContextSize('')).toBeNull();
    expect(parseContextSize('   ')).toBeNull();
  });

  it('refuses what the server would refuse', () => {
    for (const text of ['128k', '1.5', '-4096', '1023', '100000001', 'lots']) {
      expect(parseContextSize(text)).toBe('invalid');
    }
  });
});

describe('the stored map and the form', () => {
  it('splits "*" from the per-model sizes, and builds them back', () => {
    const stored = { '*': 128_000, 'gpt-4.1': 1_047_576 };
    const form = splitContextWindows(stored);
    expect(form).toEqual({ fallback: '128000', perModel: { 'gpt-4.1': 1_047_576 } });
    expect(buildContextWindows(form.fallback, form.perModel)).toEqual({ ok: true, value: stored });
  });

  it('saves null when nothing is set, so the server clears the column', () => {
    expect(splitContextWindows(null)).toEqual({ fallback: '', perModel: {} });
    expect(buildContextWindows('', {})).toEqual({ ok: true, value: null });
  });

  it('refuses a bad size rather than dropping it', () => {
    expect(buildContextWindows('128k', {})).toEqual({ ok: false, error: CONTEXT_SIZE_ERROR });
  });
});

describe('modelsWithoutSize', () => {
  it('counts models that report none and have no size of their own', () => {
    const models = [
      { id: 'a', context_tokens: null },
      { id: 'b', context_tokens: null },
      { id: 'c', context_tokens: 200_000 },
      // An older server does not say: not counted as unknown.
      { id: 'd' },
    ];
    expect(modelsWithoutSize(models, {})).toBe(2);
    expect(modelsWithoutSize(models, { a: 128_000 })).toBe(1);
  });
});
