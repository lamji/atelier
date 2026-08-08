import { create } from "zustand";

export type Theme = "dark" | "light";

function initialTheme(): Theme {
  const stored = localStorage.getItem("atelier.theme");
  if (stored === "dark" || stored === "light") return stored;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme: Theme): void {
  // Two signals for one theme: the `dark` class is what Tailwind's `dark:`
  // variant and every existing `.dark ...` rule key off, and `data-theme` is
  // what the token blocks in index.css select on. Both are set together so
  // they can never disagree.
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.dataset.theme = theme;
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
