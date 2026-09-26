import { useCallback, useEffect, useState } from 'react';
import {
  deleteGithubConnection,
  getGithubConnection,
  putGithubConnection,
  GithubApiError,
  isUnreachableError,
  type GithubConnection,
} from '@loxaic/api-client';
import { describeRequestError, useServerReachable } from '@/lib/connection';

/**
 * One GitHub connection per user, mirroring useSandboxSettings.ts's shape
 * (a single resource, not a list) rather than useMcpServers.ts's — there is
 * nothing here to add a second of.
 */
export function useGithubConnection(token: string | null) {
  const [connection, setConnection] = useState<GithubConnection | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** The connection could not be asked about. Not the same as "none": with
   * `connection` left null the screen used to offer the setup form, as if
   * GitHub had never been connected, whenever the server was unreachable. */
  const [unknown, setUnknown] = useState(false);
  const reachable = useServerReachable();

  const refresh = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      setConnection(await getGithubConnection());
      setUnknown(false);
      setError(null);
    } catch (err) {
      setUnknown(isUnreachableError(err));
      setError(describeRequestError(err, 'Failed to load GitHub connection'));
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Asked again when the server is back, instead of waiting for a remount.
  useEffect(() => {
    if (reachable && unknown) void refresh();
  }, [reachable, unknown, refresh]);

  const connect = useCallback(async (githubToken: string) => {
    setError(null);
    try {
      setConnection(await putGithubConnection(githubToken));
      return true;
    } catch (err) {
      setError(err instanceof GithubApiError ? err.message : describeRequestError(err, 'Failed to connect GitHub'));
      return false;
    }
  }, []);

  const disconnect = useCallback(async () => {
    // Same shape as connect: a failure here — server unreachable, a 500 —
    // used to escape as an unhandled rejection with the card still reading
    // "Connected as …" and no message, for a credential-removal action.
    setError(null);
    try {
      await deleteGithubConnection();
      setConnection(null);
      return true;
    } catch (err) {
      setError(err instanceof GithubApiError ? err.message : describeRequestError(err, 'Failed to disconnect GitHub'));
      return false;
    }
  }, []);

  return { connection, loading, unknown, error, connect, disconnect, refresh };
}
