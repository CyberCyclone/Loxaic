import { Image } from 'expo-image';
import { X } from 'lucide-react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { Modal, ModalBackdrop, ModalContent } from '@/components/ui/modal';
import { Pressable } from '@/components/ui/pressable';
import { Icon } from '@/components/ui/icon';

const MIN_SCALE = 1;
const MAX_SCALE = 4;

interface ImageViewerProps {
  /** The image to show, fullscreen — the viewer is closed whenever this is null. */
  uri: string | null;
  onClose: () => void;
}

/**
 * Fullscreen pinch/pan/double-tap zoom, native. Scale and pan reset whenever
 * a new image opens (keyed by `uri` on the inner component) rather than
 * tracked across opens — nobody expects a previous zoom level to survive
 * closing and reopening the viewer.
 */
export function ImageViewer({ uri, onClose }: ImageViewerProps) {
  return (
    <Modal isOpen={!!uri} onClose={onClose} size="full">
      <ModalBackdrop />
      <ModalContent className="h-full w-full rounded-none border-0 bg-black p-0">
        {uri && <ZoomableImage key={uri} uri={uri} />}
        <Pressable
          testID="viewer.close"
          onPress={onClose}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          className="absolute right-4 top-4 rounded-full bg-black/50 p-2"
        >
          <Icon as={X} size="md" className="text-white" />
        </Pressable>
      </ModalContent>
    </Modal>
  );
}

function ZoomableImage({ uri }: { uri: string }) {
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const savedTranslateX = useSharedValue(0);
  const savedTranslateY = useSharedValue(0);

  const reset = () => {
    'worklet';
    scale.value = withTiming(1);
    translateX.value = withTiming(0);
    translateY.value = withTiming(0);
    savedScale.value = 1;
    savedTranslateX.value = 0;
    savedTranslateY.value = 0;
  };

  const pinch = Gesture.Pinch()
    .onUpdate((e) => {
      scale.value = Math.min(MAX_SCALE, Math.max(MIN_SCALE, savedScale.value * e.scale));
    })
    .onEnd(() => {
      savedScale.value = scale.value;
      if (scale.value <= MIN_SCALE) reset();
    });

  const pan = Gesture.Pan()
    .onUpdate((e) => {
      if (scale.value <= MIN_SCALE) return;
      translateX.value = savedTranslateX.value + e.translationX;
      translateY.value = savedTranslateY.value + e.translationY;
    })
    .onEnd(() => {
      savedTranslateX.value = translateX.value;
      savedTranslateY.value = translateY.value;
    });

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      if (scale.value > MIN_SCALE) {
        reset();
      } else {
        scale.value = withTiming(2);
        savedScale.value = 2;
      }
    });

  const gesture = Gesture.Simultaneous(Gesture.Race(doubleTap, pan), pinch);

  const style = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
      { scale: scale.value },
    ],
  }));

  return (
    <GestureDetector gesture={gesture}>
      <Animated.View style={[{ flex: 1 }, style]}>
        <Image testID="viewer.image" source={{ uri }} style={{ width: '100%', height: '100%' }} contentFit="contain" />
      </Animated.View>
    </GestureDetector>
  );
}
