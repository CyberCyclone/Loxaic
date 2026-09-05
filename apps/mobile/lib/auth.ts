import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { setAuthToken } from '@loxaic/api-client';
import { currentEndpoint } from './endpoint';

/**
 * The unscoped slot, used when no endpoint has resolved yet.
 *
 * Before the Loxaic rename this constant did double duty: the flat key and
 * the key older releases had written were the same string, so one name served
 * both. They are different strings now, and conflating them is how a rename
 * strands a credential — see `PRE_RENAME_TOKEN_KEY`.
 */
const FLAT_TOKEN_KEY = 'loxaic-session-token';

/**
 * The flat key written by pre-rename (Shannon-branded) releases.
 *
 * Purged, never adopted. Carrying a bearer token across a rebrand would
 * contradict the clean break the rename is, and the alternative — leaving it
 * — is worse still: no code path reads this key any more, so nothing would
 * ever delete a credential that stays valid server-side for the life of its
 * session row. `storage.ts`'s `purgePreRenameKeys` handles the web side (and
 * everything else under the old prefix); this covers native SecureStore,
 * which has no key enumeration and so must name its keys exactly.
 */
const PRE_RENAME_TOKEN_KEY = 'shannon-session-token';

/**
 * One token per server, keyed by endpoint.
 *
 * A single flat key meant switching hosts presented the *previous* host's
 * token to the new one, which 401s — and the bootstrap then clears it as a
 * dead token, so returning to the first host required signing in again.
 * Scoping keeps each host's session intact, which is what makes joining a
 * second host (and detaching from it) tolerable rather than destructive.
 *
 * The endpoint is normalized so a trailing slash doesn't create a second,
 * empty session slot.
 */
function tokenKey(endpoint: string | null): string {
  if (!endpoint) return FLAT_TOKEN_KEY;
  return `loxaic-session-token:${endpoint.replace(/\/+$/, '')}`;
}

/** Persist the session token: SecureStore on native, localStorage on web.
 *
 * Every path is guarded: the iOS Keychain can genuinely fail at runtime (a
 * locked device, a build without the application-identifier entitlement), and
 * an unhandled rejection here happens during the session bootstrap — before
 * anything has rendered — leaving the app permanently blank with no error UI.
 * A storage failure must degrade to signed-out instead. */
export async function saveToken(token: string): Promise<void> {
  setAuthToken(token);
  try {
    const key = tokenKey(currentEndpoint());
    if (Platform.OS === 'web') {
      globalThis.localStorage.setItem(key, token);
    } else {
      await SecureStore.setItemAsync(secureKey(key), token);
    }
  } catch {
    /* session continues in-memory; it just won't survive a restart */
  }
}

export async function loadToken(): Promise<string | null> {
  const endpoint = currentEndpoint();
  let token: string | null = null;
  try {
    const key = tokenKey(endpoint);
    if (Platform.OS === 'web') {
      token = globalThis.localStorage.getItem(key);
    } else {
      token = await SecureStore.getItemAsync(secureKey(key));
    }
  } catch {
    token = null;
  }
  setAuthToken(token);
  return token;
}

/**
 * Deletes any pre-rename token from native SecureStore. Web is covered by
 * `purgePreRenameKeys`, which can enumerate `localStorage`; SecureStore
 * cannot be enumerated, so both shapes a pre-rename release could have
 * written are named explicitly:
 *
 *   - the flat key, from before tokens were scoped per endpoint;
 *   - this endpoint's scoped key, which is the one an install upgrading from
 *     any recent release actually holds.
 *
 * Only the current endpoint's scoped key is reachable — a token stored for a
 * host this install has since stopped using can't be named without the
 * endpoint, and SecureStore won't list it. That residue is called out in the
 * upgrade notes; reinstalling clears the Keychain entry outright.
 */
export async function purgePreRenameToken(endpoint: string | null): Promise<void> {
  if (Platform.OS === 'web') return;
  const stale = [PRE_RENAME_TOKEN_KEY];
  if (endpoint) stale.push(`${PRE_RENAME_TOKEN_KEY}:${endpoint.replace(/\/+$/, '')}`);
  for (const key of stale) {
    try {
      await SecureStore.deleteItemAsync(secureKey(key));
    } catch {
      // A locked device or a missing entitlement — retries next launch.
    }
  }
}

/**
 * SecureStore keys allow only [A-Za-z0-9._-], and an endpoint carries `:` and
 * `/`. Encode rather than hash, so the key stays greppable when debugging a
 * device — nothing secret is in the endpoint.
 *
 * Encoded *injectively*. The first version replaced every disallowed byte with
 * `_`, which is many-to-one: `http://box:4100` and `http://box/4100` collapsed
 * onto one slot, so host A's bearer token was loaded and *presented to* host B
 * — the inverse of what endpoint-scoping exists for, and worse than the bug it
 * fixed. Each disallowed byte becomes `_` + its two-hex-digit code, which is
 * reversible and still readable.
 *
 * Changing this changes every existing native key, so installs that stored a
 * token under the old scheme are signed out once. The legacy flat-key
 * migration can't help them (their key wasn't the legacy one). That is a
 * deliberate one-time cost against a credential going to the wrong server.
 */
function secureKey(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]/g, (c) => `_${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

/** Clears this endpoint's token (or a named one, for detach). */
export async function clearToken(endpoint?: string): Promise<void> {
  setAuthToken(null);
  try {
    const key = tokenKey(endpoint ?? currentEndpoint());
    if (Platform.OS === 'web') {
      globalThis.localStorage.removeItem(key);
    } else {
      await SecureStore.deleteItemAsync(secureKey(key));
    }
  } catch {
    /* nothing stored, or storage unavailable — signed out either way */
  }
}
