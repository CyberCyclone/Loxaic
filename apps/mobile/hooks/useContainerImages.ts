import { useCallback, useEffect, useRef, useState } from 'react';
import {
  addSandboxImage,
  deleteRegistryLogin,
  deleteSandboxImage,
  getRegistryLogins,
  getSandboxImages,
  ImageApiError,
  pullSandboxImage,
  putRegistryLogin,
  updateSandboxImage,
  type ImageLimits,
  type ImageScope,
  type RegistryLogin,
  type SandboxImage,
} from '@loxaic/api-client';
import { describeRequestError, useServerReachable } from '@/lib/connection';
import { anyPulling } from '@/lib/customImages';

/** How often a list with a pull in progress is asked again. */
const PULL_POLL_MS = 1_000;

/**
 * One scope's registry logins and images (#253): the caller's own
 * (`personal`), or the shared ones an admin manages. Polls while a pull runs,
 * so a row goes from "Pulling…" to its outcome without a reload.
 */
export function useContainerImages(scope: ImageScope, token: string | null) {
  const [logins, setLogins] = useState<RegistryLogin[]>([]);
  const [images, setImages] = useState<SandboxImage[]>([]);
  const [loading, setLoading] = useState(true);
  /** The lists could not be asked for — not the same as "none". */
  const [unknown, setUnknown] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reachable = useServerReachable();
  /** Bumped by every write, so a poll that started before it cannot land
   * afterwards and put the old list back. */
  const sequence = useRef(0);

  const refresh = useCallback(async () => {
    if (!token) return;
    const mine = ++sequence.current;
    try {
      const [l, i] = await Promise.all([getRegistryLogins(scope), getSandboxImages(scope)]);
      if (mine !== sequence.current) return;
      setLogins(l);
      setImages(i);
      setUnknown(false);
    } catch (err) {
      if (mine !== sequence.current) return;
      setUnknown(true);
      setError(describeRequestError(err, "Couldn't load images"));
    } finally {
      if (mine === sequence.current) setLoading(false);
    }
  }, [scope, token]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (reachable && unknown) void refresh();
  }, [reachable, unknown, refresh]);

  const pulling = anyPulling(images);
  useEffect(() => {
    if (!pulling) return;
    const timer = setInterval(() => { void refresh(); }, PULL_POLL_MS);
    return () => { clearInterval(timer); };
  }, [pulling, refresh]);

  /** Runs a write, then reloads; returns whether it succeeded, with the
   * server's sentence in `error` when not. */
  const write = useCallback(
    async (action: () => Promise<unknown>, fallback: string): Promise<boolean> => {
      setError(null);
      sequence.current++;
      try {
        await action();
        await refresh();
        return true;
      } catch (err) {
        setError(err instanceof ImageApiError ? err.message : describeRequestError(err, fallback));
        return false;
      }
    },
    [refresh],
  );

  return {
    logins,
    images,
    loading,
    unknown,
    error,
    refresh,
    saveLogin: (input: { registry: string; username: string; password: string }) =>
      write(() => putRegistryLogin(scope, input), "Couldn't save the login"),
    removeLogin: (id: string) => write(() => deleteRegistryLogin(scope, id), "Couldn't remove the login"),
    addImage: (input: { reference: string; label?: string; limits?: ImageLimits }) =>
      write(() => addSandboxImage(scope, input), "Couldn't add the image"),
    pullImage: (id: string) => write(() => pullSandboxImage(scope, id), "Couldn't pull the image"),
    updateImage: (id: string, input: { label?: string; limits?: ImageLimits }) =>
      write(() => updateSandboxImage(scope, id, input), "Couldn't save the image"),
    removeImage: (id: string) => write(() => deleteSandboxImage(scope, id), "Couldn't remove the image"),
  };
}
