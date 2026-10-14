import { useCallback, useEffect, useRef, useState } from 'react';
import { getSkills, type PaletteSkill } from '@loxaic/api-client';
import { isServerConvId } from '@/lib/streamMessages';
import { useServerReachable } from '@/lib/connection';
import { bumpSkill, FALLBACK_SKILLS, skillNamed } from '@/lib/skillPalette';

/**
 * The skills the composer's "/" palette offers in a conversation (#283),
 * most-used first, from `GET /v1/skills`. A thread that does not exist on the
 * server yet asks for the person's own list.
 *
 * `noteUsed` re-sorts locally the moment a skill is run — the server counts
 * the same use — so the palette is right the next time "/" is typed.
 */
export function useSkills(conversationId: string | null | undefined) {
  const [skills, setSkills] = useState<readonly PaletteSkill[]>(FALLBACK_SKILLS);
  const reachable = useServerReachable();
  const id = conversationId && isServerConvId(conversationId) ? conversationId : null;
  // An answer for a conversation the person has left must not replace the
  // list of the one they are in.
  const asked = useRef(0);

  const refresh = useCallback(async () => {
    const seq = ++asked.current;
    try {
      const list = await getSkills(id);
      if (seq === asked.current) setSkills(list);
    } catch {
      // The last list stays: a palette a fetch behind beats an empty one.
    }
  }, [id]);

  useEffect(() => {
    if (reachable) void refresh();
  }, [refresh, reachable]);

  const noteUsed = useCallback((name: string) => {
    setSkills((prev) => (skillNamed(prev, name) ? bumpSkill(prev, name) : prev));
  }, []);

  return { skills, refresh, noteUsed };
}
