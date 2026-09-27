import { useEffect, useState } from 'react';
import { getConversation, type ProjectInstructionsSummary } from '@loxaic/api-client';
import { isServerConvId } from '@/lib/streamMessages';

/**
 * What the agent is told about the project's own AGENTS.md: which file, how
 * big, and whether it went in whole or as an outline.
 *
 * Fetched, and fetched again whenever a run ends, because the server looks for
 * the file on a conversation's first run — before that there is nothing to
 * show, and nothing in the stream announces it afterwards.
 *
 * `undefined` means not known (not fetched, a local id, an older server);
 * `null` means the server has not looked yet.
 */
export function useProjectInstructions(
  conversationId: string | null,
  refreshKey?: unknown,
): ProjectInstructionsSummary | null | undefined {
  const [summary, setSummary] = useState<ProjectInstructionsSummary | null | undefined>(undefined);

  useEffect(() => {
    let current = true;
    // An optimistic id (`pending-*`) has never been seen by the server.
    if (!conversationId || !isServerConvId(conversationId)) {
      setSummary(undefined);
      return;
    }
    getConversation(conversationId)
      .then((conv) => { if (current) setSummary(conv.instructions); })
      .catch(() => { if (current) setSummary(undefined); });
    return () => { current = false; };
  }, [conversationId, refreshKey]);

  return summary;
}
