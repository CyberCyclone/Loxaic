import { useWindowDimensions } from 'react-native';

export type Breakpoint = 'narrow' | 'medium' | 'wide';

/**
 * Mirrors the loxaic.css shell breakpoints:
 * wide ≥ 1024 → persistent sidebar + thread list;
 * medium 768–1023 → slide-over panels;
 * narrow < 768 → phone layout (list ↔ conversation states, bottom sheets).
 */
export function useBreakpoint(): Breakpoint {
  const { width } = useWindowDimensions();
  if (width >= 1024) return 'wide';
  if (width >= 768) return 'medium';
  return 'narrow';
}
