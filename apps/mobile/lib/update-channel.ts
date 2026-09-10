import { useSyncExternalStore } from 'react';
import { getItem, setItem } from './storage';

/**
 * Which stream of over-the-air updates this install follows.
 *
 * `production` is what a release build ships on; `beta` is opt-in and gets
 * the same updates earlier. One binary serves both — the channel is a request
 * header the app sets at runtime (see lib/expo-updates.ts), not something
 * baked into the build — so switching is a preference, not a reinstall.
 *
 * Stored rather than derived because the *stored* value is what the app
 * re-applies on every launch: `Updates.channel` reports what the binary was
 * built for, which stays "production" forever however many times someone
 * switches to beta.
 */
export type UpdateChannel = 'production' | 'beta';

export const UPDATE_CHANNELS: UpdateChannel[] = ['production', 'beta'];

const KEY = 'loxaic-update-channel';

// Module-singleton + useSyncExternalStore, the same shape hooks/useTheme.ts
// uses: this is read from a React component (the settings row) and from plain
// module code (the launch-time check), and both have to see one value.
const listeners = new Set<() => void>();
let current: UpdateChannel = 'production';
let loaded = false;

function read(): UpdateChannel {
  if (!loaded) {
    // Anything unrecognised reads as production. A garbled value must not
    // strand someone on a channel they cannot name — and production is the
    // conservative half of the choice.
    current = getItem(KEY) === 'beta' ? 'beta' : 'production';
    loaded = true;
  }
  return current;
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Subscribe outside React — the update layer re-applies the channel when it
 * changes, and it is not a component. Returns an unsubscribe. */
export function subscribeUpdateChannel(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** The stored channel, outside React. */
export function readUpdateChannel(): UpdateChannel {
  return read();
}

/** Writes the channel and notifies every reader. Applying it to the update
 * layer is the caller's job — see lib/expo-updates.ts's applyChannel. */
export function setUpdateChannel(channel: UpdateChannel): void {
  read(); // ensure the initial load happened, so `loaded` can't clobber this
  current = channel;
  setItem(KEY, channel);
  listeners.forEach((l) => { l(); });
}

/** For tests: forget the cached value so the next read comes from storage. */
export function __resetUpdateChannelForTest(): void {
  loaded = false;
  current = 'production';
}

export function useUpdateChannel(): UpdateChannel {
  return useSyncExternalStore(subscribe, read, read);
}
