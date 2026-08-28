import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { setAuthToken } from '@shannon/api-client';

const TOKEN_KEY = 'shannon-session-token';

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
    if (Platform.OS === 'web') {
      globalThis.localStorage.setItem(TOKEN_KEY, token);
    } else {
      await SecureStore.setItemAsync(TOKEN_KEY, token);
    }
  } catch {
    /* session continues in-memory; it just won't survive a restart */
  }
}

export async function loadToken(): Promise<string | null> {
  let token: string | null = null;
  try {
    if (Platform.OS === 'web') {
      token = globalThis.localStorage.getItem(TOKEN_KEY);
    } else {
      token = await SecureStore.getItemAsync(TOKEN_KEY);
    }
  } catch {
    token = null;
  }
  setAuthToken(token);
  return token;
}

export async function clearToken(): Promise<void> {
  setAuthToken(null);
  try {
    if (Platform.OS === 'web') {
      globalThis.localStorage.removeItem(TOKEN_KEY);
    } else {
      await SecureStore.deleteItemAsync(TOKEN_KEY);
    }
  } catch {
    /* nothing stored, or storage unavailable — signed out either way */
  }
}
