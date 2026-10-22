import { useCallback, useEffect, useRef, useState } from 'react';
import { getMySandboxAllocation, pauseSandbox, type MySandboxAllocation } from '@loxaic/api-client';
import { describeRequestError, useServerReachable } from '@/lib/connection';
import { createReadGate } from '@/lib/readGate';
import { useToastHelper } from './useToastHelper';

/** Often enough that Pause comes back soon after a run ends. */
const POLL_MS = 4000;

/**
 * The signed-in person's sandbox allocation and sandboxes (#254), polled while
 * the screen is open so a run starting or ending elsewhere shows here, and the
 * Pause action. A pause invalidates any poll already on its way (`readGate`),
 * so a list from before it cannot put the sandbox back as running.
 */
export function useSandboxAllocation(token: string | null) {
  const reachable = useServerReachable();
  const [data, setData] = useState<MySandboxAllocation | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pausing, setPausing] = useState<string | null>(null);
  const gate = useRef(createReadGate()).current;
  const { showToast } = useToastHelper();

  const refresh = useCallback(async () => {
    if (!token) return;
    const read = gate.beginRead();
    try {
      const next = await getMySandboxAllocation();
      if (!gate.landed(read)) return;
      setData(next);
      setLoadError(null);
    } catch (err) {
      if (!gate.landed(read)) return;
      setLoadError(describeRequestError(err, "Couldn't load your sandboxes."));
    } finally {
      gate.endRead();
      setLoading(false);
    }
  }, [token, gate]);

  // Again whenever the server comes back, and on a timer while it is there.
  useEffect(() => {
    if (!reachable) return;
    void refresh();
    const timer = setInterval(() => {
      if (!gate.busy()) void refresh();
    }, POLL_MS);
    return () => { clearInterval(timer); };
  }, [reachable, refresh, gate]);

  const pause = useCallback(
    async (sandboxId: string) => {
      setPausing(sandboxId);
      gate.write();
      try {
        await pauseSandbox(sandboxId);
      } catch (err) {
        showToast(describeRequestError(err, "Couldn't pause that sandbox."), 4000);
      } finally {
        setPausing(null);
        await refresh();
      }
    },
    [gate, refresh, showToast],
  );

  return { data, loading, loadError, pausing, refresh, pause };
}
