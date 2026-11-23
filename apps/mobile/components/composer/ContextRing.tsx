import Svg, { Circle } from 'react-native-svg';
import { useSvgColors } from '@/lib/designTokens';

// react-native-svg can't resolve CSS custom properties (no var() support on
// native), so colours come from lib/designTokens.ts for the current theme;
// the track uses a neutral alpha gray that reads fine against either background.
const TRACK = 'rgba(128,128,128,0.3)';

/** Past this, the window is close enough to full that the next turn may start
 * dropping history — worth showing before it happens, not after. */
const DANGER_THRESHOLD = 90;

// Small circular progress ring for the context-window indicator.
// RN has no CSS clip-path; this replaces the web version's clipped-circle
// hack with a real SVG stroke-dashoffset ring.
export function ContextRing({ percent, size = 16 }: { percent: number; size?: number }) {
  const colors = useSvgColors();
  const strokeWidth = 2.5;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  // Only the *arc* is clamped — a ring can't draw past full. The percentage
  // shown next to it is never clamped, so overflow stays visible as a number.
  const offset = circumference * (1 - Math.min(100, Math.max(0, percent)) / 100);

  return (
    <Svg width={size} height={size} viewBox={`0 0 ${String(size)} ${String(size)}`}>
      <Circle cx={size / 2} cy={size / 2} r={radius} stroke={TRACK} strokeWidth={strokeWidth} fill="none" />
      <Circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        stroke={percent >= DANGER_THRESHOLD ? colors.destructive : colors.primary}
        strokeWidth={strokeWidth}
        fill="none"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        strokeLinecap="round"
        transform={`rotate(-90 ${String(size / 2)} ${String(size / 2)})`}
      />
    </Svg>
  );
}
