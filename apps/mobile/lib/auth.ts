import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { setAuthToken } from '@loxaic/api-client';
import { currentEndpoint } from './endpoint';

const LEGACY_TOKEN_KEY = 'loxaic-session-token';

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
  if (!endpoint) return LEGACY_TOKEN_KEY;
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
      token = globalThis.localStorage.getItem(key) ?? migrateLegacyWeb(key);
    } else {
      token = (await SecureStore.getItemAsync(secureKey(key))) ?? (await migrateLegacyNative(key));
    }
  } catch {
    token = null;
  }
  setAuthToken(token);
  return token;
}

/**
 * One-time move of the old flat key into this endpoint's slot.
 *
 * Without it every existing install is silently signed out by this change.
 * The legacy token belongs to whatever endpoint the app was last using, and
 * on the overwhelmingly common single-server install that is the endpoint
 * resolving right now — so adopting it here is correct, and the legacy key is
 * removed afterwards so it can never be adopted by a *second* host later.
 */
function migrateLegacyWeb(key: string): string | null {
  try {
    const legacy = globalThis.localStorage.getItem(LEGACY_TOKEN_KEY);
    if (!legacy) return null;
    globalThis.localStorage.setItem(key, legacy);
    globalThis.localStorage.removeItem(LEGACY_TOKEN_KEY);
    return legacy;
  } catch {
    return null;
  }
}

async function migrateLegacyNative(key: string): Promise<string | null> {
  try {
    const legacy = await SecureStore.getItemAsync(LEGACY_TOKEN_KEY);
    if (!legacy) return null;
    await SecureStore.setItemAsync(secureKey(key), legacy);
    await SecureStore.deleteItemAsync(LEGACY_TOKEN_KEY);
    return legacy;
  } catch {
    return null;
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
