import { useRef, useState } from 'react';
import { X } from 'lucide-react-native';
import { Modal, ModalBackdrop, ModalContent } from '@/components/ui/modal';
import { Pressable } from '@/components/ui/pressable';
import { Icon } from '@/components/ui/icon';

const MIN_SCALE = 1;
const MAX_SCALE = 4;

interface ImageViewerProps {
  uri: string | null;
  onClose: () => void;
}

/** Web variant: gesture-handler's pinch recognizer doesn't track trackpad/
 * mouse input well, so this uses the wheel for zoom, double-click to toggle,
 * and plain pointer drag to pan once zoomed in. */
export function ImageViewer({ uri, onClose }: ImageViewerProps) {
  return (
    <Modal isOpen={!!uri} onClose={onClose} size="full">
      <ModalBackdrop />
      <ModalContent className="h-full w-full rounded-none border-0 bg-black p-0">
        {uri && <ZoomableImage key={uri} uri={uri} />}
        <Pressable
          testID="viewer.close"
          onPress={onClose}
          className="absolute right-4 top-4 rounded-full bg-black/50 p-2"
        >
          <Icon as={X} size="md" className="text-white" />
        </Pressable>
      </ModalContent>
    </Modal>
  );
}

function ZoomableImage({ uri }: { uri: string }) {
  const [scale, setScale] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const dragging = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);

  const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    setScale((s) => {
      const next = clampScale(s - e.deltaY * 0.01);
      if (next === MIN_SCALE) setPos({ x: 0, y: 0 });
      return next;
    });
  };

  const onDoubleClick = () => {
    if (scale > MIN_SCALE) {
      setScale(MIN_SCALE);
      setPos({ x: 0, y: 0 });
    } else {
      setScale(2);
    }
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (scale <= MIN_SCALE) return;
    dragging.current = { startX: e.clientX, startY: e.clientY, origX: pos.x, origY: pos.y };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    const d = dragging.current;
    setPos({ x: d.origX + (e.clientX - d.startX), y: d.origY + (e.clientY - d.startY) });
  };

  const onPointerUp = () => { dragging.current = null; };

  return (
    <img
      data-testid="viewer.image"
      src={uri}
      alt=""
      onWheel={onWheel}
      onDoubleClick={onDoubleClick}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerUp}
      style={{
        width: '100%',
        height: '100%',
        objectFit: 'contain',
        transform: `translate(${String(pos.x)}px, ${String(pos.y)}px) scale(${String(scale)})`,
        cursor: scale > MIN_SCALE ? 'grab' : 'default',
        touchAction: 'none',
      }}
    />
  );
}
