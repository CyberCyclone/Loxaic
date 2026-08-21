declare const darkTheme: {
  colors: {
    bg: { primary: string; secondary: string; tertiary: string };
    fg: { primary: string; secondary: string; muted: string };
    border: string;
    accent: string;
    accentHover: string;
    accentText: string;
    onAccent: string;
    danger: string;
    success: string;
    warning: string;
    codeBg: string;
    tint: { accent: string; success: string; danger: string; warning: string; muted: string };
    shadow1: string;
    shadow2: string;
  };
  radii: { sm: number; md: number; lg: number; full: number };
  spacing: { xs: number; sm: number; md: number; lg: number; xl: number };
  fontSizes: { xs: number; sm: number; md: number; lg: number; xl: number };
  layout: { sidebarW: number; threadListW: number; headerH: number };
};
declare const lightTheme: typeof darkTheme;
declare const tokens: typeof darkTheme;
export { darkTheme, lightTheme, tokens };
