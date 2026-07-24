import { create } from "zustand";
import type { Diff, FileTreeNode } from "@atelier/protocol";

export type RightTab =
  | "chat"
  | "editor"
  | "diffs"
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
  diffs: Diff[];
  activeDiffId: string | null;
  rightTab: RightTab;
  setTree: (tree: FileTreeNode) => void;
  bumpTreeVersion: () => void;
  toggleExpanded: (path: string) => void;
  setSelectedFile: (path: string, content: string, mtime: number) => void;
  refreshSelectedFile: (content: string, mtime: number) => void;
  clearSelected: () => void;
  addDiff: (diff: Diff) => void;
  showDiff: (diffId: string) => void;
  setRightTab: (tab: RightTab) => void;
}

export const useWorkspaceStore = create<WorkspaceStore>((set) => ({
  tree: null,
  treeVersion: 0,
  expanded: new Set<string>(),
  selectedPath: null,
  fileContent: null,
  fileMtime: null,
  diffs: [],
  activeDiffId: null,
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
  addDiff: (diff) =>
    set((s) => ({
      diffs: [...s.diffs.slice(-49), diff],
      activeDiffId: diff.id,
      rightTab: "diffs",
    })),
  showDiff: (activeDiffId) => set({ activeDiffId, rightTab: "diffs" }),
  setRightTab: (rightTab) => set({ rightTab }),
}));
