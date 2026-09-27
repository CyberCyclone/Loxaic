/**
 * Where the web `+` menu and its MCP submenu go. Pure, so the flip rules are
 * unit tested; `ComposerPlusMenu.web.tsx` measures the rects and applies the
 * answer.
 *
 * The menu opens upward from the `+` (it sits at the bottom of the screen).
 * The submenu goes beside the MCP row — right if it fits, else left — with
 * its bottom level with the row's, the way a desktop context menu's does.
 * When neither side fits (a phone-width browser) it takes the menu's own
 * place instead, with a back row, the way the native sheet works.
 */

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Viewport {
  width: number;
  height: number;
}

/** Kept clear of every screen edge. */
export const EDGE = 8;
/** Between the `+` and the menu, and between the menu and the submenu. */
export const GAP = 4;
export const MENU_WIDTH = 208;
export const SUBMENU_WIDTH = 288;

export interface MenuPlacement {
  left: number;
  /** Distance from the viewport's bottom edge to the menu's bottom edge. */
  bottom: number;
  maxHeight: number;
}

export function placeMenu(trigger: Rect, viewport: Viewport, width = MENU_WIDTH): MenuPlacement {
  const left = Math.max(EDGE, Math.min(trigger.left, viewport.width - width - EDGE));
  const bottom = viewport.height - trigger.top + GAP;
  return { left, bottom, maxHeight: Math.max(0, trigger.top - GAP - EDGE) };
}

export type SubmenuPlacement =
  | { mode: 'right' | 'left'; left: number; bottom: number; maxHeight: number }
  | { mode: 'replace'; left: number; bottom: number; maxHeight: number };

export function placeSubmenu(
  menu: Rect,
  row: Rect,
  viewport: Viewport,
  width = SUBMENU_WIDTH,
): SubmenuPlacement {
  // Level with the row's bottom, but never lower than the screen allows.
  const bottom = Math.max(EDGE, viewport.height - row.bottom - GAP);
  const maxHeight = Math.max(0, viewport.height - bottom - EDGE);

  if (menu.right + GAP + width <= viewport.width - EDGE) {
    return { mode: 'right', left: menu.right + GAP, bottom, maxHeight };
  }
  if (menu.left - GAP - width >= EDGE) {
    return { mode: 'left', left: menu.left - GAP - width, bottom, maxHeight };
  }
  // Neither side has room: take the menu's place, as wide as the screen
  // allows, anchored where the menu's bottom was.
  const left = Math.max(EDGE, Math.min(menu.left, viewport.width - width - EDGE));
  const replaceBottom = viewport.height - menu.bottom;
  return { mode: 'replace', left, bottom: replaceBottom, maxHeight: Math.max(0, viewport.height - replaceBottom - EDGE) };
}
