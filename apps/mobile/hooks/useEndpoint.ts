import { useSyncExternalStore } from 'react';
import { currentEndpoint, onEndpointChange } from '@/lib/endpoint';

/**
 * The API endpoint currently in force, re-rendering when it changes.
 *
 * Exists so a socket effect can *depend* on the endpoint. Changing where the
 * API lives — a Settings override, or a desktop mode switch pushed over the
 * bridge — used to update storage and the api-client while the live chat and
 * agent sockets stayed connected to the old server until the app restarted.
 * Including this in their dependency arrays is what makes the change take
 * effect: the effect tears down and reconnects to the new host.
 */
export function useEndpoint(): string | null {
  return useSyncExternalStore(onEndpointChange, currentEndpoint, currentEndpoint);
}
