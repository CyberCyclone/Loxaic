import Svg, { Path } from 'react-native-svg';
import { useSvgColors } from '@/lib/designTokens';

// The Loxaic mark: the fletched L (an L drawn as an arrow), one path on a 64
// grid, from the design system's assets/Logos/loxaic-mark.svg. Single ink:
// `primary` on the shell by default. Minimum 16px.
const MARK_PATH =
  'M36 59 52 45 36 31 36 39 24 39 24 25.25 18 29.54 12 25.25 12 51 36 51zM24 17.25 18 21.54 12 17.25 12 22.18 18 26.46 24 22.18zM18 11 12 5 12 14.18 18 18.46 24 14.18 24 5z';

export function LoxaicMark({ size = 32, color }: { size?: number; color?: string }) {
  const { primary } = useSvgColors();
  const fill = color ?? primary;
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64" accessibilityLabel="Loxaic">
      <Path d={MARK_PATH} fill={fill} />
    </Svg>
  );
}
