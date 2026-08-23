import Svg, { Circle } from 'react-native-svg';

// react-native-svg can't resolve CSS custom properties (no var() support on
// native), so colors are literal here rather than theme tokens. --primary is
// the same #0096ff in both light and dark; the track uses a neutral alpha
// gray that reads fine against either background.
const PRIMARY = '#0096ff';
const TRACK = 'rgba(128,128,128,0.3)';

// Small circular progress ring for the context-window indicator.
// RN has no CSS clip-path; this replaces the web version's clipped-circle
// hack with a real SVG stroke-dashoffset ring.
export function ContextRing({ percent, size = 16 }: { percent: number; size?: number }) {
  const strokeWidth = 2.5;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - Math.min(100, Math.max(0, percent)) / 100);

  return (
    <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <Circle cx={size / 2} cy={size / 2} r={radius} stroke={TRACK} strokeWidth={strokeWidth} fill="none" />
      <Circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        stroke={PRIMARY}
        strokeWidth={strokeWidth}
        fill="none"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        strokeLinecap="round"
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </Svg>
  );
}
