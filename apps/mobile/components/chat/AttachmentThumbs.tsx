import { Image } from 'expo-image';
import { FileText } from 'lucide-react-native';
import { attachmentClass, attachmentUrl } from '@shannon/api-client';
import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Pressable } from '@/components/ui/pressable';
import { Icon } from '@/components/ui/icon';
import type { Message } from '@/lib/types';

interface AttachmentThumbsProps {
  attachments: NonNullable<Message['attachments']>;
  /** Needed to build an authenticated /v1/files URL — absent only in the
   * impossible case of rendering a message with no signed-in session. */
  token: string | null;
  onPress: (att: NonNullable<Message['attachments']>[number]) => void;
}

/** Thumbnail row for a user message's attachments — rendered from the local
 * file while it's still uploading, then from the server once a ref exists
 * (so it survives a reload without re-sending the bytes). Non-image
 * attachments render as a compact file chip instead of a thumbnail. */
export function AttachmentThumbs({ attachments, token, onPress }: AttachmentThumbsProps) {
  return (
    <HStack space="sm" className="flex-wrap pb-1">
      {attachments.map((att, i) => {
        const uri = att.localUri ?? (att.ref && token ? attachmentUrl(att.ref, token) : undefined);
        if (!uri) return null;
        const isImage = attachmentClass(att.mime) === 'image';
        return (
          <Pressable
            key={att.ref ?? att.localUri ?? i}
            testID="chat.attachment.thumb"
            onPress={() => { onPress(att); }}
            className="h-28 w-28 overflow-hidden rounded-md border border-border"
          >
            {isImage ? (
              <Image source={{ uri }} style={{ width: '100%', height: '100%' }} contentFit="cover" />
            ) : (
              <VStack className="h-full w-full items-center justify-center gap-0.5 p-1">
                <Icon as={FileText} size="sm" className="text-muted-foreground" />
                <Text size="2xs" numberOfLines={1} className="w-full text-center text-muted-foreground">
                  {att.name ?? 'File'}
                </Text>
              </VStack>
            )}
          </Pressable>
        );
      })}
    </HStack>
  );
}
