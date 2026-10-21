/**
 * What the Server Settings screen shows. A request that failed is its own
 * state with a reason and a retry, never a spinner: the spinner is only for a
 * request still on its way.
 */
export type ServerScreenView = 'readOnly' | 'settings' | 'loadFailed' | 'loading';

export function serverScreenView(input: { isAdmin: boolean; hasSettings: boolean; loadError: string | null }): ServerScreenView {
  if (!input.isAdmin) return 'readOnly';
  // Settings already on screen stay readable when a later refresh fails.
  if (input.hasSettings) return 'settings';
  if (input.loadError !== null) return 'loadFailed';
  return 'loading';
}
