import { useMemo } from "react";
import {
  Activity,
  Bot,
  BookOpen,
  Files,
  FolderGit2,
  GitBranch,
  LayoutTemplate,
  MessageSquare,
  Moon,
  Network,
  Plus,
  RefreshCw,
  Settings,
  Sun,
  TerminalSquare,
  UserRound,
  Webhook,
  type LucideIcon,
} from "lucide-react";
import { openWorkspace } from "@/services/project-switch";
import { useProjectsStore } from "@/state/projects.store";
import { useThemeStore } from "@/state/theme.store";
import { useWorkspaceStore } from "@/state/workspace.store";
import type { ActivityView } from "@/views/shell/dock/dock-items";

export interface Command {
  id: string;
  /** What the user reads and types against. */
  title: string;
  group: string;
  icon?: LucideIcon;
  /** Keyboard shortcut label, when the action already has one. */
  hint?: string;
  /** Secondary line — a path, a workspace, a current value. */
  detail?: string;
  run: () => void;
}

/**
 * Inputs the registry cannot reach on its own. Everything here is the SAME
 * callback the corresponding button already calls — the palette is a second
 * way to reach existing actions, never a second implementation of them.
 */
export interface CommandSources {
  createSession: () => void;
  createTerminal: () => void;
  openTerminalPanel: () => void;
  refreshExplorer: () => void;
  collapseFolders: () => void;
  refreshGit: () => void;
  openFile: (path: string) => void;
}

const VIEWS: Array<{ id: ActivityView; label: string; icon: LucideIcon }> = [
  { id: "agents", label: "Agents", icon: Bot },
  { id: "explorer", label: "Explorer", icon: Files },
  { id: "git", label: "Source Control", icon: GitBranch },
  { id: "markdown", label: "Notes", icon: BookOpen },
  { id: "monitor", label: "Monitor", icon: Activity },
];

/**
 * The command palette's contents. Built from live store state so the entries
 * describe the app as it currently is — which workspace is open, whether the
 * dock is showing, which theme is active.
 */
export function useCommandRegistry(sources: CommandSources): Command[] {
  const theme = useThemeStore((s) => s.theme);
  const toggleTheme = useThemeStore((s) => s.toggle);
  const setActivityView = useWorkspaceStore((s) => s.setActivityView);
  const openSettings = useWorkspaceStore((s) => s.openSettings);
  const setRightTab = useWorkspaceStore((s) => s.setRightTab);
  const bottomPanel = useWorkspaceStore((s) => s.bottomPanel);
  const setBottomPanel = useWorkspaceStore((s) => s.setBottomPanel);
  const workbenchVisible = useWorkspaceStore((s) => s.workbenchVisible);
  const setWorkbenchVisible = useWorkspaceStore((s) => s.setWorkbenchVisible);
  const projects = useProjectsStore((s) => s.projects);
  const activeId = useProjectsStore((s) => s.activeId);

  return useMemo(() => {
    const list: Command[] = [];

    for (const view of VIEWS) {
      list.push({
        id: `view.${view.id}`,
        title: `Go to ${view.label}`,
        group: "Go to",
        icon: view.icon,
        run: () => setActivityView(view.id),
      });
    }

    list.push({
      id: "view.settings",
      title: "Open Settings",
      group: "Go to",
      icon: Settings,
      run: openSettings,
    });

    list.push(
      {
        id: "pane.chat",
        title: "Open Chat pane",
        group: "View",
        icon: MessageSquare,
        run: () => setRightTab("chat"),
      },
      {
        id: "panel.terminal",
        title: bottomPanel ? "Minimize Terminal window" : "Open Terminal window",
        group: "View",
        icon: TerminalSquare,
        hint: "Ctrl+`",
        run: () =>
          bottomPanel ? setBottomPanel(false) : sources.openTerminalPanel(),
      },
      {
        id: "pane.activity",
        title: "Show execution timeline",
        group: "View",
        icon: Activity,
        run: () => setRightTab("activity"),
      },
      {
        id: "view.tabs",
        title: workbenchVisible ? "Hide pane tabs" : "Show pane tabs",
        group: "View",
        icon: LayoutTemplate,
        run: () => setWorkbenchVisible(!workbenchVisible),
      },
      {
        id: "theme.toggle",
        title: theme === "dark" ? "Switch to light theme" : "Switch to dark theme",
        group: "View",
        icon: theme === "dark" ? Sun : Moon,
        run: toggleTheme,
      }
    );

    list.push(
      {
        id: "agent.new",
        title: "New agent session",
        group: "Create",
        icon: Plus,
        run: sources.createSession,
      },
      {
        id: "terminal.new",
        title: "New terminal",
        group: "Create",
        icon: TerminalSquare,
        run: sources.createTerminal,
      }
    );

    list.push(
      {
        id: "explorer.refresh",
        title: "Refresh Explorer",
        group: "Workspace",
        icon: RefreshCw,
        run: sources.refreshExplorer,
      },
      {
        id: "explorer.collapse",
        title: "Collapse folders in Explorer",
        group: "Workspace",
        icon: Files,
        run: sources.collapseFolders,
      },
      {
        id: "git.refresh",
        title: "Refresh Source Control",
        group: "Workspace",
        icon: GitBranch,
        run: sources.refreshGit,
      }
    );

    // Switching to the workspace you are already in is a no-op, so it is not
    // offered; adding one is the folder picker, which lives in the switcher.
    for (const project of projects) {
      if (project.id === activeId) continue;
      list.push({
        id: `workspace.${project.id}`,
        title: `Switch to ${project.name}`,
        group: "Workspace",
        icon: FolderGit2,
        detail: project.path,
        run: () => void openWorkspace(project.id).catch(() => undefined),
      });
    }

    list.push({
      id: "account.settings",
      title: "Account and sign out",
      group: "Account",
      icon: UserRound,
      detail: "Opens Settings → Account",
      run: openSettings,
    });

    return list;
  }, [
    activeId,
    bottomPanel,
    openSettings,
    projects,
    setActivityView,
    setBottomPanel,
    setRightTab,
    setWorkbenchVisible,
    sources,
    theme,
    toggleTheme,
    workbenchVisible,
  ]);
}
