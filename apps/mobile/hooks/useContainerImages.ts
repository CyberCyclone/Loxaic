import { useCallback, useEffect, useRef, useState } from 'react';
import {
  addSandboxImage,
  deleteRegistryLogin,
  deleteSandboxImage,
  getRegistryLogins,
  getSandboxImageList,
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
import { createReadGate } from '@/lib/readGate';

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
  /** Whether the server can see /dev/kvm (shared images only, #320); null
   * when it did not say. */
  const [kvmVisible, setKvmVisible] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  /** The lists could not be asked for — not the same as "none". */
  const [unknown, setUnknown] = useState(false);
  /** Kept apart: a reload that succeeds clears a failed load's message, but
   * never the sentence a refused write just showed. */
  const [loadError, setLoadError] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const reachable = useServerReachable();
  /** Which responses may land: see lib/readGate.ts. */
  const gate = useRef(createReadGate());

  const refresh = useCallback(async () => {
    if (!token) return;
    const mine = gate.current.beginRead();
    try {
      const [l, list] = await Promise.all([getRegistryLogins(scope), getSandboxImageList(scope)]);
      if (!gate.current.landed(mine)) return;
      setLogins(l);
      setImages(list.images);
      setKvmVisible(list.kvm?.visible ?? null);
      setUnknown(false);
      setLoadError(null);
    } catch (err) {
      if (!gate.current.landed(mine)) return;
      setUnknown(true);
      setLoadError(describeRequestError(err, "Couldn't load images"));
    } finally {
      gate.current.endRead();
      if (gate.current.landed(mine)) setLoading(false);
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
    // A tick with a read still out is skipped rather than stacked behind it.
    const timer = setInterval(() => { if (!gate.current.busy()) void refresh(); }, PULL_POLL_MS);
    return () => { clearInterval(timer); };
  }, [pulling, refresh]);

  /** Runs a write, then reloads; returns whether it succeeded, with the
   * server's sentence in `error` when not. */
  const write = useCallback(
    async (action: () => Promise<unknown>, fallback: string): Promise<boolean> => {
      setWriteError(null);
      gate.current.write();
      try {
        await action();
        await refresh();
        return true;
      } catch (err) {
        // The write ruled out any read still on its way, the first load
        // included; ask again so the screen is never left on its spinner.
        void refresh();
        setWriteError(err instanceof ImageApiError ? err.message : describeRequestError(err, fallback));
        return false;
      }
    },
    [refresh],
  );

  return {
    logins,
    images,
    kvmVisible,
    loading,
    unknown,
    error: writeError ?? loadError,
    refresh,
    saveLogin: (input: { registry: string; username: string; password: string }) =>
      write(() => putRegistryLogin(scope, input), "Couldn't save the login"),
    removeLogin: (id: string) => write(() => deleteRegistryLogin(scope, id), "Couldn't remove the login"),
    addImage: (input: { reference: string; label?: string; limits?: ImageLimits }) =>
      write(() => addSandboxImage(scope, input), "Couldn't add the image"),
    pullImage: (id: string) => write(() => pullSandboxImage(scope, id), "Couldn't pull the image"),
    updateImage: (id: string, input: { label?: string; limits?: Partial<ImageLimits> }) =>
      write(() => updateSandboxImage(scope, id, input), "Couldn't save the image"),
    removeImage: (id: string) => write(() => deleteSandboxImage(scope, id), "Couldn't remove the image"),
  };
}
