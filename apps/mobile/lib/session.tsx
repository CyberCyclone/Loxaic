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
import { electronBridge, resolveEndpoint, subscribeToDesktopEndpoint } from './endpoint';
import { hydrateStorage } from './storage';

type SessionUser = Session['user'];

interface SessionState {
  /** Bootstrap (storage hydration + stored-token load) finished. */
  ready: boolean;
  token: string | null;
  user: SessionUser | null;
  /** Desktop only: this install has no stored instance mode, so there is no
   * server to sign in to yet. Routes to /onboarding ahead of the auth gate. */
  needsOnboarding: boolean;
  /** Desktop only: clears needsOnboarding and builds the session against the
   * server the chosen mode just brought up. Call before routing away from
   * /onboarding, or the app layout routes straight back. */
  completeOnboarding: () => Promise<void>;
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

  // Desktop only: an install with no stored mode has nothing to sign in to
  // yet, and the endpoint follows the main process from here on.
  const [needsOnboarding, setNeedsOnboarding] = useState(false);
  useEffect(() => subscribeToDesktopEndpoint(), []);

  /** Resolve the endpoint, load the token, and check it against the server.
   * Shared by first launch and by completing onboarding, which the first
   * launch skipped. */
  const bootstrapSession = useCallback(async (state: { cancelled: boolean }) => {
    await resolveEndpoint();
    let stored = await loadToken(); // also sets the api-client's AUTH_TOKEN
    let sessionUser: SessionUser | null = null;

    if (stored) {
      // getSession resolves null *only* on a 401 — a definitively dead
      // token — and throws when the server can't be reached. Those must not
      // be conflated: signing someone out because their self-hosted server
      // was briefly down would be worse than carrying on with a token that
      // is very probably still good.
      try {
        const info = await apiGetSession();
        if (info) {
          sessionUser = info.user;
        } else {
          // Dead token. It has to be cleared, not just left unused: the app
          // gate in app/(app)/_layout.tsx keys on `token` alone, so keeping
          // it drops the user into the authenticated shell where every
          // request 401s and nothing ever signs them out.
          await clearToken();
          stored = null;
        }
      } catch {
        // Server unreachable — no conclusion can be drawn about the token.
      }
    }

    if (!state.cancelled) {
      setToken(stored);
      setUser(sessionUser);
      setReady(true);
    }
  }, []);

  useEffect(() => {
    const state = { cancelled: false };
    void (async () => {
      await hydrateStorage();

      // Ask the desktop main process first. Its answer decides whether there
      // is a server to resolve at all — an unconfigured install has none, and
      // probing for one would just stall the splash before landing nowhere.
      const bridge = electronBridge();
      if (bridge) {
        try {
          const instance = await bridge.instance.getState();
          if (instance.needsOnboarding) {
            if (!state.cancelled) {
              setNeedsOnboarding(true);
              setReady(true);
            }
            return;
          }
        } catch {
          // An older shell without the bridge methods — fall through and
          // resolve the endpoint the way every other platform does.
        }
      }

      await bootstrapSession(state);
    })();
    return () => {
      state.cancelled = true;
    };
  }, [bootstrapSession]);

  /**
   * Leave onboarding for the app proper.
   *
   * `needsOnboarding` latches true when the bootstrap finds an unconfigured
   * install, and nothing used to clear it — so after choosing a mode the app
   * layout redirected straight back here, forever. Clearing the flag alone
   * isn't enough either: that bootstrap returned early, before resolving an
   * endpoint or loading a token, so the session has to be built now that
   * there is a server to build it against.
   */
  const completeOnboarding = useCallback(async () => {
    setNeedsOnboarding(false);
    await resolveEndpoint(true);
    await bootstrapSession({ cancelled: false });
  }, [bootstrapSession]);

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

  const value = useMemo(
    () => ({ ready, token, user, needsOnboarding, completeOnboarding, isAdmin: user?.role === 'admin', signIn, signUp, signOut }),
    [ready, token, user, needsOnboarding, completeOnboarding, signIn, signUp, signOut],
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
