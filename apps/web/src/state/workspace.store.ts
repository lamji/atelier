import { create } from "zustand";
import type { FileTreeNode } from "@atelier/protocol";

export type RightTab =
  | "chat"
  | "editor"
  | "terminal"
  | "activity"
  | "graph"
  | "rag";

interface WorkspaceStore {
  tree: FileTreeNode | null;
  treeVersion: number;
  expanded: Set<string>;
  selectedPath: string | null;
  fileContent: string | null;
  fileMtime: number | null;
  rightTab: RightTab;
  setTree: (tree: FileTreeNode) => void;
  bumpTreeVersion: () => void;
  toggleExpanded: (path: string) => void;
  setSelectedFile: (path: string, content: string, mtime: number) => void;
  refreshSelectedFile: (content: string, mtime: number) => void;
  clearSelected: () => void;
  setRightTab: (tab: RightTab) => void;
}

export const useWorkspaceStore = create<WorkspaceStore>((set) => ({
  tree: null,
  treeVersion: 0,
  expanded: new Set<string>(),
  selectedPath: null,
  fileContent: null,
  fileMtime: null,
  rightTab: "chat",

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
}));
