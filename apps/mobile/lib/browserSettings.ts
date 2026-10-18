import type { BrowserSettings } from '@loxaic/api-client';

/** How often the admin screen re-reads the browser settings: every second
 * while Chromium downloads, so the percentage moves, and not at all otherwise
 * (nothing else changes on its own). */
export function browserPollMs(settings: BrowserSettings): number | null {
  return settings.status.install.state === 'installing' ? 1000 : null;
}

/** The one-line status under the switch. */
export function describeBrowserStatus(settings: BrowserSettings): string {
  const install = settings.status.install;
  switch (install.state) {
    case 'missing':
      return 'No browser installed yet. Install Chromium (about 100 MB) to turn this on.';
    case 'installing':
      return install.percent === null ? 'Downloading Chromium…' : `Downloading Chromium… ${String(install.percent)}%`;
    case 'failed':
      return `The Chromium download failed: ${install.error}`;
    case 'installed': {
      if (settings.status.lastLaunchError) return `The browser could not start: ${settings.status.lastLaunchError}`;
      // What the last launch actually used, which on Ubuntu 23.10+ may be a
      // system browser rather than the downloaded one (#281).
      const using = settings.status.using ?? install;
      const what =
        using.source === 'configured' ? 'the browser set by BROWSER_EXECUTABLE'
        : using.source === 'system' ? `${using.name ?? 'the browser'} installed on this system`
        : 'Chromium';
      const running = settings.status.running;
      return `Using ${what}.${running > 0 ? ` ${String(running)} open now.` : ''}`;
    }
  }
}

/** Whether the switch can be turned on: only once there is a browser to run. */
export function canEnableBrowsing(settings: BrowserSettings): boolean {
  return settings.status.install.state === 'installed' && !settings.envOverrides.enabled;
}

/** Whether to offer the Install button. */
export function canInstallBrowser(settings: BrowserSettings): boolean {
  const state = settings.status.install.state;
  return state === 'missing' || state === 'failed';
}
