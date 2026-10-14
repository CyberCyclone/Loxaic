import { useCallback, useEffect, useState } from 'react';
import {
  createSkill,
  deleteSkill,
  getMySkills,
  updateSkill,
  type MySkills,
  type SkillInput,
  type UserSkill,
} from '@loxaic/api-client';
import { useToastHelper } from './useToastHelper';
import { describeRequestError, useServerReachable } from '@/lib/connection';

/**
 * The Skills screen's data (#283): the built-ins, read-only, and the person's
 * own, which they create, edit and delete. Every write re-reads the list,
 * since one write can change two rows' badges — a skill named like a built-in
 * supersedes it, and deleting that skill brings the built-in back.
 *
 * `loadFailed` keeps "could not ask" apart from "none": a person whose list
 * failed to load must not be told they have no skills.
 */
export function useMySkills(token: string | null) {
  const [data, setData] = useState<MySkills | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const reachable = useServerReachable();
  const { showToast } = useToastHelper();

  const refresh = useCallback(async () => {
    if (!token) return;
    try {
      setData(await getMySkills());
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, [token]);

  useEffect(() => {
    if (reachable) void refresh();
  }, [refresh, reachable]);

  /** Throws the server's own words, for the form to show beside the field. */
  const save = useCallback(
    async (input: SkillInput, editing: UserSkill | null): Promise<void> => {
      if (editing) await updateSkill(editing.id, input);
      else await createSkill(input);
      showToast(editing ? 'Skill saved' : 'Skill added');
      await refresh();
    },
    [refresh, showToast],
  );

  const remove = useCallback(
    async (skill: UserSkill) => {
      try {
        await deleteSkill(skill.id);
        showToast(skill.overridesBuiltin ? `Deleted — the built-in ${skill.name} is back` : 'Skill deleted');
        await refresh();
      } catch (err) {
        showToast(describeRequestError(err, 'Could not delete the skill'), 4000);
      }
    },
    [refresh, showToast],
  );

  return { data, loadFailed, refresh, save, remove };
}
