import { create } from "zustand";

export type Theme = "dark" | "light";

function initialTheme(): Theme {
  const stored = localStorage.getItem("atelier.theme");
  if (stored === "dark" || stored === "light") return stored;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle("dark", theme === "dark");
  localStorage.setItem("atelier.theme", theme);
}

interface ThemeStore {
  theme: Theme;
  toggle: () => void;
}

export const useThemeStore = create<ThemeStore>((set, get) => {
  const theme = initialTheme();
  applyTheme(theme);
  return {
    theme,
    toggle: () => {
      const next: Theme = get().theme === "dark" ? "light" : "dark";
      applyTheme(next);
      set({ theme: next });
    },
  };
});
