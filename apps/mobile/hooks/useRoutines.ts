import { useCallback, useEffect, useState } from 'react';
import {
  getRoutines,
  createRoutine,
  updateRoutine,
  deleteRoutine,
  runRoutineNow,
  getRoutineRuns,
  type Routine,
  type RoutineRun,
} from '@loxaic/api-client';
import { useToastHelper } from './useToastHelper';

export function useRoutines(token: string | null) {
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [loading, setLoading] = useState(true);
  const { showToast } = useToastHelper();

  const refresh = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      setRoutines(await getRoutines());
    } catch {
      showToast('Failed to load routines');
    } finally {
      setLoading(false);
    }
  }, [token, showToast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const create = useCallback(
    async (input: { name: string; cron: string; prompt: string; model: string }) => {
      const r = await createRoutine(input);
      setRoutines((prev) => [r, ...prev]);
      showToast('Routine created');
      return r;
    },
    [showToast],
  );

  const update = useCallback(
    async (
      id: string,
      // No `null` for model: it can be changed, never removed.
      patch: Partial<{ name: string; cron: string; prompt: string; enabled: boolean; model: string }>,
    ) => {
      const r = await updateRoutine(id, patch);
      setRoutines((prev) => prev.map((x) => (x.id === r.id ? r : x)));
      return r;
    },
    [],
  );

  const toggle = useCallback(
    async (id: string, enabled: boolean) => {
      await update(id, { enabled });
      showToast(enabled ? 'Routine enabled' : 'Routine disabled');
    },
    [update, showToast],
  );

  const remove = useCallback(
    async (id: string) => {
      // The failure is reported rather than thrown at nobody: this is called
      // as `void remove(id)` from a press handler, so a rejection was an
      // unhandled one — and the row was dropped from the list either way, so
      // a delete the server refused looked exactly like one that worked until
      // the next refresh put it back.
      try {
        await deleteRoutine(id);
      } catch (err) {
        showToast(`Could not delete: ${err instanceof Error ? err.message : String(err)}`, 4000);
        await refresh();
        return;
      }
      setRoutines((prev) => prev.filter((x) => x.id !== id));
      showToast('Routine deleted');
    },
    [showToast, refresh],
  );

  const runNow = useCallback(
    async (id: string) => {
      showToast('Routine triggered — running now');
      const run = await runRoutineNow(id);
      await refresh();
      return run;
    },
    [showToast, refresh],
  );

  return { routines, loading, refresh, create, update, toggle, remove, runNow, getRuns: getRoutineRuns };
}

export type { Routine, RoutineRun };
