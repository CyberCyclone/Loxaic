/**
 * The window's size, on both desktop lanes.
 *
 * WebDriver's window commands need `Browser.getWindowForTarget`, which
 * Electron's chromedriver does not implement, so every spec that checked a
 * control was reachable on a short window failed on the Electron lane before
 * reaching its assertion. There, the main process sizes its own window — after
 * lifting the app's minimum size (900×600), which would otherwise clamp the very
 * heights those specs exist to try.
 */
import { browser } from '@wdio/globals';
import { platform } from './selectors.ts';

export async function getWindowSize(): Promise<{ width: number; height: number }> {
  if (platform() !== 'electron') return browser.getWindowSize();
  return browser.electron.execute((electron) => {
    const [width = 0, height = 0] = electron.BrowserWindow.getAllWindows()[0]?.getSize() ?? [];
    return { width, height };
  });
}

export async function setWindowSize(width: number, height: number): Promise<void> {
  if (platform() !== 'electron') {
    await browser.setWindowSize(width, height);
    return;
  }
  await browser.electron.execute((electron, w: number, h: number) => {
    for (const win of electron.BrowserWindow.getAllWindows().slice(0, 1)) {
      win.setMinimumSize(1, 1);
      win.setSize(w, h);
    }
  }, width, height);
  // The page lays out on its own resize event, a moment later; a spec that
  // measures straight away measures the old layout. Wait for the frame, then
  // for the viewport to hold still, then for two frames to be drawn.
  await browser.waitUntil(async () => (await browser.execute(() => window.outerHeight)) === height, {
    timeout: 5_000,
    timeoutMsg: `the window never became ${String(height)} high`,
  });
  let last = -1;
  await browser.waitUntil(async () => {
    const inner = await browser.execute(() => window.innerHeight);
    const still = inner === last;
    last = inner;
    return still;
  }, { timeout: 5_000, interval: 150 });
  await browser.execute(
    () => new Promise<void>((resolve) => { requestAnimationFrame(() => { requestAnimationFrame(() => { resolve(); }); }); }),
  );
}
