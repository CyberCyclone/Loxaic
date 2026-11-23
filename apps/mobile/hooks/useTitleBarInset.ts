import { electronBridge } from '@/lib/endpoint';
import { titleBarInsetLeft } from '@/lib/titleBar';

// Fixed for the life of the window: the bridge is set before the page loads.
const INSET_LEFT = titleBarInsetLeft(electronBridge());

/**
 * Left padding for a row at the window's top-left corner, so it clears the
 * macOS window buttons in the desktop app (lib/titleBar.ts); 0 elsewhere.
 */
export function useTitleBarInset(): number {
  return INSET_LEFT;
}
