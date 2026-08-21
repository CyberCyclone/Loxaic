/**
 * Design tokens — dark-first, zinc neutrals + aqua accent.
 * Values use numbers for React Native compatibility (RNW converts to px).
 * Light theme values are pre-computed from the design's color-mix/oklch derivations.
 */

const radii = { sm: 6, md: 10, lg: 16, full: 9999 };
const spacing = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 };
const fontSizes = { xs: 12, sm: 14, md: 16, lg: 18, xl: 24 };
const layout = { sidebarW: 260, threadListW: 280, headerH: 56 };

export const darkTheme = {
  colors: {
    bg: { primary: "#18181b", secondary: "#27272a", tertiary: "#3f3f46" },
    fg: { primary: "#f4f4f5", secondary: "#a1a1aa", muted: "#71717a" },
    border: "#3f3f46",
    accent: "#0096ff",
    accentHover: "#1da1f2",
    accentText: "#0096ff",
    onAccent: "#ffffff",
    danger: "#dc2626",
    success: "#16a34a",
    warning: "#ca8a04",
    codeBg: "#18181b",
    tint: {
      accent: "#0096ff26",
      success: "#16a34a26",
      danger: "#dc262626",
      warning: "#ca8a0426",
      muted: "#71717a26",
    },
    shadow1: "none",
    shadow2: "0 8px 24px rgba(0,0,0,.3)",
  },
  radii,
  spacing,
  fontSizes,
  layout,
};

export const lightTheme = {
  colors: {
    bg: { primary: "#ffffff", secondary: "#f4f4f5", tertiary: "#e4e4e6" },
    fg: { primary: "#18181b", secondary: "#37373c", muted: "#71717a" },
    border: "#d7d7da",
    accent: "#0096ff",
    accentHover: "#1da1f2",
    accentText: "#0966a8",
    onAccent: "#ffffff",
    danger: "#dc2626",
    success: "#16a34a",
    warning: "#9e6e0a",
    codeBg: "#f4f4f5",
    tint: {
      accent: "#0096ff26",
      success: "#16a34a26",
      danger: "#dc262626",
      warning: "#ca8a0426",
      muted: "#71717a26",
    },
    shadow1: "0 1px 3px rgba(0,0,0,.08)",
    shadow2: "0 8px 24px rgba(0,0,0,.12)",
  },
  radii,
  spacing,
  fontSizes,
  layout,
};

// Backward compat during transition
export const tokens = darkTheme;
