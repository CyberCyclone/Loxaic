import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  getSession as apiGetSession,
  signIn as apiSignIn,
  signUp as apiSignUp,
  type Session,
} from '@shannon/api-client';
import { clearToken, loadToken, saveToken } from './auth';
import { resolveEndpoint } from './endpoint';
import { hydrateStorage } from './storage';

type SessionUser = Session['user'];

interface SessionState {
  /** Bootstrap (storage hydration + stored-token load) finished. */
  ready: boolean;
  token: string | null;
  user: SessionUser | null;
  isAdmin: boolean;
  signIn: (email: string, password: string) => Promise<Session>;
  signUp: (email: string, password: string, name?: string) => Promise<Session>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<SessionUser | null>(null);

  useEffect(() => {
    const state = { cancelled: false };
    void (async () => {
      await hydrateStorage();
      await resolveEndpoint();
      const stored = await loadToken(); // also sets the api-client's AUTH_TOKEN
      if (stored) {
        const info = await apiGetSession().catch(() => null);
        if (!state.cancelled) setUser(info?.user ?? null);
      }
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
    await saveToken(session.token); // also sets the api-client's AUTH_TOKEN
    setToken(session.token);
    setUser(session.user);
    return session;
  }, []);

  const signUp = useCallback(
    async (email: string, password: string, name?: string) => {
      const session = await apiSignUp(email, password, name);
      await saveToken(session.token); // also sets the api-client's AUTH_TOKEN
      setToken(session.token);
      setUser(session.user);
      return session;
    },
    [],
  );

  const signOut = useCallback(async () => {
    await clearToken(); // also clears the api-client's AUTH_TOKEN
    setToken(null);
    setUser(null);
  }, []);

  const isAdmin = user?.role === 'admin';

  const value = useMemo(
    () => ({ ready, token, user, isAdmin, signIn, signUp, signOut }),
    [ready, token, user, isAdmin, signIn, signUp, signOut],
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
