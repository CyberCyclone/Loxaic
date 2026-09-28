import type { ProjectInstructionsSummary } from '@loxaic/api-client';

/**
 * The Inspector's sentence about the project's own AGENTS.md — whether the
 * agent was given it, and in what form. Pure so every state is unit-tested:
 * "not looked yet" and "we were not told" must never read as "there is none".
 *
 * Returns null where there is nothing true to say: a scratch workspace has no
 * project, and an unknown summary (not fetched, an older server) claims
 * nothing.
 */
export function describeProjectInstructions(
  summary: ProjectInstructionsSummary | null | undefined,
  workspaceKind: 'scratch' | 'github' | 'local',
): string | null {
  if (workspaceKind === 'scratch' || summary === undefined) return null;
  if (summary === null) return 'Looked for AGENTS.md (or CLAUDE.md, GEMINI.md) when the first message is sent.';
  if (summary.status === 'none') return 'No AGENTS.md, CLAUDE.md or GEMINI.md at the root of this project.';
  // Tried, and could not find out — kept apart from "none" and from "not yet":
  // the agent is working without them, and this says why.
  if (summary.status === 'unavailable') {
    switch (summary.reason) {
      case 'no-github-connection':
        return "Couldn't read the project's AGENTS.md: the conversation owner's GitHub isn't connected. It's tried again later.";
      case 'machine-offline':
        return "Couldn't read the project's AGENTS.md: the machine this folder is on is offline. It's tried again later.";
      default:
        return "Couldn't read the project's AGENTS.md just now. It's tried again later.";
    }
  }
  const size = `~${formatTokens(summary.tokens)} tokens`;
  const partial = summary.sourceTruncated ? ` Only its first ${formatKb(summary.sourceBytes)} was read.` : '';
  switch (summary.mode) {
    case 'full':
      return `${summary.path} (${size}) is included in full.${partial}`;
    case 'outline':
      return (
        `${summary.path} (${size}) is more than this model's context window can spare, so the agent gets its ` +
        `opening and section headings, and reads sections as it needs them.${partial}`
      );
    default:
      return `${summary.path} (${size}) found.${partial}`;
  }
}

function formatTokens(n: number): string {
  return n >= 10_000 ? `${String(Math.round(n / 1000))}k` : n.toLocaleString('en-US');
}

function formatKb(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${String(Math.round(bytes / (1024 * 1024)))} MB` : `${String(Math.round(bytes / 1024))} KB`;
}
