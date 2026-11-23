/**
 * The macOS window buttons and the rows under them.
 *
 * The desktop window is `hiddenInset`: no title bar of its own, the red,
 * yellow and green buttons drawn on top of the page's top-left corner. Nothing
 * used to leave room for them, so they sat over the sidebar's mark and
 * wordmark (and, with the sidebar a slide-over, over the header's menu
 * button), and nothing on the page could be dragged to move the window.
 *
 * main.js places the buttons (`trafficLightPosition`) and the page pads the
 * row at the corner past them (apps/mobile/lib/titleBar.ts). macOS only: no
 * other platform draws window buttons over the page.
 */
import { browser } from '@wdio/globals';
import { provisionUser } from '../../helpers/auth.ts';
import { openSidebar, signIn } from '../../helpers/app.ts';
import { shot } from '../../helpers/screenshot.ts';
import { tap, waitForVisible } from '../../helpers/selectors.ts';
import { getWindowSize, setWindowSize } from '../../helpers/window.ts';

/** Where main.js puts the buttons, and the right edge of the three of them. */
const BUTTONS = { x: 16, y: 23 };
const BUTTONS_RIGHT = BUTTONS.x + 52;

interface Row {
  /** Left edge of the row's first child: where its content starts. */
  contentLeft: number;
  region: string;
}

async function row(testID: string): Promise<Row | null> {
  return browser.execute((id: string) => {
    const el = document.querySelector(`[data-testid="${id}"]`);
    if (!el) return null;
    const first = el.firstElementChild ?? el;
    return {
      contentLeft: first.getBoundingClientRect().left,
      region: getComputedStyle(el).getPropertyValue('-webkit-app-region'),
    };
  }, testID);
}

async function region(testID: string): Promise<string> {
  return browser.execute((id: string) => {
    const el = document.querySelector(`[data-testid="${id}"]`);
    if (!el) return 'missing';
    return getComputedStyle(el).getPropertyValue('-webkit-app-region');
  }, testID);
}

describe('the macOS window buttons', function () {
  let restore: { width: number; height: number } | null = null;

  before(async function () {
    if (process.platform !== 'darwin') this.skip();
    await signIn(await provisionUser());
    restore = await getWindowSize();
  });

  after(async () => {
    if (restore) await setWindowSize(restore.width, restore.height);
  });

  it('sit where the page leaves room for them', async () => {
    const position = await browser.electron.execute((electron) =>
      electron.BrowserWindow.getAllWindows()[0]?.getWindowButtonPosition() ?? null,
    );
    expect(position).toEqual(BUTTONS);
  });

  it('leave the sidebar header clear, and the window drags from it', async () => {
    await setWindowSize(1280, 800);
    await waitForVisible('sidebar.header');
    const header = await row('sidebar.header');
    expect(header?.contentLeft).toBeGreaterThan(BUTTONS_RIGHT);
    expect(header?.region).toBe('drag');
    await shot('title-bar-sidebar-clear');
  });

  it('leave the header clear when the sidebar is a slide-over, and its menu button still works', async () => {
    await setWindowSize(900, 700);
    await waitForVisible('shell.menuButton');
    const header = await row('shell.header');
    expect(header?.contentLeft).toBeGreaterThan(BUTTONS_RIGHT);
    expect(header?.region).toBe('drag');
    // A button inside a drag region swallows its clicks unless it opts out.
    expect(await region('shell.menuButton')).toBe('no-drag');
    await shot('title-bar-header-clear');
    await openSidebar();
    const sidebar = await row('sidebar.header');
    expect(sidebar?.contentLeft).toBeGreaterThan(BUTTONS_RIGHT);
    await tap('shell.sidebarScrim');
  });
});
