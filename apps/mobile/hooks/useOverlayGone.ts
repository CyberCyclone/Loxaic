import { useEffect, useState } from 'react';
import { SHEET_EXIT_MS } from '@/lib/sheetExit';

/**
 * True once no overlay is open and the last one has had time to leave: what
 * an overlay that opens by itself (a tool approval) waits for, since this app
 * never stacks one overlay on another and iOS will not present one while
 * another is up or still leaving. False from the render `open` turns true.
 */
export function useOverlayGone(open: boolean): boolean {
  const [gone, setGone] = useState(!open);
  useEffect(() => {
    if (open) {
      setGone(false);
      return;
    }
    const timer = setTimeout(() => { setGone(true); }, SHEET_EXIT_MS);
    return () => { clearTimeout(timer); };
  }, [open]);
  return gone && !open;
}
