/**
 * The status bar's content style for the theme the app has applied.
 *
 * Android draws status bar icons from the system's light/dark setting, not the
 * app's: with the app set to light on a phone in dark mode, the clock and icons
 * stayed white on the light page. iOS follows the app's appearance by itself;
 * setting it on both keeps them the same.
 */
export function statusBarStyle(theme: string | undefined): 'light-content' | 'dark-content' {
  return theme === 'light' ? 'dark-content' : 'light-content';
}
