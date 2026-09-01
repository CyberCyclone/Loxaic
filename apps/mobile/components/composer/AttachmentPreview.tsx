import { Image } from 'expo-image';
import { X, TriangleAlert, FileText } from 'lucide-react-native';
import { attachmentClass } from '@shannon/api-client';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import { Pressable } from '@/components/ui/pressable';
import { Icon } from '@/components/ui/icon';
import { Spinner } from '@/components/ui/spinner';
import type { PendingAttachment } from '@/hooks/useComposerAttachments';

interface AttachmentPreviewProps {
  items: PendingAttachment[];
  onRemove: (localUri: string) => void;
}

/** Thumbnail strip above the textarea for images picked but not yet sent —
 * shows upload progress and a per-item remove control. */
export function AttachmentPreview({ items, onRemove }: AttachmentPreviewProps) {
  if (items.length === 0) return null;

  return (
    <HStack space="sm" className="flex-wrap">
      {items.map((item) => (
        <Box
          key={item.localUri}
          testID="composer.attachment.preview"
          className="relative h-16 w-16 overflow-hidden rounded-md border border-border bg-muted"
        >
          {attachmentClass(item.mime) === 'image' ? (
            <Image source={{ uri: item.localUri }} style={{ width: '100%', height: '100%' }} contentFit="cover" />
          ) : (
            <VStack className="h-full w-full items-center justify-center gap-0.5 p-1">
              <Icon as={FileText} size="sm" className="text-muted-foreground" />
              <Text size="2xs" numberOfLines={1} className="w-full text-center text-muted-foreground">
                {item.name ?? 'File'}
              </Text>
            </VStack>
          )}
          {item.status === 'uploading' && (
            <Box className="absolute inset-0 items-center justify-center bg-background/60">
              <Spinner size="small" />
            </Box>
          )}
          {item.status === 'error' && (
            <Box className="absolute inset-0 items-center justify-center bg-background/70">
              <Icon as={TriangleAlert} size="sm" className="text-destructive" />
            </Box>
          )}
          <Pressable
            testID="composer.attachment.remove"
            onPress={() => { onRemove(item.localUri); }}
            hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
            className="absolute right-0.5 top-0.5 rounded-full bg-background/80 p-0.5"
          >
            <Icon as={X} size="2xs" className="text-foreground" />
          </Pressable>
        </Box>
      ))}
    </HStack>
  );
}
