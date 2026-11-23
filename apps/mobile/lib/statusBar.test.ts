import { describe, expect, it } from 'vitest';
import { statusBarStyle } from './statusBar';

describe('statusBarStyle', () => {
  it('draws dark icons on the light theme', () => {
    expect(statusBarStyle('light')).toBe('dark-content');
  });

  it('draws light icons on the dark theme, the default', () => {
    expect(statusBarStyle('dark')).toBe('light-content');
    expect(statusBarStyle(undefined)).toBe('light-content');
  });
});
