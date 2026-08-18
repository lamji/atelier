import { create } from "zustand";
import type { FileTreeNode, SlashCommand } from "@atelier/protocol";
import type { ActivityView } from "@/views/shell/dock/dock-items";

export type RightTab =
  | "chat"
  | "editor"
  | "terminal"
  | "activity"
  | "output"
  | "graph"
  | "rag";

/*
 * The bottom dock hosts the integrated terminal and nothing else. The
 * execution timeline used to be a second tab down there; it is a full-height
 * feed rather than a terminal, so it lives in the editor area's Activity pane
 * and the dock's bar is free to be the terminal tab strip.
 */

interface WorkspaceStore {
  /** Which left panel the activity rail shows. Lives here (not in
   *  AppShell state) so other views can navigate the rail. */
  activityView: ActivityView;
  tree: FileTreeNode | null;
  treeVersion: number;
  expanded: Set<string>;
  selectedPath: string | null;
  fileContent: string | null;
  fileMtime: number | null;
  rightTab: RightTab;
  /** The header's Chat / Editor / Terminal / Activity workbench. */
  workbenchVisible: boolean;
  /**
   * Bumped every time the app re-points at a different project. Anything
   * holding workspace-scoped state OUTSIDE a store (React local state, refs)
   * watches this to drop it — a draft or a queued file write from the old
   * workspace must never reach the new one.
   */
  workspaceEpoch: number;
  /** Whether the bottom dock (the integrated terminal) is expanded. */
  bottomPanel: boolean;
  settingsOpen: boolean;
  skillDetail: { command: SlashCommand; content: string } | null;
  /** The active file-name search in the explorer; the editor reads it so it
   *  can highlight the same matches inside the open file. Lifted out of the
   *  panel's local state because Monaco lives in a different view tree. */
  searchQuery: string;
  setActivityView: (view: ActivityView) => void;
  setBottomPanel: (open: boolean) => void;
  openSettings: () => void;
  closeSettings: () => void;
  openBottom: () => void;
  setSearchQuery: (query: string) => void;
  setTree: (tree: FileTreeNode) => void;
  bumpTreeVersion: () => void;
  toggleExpanded: (path: string) => void;
  /** Expands a directory and every ancestor of it. */
  expandPath: (path: string) => void;
  collapseAll: () => void;
  setSelectedFile: (path: string, content: string, mtime: number) => void;
  refreshSelectedFile: (content: string, mtime: number) => void;
  clearSelected: () => void;
  setRightTab: (tab: RightTab) => void;
  setWorkbenchVisible: (visible: boolean) => void;
  openSkillDetail: (detail: { command: SlashCommand; content: string }) => void;
  closeSkillDetail: () => void;
}

export const useWorkspaceStore = create<WorkspaceStore>((set) => ({
  activityView: "agents",
  tree: null,
  treeVersion: 0,
  expanded: new Set<string>(),
  selectedPath: null,
  fileContent: null,
  fileMtime: null,
  rightTab: "chat",
  workbenchVisible: false,
  workspaceEpoch: 0,
  bottomPanel: false,
  settingsOpen: false,
  skillDetail: null,
  searchQuery: "",

  setActivityView: (activityView) => set({ activityView }),
  setBottomPanel: (bottomPanel) => set({ bottomPanel }),
  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),
  openBottom: () => set({ bottomPanel: true }),
  setTree: (tree) => set({ tree }),
  bumpTreeVersion: () => set((s) => ({ treeVersion: s.treeVersion + 1 })),
  toggleExpanded: (path) =>
    set((s) => {
      const expanded = new Set(s.expanded);
      if (expanded.has(path)) expanded.delete(path);
      else expanded.add(path);
      return { expanded };
    }),
  expandPath: (path) =>
    set((s) => {
      const expanded = new Set(s.expanded);
      const segments = path.split("/").filter(Boolean);
      for (let i = 1; i <= segments.length; i++) {
        expanded.add(segments.slice(0, i).join("/"));
      }
      return { expanded };
    }),
  collapseAll: () => set({ expanded: new Set<string>() }),
  setSelectedFile: (selectedPath, fileContent, fileMtime) =>
    set({ selectedPath, fileContent, fileMtime, rightTab: "editor" }),
  refreshSelectedFile: (fileContent, fileMtime) =>
    set({ fileContent, fileMtime }),
  clearSelected: () =>
    set({ selectedPath: null, fileContent: null, fileMtime: null }),
  setRightTab: (rightTab) => set({ rightTab }),
  setWorkbenchVisible: (workbenchVisible) => set({ workbenchVisible }),
  openSkillDetail: (skillDetail) => set({ skillDetail, rightTab: "chat" }),
  closeSkillDetail: () => set({ skillDetail: null, rightTab: "chat" }),
  setSearchQuery: (searchQuery) => set({ searchQuery }),
}));
