import { useCallback, useMemo, useRef, useState } from 'react';
import { ApiError, previewRewind, rewindConversation, type AttachmentRef, type RewindScope } from '@loxaic/api-client';
import type { RewindDialog } from '@/components/chat/RewindModal';
import type { MessageActions } from '@/components/chat/MessageList';
import { useToastHelper } from '@/hooks/useToastHelper';
import { describeRequestError } from '@/lib/connection';
import { ATTACHMENTS_WITHHELD, canRewind, restoreReportLine } from '@/lib/rewind';
import type { Message } from '@/lib/types';

/** What a rewind gives back to the composer. */
export interface ComposerSeed {
  token: number;
  text: string;
  attachments?: AttachmentRef[];
}

/**
 * Rewind and Retry for one screen (#166): the message actions, the dialog's
 * state, and what happens on each answer. Shared by Chat, Agent and a
 * routine's chat, which differ only in how a retry is sent.
 *
 * The actions handed to the list are stable for the life of the screen —
 * every message's memo compares them — so everything they need is read
 * through a ref.
 */
export function useRewindRetry(opts: {
  conversationId: string | null;
  messages: Message[] | undefined;
  /** Whether this person may act here at all (an editor, online). */
  enabled: boolean;
  /** Sends the retry; false when it could not be sent (already said). */
  retry: (restoreFiles: boolean) => boolean;
  applyLocalRewind: (convId: string, messageId: string, removedIds: string[]) => void;
  /** Puts a rewound message back in the composer. */
  onSeed: (seed: ComposerSeed) => void;
}) {
  const { showToast } = useToastHelper();
  const [dialog, setDialog] = useState<RewindDialog | null>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;
  // Answers that land after the person moved on change nothing.
  const asked = useRef(0);

  const onRewind = useCallback((messageId: string) => {
    const convId = optsRef.current.conversationId;
    if (!convId) return;
    const ask = ++asked.current;
    setDialog({ kind: 'rewind', messageId, preview: null });
    previewRewind(convId, messageId)
      .then((preview) => {
        if (asked.current !== ask) return;
        setDialog((d) => (d?.kind === 'rewind' && d.messageId === messageId ? { ...d, preview } : d));
      })
      .catch((err: unknown) => {
        if (asked.current !== ask) return;
        setDialog(null);
        showToast(describeRequestError(err, 'Could not rewind this message'), 6000);
      });
  }, [showToast]);

  const onRetry = useCallback(() => {
    const { conversationId: convId, messages } = optsRef.current;
    if (!convId) return;
    // Files only ever come into it when the reply's turn changed some; asked
    // about the newest typed message, whose turn the reply is.
    const target = [...(messages ?? [])].reverse().find(canRewind)?.id;
    if (!target) {
      optsRef.current.retry(false);
      return;
    }
    const ask = ++asked.current;
    previewRewind(convId, target)
      .then((preview) => {
        if (asked.current !== ask) return;
        const files = preview.files ?? 0;
        if (files > 0) setDialog({ kind: 'retry', files });
        else optsRef.current.retry(false);
      })
      // The question could not be asked: retry without touching files, which
      // is what a retry did before there were any to ask about.
      .catch(() => {
        if (asked.current === ask) optsRef.current.retry(false);
      });
  }, []);

  const confirm = useCallback((scope: RewindScope) => {
    const current = dialog;
    setDialog(null);
    asked.current += 1;
    if (!current) return;
    if (current.kind === 'retry') {
      optsRef.current.retry(scope === 'both');
      return;
    }
    const convId = optsRef.current.conversationId;
    if (!convId) return;
    rewindConversation(convId, current.messageId, scope)
      .then((result) => {
        if (scope !== 'files') {
          optsRef.current.applyLocalRewind(convId, current.messageId, result.removed_ids);
          optsRef.current.onSeed({
            token: Date.now(),
            text: result.text,
            ...(result.attachments.length > 0 ? { attachments: result.attachments } : {}),
          });
        }
        const said = [restoreReportLine(result.files), result.attachments_withheld ? ATTACHMENTS_WITHHELD : null].filter(Boolean);
        if (said.length > 0) showToast(said.join(' '), 8000);
      })
      .catch((err: unknown) => {
        const busy = err instanceof ApiError && err.code === 'conversation_busy';
        showToast(busy ? 'Stop the reply in progress, then rewind.' : describeRequestError(err, 'Could not rewind'), 6000);
      });
  }, [dialog, showToast]);

  /** "Edit message": straight back to the composer, conversation only — the
   * reply failed before doing anything, so there is nothing else to ask. */
  const onEdit = useCallback((messageId: string) => {
    const convId = optsRef.current.conversationId;
    if (!convId) return;
    rewindConversation(convId, messageId, 'conversation')
      .then((result) => {
        optsRef.current.applyLocalRewind(convId, messageId, result.removed_ids);
        optsRef.current.onSeed({
          token: Date.now(),
          text: result.text,
          ...(result.attachments.length > 0 ? { attachments: result.attachments } : {}),
        });
        if (result.attachments_withheld) showToast(ATTACHMENTS_WITHHELD, 6000);
      })
      .catch((err: unknown) => {
        const busy = err instanceof ApiError && err.code === 'conversation_busy';
        showToast(busy ? 'Stop the reply in progress, then edit.' : describeRequestError(err, 'Could not take the message back'), 6000);
      });
  }, [showToast]);

  const cancel = useCallback(() => {
    asked.current += 1;
    setDialog(null);
  }, []);

  const actions: MessageActions | null = useMemo(() => ({ onRewind, onRetry, onEdit }), [onRewind, onRetry, onEdit]);

  return {
    /** For the message list; null when this person cannot act here. */
    actions: opts.enabled && opts.conversationId ? actions : null,
    dialog,
    confirm,
    cancel,
  };
}
