import React from "react";
import { View, type ViewStyle } from "react-native";
import { ThemeProvider, useTheme } from "./theme";

function ThemeRoot({ children }: { children: React.ReactNode }) {
  const { theme } = useTheme();
  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.bg.primary } as ViewStyle}>
      {children}
    </View>
  );
}

export function GluestackProvider({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      <ThemeRoot>{children}</ThemeRoot>
    </ThemeProvider>
  );
}
