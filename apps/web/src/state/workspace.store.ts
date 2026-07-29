import { create } from "zustand";
import type { FileTreeNode, SlashCommand } from "@atelier/protocol";
import type { ActivityView } from "@/views/shell/ActivityBar";

export type RightTab =
  | "chat"
  | "editor"
  | "terminal"
  | "activity"
  | "graph"
  | "rag";

/** Tabs of the collapsible bottom dock (terminal + execution timeline). */
export type BottomTab = "terminal" | "timeline";

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
  /** Whether the bottom dock (terminal / timeline) is expanded. */
  bottomPanel: boolean;
  bottomTab: BottomTab;
  skillDetail: { command: SlashCommand; content: string } | null;
  setActivityView: (view: ActivityView) => void;
  setBottomPanel: (open: boolean) => void;
  openBottom: (tab: BottomTab) => void;
  setTree: (tree: FileTreeNode) => void;
  bumpTreeVersion: () => void;
  toggleExpanded: (path: string) => void;
  setSelectedFile: (path: string, content: string, mtime: number) => void;
  refreshSelectedFile: (content: string, mtime: number) => void;
  clearSelected: () => void;
  setRightTab: (tab: RightTab) => void;
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
  bottomPanel: false,
  bottomTab: "terminal",
  skillDetail: null,

  setActivityView: (activityView) => set({ activityView }),
  setBottomPanel: (bottomPanel) => set({ bottomPanel }),
  openBottom: (bottomTab) => set({ bottomPanel: true, bottomTab }),
  setTree: (tree) => set({ tree }),
  bumpTreeVersion: () => set((s) => ({ treeVersion: s.treeVersion + 1 })),
  toggleExpanded: (path) =>
    set((s) => {
      const expanded = new Set(s.expanded);
      if (expanded.has(path)) expanded.delete(path);
      else expanded.add(path);
      return { expanded };
    }),
  setSelectedFile: (selectedPath, fileContent, fileMtime) =>
    set({ selectedPath, fileContent, fileMtime, rightTab: "editor" }),
  refreshSelectedFile: (fileContent, fileMtime) =>
    set({ fileContent, fileMtime }),
  clearSelected: () =>
    set({ selectedPath: null, fileContent: null, fileMtime: null }),
  setRightTab: (rightTab) => set({ rightTab }),
  openSkillDetail: (skillDetail) => set({ skillDetail, rightTab: "chat" }),
  closeSkillDetail: () => set({ skillDetail: null, rightTab: "chat" }),
}));
