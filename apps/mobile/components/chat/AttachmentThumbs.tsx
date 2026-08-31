import { Image } from 'expo-image';
import { attachmentUrl } from '@shannon/api-client';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import type { Message } from '@/lib/types';

interface AttachmentThumbsProps {
  attachments: NonNullable<Message['attachments']>;
  /** Needed to build an authenticated /v1/files URL — absent only in the
   * impossible case of rendering a message with no signed-in session. */
  token: string | null;
  onPress: (uri: string) => void;
}

/** Thumbnail row for a user message's images — rendered from the local file
 * while it's still uploading, then from the server once a ref exists (so it
 * survives a reload without re-sending the bytes). */
export function AttachmentThumbs({ attachments, token, onPress }: AttachmentThumbsProps) {
  return (
    <HStack space="sm" className="flex-wrap pb-1">
      {attachments.map((att, i) => {
        const uri = att.localUri ?? (att.ref && token ? attachmentUrl(att.ref, token) : undefined);
        if (!uri) return null;
        return (
          <Pressable
            key={att.ref ?? att.localUri ?? i}
            testID="chat.attachment.thumb"
            onPress={() => { onPress(uri); }}
            className="h-28 w-28 overflow-hidden rounded-md border border-border"
          >
            <Image source={{ uri }} style={{ width: '100%', height: '100%' }} contentFit="cover" />
          </Pressable>
        );
      })}
    </HStack>
  );
}
