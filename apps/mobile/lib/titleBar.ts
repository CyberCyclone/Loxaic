import type { LoxaicBridge } from './endpoint';

/**
 * Where apps/desktop/src/main.js puts the macOS window buttons
 * (`trafficLightPosition`), and how wide the three of them are. The window is
 * `hiddenInset`, so they sit on top of the page's top-left corner.
 */
export const MAC_WINDOW_BUTTONS = { x: 16, width: 52 } as const;

/** Clear space kept between the window buttons and what follows them. */
const GAP = 16;

/**
 * How far the row at the top-left of the window must start from the left edge
 * to clear the window buttons: only in the desktop app on macOS, where the
 * buttons are drawn over the page. Zero everywhere else, including a desktop
 * build too old to say which OS it runs on.
 */
export function titleBarInsetLeft(bridge: Pick<LoxaicBridge, 'platform' | 'os'> | null | undefined): number {
  if (bridge?.platform !== 'electron' || bridge.os !== 'darwin') return 0;
  return MAC_WINDOW_BUTTONS.x + MAC_WINDOW_BUTTONS.width + GAP;
}
