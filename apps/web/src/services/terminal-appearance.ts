import type { ITheme } from "@xterm/xterm";

export type TerminalProfileId = "system" | "ubuntu" | "fedora" | "matrix";

export interface TerminalProfile {
  id: TerminalProfileId;
  name: string;
  description: string;
  surface: string;
  chrome: string;
  tab: string;
  theme: ITheme;
}

export const TERMINAL_PROFILES: Record<TerminalProfileId, TerminalProfile> = {
  /**
   * Follows the app.
   *
   * The other profiles are fixed palettes — an aubergine Ubuntu shell stays
   * aubergine in a light workspace, which is a striking thing to put next to
   * a white editor. This one has no colours of its own: the surfaces are the
   * shell's own tokens, so switching the app to light switches the terminal
   * with it, and xterm's own theme is resolved per render from the dark flag
   * (see TerminalRegistry.themeFor — a "system" profile takes the same
   * branch as no profile at all).
   *
   * `theme` here is never read for that reason; it is the dark variant so
   * the type stays honest about what a profile is.
   */
  system: {
    id: "system",
    name: "Match the app",
    description: "Follows the light or dark theme",
    surface: "var(--card)",
    chrome: "var(--muted)",
    tab: "var(--accent)",
    theme: {
      background: "#00000000",
      foreground: "#e7eeee",
      cursor: "#68aeb8",
      cursorAccent: "#111a1c",
      selectionBackground: "#35666e66",
    },
  },
  ubuntu: {
    id: "ubuntu",
    name: "Ubuntu",
    description: "Aubergine shell with warm ANSI colors",
    surface: "#300a24",
    chrome: "#24111f",
    tab: "#4a183d",
    theme: {
      background: "#300a24",
      foreground: "#eeeeec",
      cursor: "#f2f1ef",
      cursorAccent: "#300a24",
      selectionBackground: "#77216f88",
      black: "#2e3436",
      red: "#cc0000",
      green: "#4e9a06",
      yellow: "#c4a000",
      blue: "#3465a4",
      magenta: "#75507b",
      cyan: "#06989a",
      white: "#d3d7cf",
      brightBlack: "#555753",
      brightRed: "#ef2929",
      brightGreen: "#8ae234",
      brightYellow: "#fce94f",
      brightBlue: "#729fcf",
      brightMagenta: "#ad7fa8",
      brightCyan: "#34e2e2",
      brightWhite: "#eeeeec",
    },
  },
  fedora: {
    id: "fedora",
    name: "Fedora",
    description: "Deep blue workstation console",
    surface: "#0b1f33",
    chrome: "#071827",
    tab: "#123554",
    theme: {
      background: "#0b1f33",
      foreground: "#d9e8f6",
      cursor: "#8cc8ff",
      cursorAccent: "#071827",
      selectionBackground: "#2f81f766",
      black: "#0d1117",
      red: "#ff6b6b",
      green: "#71d083",
      yellow: "#ffd166",
      blue: "#58a6ff",
      magenta: "#d2a8ff",
      cyan: "#56d4dd",
      white: "#d9e8f6",
      brightBlack: "#6e7681",
      brightRed: "#ff8f8f",
      brightGreen: "#9be9a8",
      brightYellow: "#ffe28a",
      brightBlue: "#79c0ff",
      brightMagenta: "#e2c5ff",
      brightCyan: "#8be9fd",
      brightWhite: "#ffffff",
    },
  },
  matrix: {
    id: "matrix",
    name: "Matrix",
    description: "Black console with phosphor green text",
    surface: "#020804",
    chrome: "#06130a",
    tab: "#0b2412",
    theme: {
      background: "#020804",
      foreground: "#b7f7c1",
      cursor: "#7cff8a",
      cursorAccent: "#020804",
      selectionBackground: "#1f7a3b66",
      black: "#001b0a",
      red: "#ff5f57",
      green: "#39ff7a",
      yellow: "#d7ff5f",
      blue: "#5fafff",
      magenta: "#ff7bff",
      cyan: "#5fffe1",
      white: "#c8ffd1",
      brightBlack: "#3b6b45",
      brightRed: "#ff8b82",
      brightGreen: "#7cff8a",
      brightYellow: "#efff8b",
      brightBlue: "#8bc8ff",
      brightMagenta: "#ffa8ff",
      brightCyan: "#94ffef",
      brightWhite: "#ffffff",
    },
  },
};

export function terminalProfile(id: TerminalProfileId): TerminalProfile {
  return TERMINAL_PROFILES[id] ?? TERMINAL_PROFILES.system;
}

/** True for the profile that has no palette of its own. */
export function followsAppTheme(id: TerminalProfileId): boolean {
  return id === "system";
}

export function isTerminalProfileId(value: string | null): value is TerminalProfileId {
  return (
    value === "system" ||
    value === "ubuntu" ||
    value === "fedora" ||
    value === "matrix"
  );
}
