import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));

const { MONO_FAMILY, monoFont, monoFontFamily, setMonoLoaded } = await import('./fonts');

describe('monoFontFamily', () => {
  it('uses JetBrains Mono on native once the fonts loaded', () => {
    expect(monoFontFamily(true, 'ios')).toBe(MONO_FAMILY);
    expect(monoFontFamily(true, 'android')).toBe(MONO_FAMILY);
  });

  it("falls back to the platform's own monospace on native when they did not", () => {
    expect(monoFontFamily(false, 'ios')).toBe('Menlo');
    expect(monoFontFamily(false, 'android')).toBe('monospace');
  });

  it('gives web a stack that ends in a generic monospace, loaded or not', () => {
    for (const loaded of [true, false]) {
      const stack = monoFontFamily(loaded, 'web');
      expect(stack.startsWith(`${MONO_FAMILY},`)).toBe(true);
      expect(stack.endsWith('monospace')).toBe(true);
    }
  });
});

describe('monoFont', () => {
  it('follows what RootLayout reported', () => {
    setMonoLoaded(false);
    expect(monoFont()).toBe('monospace');
    setMonoLoaded(true);
    expect(monoFont()).toBe(MONO_FAMILY);
  });
});
