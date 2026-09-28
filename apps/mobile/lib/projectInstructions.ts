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
  isolation?: 'direct' | 'container',
): string | null {
  if (workspaceKind === 'scratch' || summary === undefined) return null;
  if (summary === null) {
    // A container-isolated folder is read inside its container, never on the
    // host, and nothing starts the container just to read it: the agent's
    // first command does, and the next message is when it is looked for.
    return workspaceKind === 'local' && isolation === 'container'
      ? 'Looked for AGENTS.md (or CLAUDE.md, GEMINI.md) inside the container, once the agent has started it.'
      : 'Looked for AGENTS.md (or CLAUDE.md, GEMINI.md) when the first message is sent.';
  }
  if (summary.status === 'none') {
    return summary.pendingUpdate
      ? 'The project has an instructions file now; the agent was given it in the chat.'
      : 'No AGENTS.md, CLAUDE.md or GEMINI.md at the root of this project.';
  }
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
  const n = summary.imports ?? 0;
  const pending = summary.pendingUpdate
    ? " It has changed since this conversation started: the agent was given the changes in the chat, and they move into its instructions at the next compaction."
    : '';
  // With imports, the size and the verdict are about all of them together.
  const what = n > 0 ? `${summary.path} and the ${n === 1 ? 'file' : `${String(n)} files`} it imports (${size})` : `${summary.path} (${size})`;
  const their = n > 0 ? 'their' : 'its';
  const are = n > 0 ? 'are' : 'is';
  switch (summary.mode) {
    case 'full':
      return `${what} ${are} included in full.${partial}${pending}`;
    case 'outline':
      return (
        `${what} ${are} more than this model's context window can spare, so the agent gets ${their} ` +
        `opening and section headings, and reads sections as it needs them.${partial}${pending}`
      );
    default:
      return `${what} found.${partial}${pending}`;
  }
}

/** The line shown with a user message the agent was given an instructions
 * change on — `summary` is the server's ("AGENTS.md: 1 section changed"). */
export function instructionsUpdateLine(update: { path: string; summary: string }): string {
  return `${update.summary}. The agent was given the change with this message.`;
}

function formatTokens(n: number): string {
  return n >= 10_000 ? `${String(Math.round(n / 1000))}k` : n.toLocaleString('en-US');
}

function formatKb(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${String(Math.round(bytes / (1024 * 1024)))} MB` : `${String(Math.round(bytes / 1024))} KB`;
}
