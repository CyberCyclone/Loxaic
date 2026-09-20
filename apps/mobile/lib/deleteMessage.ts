/**
 * What the delete dialog tells someone they are about to lose.
 *
 * A pure function in its own module so it can be tested without a React Native
 * environment — the sentence is a promise about someone's data, and both of
 * the things it varies on (this deployment's retention policy, and where the
 * conversation's files actually live) have already been got wrong once.
 */

/** Where an agent conversation's files live. Absent means scratch — every row
 * that predates the column, and every conversation created without choosing. */
export type WorkspaceKind = 'scratch' | 'github' | 'local'

export function deleteConversationMessage(
  title: string,
  area: 'chat' | 'agent',
  retentionDays: number | null | undefined,
  workspaceKind?: WorkspaceKind,
): string {
  const noun = area === 'agent' ? 'run' : 'chat'
  const shared = `“${title}” will be removed for you and for anyone it is shared with.`
  // What happens to an agent's files is the part nobody guesses — and it
  // depends on where they are, so this must not be keyed on the surface alone.
  //
  // A scratch or GitHub workspace lives in a sandbox the server owns, and that
  // sandbox is destroyed: work the agent did and never pushed goes with it, and
  // it is not in the transcript. A **local** workspace is a folder on the
  // user's own machine, and nothing here touches it — `executor/service.ts`'s
  // destroy removes a container at most, "never the folder that was mounted
  // into it", and for a direct workspace it is not called at all. Claiming
  // otherwise would be alarming precisely where it is false, about the one
  // workspace holding work the user can actually lose.
  const workspace =
    area !== 'agent'
      ? ''
      : workspaceKind === 'local'
        ? ' The folder on your own machine is left exactly as it is — only the conversation goes.'
        : ' Its workspace is destroyed too, including any commits that were never pushed.'

  if (retentionDays === undefined) {
    // The honest answer while we do not know. Naming neither outcome is better
    // than guessing: "permanently" understates what an admin can still read,
    // and naming a window promises something this server may not do.
    return `${shared}${workspace} You cannot undo this yourself.`
  }
  if (retentionDays === null) {
    return `${shared}${workspace} This cannot be undone — the messages are erased.`
  }
  const days = retentionDays === 1 ? '1 day' : `${String(retentionDays)} days`
  return (
    `${shared}${workspace} This server keeps deleted ${noun}s for ${days} so an administrator can ` +
    `review them, and then erases them. You cannot reach it again yourself.`
  )
}
