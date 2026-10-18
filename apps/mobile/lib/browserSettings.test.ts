import { describe, expect, it } from 'vitest';
import type { BrowserSettings } from '@loxaic/api-client';
import { browserPollMs, canEnableBrowsing, canInstallBrowser, describeBrowserStatus } from './browserSettings';

const base = (install: BrowserSettings['status']['install'], over: Partial<BrowserSettings> = {}): BrowserSettings => ({
  enabled: false,
  idleMs: 300_000,
  maxBrowsers: 3,
  actionTimeoutMs: 30_000,
  envOverrides: { enabled: false, idleMs: false, maxBrowsers: false, actionTimeoutMs: false },
  status: { install, running: 0, lastLaunchError: null },
  ...over,
});

describe('the web browsing admin section (#281)', () => {
  it('polls only while Chromium downloads', () => {
    expect(browserPollMs(base({ state: 'installing', percent: 4 }))).toBe(1000);
    expect(browserPollMs(base({ state: 'missing' }))).toBeNull();
    expect(browserPollMs(base({ state: 'installed', source: 'managed', executable: '/x' }))).toBeNull();
  });

  it('can be switched on only once a browser is installed, and never against an env pin', () => {
    expect(canEnableBrowsing(base({ state: 'missing' }))).toBe(false);
    expect(canEnableBrowsing(base({ state: 'installing', percent: null }))).toBe(false);
    expect(canEnableBrowsing(base({ state: 'installed', source: 'managed', executable: '/x' }))).toBe(true);
    const pinned = base({ state: 'installed', source: 'managed', executable: '/x' }, {
      envOverrides: { enabled: true, idleMs: false, maxBrowsers: false, actionTimeoutMs: false },
    });
    expect(canEnableBrowsing(pinned)).toBe(false);
  });

  it('offers the install when nothing is installed or the last try failed', () => {
    expect(canInstallBrowser(base({ state: 'missing' }))).toBe(true);
    expect(canInstallBrowser(base({ state: 'failed', error: 'x' }))).toBe(true);
    expect(canInstallBrowser(base({ state: 'installing', percent: 10 }))).toBe(false);
    expect(canInstallBrowser(base({ state: 'installed', source: 'configured', executable: '/x' }))).toBe(false);
  });

  it('says what state it is in', () => {
    expect(describeBrowserStatus(base({ state: 'missing' }))).toMatch(/No browser installed/);
    expect(describeBrowserStatus(base({ state: 'installing', percent: 42 }))).toBe('Downloading Chromium… 42%');
    expect(describeBrowserStatus(base({ state: 'installing', percent: null }))).toBe('Downloading Chromium…');
    expect(describeBrowserStatus(base({ state: 'failed', error: 'offline' }))).toBe('The Chromium download failed: offline');
    expect(describeBrowserStatus(base({ state: 'installed', source: 'configured', executable: '/x' }))).toBe('Using the browser set by BROWSER_EXECUTABLE.');
    const running = base({ state: 'installed', source: 'managed', executable: '/x' });
    running.status.running = 2;
    expect(describeBrowserStatus(running)).toBe('Using Chromium. 2 open now.');
    const broken = base({ state: 'installed', source: 'managed', executable: '/x' });
    broken.status.lastLaunchError = 'No usable sandbox!';
    expect(describeBrowserStatus(broken)).toBe('Chromium is installed but could not start: No usable sandbox!');
  });
});
