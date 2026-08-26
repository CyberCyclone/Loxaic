import Svg, { Circle } from 'react-native-svg';

// react-native-svg can't resolve CSS custom properties (no var() support on
// native), so colors are literal here rather than theme tokens. --primary is
// the same #0096ff in both light and dark, and --destructive is likewise
// theme-stable; the track uses a neutral alpha gray that reads fine against
// either background.
const PRIMARY = '#0096ff';
const DANGER = '#dc2626';
const TRACK = 'rgba(128,128,128,0.3)';

/** Past this, the window is close enough to full that the next turn may start
 * dropping history — worth showing before it happens, not after. */
const DANGER_THRESHOLD = 90;

// Small circular progress ring for the context-window indicator.
// RN has no CSS clip-path; this replaces the web version's clipped-circle
// hack with a real SVG stroke-dashoffset ring.
export function ContextRing({ percent, size = 16 }: { percent: number; size?: number }) {
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
        stroke={percent >= DANGER_THRESHOLD ? DANGER : PRIMARY}
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
