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
  /**
   * Checkout the panel is pointed at.
   *
   * Shared rather than local to the git view model, because the Requests
   * pane has to know the moment it CHANGES. Its own data is remote and slow
   * to fetch, so without this it kept showing the previous repository's
   * name, credential and pull requests until a network round trip finished
   * — the panel claiming one repo while the strip above it named another.
   */
  activeRepo: string | null;
  /**
   * Branch + dirtiness straight from git.state.changed — always current,
   * even when the Git panel is closed, so the status bar can show it.
   */
  live: {
    branch: string;
    isClean: boolean;
    changedFiles: number;
    /** Unmerged paths right now — how the dock/alert know before a refetch. */
    conflicts: number;
    /** Merge/rebase/… in flight, or null. */
    mergeKind: string | null;
  } | null;
  gitDiff: GitDiffView | null;
  /** Path whose diff is being fetched — the drawer opens on it at once. */
  gitDiffLoading: string | null;
  error: string | null;
  setData: (
    status: GitStatus,
    commits: GitCommit[],
    branches: GitBranch[]
  ) => void;
  bumpStateVersion: () => void;
  /**
   * Bumped when THIS app opened or changed a pull request, so the Requests
   * pane re-checks in a burst instead of waiting for its next poll: the
   * forge answers the create call before it lists the request.
   */
  requestsNudge: number;
  nudgeRequests: () => void;
  setActiveRepo: (repo: string | null) => void;
  setLive: (live: GitStore["live"]) => void;
  setGitDiff: (diff: GitDiffView | null) => void;
  setGitDiffLoading: (path: string | null) => void;
  setError: (error: string | null) => void;
}

export const useGitStore = create<GitStore>((set) => ({
  status: null,
  commits: [],
  branches: [],
  stateVersion: 0,
  activeRepo: null,
  live: null,
  gitDiff: null,
  gitDiffLoading: null,
  error: null,

  setData: (status, commits, branches) =>
    set({ status, commits, branches, error: null }),
  bumpStateVersion: () => set((s) => ({ stateVersion: s.stateVersion + 1 })),
  requestsNudge: 0,
  nudgeRequests: () => set((s) => ({ requestsNudge: s.requestsNudge + 1 })),
  setActiveRepo: (activeRepo) => set({ activeRepo }),
  setLive: (live) => set({ live }),
  setGitDiff: (gitDiff) => set({ gitDiff, gitDiffLoading: null }),
  setGitDiffLoading: (gitDiffLoading) => set({ gitDiffLoading }),
  setError: (error) => set({ error }),
}));
