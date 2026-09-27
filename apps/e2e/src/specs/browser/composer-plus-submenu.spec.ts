/**
 * On web and Electron the `+` is a small popup, and MCP is a submenu that
 * opens beside it on hover — a desktop context menu, not a sheet. These are
 * the behaviours only a pointer has: hovering in, crossing into the submenu
 * without it closing, and leaving. At phone width, where neither side has
 * room, the submenu takes the menu's place with a back row instead.
 *
 * Driven with real pointer moves (`moveTo`), never a click, since a click
 * opens the submenu as well and would pass with hover broken.
 */
import { $, browser } from '@wdio/globals';
import { provisionUser, uniqueCreds } from '../../helpers/auth.ts';
import { shot } from '../../helpers/screenshot.ts';
import { byTestId, tap, testIdSelector, waitForGone, waitForVisible } from '../../helpers/selectors.ts';
import { addMockMcpServer, closePlusMenu, goToSurface, openPlusMenu, signIn } from '../../helpers/app.ts';
import { setWindowSize } from '../../helpers/window.ts';

async function placement(): Promise<string | null> {
  return await $(testIdSelector('composer.mcp.submenu')).getAttribute('data-placement');
}

describe('the + menu on web: MCP as a hover submenu', () => {
  const creds = uniqueCreds();
  let alpha: string;

  before(async () => {
    await provisionUser(creds);
    alpha = await addMockMcpServer(creds, 'Mock Alpha', 'alpha');
    await setWindowSize(1280, 800);
    await signIn(creds);
    await goToSurface('chat');
  });

  after(async () => {
    await setWindowSize(1280, 800);
  });

  it('opens the submenu beside the menu on hover, with no click', async () => {
    await openPlusMenu();
    await byTestId('composer.plus.mcp').moveTo();
    await waitForVisible('composer.mcp.submenu');
    expect(await placement()).toBe('right');

    // Beside it, not over it: the submenu starts to the right of the menu.
    const menu = await byTestId('composer.plus.menu').getLocation();
    const menuSize = await byTestId('composer.plus.menu').getSize();
    const sub = await byTestId('composer.mcp.submenu').getLocation();
    expect(sub.x).toBeGreaterThanOrEqual(menu.x + menuSize.width);
    await waitForVisible(`composer.mcp.server.${alpha}`);
    await shot('plus-submenu-hover');
  });

  it('stays open while the pointer crosses into it', async () => {
    await byTestId(`composer.mcp.server.${alpha}`).moveTo();
    // Longer than the close delay: had leaving the MCP row closed it, it
    // would be gone by now.
    await browser.pause(400);
    await waitForVisible('composer.mcp.submenu');
  });

  it('closes when the pointer leaves for the rest of the menu', async () => {
    await byTestId('composer.plus.attach').moveTo();
    await waitForGone('composer.mcp.submenu', 5_000);
    await waitForVisible('composer.plus.menu');
    await closePlusMenu();
  });

  it('takes the menu\'s place at phone width, with a way back', async () => {
    await setWindowSize(400, 800);
    await openPlusMenu();
    await tap('composer.plus.mcp');
    await waitForVisible('composer.mcp.submenu');
    expect(await placement()).toBe('replace');
    await waitForGone('composer.plus.menu', 5_000);
    await shot('plus-submenu-phone');

    await tap('composer.mcp.back');
    await waitForVisible('composer.plus.menu');
    await waitForGone('composer.mcp.submenu', 5_000);
    await closePlusMenu();
  });
});
