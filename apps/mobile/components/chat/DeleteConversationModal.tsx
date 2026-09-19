import { WarningConfirmModal } from '@/components/sandbox/WarningConfirmModal';

interface DeleteConversationModalProps {
  /** The conversation being deleted, or null when the dialog is closed. */
  title: string | null;
  area: 'chat' | 'agent';
  /**
   * How long this deployment keeps a deleted conversation for an admin to
   * audit, from `/v1/config`; null means deleting erases it. Undefined while
   * the config is still loading, which is deliberately *not* rendered as
   * "erased" — see below.
   */
  retentionDays: number | null | undefined;
  onConfirm: () => void;
  onCancel: () => void;
}

/** What the user is agreeing to, in the words that match what will happen. */
export function deleteConversationMessage(
  title: string,
  area: 'chat' | 'agent',
  retentionDays: number | null | undefined,
): string {
  const noun = area === 'agent' ? 'run' : 'chat';
  const shared = `“${title}” will be removed for you and for anyone it is shared with.`;
  // An agent conversation's workspace is destroyed with it, and that is the
  // part nobody guesses: files the agent wrote and commits nobody pushed are
  // in there, and they are not in the transcript.
  const workspace =
    area === 'agent' ? ' Its workspace is destroyed too, including any commits that were never pushed.' : '';

  if (retentionDays === undefined) {
    // The honest answer while we do not know. Naming neither outcome is
    // better than guessing: "permanently" understates what an admin can still
    // read, and naming a window promises something this server may not do.
    return `${shared}${workspace} You cannot undo this yourself.`;
  }
  if (retentionDays === null) {
    return `${shared}${workspace} This cannot be undone — the messages are erased.`;
  }
  const days = retentionDays === 1 ? '1 day' : `${String(retentionDays)} days`;
  return (
    `${shared}${workspace} This server keeps deleted ${noun}s for ${days} so an administrator can ` +
    `review them, and then erases them. You cannot reach it again yourself.`
  );
}

/**
 * The one confirm dialog for deleting a conversation, opened from both the
 * header's ⋮ menu and the thread list's Delete.
 *
 * One component rather than two call sites composing the same strings, because
 * the sentence depends on a server setting — and two copies of that sentence
 * is how one of them ends up describing a policy the deployment stopped having.
 */
export function DeleteConversationModal({
  title,
  area,
  retentionDays,
  onConfirm,
  onCancel,
}: DeleteConversationModalProps) {
  return (
    <WarningConfirmModal
      open={title !== null}
      title={area === 'agent' ? 'Delete this run?' : 'Delete this chat?'}
      message={deleteConversationMessage(title ?? '', area, retentionDays)}
      confirmLabel="Delete"
      testIDPrefix={`${area}.deleteConfirm`}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}
