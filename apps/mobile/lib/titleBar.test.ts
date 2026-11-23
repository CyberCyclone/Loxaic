import { describe, expect, it } from 'vitest';
import { titleBarInsetLeft } from './titleBar';

describe('titleBarInsetLeft', () => {
  it('clears the window buttons in the desktop app on macOS', () => {
    expect(titleBarInsetLeft({ platform: 'electron', os: 'darwin' })).toBe(84);
  });

  it('is zero where nothing is drawn over the page', () => {
    expect(titleBarInsetLeft({ platform: 'electron', os: 'win32' })).toBe(0);
    expect(titleBarInsetLeft({ platform: 'electron', os: 'linux' })).toBe(0);
    expect(titleBarInsetLeft(null)).toBe(0);
    expect(titleBarInsetLeft(undefined)).toBe(0);
  });

  it('is zero for a desktop build too old to say its OS', () => {
    expect(titleBarInsetLeft({ platform: 'electron' })).toBe(0);
  });
});
