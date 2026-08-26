import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  signIn as apiSignIn,
  signUp as apiSignUp,
  type Session,
} from '@shannon/api-client';
import { clearToken, loadToken, saveToken } from './auth';
import { resolveEndpoint } from './endpoint';
import { hydrateStorage } from './storage';

interface SessionState {
  /** Bootstrap (storage hydration + stored-token load) finished. */
  ready: boolean;
  token: string | null;
  signIn: (email: string, password: string) => Promise<Session>;
  signUp: (email: string, password: string, name?: string) => Promise<Session>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    const state = { cancelled: false };
    void (async () => {
      await hydrateStorage();
      await resolveEndpoint();
      const stored = await loadToken();
      if (!state.cancelled) {
        setToken(stored);
        setReady(true);
      }
    })();
    return () => {
      state.cancelled = true;
    };
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const session = await apiSignIn(email, password);
    await saveToken(session.token);
    setToken(session.token);
    return session;
  }, []);

  const signUp = useCallback(
    async (email: string, password: string, name?: string) => {
      const session = await apiSignUp(email, password, name);
      await saveToken(session.token);
      setToken(session.token);
      return session;
    },
    [],
  );

  const signOut = useCallback(async () => {
    await clearToken();
    setToken(null);
  }, []);

  const value = useMemo(
    () => ({ ready, token, signIn, signUp, signOut }),
    [ready, token, signIn, signUp, signOut],
  );

  return (
    <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
  );
}

export function useSession(): SessionState {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used within SessionProvider');
  return ctx;
}
