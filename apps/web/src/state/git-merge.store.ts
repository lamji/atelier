import { create } from "zustand";
import type { GitConflictFile, GitPullMode, GitRefs } from "@atelier/protocol";

/**
 * State for the sync row (fetch / pull / push) and the merge-conflict
 * flow: which file the resolver has open, the streamed output of the last
 * sync run, and the AI repair task that may be resolving files while the
 * user looks elsewhere.
 *
 * The list of conflicted paths itself is NOT here — it is `status.conflicts`
 * in the git store, refetched on every git.state.changed, so a conflict
 * made by a terminal `git pull` shows up the same way as one made here.
 */

/** Which sync command the output pane belongs to. */
export type SyncKind = "fetch" | "pull" | "push" | "continue" | "checkout";

/** The picker modals: where to pull from, or check out from. */
export type SyncModalKind = "pull" | "checkout";

/** Outcome of the last modal-driven run, for the modal's result screen. */
export interface SyncRunResult {
  kind: SyncKind;
  ok: boolean;
  exitCode: number;
  conflicts: number;
  /** One-line human summary ("fast-forward · 3 files changed"). */
  summary: string;
}

export interface GitMergeStore {
  /** Workspace-relative path the resolver shows, or null when closed. */
  openPath: string | null;
  /** The loaded three sides for `openPath`. */
  file: GitConflictFile | null;
  loadingFile: boolean;
  /** Streamed output of the running or last sync/continue command. */
  syncKind: SyncKind | null;
  syncOutput: string;
  syncRunning: boolean;
  /** Set when the last run failed for a reason other than conflicts. */
  syncError: string | null;
  /** Reconcile strategy the Pull button uses; remembered per session. */
  pullMode: GitPullMode;
  /** Whether the streamed output drawer is expanded under the sync row. */
  outputOpen: boolean;

  /** Open picker modal, or null. */
  syncModal: SyncModalKind | null;
  /** "configure" shows the picker; "run" shows the terminal + result. */
  syncModalPhase: "configure" | "run";
  /** Refs for the pickers; refreshed on open and after Fetch. */
  refs: GitRefs | null;
  refsLoading: boolean;
  lastRun: SyncRunResult | null;

  /** Conversation the AI resolver runs in (one per merge). */
  aiConversationId: string | null;
  /** Paths the current AI task was asked to resolve; null when idle. */
  aiPaths: string[] | null;
  /** Files the AI resolved and the app auto-staged — flagged for review. */
  aiResolved: string[];
  /**
   * Every path seen conflicted during the CURRENT merge state. git drops a
   * path from `conflicts` the moment it is staged, so this is what lets the
   * banner say "2 of 5 resolved" and list the resolved ones with an Undo.
   * Cleared when the merge state ends.
   */
  trackedConflicts: string[];
  /** Human-readable outcome of the last AI pass, shown in the banner. */
  aiSummary: string | null;

  /**
   * Conflict count the shell-level alert last announced. The alert shows
   * when `status.conflicts` grows past this and the user is not already on
   * the git view; dismissing it records the count so it stays quiet until
   * a NEW conflict appears.
   */
  alertSeenCount: number;
  alertVisible: boolean;

  set: (patch: Partial<GitMergeStore>) => void;
  appendOutput: (chunk: string) => void;
  startRun: (kind: SyncKind) => void;
  openSyncModal: (kind: SyncModalKind) => void;
  closeSyncModal: () => void;
  openConflict: (path: string) => void;
  closeConflict: () => void;
  reset: () => void;
}

const initial = {
  openPath: null,
  file: null,
  loadingFile: false,
  syncKind: null,
  syncOutput: "",
  syncRunning: false,
  syncError: null,
  pullMode: "merge" as GitPullMode,
  outputOpen: false,
  syncModal: null as SyncModalKind | null,
  syncModalPhase: "configure" as "configure" | "run",
  refs: null as GitRefs | null,
  refsLoading: false,
  lastRun: null as SyncRunResult | null,
  aiConversationId: null,
  aiPaths: null,
  aiResolved: [],
  aiSummary: null,
  trackedConflicts: [],
  alertSeenCount: 0,
  alertVisible: false,
};

export const useGitMergeStore = create<GitMergeStore>((set) => ({
  ...initial,
  set: (patch) => set(patch),
  appendOutput: (chunk) => set((s) => ({ syncOutput: s.syncOutput + chunk })),
  startRun: (kind) =>
    set((s) => ({
      syncKind: kind,
      syncOutput: "",
      syncRunning: true,
      syncError: null,
      outputOpen: true,
      lastRun: null,
      // A run started from the picker flips it to its terminal screen —
      // except Fetch, which the picker offers to refresh its own list.
      syncModalPhase:
        s.syncModal && kind !== "fetch" ? "run" : s.syncModalPhase,
    })),
  openSyncModal: (kind) =>
    set({ syncModal: kind, syncModalPhase: "configure", lastRun: null }),
  closeSyncModal: () => set({ syncModal: null, syncModalPhase: "configure" }),
  openConflict: (path) =>
    set((s) =>
      s.openPath === path
        ? s
        : { openPath: path, file: null, loadingFile: true }
    ),
  closeConflict: () => set({ openPath: null, file: null, loadingFile: false }),
  reset: () => set({ ...initial }),
}));
