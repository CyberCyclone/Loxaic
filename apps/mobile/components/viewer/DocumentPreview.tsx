import { useEffect, useState } from 'react';
import { X } from 'lucide-react-native';
import { getAttachmentText } from '@shannon/api-client';
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

type PreviewState = { status: 'loading' } | { status: 'ok'; text: string } | { status: 'error'; message: string };

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
      .then((r) => { if (!cancelled) setState({ status: 'ok', text: r.text }); })
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
            <Text className="font-mono text-xs text-foreground" selectable>
              {state.text}
            </Text>
          )}
        </ModalBody>
      </ModalContent>
    </Modal>
  );
}
