import { WarningConfirmModal } from '@/components/sandbox/WarningConfirmModal';
import { deleteConversationMessage, type WorkspaceKind } from '@/lib/deleteMessage';

interface DeleteConversationModalProps {
  /** The conversation being deleted, or null when the dialog is closed. */
  title: string | null;
  area: 'chat' | 'agent';
  /** The conversation's own workspace kind — what decides whether deleting
   * takes its files with it. */
  workspaceKind?: WorkspaceKind;
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
  workspaceKind,
  retentionDays,
  onConfirm,
  onCancel,
}: DeleteConversationModalProps) {
  return (
    <WarningConfirmModal
      open={title !== null}
      title={area === 'agent' ? 'Delete this run?' : 'Delete this chat?'}
      message={deleteConversationMessage(title ?? '', area, retentionDays, workspaceKind)}
      confirmLabel="Delete"
      testIDPrefix={`${area}.deleteConfirm`}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}
