import { useUniwind } from 'uniwind';

// react-native-svg can't resolve CSS custom properties, so SVG fills and
// strokes need literal hex. These are the same values as global.css (both
// generated from the design system's tokens.json); keep the two in step.
export const SVG_COLORS = {
  'light': {
    'primary': '#47740e',
    'destructive': '#c2272d',
    'foreground-muted': '#656d75',
    'surface-sunken': '#eef0f3',
    'foreground': '#151b22',
    'border': '#dde0e3',
    'chart-1': '#47740e',
    'chart-2': '#9163d5',
    'chart-3': '#d77600',
    'chart-4': '#1f5fd1',
    'chart-5': '#bf2a82',
    'chart-6': '#6b7785'
  },
  'dark': {
    'primary': '#a3e635',
    'destructive': '#fd736d',
    'foreground-muted': '#8d9399',
    'surface-sunken': '#0c1013',
    'foreground': '#eceff2',
    'border': '#2d3135',
    'chart-1': '#a3e635',
    'chart-2': '#bd96fe',
    'chart-3': '#faab3f',
    'chart-4': '#5a8ff0',
    'chart-5': '#f86ab5',
    'chart-6': '#a7b1bc'
  }
} as const;

export type SvgColors = Record<keyof (typeof SVG_COLORS)['dark'], string>;

/** The SVG palette for the theme currently applied (light or dark). */
export function useSvgColors(): SvgColors {
  const { theme } = useUniwind();
  return theme === 'light' ? SVG_COLORS.light : SVG_COLORS.dark;
}

export function chartSeries(c: SvgColors): string[] {
  return [c['chart-1'], c['chart-2'], c['chart-3'], c['chart-4'], c['chart-5'], c['chart-6']];
}
