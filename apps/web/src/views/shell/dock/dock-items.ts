import {
  BookOpen,
  Bot,
  Files,
  GaugeCircle,
  GitBranch,
  Moon,
  Network,
  Settings,
  Sun,
  TerminalSquare,
  Webhook,
  type LucideIcon,
} from "lucide-react";
import type { ComponentType, SVGProps } from "react";
import { ClaudeMark, CodexMark } from "./ProviderMarks";
import type { RightTab } from "@/state/workspace.store";
import type { Theme } from "@/state/theme.store";
import type { UsageVm } from "@/hooks/useUsageViewModel";

export type ActivityView =
  | "agents"
  | "explorer"
  | "markdown"
  | "git"
  | "monitor"
  | "settings"
  | "knowledge"
  | "hooks";

/**
 * A glyph the dock can render. Lucide icons are the common case; the two
 * provider tiles instead carry a brand mark (ClaudeMark / CodexMark) that
 * accepts the same `className`/`size` props so the dock renders them
 * identically.
 */
export type DockIcon =
  | LucideIcon
  | ComponentType<SVGProps<SVGSVGElement> & { size?: string | number }>;

/**
 * One dock tile. `tab` tiles navigate (aria-selected, running dot); `toggle`
 * tiles flip a piece of app state (aria-pressed, no dot) — the same split the
 * header made with a hairline, kept so the dock never implies that toggling
 * the terminal moved you somewhere.
 */
export interface DockTile {
  id: string;
  icon: DockIcon;
  label: string;
  kind: "tab" | "toggle";
  active: boolean;
  /** Live count badged onto the tile, or null when there is nothing to say. */
  badge: number | null;
  /** "danger" paints the badge red — merge conflicts on the Changes tile. */
  badgeTone?: "danger";
  /**
   * Colour of the tile's dot when it is not just marking "you are here".
   * Only used where the dot carries a threshold the user should not have to
   * open a modal to notice.
   */
  dotTone?: "warning" | "danger";
  onSelect: () => void;
}

/**
 * Workspace destinations, ordered by how often a session reaches for them.
 * Settings is not here: it configures the app rather than being a place you
 * work, so it sits in the dock's trailing group with the theme toggle.
 */
const DESTINATIONS: Array<{
  id: ActivityView;
  icon: LucideIcon;
  label: string;
}> = [
  { id: "agents", icon: Bot, label: "Agents" },
  { id: "explorer", icon: Files, label: "Files" },
  { id: "git", icon: GitBranch, label: "Changes" },
  { id: "markdown", icon: BookOpen, label: "Notes" },
];

/** Everything the dock needs from the shell to describe its tiles. */
export interface DockInput {
  activeView: ActivityView;
  onSelectView: (view: ActivityView) => void;
  /** Agents currently working, badged onto Agents. */
  workingCount: number;
  /** Changed files, badged onto Changes. */
  changedCount: number;
  /** Unmerged files: the Changes badge turns red and its dot goes danger. */
  conflictCount: number;
  /** Live terminals, badged onto the terminal toggle. */
  terminalCount: number;
  /** CLI mode is showing a Claude session. */
  claudeActive: boolean;
  /** CLI mode is showing a Codex session. */
  codexActive: boolean;
  /** Enter CLI mode and activate a Claude session. */
  onSelectClaude: () => void;
  /** Enter CLI mode and activate a Codex session. */
  onSelectCodex: () => void;
  bottomOpen: boolean;
  theme: Theme;
  /** Live plan usage, behind the dock's gauge tile. */
  usage: UsageVm;
  usageOpen: boolean;
  onToggleUsage: () => void;
  settingsOpen: boolean;
  onToggleSettings: () => void;
  onToggleTheme: () => void;
  onSelectTab: (tab: RightTab) => void;
}

/**
 * The dock's contents as three groups, rendered with a hairline between them:
 * where you are, what the workspace shows, and how the app itself is set up.
 */
export function buildDockGroups(input: DockInput): DockTile[][] {
  const destinations: DockTile[] = DESTINATIONS.map((item) => ({
    id: item.id,
    icon: item.icon,
    label: item.label,
    kind: "tab",
    active: input.activeView === item.id,
    badge: badgeFor(item.id, input),
    ...(item.id === "git" && input.conflictCount > 0
      ? { badgeTone: "danger" as const, dotTone: "danger" as const }
      : {}),
    onSelect: () => input.onSelectView(item.id),
  }));

  // Provider quick-switch: two tab tiles that replace the Atelier chat flow
  // with the selected provider's real CLI and its session rail. They are tabs,
  // not toggles, because picking one moves the conversation to that provider.
  // The session currently visible in the CLI decides which tile is active.
  const providers: DockTile[] = [
    {
      id: "claude",
      icon: ClaudeMark,
      label: "Claude",
      kind: "tab",
      active: input.claudeActive,
      badge: null,
      onSelect: input.onSelectClaude,
    },
    {
      id: "codex",
      icon: CodexMark,
      label: "Codex",
      kind: "tab",
      active: input.codexActive,
      badge: null,
      onSelect: input.onSelectCodex,
    },
  ];

  const workbench: DockTile[] = [
    {
      id: "terminal",
      icon: TerminalSquare,
      label: "Terminal window (Ctrl+`)",
      kind: "toggle",
      active: input.bottomOpen,
      badge: input.terminalCount > 0 ? input.terminalCount : null,
      onSelect: () => input.onSelectTab("terminal"),
    },
  ];

  const dark = input.theme === "dark";
  const app: DockTile[] = [
    {
      id: "usage",
      icon: GaugeCircle,
      label: usageLabel(input.usage),
      kind: "toggle",
      active: input.usageOpen,
      badge: null,
      dotTone: usageTone(input.usage),
      onSelect: input.onToggleUsage,
    },
    {
      id: "settings",
      icon: Settings,
      label: "Settings",
      kind: "toggle",
      active: input.settingsOpen,
      badge: null,
      onSelect: input.onToggleSettings,
    },
    {
      id: "theme",
      icon: dark ? Sun : Moon,
      label: dark ? "Switch to light theme" : "Switch to dark theme",
      kind: "toggle",
      active: false,
      badge: null,
      onSelect: input.onToggleTheme,
    },
  ];

  return [destinations, providers, workbench, app];
}

function badgeFor(id: ActivityView, input: DockInput): number | null {
  if (id === "agents" && input.workingCount > 0) return input.workingCount;
  // Conflicts outrank the change count: "3" in red means three files are
  // blocking the merge, which is the number that needs acting on.
  if (id === "git" && input.conflictCount > 0) return input.conflictCount;
  if (id === "git" && input.changedCount > 0) return input.changedCount;
  return null;
}

/** The tightest window, so the tooltip answers the question without a click. */
function peakUtilization(usage: UsageVm): number | null {
  if (!usage.available || usage.windows.length === 0) return null;
  return Math.round(Math.max(...usage.windows.map((w) => w.utilization)));
}

function usageLabel(usage: UsageVm): string {
  const peak = peakUtilization(usage);
  if (peak === null) {
    return (usage.ollamaCloudUsage?.length ?? 0) > 0
      ? "Usage (incl. Ollama Cloud activity)"
      : "Plan usage";
  }
  return `Plan usage — ${peak}% used`;
}

/**
 * Moving usage into a modal must not mean you only find out you are near the
 * limit by opening it, so the tile's dot carries the same two thresholds the
 * bars use. Below 70% there is nothing to say and the dot stays off.
 */
function usageTone(usage: UsageVm): "warning" | "danger" | undefined {
  const peak = peakUtilization(usage);
  if (peak === null) return undefined;
  if (peak >= 90) return "danger";
  if (peak >= 70) return "warning";
  return undefined;
}
