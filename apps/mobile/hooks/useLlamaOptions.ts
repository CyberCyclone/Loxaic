import { useEffect, useState } from 'react';
import { getLlamaOptions, type LlamaOptionInfo } from '@loxaic/api-client';
import { describeRequestError } from '@/lib/connection';

export interface LlamaOptionsState {
  /** What the running build lists in its `--help`, or null while asking or
   * when it is not known. */
  options: LlamaOptionInfo[] | null;
  /** Why options cannot be set right now, or null. */
  unavailable: string | null;
  loading: boolean;
}

/**
 * The running llama.cpp's options, asked for while `active` (the settings
 * sheet is open, the runtime card's advanced section is showing) and again
 * when `version` changes, since a different build may take different ones.
 */
export function useLlamaOptions(active: boolean, version: string | null): LlamaOptionsState {
  const [state, setState] = useState<LlamaOptionsState>({ options: null, unavailable: null, loading: false });
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    getLlamaOptions()
      .then((r) => {
        if (!cancelled) setState({ options: r.options, unavailable: r.unavailable, loading: false });
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ options: null, unavailable: describeRequestError(err, "Could not ask which options llama.cpp takes."), loading: false });
      });
    return () => { cancelled = true; };
  }, [active, version]);
  return state;
}
