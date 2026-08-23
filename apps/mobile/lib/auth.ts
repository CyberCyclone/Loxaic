import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { setAuthToken } from '@shannon/api-client';

const TOKEN_KEY = 'shannon-session-token';

/** Persist the session token: SecureStore on native, localStorage on web. */
export async function saveToken(token: string): Promise<void> {
  setAuthToken(token);
  if (Platform.OS === 'web') {
    try {
      globalThis.localStorage?.setItem(TOKEN_KEY, token);
    } catch {
      /* ignore */
    }
    return;
  }
  await SecureStore.setItemAsync(TOKEN_KEY, token);
}

export async function loadToken(): Promise<string | null> {
  let token: string | null = null;
  if (Platform.OS === 'web') {
    try {
      token = globalThis.localStorage?.getItem(TOKEN_KEY) ?? null;
    } catch {
      token = null;
    }
  } else {
    token = await SecureStore.getItemAsync(TOKEN_KEY);
  }
  setAuthToken(token);
  return token;
}

export async function clearToken(): Promise<void> {
  setAuthToken(null);
  if (Platform.OS === 'web') {
    try {
      globalThis.localStorage?.removeItem(TOKEN_KEY);
    } catch {
      /* ignore */
    }
    return;
  }
  await SecureStore.deleteItemAsync(TOKEN_KEY);
}
