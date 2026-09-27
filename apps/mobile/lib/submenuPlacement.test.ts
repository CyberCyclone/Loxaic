import { describe, expect, it } from 'vitest';
import { EDGE, GAP, MENU_WIDTH, SUBMENU_WIDTH, placeMenu, placeSubmenu, type Rect } from './submenuPlacement';

const rect = (left: number, top: number, width: number, height: number): Rect => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
});

describe('placeMenu', () => {
  it('opens upward from the + button, aligned to its left edge', () => {
    const p = placeMenu(rect(300, 900, 28, 28), { width: 1400, height: 1000 });
    expect(p.left).toBe(300);
    expect(p.bottom).toBe(1000 - 900 + GAP);
    expect(p.maxHeight).toBe(900 - GAP - EDGE);
  });

  it('stays on screen when the button is near the right edge', () => {
    const p = placeMenu(rect(390, 700, 28, 28), { width: 400, height: 800 });
    expect(p.left).toBe(400 - MENU_WIDTH - EDGE);
  });
});

describe('placeSubmenu', () => {
  const viewport = { width: 1400, height: 1000 };
  const menu = rect(300, 800, MENU_WIDTH, 96);
  const row = rect(304, 850, MENU_WIDTH - 8, 40);

  it('goes to the right when there is room, level with the MCP row', () => {
    const p = placeSubmenu(menu, row, viewport);
    expect(p.mode).toBe('right');
    expect(p.left).toBe(menu.right + GAP);
    expect(p.bottom).toBe(1000 - row.bottom - GAP);
  });

  it('flips to the left when the right side would run off screen', () => {
    const nearRight = rect(1400 - MENU_WIDTH - 20, 800, MENU_WIDTH, 96);
    const p = placeSubmenu(nearRight, rect(nearRight.left + 4, 850, MENU_WIDTH - 8, 40), viewport);
    expect(p.mode).toBe('left');
    expect(p.left).toBe(nearRight.left - GAP - SUBMENU_WIDTH);
    expect(p.left).toBeGreaterThanOrEqual(EDGE);
  });

  it('takes the menu\'s place at phone width, where neither side fits', () => {
    const phone = { width: 400, height: 800 };
    const m = rect(16, 600, MENU_WIDTH, 96);
    const p = placeSubmenu(m, rect(20, 650, MENU_WIDTH - 8, 40), phone);
    expect(p.mode).toBe('replace');
    expect(p.left + SUBMENU_WIDTH).toBeLessThanOrEqual(phone.width - EDGE);
    expect(p.bottom).toBe(phone.height - m.bottom);
  });

  it('never gives a negative height, however cramped', () => {
    const p = placeSubmenu(rect(0, 0, 10, 10), rect(0, 0, 10, 10), { width: 20, height: 5 });
    expect(p.maxHeight).toBeGreaterThanOrEqual(0);
  });
});
