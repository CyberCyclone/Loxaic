import { useCallback, useEffect, useRef, useState } from 'react';
import { getSkills, type PaletteSkill } from '@loxaic/api-client';
import { isServerConvId } from '@/lib/streamMessages';
import { useServerReachable } from '@/lib/connection';
import { bumpSkill, skillNamed, skillsFor } from '@/lib/skillPalette';

/**
 * The skills the composer's "/" palette offers in a conversation (#283),
 * most-used first, from `GET /v1/skills`. A thread that does not exist on the
 * server yet asks for the person's own list.
 *
 * The list is held with the conversation it was asked for and shown only for
 * that one (`skillsFor`): it is the conversation owner's, so a list a fetch
 * behind is fine for the same thread and wrong for any other.
 *
 * `noteUsed` re-sorts locally the moment a skill is run — the server counts
 * the same use — so the palette is right the next time "/" is typed.
 */
export function useSkills(conversationId: string | null | undefined) {
  const id = conversationId && isServerConvId(conversationId) ? conversationId : null;
  const [held, setHeld] = useState<{ for: string | null; skills: readonly PaletteSkill[] } | null>(null);
  const reachable = useServerReachable();
  // Only the newest request may answer, even for the same conversation.
  const asked = useRef(0);

  const refresh = useCallback(async () => {
    const seq = ++asked.current;
    try {
      const list = await getSkills(id);
      if (seq === asked.current) setHeld({ for: id, skills: list });
    } catch {
      // The last list stays, and only for the conversation it is for.
    }
  }, [id]);

  useEffect(() => {
    if (reachable) void refresh();
  }, [refresh, reachable]);

  const noteUsed = useCallback(
    (name: string) => {
      setHeld((prev) =>
        prev?.for === id && skillNamed(prev.skills, name) ? { ...prev, skills: bumpSkill(prev.skills, name) } : prev,
      );
    },
    [id],
  );

  return { skills: skillsFor(held, id), refresh, noteUsed };
}
