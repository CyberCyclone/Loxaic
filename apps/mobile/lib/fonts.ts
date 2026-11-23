import { Platform } from 'react-native';

/** The family expo-font registers JetBrains Mono under (app/_layout.tsx). */
export const MONO_FAMILY = 'JetBrainsMono_400Regular';

/**
 * The font family for machine output (code, tool results, the terminal).
 *
 * The app still renders when its fonts fail to load (system fonts beat a blank
 * app), and then JetBrains Mono is not registered: naming it alone would set
 * code in a serif on web and in the proportional system font on native,
 * scrambling aligned output. Web takes a CSS stack; native takes one family,
 * so it gets the platform's own monospace when ours is missing (iOS has no
 * family called `monospace`).
 */
export function monoFontFamily(loaded: boolean, os: string): string {
  if (os === 'web') return `${MONO_FAMILY}, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
  if (loaded) return MONO_FAMILY;
  return os === 'ios' ? 'Menlo' : 'monospace';
}

// Set once by RootLayout before it renders anything that reads monoFont().
let monoLoaded = false;

export function setMonoLoaded(loaded: boolean): void {
  monoLoaded = loaded;
}

/** The mono family for this platform, given whether the fonts loaded. */
export function monoFont(): string {
  return monoFontFamily(monoLoaded, Platform.OS);
}
