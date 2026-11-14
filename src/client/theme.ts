import { useEffect, useState } from "react";

export const THEME_KEY = "churntop10.theme";
export type ThemeName = "light" | "dark";

export interface ThemeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function parseTheme(value: string | null | undefined): ThemeName {
  return value === "dark" ? "dark" : "light";
}

export function readTheme(storage: ThemeStorage | null): ThemeName {
  if (!storage) return "light";
  try {
    return parseTheme(storage.getItem(THEME_KEY));
  } catch {
    return "light";
  }
}

export function writeTheme(theme: ThemeName, storage: ThemeStorage | null): void {
  if (!storage) return;
  storage.setItem(THEME_KEY, theme);
}

export function applyTheme(theme: ThemeName, root: { dataset: { theme?: string }; style?: { colorScheme?: string } }): void {
  root.dataset.theme = theme;
  if (root.style) root.style.colorScheme = theme;
}

const listeners = new Set<(theme: ThemeName) => void>();

function browserStorage(): ThemeStorage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

export function applyStoredTheme(): ThemeName {
  const theme = readTheme(browserStorage());
  if (typeof document !== "undefined") applyTheme(theme, document.documentElement);
  return theme;
}

export function setTheme(theme: ThemeName): void {
  writeTheme(theme, browserStorage());
  if (typeof document !== "undefined") applyTheme(theme, document.documentElement);
  for (const listener of listeners) listener(theme);
}

export function subscribeTheme(listener: (theme: ThemeName) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTheme(): [ThemeName, (theme: ThemeName) => void] {
  const [theme, setLocal] = useState<ThemeName>(() => readTheme(browserStorage()));
  useEffect(() => subscribeTheme(setLocal), []);
  return [theme, setTheme];
}
