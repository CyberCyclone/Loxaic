import { useState } from 'react';
import { Camera, Image as ImageIcon, Plus } from 'lucide-react-native';
import { Pressable } from '@/components/ui/pressable';
import { Icon } from '@/components/ui/icon';
import {
  Actionsheet,
  ActionsheetBackdrop,
  ActionsheetContent,
  ActionsheetDragIndicator,
  ActionsheetDragIndicatorWrapper,
  ActionsheetItem,
  ActionsheetItemText,
  ActionsheetIcon,
} from '@/components/ui/actionsheet';

export interface AttachButtonProps {
  /** Native only: opens the camera. */
  onTakePhoto: () => void;
  /** Native only: opens the OS photo library picker. */
  onPickFromLibrary: () => void;
  /** Web only (see AttachButton.web.tsx): files chosen from the file input. */
  onFilesSelected: (files: File[]) => void;
}

/**
 * Native attach control: a button that opens a camera/library actionsheet.
 * Web renders AttachButton.web.tsx instead, which drives a real
 * `<input type="file">` directly — expo-image-picker's web shim creates a
 * transient hidden input at click time with nothing stable to select.
 */
export function AttachButton({ onTakePhoto, onPickFromLibrary }: AttachButtonProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Pressable
        testID="composer.attach"
        onPress={() => { setOpen(true); }}
        className="shrink-0 rounded-md border border-border bg-muted p-1.5"
      >
        <Icon as={Plus} size="2xs" className="text-foreground" />
      </Pressable>
      <Actionsheet isOpen={open} onClose={() => { setOpen(false); }}>
        <ActionsheetBackdrop />
        <ActionsheetContent>
          <ActionsheetDragIndicatorWrapper>
            <ActionsheetDragIndicator />
          </ActionsheetDragIndicatorWrapper>
          <ActionsheetItem
            testID="composer.attach.camera"
            onPress={() => {
              setOpen(false);
              onTakePhoto();
            }}
          >
            <ActionsheetIcon as={Camera} />
            <ActionsheetItemText>Take photo</ActionsheetItemText>
          </ActionsheetItem>
          <ActionsheetItem
            testID="composer.attach.library"
            onPress={() => {
              setOpen(false);
              onPickFromLibrary();
            }}
          >
            <ActionsheetIcon as={ImageIcon} />
            <ActionsheetItemText>Photo library</ActionsheetItemText>
          </ActionsheetItem>
        </ActionsheetContent>
      </Actionsheet>
    </>
  );
}
