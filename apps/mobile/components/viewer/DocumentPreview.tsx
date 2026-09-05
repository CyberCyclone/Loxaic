import { useEffect, useState } from 'react';
import { X } from 'lucide-react-native';
import { getAttachmentText } from '@loxaic/api-client';
import { Modal, ModalBackdrop, ModalContent, ModalHeader, ModalBody } from '@/components/ui/modal';
import { Pressable } from '@/components/ui/pressable';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { Spinner } from '@/components/ui/spinner';
import type { Message } from '@/lib/types';

interface DocumentPreviewProps {
  attachment: NonNullable<Message['attachments']>[number] | null;
  onClose: () => void;
}

type PreviewState =
  | { status: 'loading' }
  | { status: 'ok'; text: string; omitted: number }
  | { status: 'error'; message: string };

/** How much of a document's extraction the preview will render.
 *
 * The endpoint serves the cached sidecar, bounded by
 * MAX_CACHED_EXTRACTION_BYTES (4 MB) — not the 256 KB prompt cap — and this
 * renders into a single non-virtualised `Text`. A million-character node means
 * a multi-second layout freeze on web and a plausible OOM on a mid-range
 * Android device, triggered by one tap on a chip with no warning. */
const PREVIEW_CHAR_LIMIT = 200_000;

/** Shows a document attachment's cached extraction — exactly the text the
 * model was given, which for a PDF is not the same as the file. Deliberately
 * a preview, not a download: it answers "what did the model actually see",
 * the single most useful thing to show for a truncated or reformatted
 * extraction. `ModalBody` is already a ScrollView (see components/ui/modal),
 * so long extracted text scrolls without any extra wrapper. */
export function DocumentPreview({ attachment, onClose }: DocumentPreviewProps) {
  const [state, setState] = useState<PreviewState>({ status: 'loading' });

  useEffect(() => {
    if (!attachment?.ref) return;
    setState({ status: 'loading' });
    let cancelled = false;
    getAttachmentText(attachment.ref)
      .then((r) => {
        if (cancelled) return;
        const text = r.text.slice(0, PREVIEW_CHAR_LIMIT);
        setState({ status: 'ok', text, omitted: r.text.length - text.length });
      })
      .catch((e: unknown) => { if (!cancelled) setState({ status: 'error', message: (e as Error).message }); });
    return () => { cancelled = true; };
  }, [attachment?.ref]);

  return (
    <Modal isOpen={!!attachment} onClose={onClose} size="lg">
      <ModalBackdrop />
      <ModalContent testID="documentPreview.modal">
        <ModalHeader>
          <Text className="font-medium text-foreground" numberOfLines={1}>
            {attachment?.name ?? 'File'}
          </Text>
          <Pressable testID="documentPreview.close" onPress={onClose} hitSlop={8}>
            <Icon as={X} size="sm" className="text-muted-foreground" />
          </Pressable>
        </ModalHeader>
        <ModalBody>
          {state.status === 'loading' && <Spinner />}
          {state.status === 'error' && (
            <Text className="text-destructive">Couldn&apos;t load this file&apos;s contents: {state.message}</Text>
          )}
          {state.status === 'ok' && (
            <>
              <Text className="font-mono text-xs text-foreground" selectable>
                {state.text}
              </Text>
              {state.omitted > 0 && (
                <Text size="xs" className="pt-2 text-muted-foreground">
                  Showing the first {PREVIEW_CHAR_LIMIT.toLocaleString()} characters —{' '}
                  {state.omitted.toLocaleString()} more not shown.
                </Text>
              )}
            </>
          )}
        </ModalBody>
      </ModalContent>
    </Modal>
  );
}
