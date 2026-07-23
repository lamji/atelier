import { create } from "zustand";
import type { GitBranch, GitCommit, GitStatus } from "@atelier/protocol";

/** A single-file diff opened from the Git panel, shown in the editor pane. */
export interface GitDiffView {
  path: string;
  staged: boolean;
  before: string;
  after: string;
}

interface GitStore {
  status: GitStatus | null;
  commits: GitCommit[];
  branches: GitBranch[];
  /** Bumped by git.state.changed events to trigger a refetch. */
  stateVersion: number;
  gitDiff: GitDiffView | null;
  error: string | null;
  setData: (
    status: GitStatus,
    commits: GitCommit[],
    branches: GitBranch[]
  ) => void;
  bumpStateVersion: () => void;
  setGitDiff: (diff: GitDiffView | null) => void;
  setError: (error: string | null) => void;
}

export const useGitStore = create<GitStore>((set) => ({
  status: null,
  commits: [],
  branches: [],
  stateVersion: 0,
  gitDiff: null,
  error: null,

  setData: (status, commits, branches) =>
    set({ status, commits, branches, error: null }),
  bumpStateVersion: () => set((s) => ({ stateVersion: s.stateVersion + 1 })),
  setGitDiff: (gitDiff) => set({ gitDiff }),
  setError: (error) => set({ error }),
}));
