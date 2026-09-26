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
import { describeRequestError } from '@/lib/connection';
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

  // Called as `void toggle(…)`: a throw was an unhandled rejection, and the
  // switch snapped back with nothing said.
  const toggle = useCallback(
    async (id: string, enabled: boolean) => {
      try {
        await update(id, { enabled });
        showToast(enabled ? 'Routine enabled' : 'Routine disabled');
      } catch (err) {
        showToast(describeRequestError(err, 'Could not change the routine'), 4000);
      }
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
        showToast(`Could not delete: ${describeRequestError(err, 'something went wrong')}`, 4000);
        await refresh();
        return;
      }
      setRoutines((prev) => prev.filter((x) => x.id !== id));
      showToast('Routine deleted');
    },
    [showToast, refresh],
  );

  // Says it is running once it is: the toast used to come before the request,
  // so a run the server never started was announced, then contradicted.
  const runNow = useCallback(
    async (id: string) => {
      const run = await runRoutineNow(id);
      showToast('Routine triggered — running now');
      await refresh();
      return run;
    },
    [showToast, refresh],
  );

  return { routines, loading, refresh, create, update, toggle, remove, runNow, getRuns: getRoutineRuns };
}

export type { Routine, RoutineRun };
