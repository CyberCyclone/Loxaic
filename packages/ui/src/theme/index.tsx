import React, { createContext, useContext, useEffect, useState, useCallback } from "react";
import { darkTheme, lightTheme } from "@shannon/config-style/design-tokens.js";

type ThemePreference = "light" | "dark" | "system";

type ThemeContextValue = {
  theme: typeof darkTheme;
  preference: ThemePreference;
  setPreference: (p: ThemePreference) => void;
  isDark: boolean;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

const STORAGE_KEY = "shannon-theme";

function getSystemPreference(): "light" | "dark" {
  if (typeof window !== "undefined" && window.matchMedia) {
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  return "dark";
}

function resolveTheme(pref: ThemePreference): typeof darkTheme {
  if (pref === "light") return lightTheme;
  if (pref === "dark") return darkTheme;
  return getSystemPreference() === "light" ? lightTheme : darkTheme;
}

function getStoredPreference(): ThemePreference {
  if (typeof window !== "undefined" && window.localStorage) {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") return stored;
  }
  return "system";
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(getStoredPreference);
  const [theme, setTheme] = useState(() => resolveTheme(getStoredPreference()));

  const setPreference = useCallback((p: ThemePreference) => {
    setPreferenceState(p);
    if (typeof window !== "undefined" && window.localStorage) {
      window.localStorage.setItem(STORAGE_KEY, p);
    }
    setTheme(resolveTheme(p));
  }, []);

  useEffect(() => {
    if (preference !== "system" || typeof window === "undefined") return;
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const handler = () => setTheme(resolveTheme(preference));
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [preference]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY && e.newValue) {
        setPreferenceState(e.newValue as ThemePreference);
        setTheme(resolveTheme(e.newValue as ThemePreference));
      }
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, preference, setPreference, isDark: theme === darkTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}

export type { ThemePreference };
