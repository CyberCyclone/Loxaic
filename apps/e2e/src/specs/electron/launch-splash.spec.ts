/**
 * The packaged app's launch splash gives way to the app, in one window.
 *
 * A packaged launch shows the mark in a splash window while it resolves its
 * server (apps/desktop/src/launch-splash.js), and destroys it as soon as the
 * real window is constructed. If that handoff broke, the app would sit on the
 * splash, or leave it open beside the real window, which the dock, the quit
 * handler and every window-[0] lookup would then trip over.
 *
 * The splash itself is gone before a spec can look at it when the server
 * answers at once (this lane's default); its page is covered by
 * apps/desktop/src/__tests__/launch-splash.test.js.
 */
import { browser } from '@wdio/globals';
import { shot } from '../../helpers/screenshot.ts';
import { waitForVisible } from '../../helpers/selectors.ts';

describe('the packaged launch splash', () => {
  it('leaves exactly one window, the app, once the app has opened', async () => {
    await waitForVisible('login.submit', 60_000);
    const windows = await browser.electron.execute((electron) =>
      electron.BrowserWindow.getAllWindows().map((w) => w.webContents.getURL()),
    );
    expect(windows).toHaveLength(1);
    expect(windows[0]?.startsWith('app://')).toBe(true);
    await shot('desktop-after-launch-splash');
  });
});
