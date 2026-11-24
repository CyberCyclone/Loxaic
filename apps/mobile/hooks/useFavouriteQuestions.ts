import { useCallback, useEffect, useRef, useState } from 'react';
import {
  addFavouriteQuestion,
  deleteFavouriteQuestion,
  getFavouriteQuestions,
  type FavouriteQuestion,
} from '@loxaic/api-client';
import { useToastHelper } from './useToastHelper';
import { describeRequestError, requireServer, useServerReachable } from '@/lib/connection';
import { failedLoad, type FavouritesLoad } from '@/lib/favouriteQuestions';

/** The last list loaded, so the next new chat shows it at once (and, while
 * the server is away, still shows it) while it is asked for again. Keyed by
 * the session token: another sign-in never sees it. */
let lastLoaded: { token: string; questions: FavouriteQuestion[] } | null = null;

/**
 * The person's favourite questions for the new-chat screen. Asked again each
 * time the screen mounts (another device may have changed them) and whenever
 * the server comes back. Every write answers with the whole list, which
 * replaces what is shown.
 */
export function useFavouriteQuestions(token: string | null) {
  const [load, setLoadState] = useState<FavouritesLoad>(() =>
    lastLoaded?.token === token ? { status: 'ready', questions: lastLoaded.questions } : { status: 'loading' },
  );
  const setLoad = useCallback(
    (next: FavouritesLoad) => {
      if (next.status === 'ready' && token) lastLoaded = { token, questions: next.questions };
      setLoadState(next);
    },
    [token],
  );
  const reachable = useServerReachable();
  const { showToast } = useToastHelper();
  // Only the newest request may set the list: a slow load that started before
  // an add must not put the list from before the add back.
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    if (!token) return;
    const mine = ++seq.current;
    try {
      const questions = await getFavouriteQuestions();
      if (mine === seq.current) setLoad({ status: 'ready', questions });
    } catch (err) {
      // A list already on screen stays there: asking again failed, which says
      // nothing new about the list. Only one never loaded becomes "couldn't load".
      if (mine === seq.current) setLoadState((prev) => (prev.status === 'ready' ? prev : failedLoad(err)));
    }
  }, [token, setLoad]);

  useEffect(() => {
    if (reachable) void refresh();
  }, [refresh, reachable]);

  /** Throws the server's own words, for the dialog to show. */
  const add = useCallback(async (text: string): Promise<void> => {
    const mine = ++seq.current;
    const questions = await addFavouriteQuestion(text);
    if (mine === seq.current) setLoad({ status: 'ready', questions });
  }, [setLoad]);

  const remove = useCallback(
    async (question: FavouriteQuestion) => {
      if (!requireServer(showToast)) return;
      const mine = ++seq.current;
      try {
        const questions = await deleteFavouriteQuestion(question.id);
        if (mine === seq.current) setLoad({ status: 'ready', questions });
      } catch (err) {
        showToast(describeRequestError(err, 'Could not remove that question'), 4000);
        // A 404 means another device removed it already: show what is there.
        void refresh();
      }
    },
    [refresh, setLoad, showToast],
  );

  return { load, refresh, add, remove };
}
