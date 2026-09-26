import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  changePassword as apiChangePassword,
  getSession as apiGetSession,
  signIn as apiSignIn,
  signUp as apiSignUp,
  type Session,
} from '@loxaic/api-client';
import { clearToken, loadToken, saveToken } from './auth';
import { currentEndpoint, electronBridge, resolveEndpoint, subscribeToDesktopEndpoint } from './endpoint';
import { setSessionCheck } from './connectionMonitor';
import { useConnection } from './connection';
import { clearCacheForEndpoint, rememberUserId } from './message-cache';
import { hydrateStorage } from './storage';

type SessionUser = Session['user'];

/** How long the launch waits to learn who is signed in. A hung server — one
 * that accepts the connection and answers nothing, as a host that is asleep
 * or wedged does — otherwise held the splash screen for the platform's own
 * network timeout: a minute on iOS, longer in Chromium. Past it the launch
 * carries on exactly as for an unreachable server. */
const LAUNCH_SESSION_TIMEOUT_MS = 5_000;

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
  /**
   * An administrator (or the server's reset command) reset this account's
   * password, and the server refuses everything but a password change until
   * it is replaced. The app layout routes to /change-password on it.
   *
   * Learned from the ordinary session read at launch: GET /api/auth/session
   * is not behind the check (see apps/server/src/auth/middleware.ts), so
   * bootstrap needs no special case.
   */
  mustChangePassword: boolean;
  /** Always signs out every other device; rejects with the api-client's
   * ApiError (branch on `code`). */
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  signIn: (email: string, password: string) => Promise<Session>;
  signUp: (email: string, password: string, name?: string) => Promise<Session>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionState | null>(null);

/**
 * Remember who this endpoint is signed in as, for offline cache scoping.
 *
 * Called from *every* path that establishes a session — bootstrap, sign-in,
 * and sign-up alike. Wiring it only into the bootstrap looked sufficient and
 * wasn't: a fresh sign-up sets the user from its own response and never goes
 * through that branch, so the very first session on a machine remembered
 * nothing and its cache was unreadable offline.
 */
function rememberSessionUser(userId: string): void {
  const endpoint = currentEndpoint();
  if (endpoint) rememberUserId(endpoint, userId);
}

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
      const launch = new AbortController();
      const deadline = setTimeout(() => { launch.abort(); }, LAUNCH_SESSION_TIMEOUT_MS);
      try {
        const info = await apiGetSession({ signal: launch.signal });
        if (info) {
          sessionUser = info.user;
          // Remembered so the cache can still be scoped when the server is
          // unreachable — see message-cache's rememberUserId.
          rememberSessionUser(info.user.id);
        } else {
          // Dead token. It has to be cleared, not just left unused: the app
          // gate in app/(app)/_layout.tsx keys on `token` alone, so keeping
          // it drops the user into the authenticated shell where every
          // request 401s and nothing ever signs them out.
          await clearToken();
          stored = null;
        }
      } catch {
        // Server unreachable, or too slow to wait for — no conclusion can be
        // drawn about the token, so it is kept and the user is left unknown
        // until the server answers (see below). Whether the host is down is
        // the connection monitor's to say.
      } finally {
        clearTimeout(deadline);
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
    rememberSessionUser(session.user.id);
    return session;
  }, []);

  const signUp = useCallback(
    async (email: string, password: string, name?: string) => {
      const session = await apiSignUp(email, password, name);
      await saveToken(session.token); // also sets the api-client's AUTH_TOKEN
      setToken(session.token);
      setUser(session.user);
      rememberSessionUser(session.user.id);
      return session;
    },
    [],
  );

  const changePassword = useCallback(async (currentPassword: string, newPassword: string) => {
    const result = await apiChangePassword(currentPassword, newPassword);
    // The server revoked every session for this account, *this one included*,
    // and minted a replacement. The token in the response is now the only
    // live one; keeping the old token would be indistinguishable from being
    // signed out by our own password change.
    await saveToken(result.token); // also sets the api-client's AUTH_TOKEN
    setToken(result.token);
    setUser({ ...result.user, mustChangePassword: false });
  }, []);

  const signOut = useCallback(async () => {
    // Sign-out is the moment a user expects their content to stop being
    // reachable on this device — and the cache is plaintext conversation
    // bodies in localStorage on web/Electron. Clearing it was wired only into
    // Electron detach, which looked deliberate and wasn't: detach is a
    // desktop-only path, sign-out is the universal one. The remembered user
    // id goes with it (same prefix) — keeping it would leave a stale record of
    // the last account used on the machine, scoping data that no longer exists.
    const endpoint = currentEndpoint();
    await clearToken(); // also clears the api-client's AUTH_TOKEN
    if (endpoint) clearCacheForEndpoint(endpoint);
    setToken(null);
    setUser(null);
  }, []);

  // Two things only the connection monitor can notice (lib/connectionMonitor.ts):
  // - A socket refused for its session (close 4001) with the server otherwise
  //   fine. Without this the socket reopened and was refused forever, under a
  //   banner claiming the server was unreachable. A dead session signs out.
  // - The server reachable while the user is still unknown: a launch that
  //   could not reach it, or gave up waiting. The bootstrap kept the token but
  //   learned nothing about the user, so isAdmin and mustChangePassword read
  //   false until a restart. Keyed on "reachable", not "came back after
  //   failing": a server that was only slow at launch never fails a probe.
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const refresh = useCallback(async (signOutIfDead: boolean) => {
    if (!tokenRef.current) return;
    try {
      const info = await apiGetSession();
      if (info) {
        setUser(info.user);
        rememberSessionUser(info.user.id);
      } else if (signOutIfDead) {
        await signOut();
      }
    } catch {
      // Still unreachable: the monitor keeps trying, and so will this.
    }
  }, [signOut]);
  useEffect(() => {
    setSessionCheck(() => { void refresh(true); });
    return () => { setSessionCheck(null); };
  }, [refresh]);
  const connection = useConnection();
  useEffect(() => {
    if (connection === 'online' && token && !user) void refresh(false);
  }, [connection, token, user, refresh]);

  const value = useMemo(
    () => ({
      ready,
      token,
      user,
      needsOnboarding,
      completeOnboarding,
      isAdmin: user?.role === 'admin',
      mustChangePassword: user?.mustChangePassword === true,
      changePassword,
      signIn,
      signUp,
      signOut,
    }),
    [ready, token, user, needsOnboarding, completeOnboarding, changePassword, signIn, signUp, signOut],
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
