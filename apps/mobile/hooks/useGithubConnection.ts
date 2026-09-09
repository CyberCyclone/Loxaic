import { useCallback, useEffect, useState } from 'react';
import {
  deleteGithubConnection,
  getGithubConnection,
  putGithubConnection,
  GithubApiError,
  type GithubConnection,
} from '@loxaic/api-client';

/**
 * One GitHub connection per user, mirroring useSandboxSettings.ts's shape
 * (a single resource, not a list) rather than useMcpServers.ts's — there is
 * nothing here to add a second of.
 */
export function useGithubConnection(token: string | null) {
  const [connection, setConnection] = useState<GithubConnection | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      setConnection(await getGithubConnection());
      setError(null);
    } catch {
      setError('Failed to load GitHub connection');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const connect = useCallback(async (githubToken: string) => {
    setError(null);
    try {
      setConnection(await putGithubConnection(githubToken));
      return true;
    } catch (err) {
      setError(err instanceof GithubApiError ? err.message : 'Failed to connect GitHub');
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
      setError(err instanceof GithubApiError ? err.message : 'Failed to disconnect GitHub');
      return false;
    }
  }, []);

  return { connection, loading, error, connect, disconnect, refresh };
}
